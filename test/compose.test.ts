import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildReferences,
  encodeRfc2047,
  extractEmails,
  extractMessageIds,
  findSendAs,
  formatMailbox,
  normalizeEmailForMatch,
  pickSendAsForReply,
  prefixRe,
  resolveCompose,
  UnknownSendAsError,
  UnverifiedSendAsError,
  type ReplyOriginal,
  type SendAsAlias,
} from '../src/compose.js';

function decodeRaw(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8');
}

function decodeEncodedWords(value: string): string {
  return value
    .replace(/\r\n[ \t]+/g, '')
    .replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g, (_m, b64: string) => Buffer.from(b64, 'base64').toString('utf8'));
}

function headerBlock(raw: string): string {
  return decodeRaw(raw).split('\r\n\r\n')[0] ?? '';
}

function headerValue(raw: string, name: string): string {
  const block = headerBlock(raw);
  const lines = block.split('\r\n');
  const start = lines.findIndex((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}: `));
  if (start < 0) return '';
  let value = lines[start]!.slice(name.length + 2);
  for (let i = start + 1; i < lines.length; i++) {
    if (!/^[ \t]/.test(lines[i]!)) break;
    value += `\r\n${lines[i]}`;
  }
  return value;
}

const primary: SendAsAlias = {
  sendAsEmail: 'spulak.ondrej@gmail.com',
  displayName: 'Ondrej Spulak',
  isDefault: true,
  isPrimary: true,
  verificationStatus: 'accepted',
};

const alias: SendAsAlias = {
  sendAsEmail: 'mail@ondrejspulak.cz',
  displayName: 'Ondřej Špulák',
  isDefault: false,
  isPrimary: false,
  verificationStatus: 'accepted',
};

const pending: SendAsAlias = {
  sendAsEmail: 'pending@ondrejspulak.cz',
  displayName: 'Pending',
  verificationStatus: 'pending',
};

const originalToAlias: ReplyOriginal = {
  threadId: 'thread-abc',
  from: 'Client Name <client@example.com>',
  replyTo: '',
  to: 'Ondrej <mail@ondrejspulak.cz>',
  cc: 'cc-other@example.com',
  deliveredTo: 'spulak.ondrej@gmail.com, mail@ondrejspulak.cz',
  subject: 'Question about the quote',
  messageIdHeader: '<orig@mail.gmail.com>',
  references: '<first@mail.gmail.com>',
};

describe('extractEmails', () => {
  it('parses display-name mailboxes and bare addresses', () => {
    assert.deepEqual(extractEmails('Ondrej <mail@ondrejspulak.cz>'), ['mail@ondrejspulak.cz']);
    assert.deepEqual(extractEmails('a@x.com, b@y.com'), ['a@x.com', 'b@y.com']);
    assert.deepEqual(extractEmails('"Last, First" <first.last@example.com>'), ['first.last@example.com']);
    assert.deepEqual(extractEmails(''), []);
    assert.deepEqual(extractEmails(undefined), []);
  });

  it('prefers angle-addr over emails inside quoted display names', () => {
    assert.deepEqual(extractEmails('"john@x.com via List" <list@y.com>'), ['list@y.com']);
    assert.deepEqual(extractEmails('Contact "john@x.com" <list@y.com>'), ['list@y.com']);
  });

  it('does not capture stray quotes or brackets', () => {
    assert.deepEqual(extractEmails('"<not-an-addr>"'), []);
    assert.deepEqual(extractEmails('Name <mail@ondrejspulak.cz>'), ['mail@ondrejspulak.cz']);
  });
});

describe('normalizeEmailForMatch', () => {
  it('lowercases, strips plus-tags, and ignores gmail dots', () => {
    assert.equal(normalizeEmailForMatch('Mail+Invoices@Ondrejspulak.cz'), 'mail@ondrejspulak.cz');
    assert.equal(normalizeEmailForMatch('s.pulak.ondrej+tag@gmail.com'), 'spulakondrej@gmail.com');
    assert.equal(normalizeEmailForMatch('S.Pulak.Ondrej@googlemail.com'), 'spulakondrej@gmail.com');
  });
});

describe('prefixRe', () => {
  it('adds Re: when missing and does not duplicate it', () => {
    assert.equal(prefixRe('Hello'), 'Re: Hello');
    assert.equal(prefixRe('Re: Hello'), 'Re: Hello');
    assert.equal(prefixRe('RE: Hello'), 'RE: Hello');
    assert.equal(prefixRe('re:Hello'), 're:Hello');
    assert.equal(prefixRe('  re : already'), 're : already');
    assert.equal(prefixRe(''), 'Re:');
    assert.equal(prefixRe('  Fw: x'), 'Re: Fw: x');
    assert.equal(prefixRe('Odp: dotaz'), 'Re: Odp: dotaz');
    assert.equal(prefixRe('AW: Frage'), 'Re: AW: Frage');
  });
});

describe('extractMessageIds / buildReferences', () => {
  it('keeps only <...> tokens and unfolds folded values', () => {
    assert.deepEqual(extractMessageIds('<a@x>\r\n\t<b@x> extra'), ['<a@x>', '<b@x>']);
    assert.equal(buildReferences('<a@x>', 'b@x'), '<a@x> <b@x>');
    assert.equal(buildReferences('<a@x> <b@x>', '<b@x>'), '<a@x> <b@x>');
  });

  it('uses In-Reply-To when References is missing (RFC 5322 3.6.4)', () => {
    assert.equal(buildReferences(undefined, '<orig@x>', '<prev@x>'), '<prev@x> <orig@x>');
    assert.equal(buildReferences('<a@x>', '<orig@x>', '<prev@x>'), '<a@x> <orig@x>');
  });
});

describe('encodeRfc2047', () => {
  it('splits a long Czech subject into folded encoded-words under 998 chars', () => {
    const czech = 'Příliš žluťoučký kůň úpěl ďábelské ódy '.repeat(8).trim();
    const encoded = encodeRfc2047(czech);
    assert.match(encoded, /=\?UTF-8\?B\?/);
    assert.match(encoded, /\r\n /);
    assert.equal(decodeEncodedWords(encoded), czech);
    for (const line of `Subject: ${encoded}`.split('\r\n')) {
      assert.ok(line.length <= 998, `line length ${line.length}`);
    }
  });
});

describe('formatMailbox', () => {
  it('formats ASCII, quoted, and encoded-word display names', () => {
    assert.equal(formatMailbox(undefined, 'a@x.com'), 'a@x.com');
    assert.equal(formatMailbox('Ondrej Spulak', 'a@x.com'), 'Ondrej Spulak <a@x.com>');
    assert.equal(formatMailbox('Spulak, Ondrej', 'a@x.com'), '"Spulak, Ondrej" <a@x.com>');
    assert.match(formatMailbox('Ondřej', 'a@x.com'), /^=\?UTF-8\?B\?.+\?= <a@x.com>$/);
  });

  it('rejects header injection in the display name', () => {
    assert.throws(() => formatMailbox('Bad\nBcc: evil@x.com', 'a@x.com'), /line breaks/);
  });
});

describe('pickSendAsForReply', () => {
  const sendAs = [primary, alias, pending];

  it('prefers the alias in To when Delivered-To is the primary gmail address', () => {
    const chosen = pickSendAsForReply(sendAs, {
      ...originalToAlias,
      deliveredTo: 'spulak.ondrej@gmail.com',
      to: 'mail@ondrejspulak.cz',
    });
    assert.equal(chosen?.sendAsEmail, 'mail@ondrejspulak.cz');
  });

  it('uses Cc when To and Delivered-To do not match a non-default alias', () => {
    const chosen = pickSendAsForReply(sendAs, {
      ...originalToAlias,
      deliveredTo: 'spulak.ondrej@gmail.com',
      to: 'client@example.com',
      cc: 'mail@ondrejspulak.cz',
    });
    assert.equal(chosen?.sendAsEmail, 'mail@ondrejspulak.cz');
  });

  it('falls back to the default send-as when nothing matches', () => {
    const chosen = pickSendAsForReply(sendAs, {
      ...originalToAlias,
      deliveredTo: 'other@example.com',
      to: 'client@example.com',
      cc: '',
    });
    assert.equal(chosen?.sendAsEmail, 'spulak.ondrej@gmail.com');
  });

  it('skips unverified aliases when auto-picking', () => {
    const chosen = pickSendAsForReply(sendAs, {
      ...originalToAlias,
      deliveredTo: 'pending@ondrejspulak.cz',
      to: 'mail@ondrejspulak.cz',
    });
    assert.equal(chosen?.sendAsEmail, 'mail@ondrejspulak.cz');
  });

  it('matches plus-tagged and dotted gmail addresses to sendAs', () => {
    const plus = pickSendAsForReply(sendAs, {
      ...originalToAlias,
      deliveredTo: 'spulak.ondrej@gmail.com',
      to: 'mail+invoices@ondrejspulak.cz',
    });
    assert.equal(plus?.sendAsEmail, 'mail@ondrejspulak.cz');

    const dotted = pickSendAsForReply(sendAs, {
      ...originalToAlias,
      deliveredTo: '',
      to: 's.pulak.ondrej+tag@googlemail.com',
      cc: '',
    });
    assert.equal(dotted?.sendAsEmail, 'spulak.ondrej@gmail.com');
  });
});

describe('findSendAs', () => {
  it('matches a listed alias case-insensitively and extracts from a mailbox', () => {
    const found = findSendAs([primary, alias], 'Ondrej <MAIL@ondrejspulak.cz>');
    assert.equal(found.sendAsEmail, 'mail@ondrejspulak.cz');
  });

  it('matches plus-addressing against the canonical sendAs', () => {
    const found = findSendAs([primary, alias], 'mail+tag@ondrejspulak.cz');
    assert.equal(found.sendAsEmail, 'mail@ondrejspulak.cz');
  });

  it('rejects an address that is not a send-as alias', () => {
    assert.throws(
      () => findSendAs([primary, alias], 'unknown@example.com'),
      (err: unknown) => {
        assert.ok(err instanceof UnknownSendAsError);
        assert.match(err.message, /unknown@example.com/);
        assert.match(err.message, /spulak.ondrej@gmail.com/);
        assert.match(err.message, /mail@ondrejspulak.cz/);
        assert.equal(err.availableCount, 2);
        return true;
      },
    );
  });

  it('rejects an unverified send-as instead of letting Gmail rewrite From', () => {
    assert.throws(() => findSendAs([primary, alias, pending], 'pending@ondrejspulak.cz'), UnverifiedSendAsError);
  });
});

describe('resolveCompose', () => {
  it('omits From and threadId when not replying and from is not set (backwards compatible)', () => {
    const resolved = resolveCompose(
      { to: 'client@example.com', subject: 'Hi', body: 'Hello' },
      { requireRecipient: true, sendAs: [primary, alias] },
    );
    const mime = decodeRaw(resolved.raw);
    assert.equal(resolved.threadId, undefined);
    assert.equal(resolved.fromAddress, 'spulak.ondrej@gmail.com');
    assert.doesNotMatch(mime, /^From:/m);
    assert.doesNotMatch(mime, /^In-Reply-To:/m);
    assert.doesNotMatch(mime, /^References:/m);
    assert.match(mime, /^To: client@example.com/m);
    assert.match(mime, /^Subject: Hi/m);
    assert.match(mime, /\r\n\r\nHello$/);
  });

  it('replies in-thread from the arrival alias with Re:, In-Reply-To, and References', () => {
    const resolved = resolveCompose(
      { body: 'Thanks, here is the answer.' },
      { requireRecipient: true, original: originalToAlias, sendAs: [primary, alias] },
    );
    const mime = decodeRaw(resolved.raw);
    assert.equal(resolved.threadId, 'thread-abc');
    assert.equal(resolved.fromAddress, 'mail@ondrejspulak.cz');
    assert.match(mime, /^From: =\?UTF-8\?B\?.+\?= <mail@ondrejspulak.cz>/m);
    assert.match(mime, /^To: client@example.com/m);
    assert.doesNotMatch(mime, /^Cc:/m);
    assert.match(mime, /^Subject: Re: Question about the quote/m);
    assert.match(mime, /^In-Reply-To: <orig@mail.gmail.com>/m);
    assert.match(mime, /^References: <first@mail.gmail.com> <orig@mail.gmail.com>/m);
  });

  it('does not duplicate Re: on the default or an explicit subject', () => {
    const already = resolveCompose(
      { body: 'x' },
      {
        requireRecipient: true,
        original: { ...originalToAlias, subject: 'Re: already' },
        sendAs: [primary, alias],
      },
    );
    assert.match(decodeRaw(already.raw), /^Subject: Re: already/m);

    const explicit = resolveCompose(
      { subject: 'Re: custom', body: 'x' },
      { requireRecipient: true, original: originalToAlias, sendAs: [primary, alias] },
    );
    assert.match(decodeRaw(explicit.raw), /^Subject: Re: custom/m);

    const needsPrefix = resolveCompose(
      { subject: 'custom', body: 'x' },
      { requireRecipient: true, original: originalToAlias, sendAs: [primary, alias] },
    );
    assert.match(decodeRaw(needsPrefix.raw), /^Subject: Re: custom/m);
  });

  it('lets explicit to, subject, and from take precedence', () => {
    const resolved = resolveCompose(
      {
        to: 'other@example.com',
        subject: 'Override',
        body: 'x',
        from: 'spulak.ondrej@gmail.com',
      },
      { requireRecipient: true, original: originalToAlias, sendAs: [primary, alias] },
    );
    const mime = decodeRaw(resolved.raw);
    assert.equal(resolved.fromAddress, 'spulak.ondrej@gmail.com');
    assert.match(mime, /^From: Ondrej Spulak <spulak.ondrej@gmail.com>/m);
    assert.match(mime, /^To: other@example.com/m);
    assert.match(mime, /^Subject: Re: Override/m);
    assert.equal(resolved.threadId, 'thread-abc');
  });

  it('rejects an explicit from that is not a send-as alias', () => {
    assert.throws(
      () =>
        resolveCompose(
          { to: 'a@x.com', body: 'x', from: 'not-mine@example.com' },
          { requireRecipient: true, sendAs: [primary, alias] },
        ),
      UnknownSendAsError,
    );
  });

  it('defaults Reply-To over From for the recipient, including multiple addresses', () => {
    const single = resolveCompose(
      { body: 'x' },
      {
        requireRecipient: true,
        original: { ...originalToAlias, replyTo: 'desk@example.com' },
        sendAs: [primary, alias],
      },
    );
    assert.match(decodeRaw(single.raw), /^To: desk@example.com/m);

    const multi = resolveCompose(
      { body: 'x' },
      {
        requireRecipient: true,
        original: { ...originalToAlias, replyTo: 'desk@example.com, ops@example.com' },
        sendAs: [primary, alias],
      },
    );
    assert.match(decodeRaw(multi.raw), /^To: desk@example.com, ops@example.com/m);
  });

  it('when following up on mail this account sent, keeps that From and original To/Cc', () => {
    const resolved = resolveCompose(
      { body: 'one more thing' },
      {
        requireRecipient: true,
        original: {
          threadId: 'thread-sent',
          from: 'Ondřej <mail@ondrejspulak.cz>',
          to: 'Client <client@example.com>',
          cc: 'Partner <partner@example.com>, mail@ondrejspulak.cz',
          deliveredTo: 'spulak.ondrej@gmail.com',
          subject: 'Proposal',
          messageIdHeader: '<sent@mail.gmail.com>',
        },
        sendAs: [primary, alias],
      },
    );
    const mime = decodeRaw(resolved.raw);
    assert.equal(resolved.fromAddress, 'mail@ondrejspulak.cz');
    assert.match(mime, /^To: client@example.com/m);
    assert.match(mime, /^Cc: partner@example.com/m);
    assert.doesNotMatch(mime, /Cc: .*mail@ondrejspulak\.cz/);
  });

  it('allows drafts without a recipient', () => {
    const resolved = resolveCompose(
      { subject: 'WIP', body: 'notes' },
      { requireRecipient: false, sendAs: [] },
    );
    const mime = decodeRaw(resolved.raw);
    assert.doesNotMatch(mime, /^To:/m);
    assert.match(mime, /^Subject: WIP/m);
  });

  it('still requires to when sending a new message', () => {
    assert.throws(
      () => resolveCompose({ body: 'x' }, { requireRecipient: true, sendAs: [] }),
      /to is required/,
    );
  });

  it('still threads via threadId when the original has no Message-ID header', () => {
    const resolved = resolveCompose(
      { body: 'x' },
      {
        requireRecipient: true,
        original: { ...originalToAlias, messageIdHeader: '', references: '' },
        sendAs: [primary, alias],
      },
    );
    const mime = decodeRaw(resolved.raw);
    assert.equal(resolved.threadId, 'thread-abc');
    assert.doesNotMatch(mime, /^In-Reply-To:/m);
    assert.doesNotMatch(mime, /^References:/m);
  });

  it('normalizes folded References and fills them from In-Reply-To when missing', () => {
    const folded = resolveCompose(
      { body: 'x' },
      {
        requireRecipient: true,
        original: {
          ...originalToAlias,
          references: '<a@x>\r\n\t<b@x>',
          messageIdHeader: '<orig@mail.gmail.com>',
        },
        sendAs: [primary, alias],
      },
    );
    assert.match(decodeRaw(folded.raw), /^References: <a@x> <b@x> <orig@mail.gmail.com>/m);

    const fromInReplyTo = resolveCompose(
      { body: 'x' },
      {
        requireRecipient: true,
        original: {
          ...originalToAlias,
          references: '',
          inReplyToHeader: '<prev@mail.gmail.com>',
          messageIdHeader: '<orig@mail.gmail.com>',
        },
        sendAs: [primary, alias],
      },
    );
    assert.match(decodeRaw(fromInReplyTo.raw), /^References: <prev@mail.gmail.com> <orig@mail.gmail.com>/m);
  });

  it('encodes a long Czech reply subject as folded RFC 2047 words', () => {
    const czech = 'Příliš žluťoučký kůň úpěl ďábelské ódy '.repeat(6).trim();
    const resolved = resolveCompose(
      { subject: czech, body: 'x' },
      { requireRecipient: true, original: originalToAlias, sendAs: [primary, alias] },
    );
    const value = headerValue(resolved.raw, 'Subject');
    assert.match(value, /=\?UTF-8\?B\?/);
    assert.match(value, /\r\n /);
    assert.equal(decodeEncodedWords(value), `Re: ${czech}`);
    for (const line of headerBlock(resolved.raw).split('\r\n')) {
      assert.ok(line.length <= 998, `header line length ${line.length}`);
    }
  });

  it('sets From on a new message when from is passed without a reply', () => {
    const resolved = resolveCompose(
      { to: 'client@example.com', subject: 'Hi', body: 'Hello', from: 'mail@ondrejspulak.cz' },
      { requireRecipient: true, sendAs: [primary, alias] },
    );
    assert.equal(resolved.threadId, undefined);
    assert.equal(resolved.fromAddress, 'mail@ondrejspulak.cz');
    assert.match(decodeRaw(resolved.raw), /^From: =\?UTF-8\?B\?.+\?= <mail@ondrejspulak.cz>/m);
    assert.doesNotMatch(decodeRaw(resolved.raw), /^In-Reply-To:/m);
  });
});
