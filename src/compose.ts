/**
 * MIME construction and reply/send-as resolution. Pure functions so the Gmail
 * API layer can stay thin and the matching rules can be unit-tested without
 * talking to Google.
 */

export interface ComposeMessageInput {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body: string;
  /** Explicit send-as address; must match an account alias when sendAs is provided. */
  from?: string;
  /** Gmail API message id of the message being replied to (not the RFC Message-ID). */
  replyToMessageId?: string;
}

export interface SendAsAlias {
  sendAsEmail: string;
  displayName?: string;
  isDefault?: boolean;
  isPrimary?: boolean;
  verificationStatus?: string;
}

export interface ReplyOriginal {
  threadId: string;
  from: string;
  replyTo?: string;
  to: string;
  cc: string;
  deliveredTo?: string;
  subject: string;
  /** RFC 5322 Message-ID header of the original, if present. */
  messageIdHeader?: string;
  references?: string;
}

export interface ResolvedCompose {
  raw: string;
  threadId?: string;
  /** The send-as email actually used, when a From header was set. */
  fromAddress?: string;
}

export class UnknownSendAsError extends Error {
  constructor(from: string, available: string[]) {
    const listed = available.length > 0 ? available.join(', ') : '(none returned by Gmail)';
    super(`from address "${from}" is not a send-as alias on this Gmail account. Use one of: ${listed}.`);
    this.name = 'UnknownSendAsError';
  }
}

export function rejectHeaderInjection(value: string, field: string): void {
  if (/[\r\n]/.test(value)) throw new Error(`${field} must not contain line breaks.`);
}

/** Email addresses appearing in a header, in order. Display names are ignored. */
export function extractEmails(header: string | undefined): string[] {
  if (!header) return [];
  return header.match(/[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+/g) ?? [];
}

export function prefixRe(subject: string): string {
  const trimmed = subject.trim();
  if (trimmed === '') return 'Re:';
  if (/^re\s*:/i.test(trimmed)) return trimmed;
  return `Re: ${trimmed}`;
}

export function ensureAngleBrackets(id: string): string {
  const trimmed = id.trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) return trimmed;
  return `<${trimmed}>`;
}

export function buildReferences(existing: string | undefined, messageId: string | undefined): string | undefined {
  if (!messageId?.trim()) return existing?.trim() || undefined;
  const id = ensureAngleBrackets(messageId);
  rejectHeaderInjection(id, 'References');
  const prior = (existing ?? '').trim();
  if (!prior) return id;
  rejectHeaderInjection(prior, 'References');
  if (prior.includes(id)) return prior;
  return `${prior} ${id}`;
}

export function formatMailbox(displayName: string | undefined, email: string): string {
  rejectHeaderInjection(email, 'from');
  if (!displayName || displayName.trim() === '') return email;
  const name = displayName.trim();
  rejectHeaderInjection(name, 'from');
  if (!/^[\x20-\x7e]*$/.test(name)) {
    return `=?UTF-8?B?${Buffer.from(name, 'utf8').toString('base64')}?= <${email}>`;
  }
  if (/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/.test(name)) {
    return `${name} <${email}>`;
  }
  return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" <${email}>`;
}

function isUsableSendAs(alias: SendAsAlias): boolean {
  if (alias.isPrimary || alias.isDefault) return true;
  const status = (alias.verificationStatus ?? 'accepted').toLowerCase();
  return status === 'accepted' || status === '';
}

export function defaultSendAs(sendAs: SendAsAlias[]): SendAsAlias | undefined {
  const usable = sendAs.filter(isUsableSendAs);
  const pool = usable.length > 0 ? usable : sendAs;
  return pool.find((a) => a.isDefault) ?? pool.find((a) => a.isPrimary) ?? pool[0];
}

/**
 * Choose the send-as identity the original message arrived at.
 * Preference: Delivered-To, then To, then Cc; otherwise the account default.
 */
export function pickSendAsForReply(sendAs: SendAsAlias[], original: ReplyOriginal): SendAsAlias | undefined {
  const usable = sendAs.filter(isUsableSendAs);
  const pool = usable.length > 0 ? usable : sendAs;
  const candidates = [
    ...extractEmails(original.deliveredTo),
    ...extractEmails(original.to),
    ...extractEmails(original.cc),
  ];
  for (const email of candidates) {
    const match = pool.find((a) => a.sendAsEmail.toLowerCase() === email.toLowerCase());
    if (match) return match;
  }
  return defaultSendAs(sendAs);
}

