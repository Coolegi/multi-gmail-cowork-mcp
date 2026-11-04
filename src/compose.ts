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
  /** All Delivered-To header values, joined. Gmail often lists the primary first. */
  deliveredTo?: string;
  subject: string;
  /** RFC 5322 Message-ID header of the original, if present. */
  messageIdHeader?: string;
  references?: string;
  /** RFC 5322 In-Reply-To header of the original, if present. */
  inReplyToHeader?: string;
}

export interface ResolvedCompose {
  raw: string;
  threadId?: string;
  /**
   * The send-as email Gmail is expected to use: the chosen From, or the
   * account's default send-as when no From header is set.
   */
  fromAddress?: string;
}

export class UnknownSendAsError extends Error {
  readonly availableCount: number;
  readonly available: string[];

  constructor(from: string, available: string[]) {
    const listed = available.length > 0 ? available.join(', ') : '(none returned by Gmail)';
    super(`from address "${from}" is not a send-as alias on this Gmail account. Use one of: ${listed}.`);
    this.name = 'UnknownSendAsError';
    this.available = available;
    this.availableCount = available.length;
  }
}

export class UnverifiedSendAsError extends Error {
  constructor(from: string) {
    super(
      `from address "${from}" is a send-as alias on this account but is not verified. ` +
        'Gmail would ignore it and send from the default address. Verify the alias in Gmail settings, or pick a verified send-as.',
    );
    this.name = 'UnverifiedSendAsError';
  }
}

export function rejectHeaderInjection(value: string, field: string): void {
  if (/[\r\n]/.test(value)) throw new Error(`${field} must not contain line breaks.`);
}

const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/;

function unfoldHeader(value: string): string {
  return value.replace(/\r\n[ \t]+/g, ' ').replace(/[\r\n]+/g, ' ');
}

/**
 * Email addresses in a header.
 * Prefers angle-addr (`<user@host>`) so a quoted display name like
 * `"john@x.com via List" <list@y.com>` yields list@y.com. Falls back to bare
 * addresses only when no angle-addr is present. Quoted strings are skipped.
 */
export function extractEmails(header: string | undefined): string[] {
  if (!header) return [];
  const unfolded = unfoldHeader(header);
  const angle: string[] = [];
  const bare: string[] = [];
  let i = 0;
  let inQuote = false;

  while (i < unfolded.length) {
    const c = unfolded[i]!;
    if (inQuote) {
      if (c === '\\' && i + 1 < unfolded.length) {
        i += 2;
        continue;
      }
      if (c === '"') inQuote = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuote = true;
      i += 1;
      continue;
    }
    if (c === '<') {
      const end = unfolded.indexOf('>', i + 1);
      if (end === -1) {
        i += 1;
        continue;
      }
      const inner = unfolded.slice(i + 1, end);
      const match = inner.match(EMAIL_RE);
      if (match) angle.push(match[0]);
      i = end + 1;
      continue;
    }
    const rest = unfolded.slice(i);
    const match = rest.match(EMAIL_RE);
    if (match && match.index === 0) {
      bare.push(match[0]);
      i += match[0].length;
      continue;
    }
    i += 1;
  }

  return uniquePreserve(angle.length > 0 ? angle : bare);
}

/**
 * Lowercase, strip +tags from the local part, and for gmail.com/googlemail.com
 * ignore dots in the local part so plus/dot aliases still match sendAs.
 */
export function normalizeEmailForMatch(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return trimmed;
  let local = trimmed.slice(0, at);
  let domain = trimmed.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus >= 0) local = local.slice(0, plus);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

function emailsMatch(a: string, b: string): boolean {
  return normalizeEmailForMatch(a) === normalizeEmailForMatch(b);
}

