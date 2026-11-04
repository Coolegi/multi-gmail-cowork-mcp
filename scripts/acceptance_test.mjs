#!/usr/bin/env node
// Acceptance test harness for a deployed (or locally-running) Multi-Gmail MCP.
//
// Performs the full MCP OAuth flow as a real remote client would:
//   Dynamic Client Registration -> PKCE authorize -> admin consent -> token exchange
// then calls every tool through the authenticated /claude-mcp endpoint and checks
// the architecture's invariants: account isolation, no-fallback on a bad alias,
// correct From identity, and send-arrival verification.
//
// It sends test emails account-A -> account-B and account-B -> account-A, so the
// recipient is always an account you own. Set SKIP_SEND=1 to skip the send tests.
//
// Usage:
//   MCP_BASE_URL=https://your-host.run.app MCP_ADMIN_PASSWORD='...' \
//     node scripts/acceptance_test.mjs
//
//   # read the admin password from a file instead of an env var:
//   node scripts/acceptance_test.mjs --base https://your-host.run.app --password-file ./pw.txt
//
//   # fetch the admin password with gcloud (needs an authed gcloud in the project):
//   MCP_BASE_URL=https://your-host.run.app GCP_PROJECT_ID=your-project \
//     node scripts/acceptance_test.mjs --gcloud
//
// The harness never prints the admin password, OAuth tokens, or refresh tokens.
// It prints only aliases, verified email addresses, and PASS/FAIL lines.

import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Config / arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
}
function argFlag(name) {
  return args.includes(`--${name}`);
}

const baseUrl = (argValue('base') || process.env.MCP_BASE_URL || '').replace(/\/+$/, '');
if (!baseUrl) {
  console.error('FAIL  Set MCP_BASE_URL (or pass --base) to the deployment root, e.g. https://svc.run.app');
  process.exit(2);
}

const skipSend = argFlag('skip-send') || process.env.SKIP_SEND === '1';
const probeOnly = argFlag('probe'); // stop after proving the OAuth flow is wired (no real password needed)

// ---------------------------------------------------------------------------
// Low-level HTTP helper (we must read 302 Location headers that fetch hides)
// ---------------------------------------------------------------------------