export function findSendAs(sendAs: SendAsAlias[], from: string): SendAsAlias {
  rejectHeaderInjection(from, 'from');
  const emails = extractEmails(from);
  if (emails.length !== 1) {
    throw new Error('from must be a single email address that matches a send-as alias on this account.');
  }
  const email = emails[0]!;
  const match = sendAs.find((a) => a.sendAsEmail.toLowerCase() === email.toLowerCase());
  if (!match) {
    throw new UnknownSendAsError(
      email,
      sendAs.map((a) => a.sendAsEmail),
    );
  }
  return match;
}

function encodeSubject(subject: string): string {
  rejectHeaderInjection(subject, 'subject');
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

export function normalizeRecipients(value: string | undefined, field: string, required: boolean): string | undefined {
  if (!value) {
    if (required) throw new Error(`${field} is required.`);
    return undefined;
  }
  rejectHeaderInjection(value, field);
  const recipients = value
    .split(',')
    .map((recipient) => recipient.trim())
    .filter(Boolean);
  if (recipients.length === 0 || recipients.some((recipient) => !/^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/.test(recipient))) {
    throw new Error(`${field} must contain one or more comma-separated email addresses.`);
  }
  return recipients.join(', ');
}

export function buildRawMime(headers: {
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject: string;
  inReplyTo?: string;
  references?: string;
}, body: string): string {
  if (body.length > 100_000) throw new Error('body is too large (maximum 100,000 characters).');
  if (headers.from) rejectHeaderInjection(headers.from, 'from');
  if (headers.inReplyTo) rejectHeaderInjection(headers.inReplyTo, 'In-Reply-To');
  if (headers.references) rejectHeaderInjection(headers.references, 'References');
  const normalizedBody = body.replace(/\r\n?|\n/g, '\r\n');
  const lines = [
    ...(headers.from ? [`From: ${headers.from}`] : []),
    ...(headers.to ? [`To: ${headers.to}`] : []),
    ...(headers.cc ? [`Cc: ${headers.cc}`] : []),
    ...(headers.bcc ? [`Bcc: ${headers.bcc}`] : []),
    `Subject: ${encodeSubject(headers.subject)}`,
    ...(headers.inReplyTo ? [`In-Reply-To: ${headers.inReplyTo}`] : []),
    ...(headers.references ? [`References: ${headers.references}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ];
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n${normalizedBody}`, 'utf8').toString('base64url');
}

export interface ResolveComposeOptions {
  requireRecipient: boolean;
  original?: ReplyOriginal;
  sendAs: SendAsAlias[];
}

/**
 * Resolve recipients, From, threading headers, and MIME for a send or draft.
 *
 * Backwards compatible: with no `from` and no original message, no From header
 * is added and Gmail uses the account's default send-as as it always has.
 */
export function resolveCompose(input: ComposeMessageInput, options: ResolveComposeOptions): ResolvedCompose {
  let chosen: SendAsAlias | undefined;
  if (options.original) {
    chosen = pickSendAsForReply(options.sendAs, options.original);
  }
  if (input.from) {
    chosen = findSendAs(options.sendAs, input.from);
  }

  const defaultTo = options.original
    ? (extractEmails(options.original.replyTo)[0] ?? extractEmails(options.original.from)[0])
    : undefined;
  const resolvedTo = input.to ?? defaultTo;
  if (!resolvedTo) {
    if (options.requireRecipient && options.original) {
      throw new Error('Could not determine a recipient from the original message. Pass to explicitly.');
    }
  }

  const to = normalizeRecipients(resolvedTo, 'to', options.requireRecipient);
  const cc = normalizeRecipients(input.cc, 'cc', false);
  const bcc = normalizeRecipients(input.bcc, 'bcc', false);

  const explicitSubject = input.subject?.trim();
  const baseSubject = explicitSubject || options.original?.subject || '';
  const subject = options.original ? prefixRe(baseSubject) : (input.subject ?? '');

  let inReplyTo: string | undefined;
  let references: string | undefined;
  if (options.original?.messageIdHeader?.trim()) {
    inReplyTo = ensureAngleBrackets(options.original.messageIdHeader);
    references = buildReferences(options.original.references, options.original.messageIdHeader);
  }

  const fromHeader = chosen ? formatMailbox(chosen.displayName, chosen.sendAsEmail) : undefined;

  return {
    raw: buildRawMime(
      { from: fromHeader, to, cc, bcc, subject, inReplyTo, references },
      input.body,
    ),
    threadId: options.original?.threadId,
    fromAddress: chosen?.sendAsEmail,
  };
}
