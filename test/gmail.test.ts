import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { OAuth2Client } from 'google-auth-library';
import {
  createDraft,
  deleteDraft,
  gmailHttp,
  listDrafts,
  resetGmailHttp,
  sendMessage,
} from '../src/gmail.js';

type Call = { method: string; url: string; body?: unknown };

const SEND_AS = {
  sendAs: [
    {
      sendAsEmail: 'spulak.ondrej@gmail.com',
      displayName: 'Ondrej Spulak',
      isDefault: true,
      isPrimary: true,
      verificationStatus: 'accepted',
    },
    {
      sendAsEmail: 'mail@ondrejspulak.cz',
      displayName: 'Ondrej',
      isDefault: false,
      isPrimary: false,
      verificationStatus: 'accepted',
    },
  ],
};

const ORIGINAL = {
  id: 'msg1',
  threadId: 'thread-abc',
  payload: {
    headers: [
      { name: 'Delivered-To', value: 'spulak.ondrej@gmail.com' },
      { name: 'Delivered-To', value: 'mail@ondrejspulak.cz' },
      { name: 'To', value: 'mail@ondrejspulak.cz' },
      { name: 'From', value: 'client@example.com' },
      { name: 'Subject', value: 'Hello' },
      { name: 'Message-ID', value: '<orig@mail.gmail.com>' },
      { name: 'References', value: '<first@mail.gmail.com>' },
      { name: 'In-Reply-To', value: '<first@mail.gmail.com>' },
    ],
  },
};

function jsonResponse(status: number, body?: unknown): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installFetch(handler: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  gmailHttp.clientForRefreshToken = () => ({}) as OAuth2Client;
  gmailHttp.tokenFromClient = async () => 'test-token';
  gmailHttp.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const call: Call = { method, url, body };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  resetGmailHttp();
});

describe('gmail send/draft HTTP layer', () => {
  it('posts threadId on messages.send for a reply', async () => {
    const calls = installFetch((call) => {
      if (call.url.includes('/settings/sendAs')) return jsonResponse(200, SEND_AS);
      if (call.url.includes('/messages/msg1')) return jsonResponse(200, ORIGINAL);
      if (call.url.includes('/messages/send')) {
        return jsonResponse(200, { id: 'sent1', threadId: call.body?.threadId });
      }
      return jsonResponse(404, { error: { message: call.url } });
    });

    const sent = await sendMessage('refresh', {
      replyToMessageId: 'msg1',
      body: 'Thanks',
    });

    assert.equal(sent.threadId, 'thread-abc');
    assert.equal(sent.from, 'mail@ondrejspulak.cz');
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/messages/send'));
    assert.equal(post?.body?.threadId, 'thread-abc');
    assert.equal(typeof post?.body?.raw, 'string');
  });

  it('posts threadId on drafts.create for a reply', async () => {
    const calls = installFetch((call) => {
      if (call.url.includes('/settings/sendAs')) return jsonResponse(200, SEND_AS);
      if (call.url.includes('/messages/msg1')) return jsonResponse(200, ORIGINAL);
      if (call.method === 'POST' && /\/drafts$/.test(new URL(call.url).pathname)) {
        return jsonResponse(200, { id: 'draft1', message: { id: 'dmsg', threadId: call.body?.message?.threadId } });
      }
      return jsonResponse(404, { error: { message: call.url } });
    });

    const draft = await createDraft('refresh', {
      replyToMessageId: 'msg1',
      body: 'Draft reply',
    });

    assert.equal(draft.message?.threadId, 'thread-abc');
    assert.equal(draft.from, 'mail@ondrejspulak.cz');
    const post = calls.find((c) => c.method === 'POST' && /\/drafts$/.test(new URL(c.url).pathname));
    assert.equal(post?.body?.message?.threadId, 'thread-abc');
    assert.equal(typeof post?.body?.message?.raw, 'string');
  });

  it('treats DELETE 204 as success', async () => {
    installFetch((call) => {
      if (call.method === 'DELETE' && call.url.includes('/drafts/r123')) return jsonResponse(204);
      return jsonResponse(404, { error: { message: call.url } });
    });
    await deleteDraft('refresh', 'r123');
  });

  it('lists drafts with format=metadata and caps hydrate concurrency at 10', async () => {
    const ids = Array.from({ length: 15 }, (_, i) => `d${i}`);
    let inflight = 0;
    let maxInflight = 0;
    const calls = installFetch(async (call) => {
      if (call.method === 'GET' && /\/drafts$/.test(new URL(call.url).pathname)) {
        return jsonResponse(200, { drafts: ids.map((id) => ({ id })) });
      }
      if (call.method === 'GET' && call.url.includes('/drafts/')) {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, 20));
        inflight -= 1;
        const id = new URL(call.url).pathname.split('/').pop();
        return jsonResponse(200, {
          id,
          message: {
            id: `m-${id}`,
            threadId: 't1',
            snippet: 'hi',
            payload: { headers: [{ name: 'Subject', value: `Draft ${id}` }] },
          },
        });
      }
      return jsonResponse(404, { error: { message: call.url } });
    });

    const listed = await listDrafts('refresh', 50);
    assert.equal(listed.length, 15);
    assert.equal(listed[0]?.subject, 'Draft d0');
    assert.ok(maxInflight <= 10, `max inflight ${maxInflight}`);
    assert.ok(maxInflight >= 2, `expected parallel hydrates, got ${maxInflight}`);
    const hydrate = calls.find((c) => c.url.includes('/drafts/d0'));
    assert.match(hydrate?.url ?? '', /format=metadata/);
    assert.match(hydrate?.url ?? '', /metadataHeaders=From/);
  });
});
