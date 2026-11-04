import express, { Router } from 'express';
import { getAccountStore } from './accountStore.js';
import { requireAdminAuth, requireSameOrigin } from './adminAuth.js';
import { ALIAS_PATTERN, loadConfig } from './config.js';
import { buildAuthorizationUrl, generatePkce, revokeRefreshToken } from './googleOAuth.js';
import { escapeHtml, pageShell } from './html.js';
import { log } from './logger.js';
import { createState } from './oauthState.js';
import { toSummary, type AccountSummary } from './types.js';

function renderAdminPage(accounts: AccountSummary[], message?: string): string {
  const config = loadConfig();
  const baseUrl = config.publicBaseUrl;
  const mcpUrl = `${baseUrl}/claude-mcp`;
  const callbackUrl = `${baseUrl}/oauth/google/callback`;
  const oauthClientConfigured = !!config.googleClientId && config.googleClientId !== 'REPLACE_ME';

  const rows = accounts
    .map(
      (a) => `<tr>
  <td>${escapeHtml(a.alias)}</td>
  <td>${escapeHtml(a.email)}</td>
  <td>${a.status === 'connected' ? '<span class="ok">Connected</span>' : '<span class="warn">Needs Gmail permission upgrade</span>'}</td>
  <td>
    ${
      a.status === 'reauthorization_required'
        ? `<form class="inline" method="post" action="/admin/accounts/start">
      <input type="hidden" name="alias" value="${escapeHtml(a.alias)}">
      <button type="submit">Reauthorize</button>
    </form>`
        : ''
    }
    <form class="inline" method="post" action="/admin/accounts/${encodeURIComponent(a.alias)}/disconnect">
      <button type="submit">Disconnect</button>
    </form>
  </td>
</tr>`,
    )
    .join('\n');

  const oauthCheck = oauthClientConfigured
    ? '<li><span class="ok">✓</span> Google OAuth client — configured</li>'
    : '<li><span class="warn">⚠</span> Google OAuth client — <strong>not configured yet</strong> (see the Google OAuth section below)</li>';

  const body = `
<h1>Multi-Gmail MCP</h1>
<p class="sub">Connect Gmail accounts and your Claude connector to this private deployment.</p>
${message ? `<p class="msg">${escapeHtml(message)}</p>` : ''}

<h2>Deployment</h2>
<ul class="checks">
  <li><span class="ok">✓</span> Cloud Run service — online</li>
  ${oauthCheck}
  <li><span class="ok">✓</span> MCP OAuth — configured (self-hosted)</li>
  <li><span class="ok">✓</span> Admin password — set</li>
</ul>

<h2>Google OAuth setup</h2>
<p class="muted">When creating your Google OAuth web client, use this exact authorized redirect URI:</p>
<div class="row">
  <input id="google-callback" class="url" readonly value="${escapeHtml(callbackUrl)}">
  <button type="button" data-target="google-callback" onclick="copyUrl(this)">Copy</button>
</div>

<h2>Connected Gmail accounts</h2>
<table>
  <thead><tr><th>Alias</th><th>Email</th><th>Status</th><th></th></tr></thead>
  <tbody>${rows || '<tr><td colspan="4"><em>No accounts connected yet — add one below.</em></td></tr>'}</tbody>
</table>

<h2>Add Gmail account</h2>
<form method="post" action="/admin/accounts/start">
  <div class="row">
    <input type="text" name="alias" placeholder="alias (e.g. work, personal)" pattern="[a-z0-9_-]{1,32}" maxlength="32" required autofocus>
    <button type="submit" class="primary">Connect account</button>
  </div>
</form>
<p class="muted">You choose the Google account on Google's sign-in screen. This app only sees the address Google confirms after you approve Gmail read, compose, and send permission.</p>

<h2>Claude setup</h2>
<p class="muted">In Claude: <strong>Settings → Connectors → Add custom connector</strong>, then enter:</p>
<div class="row">
  <input id="mcp-url" class="url" readonly value="${escapeHtml(mcpUrl)}">
  <button type="button" data-target="mcp-url" onclick="copyUrl(this)">Copy</button>
</div>
<details>
  <summary>Step-by-step Claude connector instructions</summary>
  <ol>
    <li>Open Claude and go to <strong>Settings → Connectors → Add custom connector</strong>.</li>
    <li><strong>Connector name:</strong> <code>Multi-Gmail</code></li>
    <li><strong>Remote MCP URL:</strong> the URL above (ending in <code>/claude-mcp</code>).</li>
    <li><strong>OAuth Client ID</strong> and <strong>OAuth Client Secret:</strong> leave blank — this server supports Dynamic Client Registration.</li>
    <li>Click <strong>Add</strong>, then <strong>Connect</strong>.</li>
    <li>Claude opens this deployment's <strong>Authorize MCP access</strong> page. Sign in with username <code>admin</code> and the admin password from your Secret Manager, then approve.</li>
    <li>Ask Claude to <code>list_accounts</code> to confirm the connection.</li>
  </ol>
  <p class="muted">Recommended tool permissions: read tools and <code>list_drafts</code> Always allow; <code>create_draft</code> user preference; <code>send_email</code> and <code>delete_draft</code> Needs approval.</p>
</details>
`;
  return pageShell('Multi-Gmail MCP — Admin', body);
}

export function createAdminRouter(): Router {
  const router = Router();
  router.use(requireAdminAuth);
  router.use(express.urlencoded({ extended: false }));

  router.get('/', async (req, res) => {
    const accounts = await getAccountStore().list();
    const msg = typeof req.query.msg === 'string' ? req.query.msg : undefined;
    res.type('html').send(renderAdminPage(accounts.map(toSummary), msg));
  });

  router.post('/accounts/start', requireSameOrigin, (req, res) => {
    const alias = String((req.body as { alias?: string }).alias ?? '').trim();
    if (!ALIAS_PATTERN.test(alias)) {
      res.redirect(
        '/admin?msg=' +
          encodeURIComponent('Invalid alias. Use lowercase letters, digits, "-" or "_", max 32 characters.'),
      );
      return;
    }
    const pkce = generatePkce();
    const state = createState(alias, pkce.codeVerifier);
    res.redirect(buildAuthorizationUrl(state, pkce));
  });

  router.post('/accounts/:alias/disconnect', requireSameOrigin, async (req, res) => {
    const alias = req.params.alias ?? '';
    if (!ALIAS_PATTERN.test(alias)) {
      res.redirect('/admin?msg=' + encodeURIComponent('Invalid alias.'));
      return;
    }
    const store = getAccountStore();
    const existing = await store.get(alias);
    if (existing) {
      await revokeRefreshToken(existing.refreshToken);
      await store.remove(alias);
      log.info('account_disconnected', { alias });
    }
    res.redirect('/admin?msg=' + encodeURIComponent(`Disconnected "${alias}".`));
  });

  return router;
}