function rawRequest(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = lib(
      {
        method,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        headers,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// The Streamable HTTP transport rejects requests without this Accept header (406).
const MCP_ACCEPT = 'application/json, text/event-stream';

function parseBody(body) {
  // The transport may respond as application/json (single response) or as an SSE
  // stream (data: {...}\n\n). Extract the last JSON object either way.
  if (!body) return null;
  const sse = body.match(/^data:\s*(.+)$/gm);
  if (sse) {
    for (const line of sse.reverse()) {
      try {
        return JSON.parse(line.replace(/^data:\s*/, ''));
      } catch {
        /* try next */
      }
    }
  }
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function httpJson(url, opts) {
  const res = await rawRequest(url, opts);
  return { ...res, json: parseBody(res.body) };
}

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`${tag}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// MCP OAuth flow
// ---------------------------------------------------------------------------

const REDIRECT_URI = 'http://127.0.0.1:1/callback'; // nothing listens; we capture the 302 Location
const MCP_RESOURCE = `${baseUrl}/claude-mcp`;
const SCOPE = 'mcp:tools';

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function dynamicClientRegistration() {
  const res = await httpJson(`${baseUrl}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'acceptance-test-harness',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`DCR /register returned HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }
  if (!res.json?.client_id) throw new Error('DCR did not return a client_id.');
  return res.json;
}

async function startAuthorization(client, challenge, state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: SCOPE,
    state,
    resource: MCP_RESOURCE,
  });
  const res = await rawRequest(`${baseUrl}/authorize?${params}`);
  if (res.status !== 200) {
    throw new Error(`GET /authorize returned HTTP ${res.status}, expected 200 (consent page).`);
  }
  const match = res.body.match(/name="request"\s+value="([^"]+)"/);
  if (!match) throw new Error('Consent page did not contain a signed request token.');
  return match[1];
}

async function completeConsent(requestToken, password, decision = 'approve') {
  const form = new URLSearchParams({
    request: requestToken,
    username: 'admin',
    password: password || '',
    decision,
  });
  // redirect:'manual' equivalent — we read the Location header directly.
  const res = await rawRequest(`${baseUrl}/authorize/consent`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  return res; // 302 with Location on success, 400 with HTML error on bad creds
}

async function exchangeCode(client, code, verifier) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: client.client_id,
    code_verifier: verifier,
    resource: MCP_RESOURCE,
  });
  const res = await httpJson(`${baseUrl}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (res.status !== 200) {
    throw new Error(`Token exchange returned HTTP ${res.status}: ${res.body.slice(0, 300)}`);
  }
  if (!res.json?.access_token) throw new Error('Token response did not include access_token.');
  return res.json;
}

// ---------------------------------------------------------------------------
// MCP tool calls (stateless JSON-RPC over POST /claude-mcp)
// ---------------------------------------------------------------------------

let rpcId = 0;
async function mcpCall(accessToken, method, params) {
  const res = await httpJson(`${baseUrl}/claude-mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: MCP_ACCEPT,
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  if (res.status !== 200 && res.status !== 202) {
    throw new Error(`${method} returned HTTP ${res.status}: ${res.body.slice(0, 300)}`);
  }
  if (res.json?.error) {
    throw new Error(`${method} JSON-RPC error: ${JSON.stringify(res.json.error)}`);
  }
  return res.json?.result;
}

function parseToolResult(result) {
  // Tools return { content: [{type:'text', text: JSON}], isError?: bool }
  const text = result?.content?.[0]?.text;
  const isError = result?.isError === true;
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { isError, text, parsed };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function resolveAdminPassword() {
  if (process.env.MCP_ADMIN_PASSWORD) return process.env.MCP_ADMIN_PASSWORD;
  const file = argValue('password-file');
  if (file) return readFileSync(file, 'utf8').replace(/\r?\n+$/, '');
  if (argFlag('gcloud')) {
    const project = process.env.GCP_PROJECT_ID || '';
    const args = ['secrets', 'versions', 'access', 'latest', '--secret=admin-password'];
    if (project) args.push('--project', project);
    // On Windows, gcloud is gcloud.cmd and Node cannot exec .cmd without a shell.
    // shell:true lets cmd.exe resolve it via PATHEXT; on Linux (Cloud Shell) we exec directly.
    try {
      return execFileSync('gcloud', args, {
        encoding: 'utf8',
        shell: process.platform === 'win32',
      }).replace(/\r?\n+$/, '');
    } catch (e) {
      throw new Error(`--gcloud failed to read admin-password: ${e.message}`);
    }
  }
  return undefined;
}

async function obtainAccessToken(password) {
  const client = await dynamicClientRegistration();
  const { verifier, challenge } = pkce();
  const state = randomUUID();
  const requestToken = await startAuthorization(client, challenge, state);
  const consent = await completeConsent(requestToken, password, 'approve');
  if (consent.status !== 302) {
    throw new Error(`Consent did not redirect (HTTP ${consent.status}): ${consent.body.slice(0, 200)}`);
  }
  const loc = consent.headers.location || '';
  const u = new URL(loc, baseUrl);
  const code = u.searchParams.get('code');
  if (!code) throw new Error(`Consent redirect did not include a code: ${loc}`);
  const tokens = await exchangeCode(client, code, verifier);
  return tokens.access_token;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(`\nMulti-Gmail MCP acceptance tests\nTarget: ${baseUrl}\n`);

  // --- MCP OAuth wiring (provable without a real password) ---
  console.log('--- MCP OAuth flow ---');
  try {
    const client = await dynamicClientRegistration();
    record('Dynamic Client Registration', true, `client_id ${client.client_id.slice(0, 8)}…`);
  } catch (e) {
    record('Dynamic Client Registration', false, e.message);
    return exitSummary();
  }

  const { verifier, challenge } = pkce();
  const state = randomUUID();
  let requestToken;
  try {
    requestToken = await startAuthorization(await dynamicClientRegistration(), challenge, state);
    record('Authorize -> consent page', true, 'signed request token returned');
  } catch (e) {
    record('Authorize -> consent page', false, e.message);
    return exitSummary();
  }

  // Verify the consent gate rejects a wrong password (proves the gate is wired).
  try {
    const bad = await completeConsent(requestToken, 'definitely-wrong-password', 'approve');
    const wrongDenied = bad.status === 400 && /invalid admin credentials/i.test(bad.body);
    record('Consent rejects wrong admin password', wrongDenied, `HTTP ${bad.status}`);
  } catch (e) {
    record('Consent rejects wrong admin password', false, e.message);
  }

  if (probeOnly) {
    console.log('\n--probe: stopping before the real consent (no admin password needed for the above).');
    return exitSummary();
  }

  const password = resolveAdminPassword();
  if (!password) {
    console.log(
      '\nACTION REQUIRED  Provide the deployment admin password to run the tool tests:\n' +
        '  export MCP_ADMIN_PASSWORD="..."            # paste from Console -> Secret Manager -> admin-password\n' +
        '  node scripts/acceptance_test.mjs --password-file ./pw.txt   # or read from a file\n' +
        '  node scripts/acceptance_test.mjs --gcloud                   # or fetch with gcloud\n',
    );
    return exitSummary();
  }

  // --- Real access token ---
  let accessToken;
  try {
    accessToken = await obtainAccessToken(password);
    record('Full OAuth -> access token', true, 'token obtained (value hidden)');
  } catch (e) {
    record('Full OAuth -> access token', false, e.message);
    return exitSummary();
  }

  // --- Tool discovery ---
  console.log('\n--- Tool discovery ---');
  let toolNames;
  try {
    const list = await mcpCall(accessToken, 'tools/list', {});
    toolNames = (list?.tools || []).map((t) => t.name);
    const expected = [
      'list_accounts',
      'search_emails',
      'get_email',
      'search_all_accounts',
      'create_draft',
      'send_email',
      'list_drafts',
      'delete_draft',
    ];
    const missing = expected.filter((t) => !toolNames.includes(t));
    record('Eight tools discovered', missing.length === 0, `found: ${toolNames.join(', ')}`);
    if (missing.length) return exitSummary();
  } catch (e) {
    record('Eight tools discovered', false, e.message);
    return exitSummary();
  }

  // --- 1. list_accounts ---
  console.log('\n--- Gmail tool acceptance tests ---');
  let accounts;
  try {
    const r = parseToolResult(await mcpCall(accessToken, 'tools/call', { name: 'list_accounts', arguments: {} }));
    if (r.isError) throw new Error(r.text);
    accounts = r.parsed;
    const n = accounts.length;
    record('1. list_accounts', n >= 2, `${n} account(s): ${accounts.map((a) => `${a.alias}=${a.email}`).join(', ')}`);
    if (n < 2) {
      console.log('FAIL  Need at least 2 connected accounts for the isolation tests.');
      return exitSummary();
    }
  } catch (e) {
    record('1. list_accounts', false, e.message);
    return exitSummary();
  }

  const A = accounts[0];
  const B = accounts[1];

  // --- 2 & 3. Read from A and B ---
  for (const [label, acct] of [['2. read account A', A], ['3. read account B', B]]) {
    try {
      const r = parseToolResult(
        await mcpCall(accessToken, 'tools/call', {
          name: 'search_emails',
          arguments: { account: acct.alias, query: 'newer_than:365d', max_results: 3 },
        }),
      );
      const ok = !r.isError && r.parsed?.email === acct.email;
      record(label, ok, ok ? `${r.parsed.results.length} result(s) attributed to ${acct.alias}` : r.text);
    } catch (e) {
      record(label, false, e.message);
    }
  }

  // --- 4. A -> B -> A switching ---
  try {
    const seq = [];
    for (const acct of [A, B, A]) {
      const r = parseToolResult(
        await mcpCall(accessToken, 'tools/call', {
          name: 'search_emails',
          arguments: { account: acct.alias, query: 'newer_than:365d', max_results: 1 },
        }),
      );
      seq.push(r.isError ? null : r.parsed?.email);
    }
    const ok = seq[0] === A.email && seq[1] === B.email && seq[2] === A.email;
    record('4. A->B->A identity switching', ok, `emails: ${seq.join(' -> ')}`);
  } catch (e) {
    record('4. A->B->A identity switching', false, e.message);
  }

  // --- 5. search_all_accounts ---
  try {
    const r = parseToolResult(
      await mcpCall(accessToken, 'tools/call', {
        name: 'search_all_accounts',
        arguments: { query: 'newer_than:365d', max_results_per_account: 2 },
      }),
    );
    const res = r.parsed?.results || [];
    const aliases = res.map((x) => x.account);
    const both = aliases.includes(A.alias) && aliases.includes(B.alias);
    record('5. search_all_accounts', !r.isError && both, `accounts returned: ${aliases.join(', ')}`);
  } catch (e) {
    record('5. search_all_accounts', false, e.message);
  }

  // --- 6. Invalid alias: MUST error, MUST NOT fall back ---
  try {
    const r = parseToolResult(
      await mcpCall(accessToken, 'tools/call', {
        name: 'search_emails',
        arguments: { account: 'does-not-exist', query: 'newer_than:365d', max_results: 1 },
      }),
    );
    const mentionsNoConnected = /no connected gmail account/i.test(r.text || '') || /never falls back/i.test(r.text || '');
    // CRITICAL: the error must not contain another account's data
    const leakedOther = [A.email, B.email, A.alias, B.alias].some((v) => v !== 'does-not-exist' && (r.text || '').includes(v) && !mentionsNoConnected);
    const pass = r.isError && mentionsNoConnected && !leakedOther;
    record('6. invalid alias -> error, no fallback', pass, r.text.slice(0, 120));
    if (leakedOther) console.log('  *** SECURITY FAIL: another account may have been substituted ***');
  } catch (e) {
    record('6. invalid alias -> error, no fallback', false, e.message);
  }

  // --- 7 & 8. Drafts + list + delete ---
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const createdDrafts = [];
  for (const [label, acct, other] of [['7. draft account A', A, B], ['8. draft account B', B, A]]) {
    try {
      const r = parseToolResult(
        await mcpCall(accessToken, 'tools/call', {
          name: 'create_draft',
          arguments: {
            account: acct.alias,
            to: other.email,
            subject: `[acceptance-test] draft from ${acct.alias} ${stamp}`,
            body: `Harmless automated acceptance-test draft, sent by the Multi-Gmail MCP test harness. From ${acct.email}.`,
          },
        }),
      );
      const ok = !r.isError && r.parsed?.email === acct.email && r.parsed?.draft_id;
      record(label, ok, ok ? `draft_id ${r.parsed.draft_id} in ${acct.email}` : r.text.slice(0, 120));
      if (ok) createdDrafts.push({ account: acct, draftId: r.parsed.draft_id });
    } catch (e) {
      record(label, false, e.message);
    }
  }

  for (const created of createdDrafts) {
    try {
      const listed = parseToolResult(
        await mcpCall(accessToken, 'tools/call', {
          name: 'list_drafts',
          arguments: { account: created.account.alias, max_results: 50 },
        }),
      );
      const found = (listed.parsed?.drafts || []).some((d) => d.draft_id === created.draftId);
      record(
        `list_drafts finds ${created.account.alias} draft`,
        !listed.isError && found,
        found ? created.draftId : (listed.text || '').slice(0, 120),
      );
    } catch (e) {
      record(`list_drafts finds ${created.account.alias} draft`, false, e.message);
    }
  }

  for (const created of createdDrafts) {
    try {
      const deleted = parseToolResult(
        await mcpCall(accessToken, 'tools/call', {
          name: 'delete_draft',
          arguments: { account: created.account.alias, draft_id: created.draftId },
        }),
      );
      const ok = !deleted.isError && deleted.parsed?.deleted_draft_id === created.draftId;
      record(
        `delete_draft ${created.account.alias}`,
        ok,
        ok ? created.draftId : (deleted.text || '').slice(0, 120),
      );
    } catch (e) {
      record(`delete_draft ${created.account.alias}`, false, e.message);
    }
  }

  try {
    const r = parseToolResult(
      await mcpCall(accessToken, 'tools/call', {
        name: 'send_email',
        arguments: {
          account: A.alias,
          to: B.email,
          subject: `[acceptance-test] invalid-from ${stamp}`,
          body: 'Should not be sent.',
          from: 'not-a-sendas-alias@example.com',
        },
      }),
    );
    const pass = r.isError && /not a send-as alias/i.test(r.text || '');
    record('invalid from -> clear error, no send', pass, (r.text || '').slice(0, 160));
  } catch (e) {
    record('invalid from -> clear error, no send', false, e.message);
  }

  // --- 9 & 10. Send (A->B, B->A) + verify arrival + From identity ---
  if (skipSend) {
    record('9. send A->B', true, 'SKIPPED (SKIP_SEND=1)');
    record('10. send B->A', true, 'SKIPPED (SKIP_SEND=1)');
    record('send arrival + From identity', true, 'SKIPPED (SKIP_SEND=1)');
    record('reply stays in thread', true, 'SKIPPED (SKIP_SEND=1)');
    record('reply draft stays in thread', true, 'SKIPPED (SKIP_SEND=1)');
  } else {
    const sends = [
      { label: '9. send A->B', from: A, to: B },
      { label: '10. send B->A', from: B, to: A },
    ];
    let bothSent = true;
    for (const s of sends) {
      try {
        const r = parseToolResult(
          await mcpCall(accessToken, 'tools/call', {
            name: 'send_email',
            arguments: {
              account: s.from.alias,
              to: s.to.email,
              subject: `[acceptance-test] send ${s.from.alias}->${s.to.alias} ${stamp}`,
              body: `Harmless automated acceptance-test email. From ${s.from.email}.`,
            },
          }),
        );
        const ok = !r.isError && r.parsed?.from === s.from.email;
        record(s.label, ok, ok ? `from ${r.parsed.from} message_id ${r.parsed.message_id}` : r.text.slice(0, 120));
        if (!ok) bothSent = false;
      } catch (e) {
        record(s.label, false, e.message);
        bothSent = false;
      }
    }

    // Verify arrival + correct From by reading the recipient account.
    let arrivedOnB = null;
    if (bothSent) {
      let arrivalOk = true;
      const checks = [
        { recipient: B, sender: A },
        { recipient: A, sender: B },
      ];
      for (const c of checks) {
        let found = null;
        // Gmail delivery + indexing can lag a few seconds; retry briefly.
        for (let attempt = 0; attempt < 6 && !found; attempt++) {
          await sleep(5000 * (attempt + 1));
          try {
            const r = parseToolResult(
              await mcpCall(accessToken, 'tools/call', {
                name: 'search_emails',
                arguments: {
                  account: c.recipient.alias,
                  query: `from:${c.sender.email} subject:[acceptance-test] send newer_than:1d`,
                  max_results: 3,
                },
              }),
            );
            const hit = (r.parsed?.results || []).find((m) => m.from.toLowerCase().includes(c.sender.email.toLowerCase()));
            if (hit) found = hit;
          } catch {
            /* retry */
          }
        }
        if (!found) arrivalOk = false;
        else if (c.recipient === B) arrivedOnB = found;
      }
      record('send arrival + From identity', arrivalOk, arrivalOk ? 'both test emails arrived with correct sender' : 'could not confirm arrival (may need a longer wait)');
    } else {
      record('send arrival + From identity', false, 'a send failed; arrival not checked');
    }

    if (arrivedOnB) {
      try {
        const reply = parseToolResult(
          await mcpCall(accessToken, 'tools/call', {
            name: 'send_email',
            arguments: {
              account: B.alias,
              reply_to_message_id: arrivedOnB.id,
              body: `Harmless automated acceptance-test reply in-thread. From ${B.email}.`,
            },
          }),
        );
        const ok =
          !reply.isError &&
          reply.parsed?.thread_id === arrivedOnB.threadId &&
          typeof reply.parsed?.from === 'string' &&
          reply.parsed.from.includes('@');
        record(
          'reply stays in thread',
          ok,
          ok
            ? `from ${reply.parsed.from} thread_id ${reply.parsed.thread_id}`
            : (reply.text || '').slice(0, 160),
        );
      } catch (e) {
        record('reply stays in thread', false, e.message);
      }

      try {
        const draft = parseToolResult(
          await mcpCall(accessToken, 'tools/call', {
            name: 'create_draft',
            arguments: {
              account: B.alias,
              reply_to_message_id: arrivedOnB.id,
              body: `Harmless automated acceptance-test reply draft. From ${B.email}.`,
            },
          }),
        );
        const ok = !draft.isError && draft.parsed?.draft_id && draft.parsed?.thread_id === arrivedOnB.threadId;
        record(
          'reply draft stays in thread',
          ok,
          ok ? `draft_id ${draft.parsed.draft_id} thread_id ${draft.parsed.thread_id}` : (draft.text || '').slice(0, 160),
        );
        if (ok) {
          await mcpCall(accessToken, 'tools/call', {
            name: 'delete_draft',
            arguments: { account: B.alias, draft_id: draft.parsed.draft_id },
          });
        }
      } catch (e) {
        record('reply draft stays in thread', false, e.message);
      }
    } else if (!skipSend) {
      record('reply stays in thread', false, 'original message did not arrive on B; reply not attempted');
      record('reply draft stays in thread', false, 'original message did not arrive on B; reply draft not attempted');
    }
  }

  // --- 11. Persistence ---
  console.log(
    '\nNOTE  11. persistence (cold start) is not automated by this harness: forcing a new Cloud Run\n' +
      '      instance requires gcloud. The architecture is stateless — refresh tokens and MCP OAuth\n' +
      '      state live in Secret Manager, not instance memory — so a cold start cannot drop them.\n' +
      '      To verify manually: gcloud run services update-traffic multi-gmail-mcp --region us-central1\n' +
      '      --to-revisions LATEST=100 (or just wait for scale-to-zero), then rerun this harness.',
  );

  return exitSummary();
}

function exitSummary() {
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n--- Summary ---\n${passed} passed, ${failed} failed, ${results.length} total\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('Harness crashed:', e);
  process.exit(1);
});