function uniquePreserve(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Prefixes English "Re:" when missing. Does not treat localized prefixes
 * (Odp:, AW:, Sv:) or forward prefixes (Fwd:, FW:, Fw:) as already-replied.
 */
export function prefixRe(subject: string): string {
  const trimmed = subject.trim();
  if (trimmed === '') return 'Re:';
  if (/^re\s*:/i.test(trimmed)) return trimmed;
  return `Re: ${trimmed}`;
}

function uniqueExact(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

export function extractMessageIds(value: string | undefined): string[] {
  if (!value) return [];
  const unfolded = unfoldHeader(value);
  const tokens = unfolded.match(/<[^<>\s]+>/g) ?? [];
  if (tokens.length > 0) return uniqueExact(tokens);
  const compact = unfolded.replace(/\s+/g, '').trim();
  if (/^[^<>\s]+@[^<>\s]+$/.test(compact)) return [`<${compact}>`];
  return [];
}

export function ensureAngleBrackets(id: string): string {
  const tokens = extractMessageIds(id);
  if (tokens.length > 0) return tokens[0]!;
  const trimmed = unfoldHeader(id).trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) return trimmed;
  return `<${trimmed}>`;
}

/**
 * RFC 5322 3.6.4: parent's References, or if none its In-Reply-To, then the
 * parent's Message-ID. Whitespace/folding is ignored; only <...> tokens kept.
 */
export function buildReferences(
  existing: string | undefined,
  messageId: string | undefined,
  inReplyTo?: string,
): string | undefined {
  const prior = extractMessageIds(existing);
  const fallback = prior.length > 0 ? prior : extractMessageIds(inReplyTo);
  const parent = extractMessageIds(messageId);
  const ids = uniqueExact([...fallback, ...parent]);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

const RFC2047_CHUNK = 45;

/**
 * RFC 2047 encoded-words in ~45-byte UTF-8 chunks (never mid-character),
 * folded with CRLF+space so each header line stays well under 998 chars.
 */
export function encodeRfc2047(text: string): string {
  const buf = Buffer.from(text, 'utf8');
  const words: string[] = [];
  let i = 0;
  while (i < buf.length) {
    let end = Math.min(i + RFC2047_CHUNK, buf.length);
    while (end > i && (buf[end]! & 0xc0) === 0x80) end -= 1;
    if (end === i) end = Math.min(i + 1, buf.length);
    words.push(`=?UTF-8?B?${buf.subarray(i, end).toString('base64')}?=`);
    i = end;
  }
  return words.join('\r\n ');
}

export function formatMailbox(displayName: string | undefined, email: string): string {
  rejectHeaderInjection(email, 'from');
  if (!displayName || displayName.trim() === '') return email;
  const name = displayName.trim();
  rejectHeaderInjection(name, 'from');
  if (!/^[\x20-\x7e]*$/.test(name)) {
    return `${encodeRfc2047(name)} <${email}>`;
  }
  if (/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/.test(name)) {
    return `${name} <${email}>`;
  }
  return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" <${email}>`;
}

export function isUsableSendAs(alias: SendAsAlias): boolean {
  if (alias.isPrimary || alias.isDefault) return true;
  const status = (alias.verificationStatus ?? 'accepted').toLowerCase();
  return status === 'accepted' || status === '';
}

export function defaultSendAs(sendAs: SendAsAlias[]): SendAsAlias | undefined {
  const usable = sendAs.filter(isUsableSendAs);
  const pool = usable.length > 0 ? usable : sendAs;
  return pool.find((a) => a.isDefault) ?? pool.find((a) => a.isPrimary) ?? pool[0];
}

function findMatchingSendAs(pool: SendAsAlias[], email: string): SendAsAlias | undefined {
  return pool.find((a) => emailsMatch(a.sendAsEmail, email));
}

function isOwnAddress(sendAs: SendAsAlias[], email: string): boolean {
  return sendAs.some((a) => emailsMatch(a.sendAsEmail, email));
}

/**
 * Choose the send-as identity the original message arrived at.
 * Candidates: To, then Cc, then every Delivered-To value. Prefer a match that
 * is not the primary/default address (the alias), then any match, then default.
 *
 * Delivered-To is last because Gmail typically prepends Delivered-To with the
 * account's primary gmail.com address even when the user was addressed at an alias.
 */
export function pickSendAsForReply(sendAs: SendAsAlias[], original: ReplyOriginal): SendAsAlias | undefined {
  const usable = sendAs.filter(isUsableSendAs);
  const pool = usable.length > 0 ? usable : sendAs;
  const candidates = uniquePreserve([
    ...extractEmails(original.to),
    ...extractEmails(original.cc),
    ...extractEmails(original.deliveredTo),
  ]);

  const firstMatch = (predicate: (alias: SendAsAlias) => boolean): SendAsAlias | undefined => {
    for (const email of candidates) {
      const match = pool.find((a) => emailsMatch(a.sendAsEmail, email) && predicate(a));
      if (match) return match;
    }
    return undefined;
  };

  return (
    firstMatch((a) => !a.isPrimary && !a.isDefault) ?? firstMatch(() => true) ?? defaultSendAs(sendAs)
  );
}

export function findSendAs(sendAs: SendAsAlias[], from: string): SendAsAlias {
  rejectHeaderInjection(from, 'from');
  const emails = extractEmails(from);
  if (emails.length !== 1) {
    throw new Error('from must be a single email address that matches a send-as alias on this account.');
  }
  const email = emails[0]!;
  const match = sendAs.find((a) => emailsMatch(a.sendAsEmail, email));
  const usableListed = sendAs.filter(isUsableSendAs).map((a) => a.sendAsEmail);
  if (!match) {
    throw new UnknownSendAsError(email, usableListed);
  }
  if (!isUsableSendAs(match)) {
    throw new UnverifiedSendAsError(match.sendAsEmail);
  }
  return match;
}

function encodeSubject(subject: string): string {
  rejectHeaderInjection(subject, 'subject');
  if (/^[\x20-\x7e]*$/.test(subject)) return foldHeaderValue('Subject', subject);
  return encodeRfc2047(subject);
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

/** Fold a header *value* so "Name: value" lines stay under 998 characters. */
export function foldHeaderValue(fieldName: string, value: string): string {
  const MAX = 998;
  if (value.includes('\r\n')) return value;
  const tokens = value.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return value;
  const firstBudget = MAX - fieldName.length - 2;
  const contBudget = MAX - 1;
  const lines: string[] = [];
  let line = '';
  let budget = firstBudget;
  for (const token of tokens) {
    if (line.length === 0) {
      line = token;
      continue;
    }
    if (line.length + 1 + token.length <= budget) {
      line += ` ${token}`;
    } else {
      lines.push(line);
      line = token;
      budget = contBudget;
    }
  }
  if (line) lines.push(line);
  return lines.join('\r\n ');
}

export function buildRawMime(
  headers: {
    from?: string;
    to?: string;
    cc?: string;
    bcc?: string;
    subject: string;
    inReplyTo?: string;
    references?: string;
  },
  body: string,
): string {
  if (body.length > 100_000) throw new Error('body is too large (maximum 100,000 characters).');
  const normalizedBody = body.replace(/\r\n?|\n/g, '\r\n');
  const inReplyTo = headers.inReplyTo ? foldHeaderValue('In-Reply-To', headers.inReplyTo) : undefined;
  const references = headers.references ? foldHeaderValue('References', headers.references) : undefined;
  const lines = [
    ...(headers.from ? [`From: ${headers.from}`] : []),
    ...(headers.to ? [`To: ${headers.to}`] : []),
    ...(headers.cc ? [`Cc: ${headers.cc}`] : []),
    ...(headers.bcc ? [`Bcc: ${headers.bcc}`] : []),
    `Subject: ${encodeSubject(headers.subject)}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ];
  for (const line of lines.join('\r\n').split('\r\n')) {
    if (line.length > 998) throw new Error(`MIME header line exceeds 998 characters (${line.length}).`);
  }
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n${normalizedBody}`, 'utf8').toString('base64url');
}

export interface ResolveComposeOptions {
  requireRecipient: boolean;
  original?: ReplyOriginal;
  sendAs: SendAsAlias[];
}

function ownSentAlias(sendAs: SendAsAlias[], original: ReplyOriginal): SendAsAlias | undefined {
  const usable = sendAs.filter(isUsableSendAs);
  const pool = usable.length > 0 ? usable : sendAs;
  for (const email of extractEmails(original.from)) {
    const match = findMatchingSendAs(pool, email);
    if (match) return match;
  }
  return undefined;
}

function joinEmails(emails: string[]): string | undefined {
  return emails.length > 0 ? emails.join(', ') : undefined;
}

/**
 * Resolve recipients, From, threading headers, and MIME for a send or draft.
 *
 * Backwards compatible: with no `from` and no original message, no From header
 * is added and Gmail uses the account's default send-as as it always has.
 *
 * Replies to a *received* message go to the sender (Reply-To / From) only —
 * this is not reply-all. Following up on a message this account itself sent
 * reuses that From alias and addresses the original To (and Cc, minus us).
 */
export function resolveCompose(input: ComposeMessageInput, options: ResolveComposeOptions): ResolvedCompose {
  let chosen: SendAsAlias | undefined;
  let defaultTo: string | undefined;
  let defaultCc: string | undefined;
  let setFromHeader = Boolean(input.from);

  if (options.original) {
    const sentAs = ownSentAlias(options.sendAs, options.original);
    if (sentAs) {
      chosen = sentAs;
      setFromHeader = true;
      const toOthers = extractEmails(options.original.to).filter((e) => !isOwnAddress(options.sendAs, e));
      const ccOthers = extractEmails(options.original.cc).filter((e) => !isOwnAddress(options.sendAs, e));
      defaultTo = joinEmails(toOthers.length > 0 ? toOthers : extractEmails(options.original.to));
      defaultCc = joinEmails(ccOthers);
    } else {
      chosen = pickSendAsForReply(options.sendAs, options.original);
      setFromHeader = true;
      const replyToAddrs = extractEmails(options.original.replyTo);
      defaultTo = joinEmails(replyToAddrs.length > 0 ? replyToAddrs : extractEmails(options.original.from));
    }
  }

  if (input.from) {
    chosen = findSendAs(options.sendAs, input.from);
    setFromHeader = true;
  }

  const resolvedTo = input.to ?? defaultTo;
  if (!resolvedTo && options.requireRecipient && options.original) {
    throw new Error('Could not determine a recipient from the original message. Pass to explicitly.');
  }

  const to = normalizeRecipients(resolvedTo, 'to', options.requireRecipient);
  const cc = normalizeRecipients(input.cc ?? defaultCc, 'cc', false);
  const bcc = normalizeRecipients(input.bcc, 'bcc', false);

  const explicitSubject = input.subject?.trim();
  const baseSubject = explicitSubject || options.original?.subject || '';
  const subject = options.original ? prefixRe(baseSubject) : (input.subject ?? '');

  let inReplyTo: string | undefined;
  let references: string | undefined;
  if (options.original) {
    const parentIds = extractMessageIds(options.original.messageIdHeader);
    if (parentIds.length > 0) {
      inReplyTo = parentIds.join(' ');
      references = buildReferences(
        options.original.references,
        options.original.messageIdHeader,
        options.original.inReplyToHeader,
      );
    }
  }

  const fromHeader = setFromHeader && chosen ? formatMailbox(chosen.displayName, chosen.sendAsEmail) : undefined;
  const reportedFrom = chosen?.sendAsEmail ?? defaultSendAs(options.sendAs)?.sendAsEmail;

  return {
    raw: buildRawMime(
      { from: fromHeader, to, cc, bcc, subject, inReplyTo, references },
      input.body,
    ),
    threadId: options.original?.threadId,
    fromAddress: reportedFrom,
  };
}
