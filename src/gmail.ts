import type { OAuth2Client } from 'google-auth-library';
import {
  resolveCompose,
  type ComposeMessageInput,
  type ReplyOriginal,
  type SendAsAlias,
} from './compose.js';
import { clientForRefreshToken } from './googleOAuth.js';

export type { ComposeMessageInput } from './compose.js';
export { UnknownSendAsError } from './compose.js';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

interface GmailHeader {
  name?: string;
  value?: string;
}

interface GmailMessagePart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailMessagePart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailMessagePart;
}

interface GmailListResponse {
  messages?: { id: string; threadId: string }[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

interface GmailSendAs {
  sendAsEmail?: string;
  displayName?: string;
  isDefault?: boolean;
  isPrimary?: boolean;
  verificationStatus?: string;
}

interface GmailSendAsListResponse {
  sendAs?: GmailSendAs[];
}

interface GmailDraftListResponse {
  drafts?: { id: string; message?: { id?: string; threadId?: string } }[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

interface GmailDraft {
  id: string;
  message?: GmailMessage;
}

// Gmail message/thread/draft IDs are hex strings in practice, but this is deliberately a
// little more permissive while still rejecting anything that could act as a path
// separator or traversal segment when interpolated into a Gmail API URL path.
const GMAIL_ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;

export class InvalidGmailIdError extends Error {
  constructor(kind: string, id: string) {
    super(`Invalid Gmail ${kind} ID: "${id}".`);
  }
}

export class InvalidMessageIdError extends InvalidGmailIdError {
  constructor(messageId: string) {
    super('message', messageId);
  }
}

/**
 * Validates AND percent-encodes a caller-supplied Gmail id before it is
 * interpolated into a request path. Defense in depth against path-segment
 * injection (e.g. "../settings/forwardingAddresses") reaching a Gmail API
 * endpoint other than the one a tool is meant to call — validated here even
 * though callers also validate at the MCP tool-schema layer, because message
 * IDs can originate from email content an LLM just read (indirect prompt
 * injection), not only from a manually typed argument.
 */
function encodeGmailId(id: string, kind: 'message' | 'draft'): string {
  if (!GMAIL_ID_PATTERN.test(id)) {
    throw new InvalidGmailIdError(kind, id);
  }
  return encodeURIComponent(id);
}

export class GmailApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function gmailFetch<T>(
  client: OAuth2Client,
  path: string,
  params: Record<string, string | number | string[] | undefined>,
  request: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown } = {},
): Promise<T> {
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Failed to obtain a Gmail access token.');

  const url = new URL(`${GMAIL_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, item);
    } else {
      url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  const body = request.body === undefined ? undefined : JSON.stringify(request.body);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method: request.method ?? 'GET', headers, body });
  if (!res.ok) {
    let detail = '';
    try {
      const errBody = (await res.json()) as { error?: { message?: string } };
      const gmailMessage = errBody?.error?.message;
      if (typeof gmailMessage === 'string' && gmailMessage.length > 0 && gmailMessage.length < 300) {
        detail = `: ${gmailMessage}`;
      }
    } catch {
      // Keep the generic status error when the body isn't JSON.
    }
    throw new GmailApiError(`Gmail API request to ${path} failed with HTTP ${res.status}${detail}`, res.status);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

function headerLookup(headers: GmailHeader[] | undefined, name: string): string {
  const found = headers?.find((h) => (h.name ?? '').toLowerCase() === name.toLowerCase());
  return found?.value ?? '';
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

export interface AttachmentMeta {
  filename: string;
  mimeType: string;
  sizeEstimate?: number;
}

interface ExtractedBody {
  text?: string;
  html?: string;
  attachments: AttachmentMeta[];
}

/** Recursively walks a (possibly multipart) message payload for the body text/html and attachment metadata. */
function extractBody(payload: GmailMessagePart | undefined): ExtractedBody {
  const result: ExtractedBody = { attachments: [] };

  function walk(part: GmailMessagePart | undefined): void {
    if (!part) return;
    if (part.filename) {
      result.attachments.push({
        filename: part.filename,
        mimeType: part.mimeType ?? 'application/octet-stream',
        sizeEstimate: part.body?.size,
      });
    }
    if (part.mimeType === 'text/plain' && part.body?.data && result.text === undefined) {
      result.text = decodeBase64Url(part.body.data);
    } else if (part.mimeType === 'text/html' && part.body?.data && result.html === undefined) {
      result.html = decodeBase64Url(part.body.data);
    }
    for (const child of part.parts ?? []) walk(child);
  }

  walk(payload);
  return result;
}

export interface SearchResultItem {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
}

const METADATA_HEADERS = ['From', 'To', 'Subject', 'Date'];
const REPLY_HEADERS = ['From', 'To', 'Cc', 'Delivered-To', 'Reply-To', 'Subject', 'Message-ID', 'References'];

export async function searchMessages(
  refreshToken: string,
  query: string,
  maxResults: number,
): Promise<SearchResultItem[]> {
  const client = clientForRefreshToken(refreshToken);
  const capped = Math.min(Math.max(Math.floor(maxResults), 1), 50);

  const list = await gmailFetch<GmailListResponse>(client, '/messages', { q: query, maxResults: capped });
  const ids = list.messages ?? [];

  const messages = await Promise.all(
    ids.map((m) =>
      gmailFetch<GmailMessage>(client, `/messages/${encodeGmailId(m.id, 'message')}`, {
        format: 'metadata',
        metadataHeaders: METADATA_HEADERS,
      }),
    ),
  );

  return messages.map((msg) => ({
    id: msg.id,
    threadId: msg.threadId,
    from: headerLookup(msg.payload?.headers, 'From'),
    to: headerLookup(msg.payload?.headers, 'To'),
    subject: headerLookup(msg.payload?.headers, 'Subject'),
    date: headerLookup(msg.payload?.headers, 'Date'),
    snippet: msg.snippet ?? '',
  }));
}

export interface FullMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  from: string;
  to: string;
  cc: string;
  replyTo: string;
  deliveredTo: string;
  subject: string;
  date: string;
  snippet: string;
  body: { text?: string; html?: string };
  attachments: AttachmentMeta[];
}

export async function getMessage(refreshToken: string, messageId: string): Promise<FullMessage> {
  const client = clientForRefreshToken(refreshToken);
  const msg = await gmailFetch<GmailMessage>(client, `/messages/${encodeGmailId(messageId, 'message')}`, {
    format: 'full',
  });
  const body = extractBody(msg.payload);

  return {
    id: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds ?? [],
    from: headerLookup(msg.payload?.headers, 'From'),
    to: headerLookup(msg.payload?.headers, 'To'),
    cc: headerLookup(msg.payload?.headers, 'Cc'),
    replyTo: headerLookup(msg.payload?.headers, 'Reply-To'),
    deliveredTo: headerLookup(msg.payload?.headers, 'Delivered-To'),
    subject: headerLookup(msg.payload?.headers, 'Subject'),
    date: headerLookup(msg.payload?.headers, 'Date'),
    snippet: msg.snippet ?? '',
    body: { text: body.text, html: body.html },
    attachments: body.attachments,
  };
}

export interface GmailWriteResult {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  from?: string;
}

export interface GmailDraftResult {
  id?: string;
  message?: GmailWriteResult;
  from?: string;
}

export interface DraftListItem {
  draftId: string;
  messageId?: string;
  threadId?: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  snippet: string;
}

async function listSendAs(client: OAuth2Client): Promise<SendAsAlias[]> {
  const res = await gmailFetch<GmailSendAsListResponse>(client, '/settings/sendAs', {});
  return (res.sendAs ?? [])
    .filter((a): a is GmailSendAs & { sendAsEmail: string } => Boolean(a.sendAsEmail))
    .map((a) => ({
      sendAsEmail: a.sendAsEmail,
      displayName: a.displayName,
      isDefault: a.isDefault,
      isPrimary: a.isPrimary,
      verificationStatus: a.verificationStatus,
    }));
}

function replyOriginalFromMessage(msg: GmailMessage): ReplyOriginal {
  return {
    threadId: msg.threadId,
    from: headerLookup(msg.payload?.headers, 'From'),
    replyTo: headerLookup(msg.payload?.headers, 'Reply-To'),
    to: headerLookup(msg.payload?.headers, 'To'),
    cc: headerLookup(msg.payload?.headers, 'Cc'),
    deliveredTo: headerLookup(msg.payload?.headers, 'Delivered-To'),
    subject: headerLookup(msg.payload?.headers, 'Subject'),
    messageIdHeader: headerLookup(msg.payload?.headers, 'Message-ID'),
    references: headerLookup(msg.payload?.headers, 'References'),
  };
}

async function fetchReplyOriginal(client: OAuth2Client, messageId: string): Promise<ReplyOriginal> {
  const msg = await gmailFetch<GmailMessage>(client, `/messages/${encodeGmailId(messageId, 'message')}`, {
    format: 'metadata',
    metadataHeaders: REPLY_HEADERS,
  });
  return replyOriginalFromMessage(msg);
}

async function prepareOutbound(
  client: OAuth2Client,
  input: ComposeMessageInput,
  requireRecipient: boolean,
): Promise<{ raw: string; threadId?: string; fromAddress?: string }> {
  const needsSendAs = Boolean(input.from || input.replyToMessageId);
  const original = input.replyToMessageId ? await fetchReplyOriginal(client, input.replyToMessageId) : undefined;
  const sendAs = needsSendAs ? await listSendAs(client) : [];
  return resolveCompose(input, { requireRecipient, original, sendAs });
}

export async function sendMessage(refreshToken: string, input: ComposeMessageInput): Promise<GmailWriteResult> {
  const client = clientForRefreshToken(refreshToken);
  const prepared = await prepareOutbound(client, input, true);
  const sent = await gmailFetch<GmailWriteResult>(
    client,
    '/messages/send',
    {},
    {
      method: 'POST',
      body: { raw: prepared.raw, ...(prepared.threadId ? { threadId: prepared.threadId } : {}) },
    },
  );
  return { ...sent, from: prepared.fromAddress };
}

export async function createDraft(refreshToken: string, input: ComposeMessageInput): Promise<GmailDraftResult> {
  const client = clientForRefreshToken(refreshToken);
  const prepared = await prepareOutbound(client, input, false);
  const draft = await gmailFetch<GmailDraftResult>(
    client,
    '/drafts',
    {},
    {
      method: 'POST',
      body: {
        message: { raw: prepared.raw, ...(prepared.threadId ? { threadId: prepared.threadId } : {}) },
      },
    },
  );
  return { ...draft, from: prepared.fromAddress };
}

export async function listDrafts(refreshToken: string, maxResults: number): Promise<DraftListItem[]> {
  const client = clientForRefreshToken(refreshToken);
  const capped = Math.min(Math.max(Math.floor(maxResults), 1), 50);
  const list = await gmailFetch<GmailDraftListResponse>(client, '/drafts', { maxResults: capped });
  const drafts = list.drafts ?? [];

  const hydrated = await Promise.all(
    drafts.map(async (d) => {
      const full = await gmailFetch<GmailDraft>(client, `/drafts/${encodeGmailId(d.id, 'draft')}`, {
        format: 'full',
      });
      const headers = full.message?.payload?.headers;
      return {
        draftId: full.id,
        messageId: full.message?.id,
        threadId: full.message?.threadId,
        from: headerLookup(headers, 'From'),
        to: headerLookup(headers, 'To'),
        cc: headerLookup(headers, 'Cc'),
        subject: headerLookup(headers, 'Subject'),
        date: headerLookup(headers, 'Date'),
        snippet: full.message?.snippet ?? '',
      };
    }),
  );

  return hydrated;
}

export async function deleteDraft(refreshToken: string, draftId: string): Promise<void> {
  await gmailFetch<void>(
    clientForRefreshToken(refreshToken),
    `/drafts/${encodeGmailId(draftId, 'draft')}`,
    {},
    { method: 'DELETE' },
  );
}
