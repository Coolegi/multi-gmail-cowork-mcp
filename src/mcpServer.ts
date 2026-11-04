import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getAccountStore } from './accountStore.js';
import {
  createDraft,
  deleteDraft,
  GmailApiError,
  getMessage,
  listDrafts,
  searchMessages,
  sendMessage,
  UnknownSendAsError,
  UnverifiedSendAsError,
} from './gmail.js';
import { isReauthRequiredError } from './googleOAuth.js';
import { log } from './logger.js';
import { ALIAS_PATTERN, loadConfig } from './config.js';
import { toSummary, type AccountRecord } from './types.js';

const aliasSchema = z.string().regex(ALIAS_PATTERN, 'Account alias must be lowercase letters, digits, "-" or "_".');

// Matches gmail.ts's own GMAIL_ID_PATTERN — rejected here too, at the tool-schema
// boundary, so a malformed ID (e.g. containing "../") never reaches gmail.ts at all.
const messageIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,100}$/, 'Gmail message IDs only contain letters, digits, "-" and "_".');

class AccountNotConnectedError extends Error {
  constructor(alias: string) {
    super(
      `No connected Gmail account with alias "${alias}". Connect it first via the admin page. ` +
        `This server never falls back to a different account.`,
    );
  }
}

async function resolveAccount(alias: string): Promise<AccountRecord> {
  const record = await getAccountStore().get(alias);
  if (!record) throw new AccountNotConnectedError(alias);
  return record;
}

function reauthMessage(account: AccountRecord): string {
  return (
    `Account "${account.alias}" (${account.email}) could not be accessed — its Google authorization ` +
    `appears to be expired or revoked. Reconnect it from the admin page. No other account was used.`
  );
}

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true as const };
}

const recipientSchema = z
  .string()
  .min(3)
  .max(2_000)
  .describe('One or more comma-separated recipient email addresses.');
const subjectSchema = z.string().max(998).default('').describe('Message subject.');
const bodySchema = z.string().min(1).max(100_000).describe('Plain-text message body.');
const fromSchema = z
  .string()
  .min(3)
  .max(998)
  .describe(
    'Send-as address to use as From. Must be one of this account\'s Gmail send-as aliases ' +
      '(the account address or a verified alias). Overrides the automatic alias chosen when replying.',
  );
const replyToMessageIdSchema = messageIdSchema.describe(
  'Gmail message ID to reply to (from search_emails / get_email). Places this message in that ' +
    'thread, sets In-Reply-To and References, prefixes Subject with English "Re:" if needed ' +
    '(Odp:/AW:/Fwd: are not treated as Re:), and sends from the alias the original arrived at ' +
    '(unless from is set). A reply to a received message goes to the sender only — not reply-all. ' +
    'Following up on a message this account sent reuses that From alias and the original To/Cc. ' +
    'to and subject default from the original when omitted.',
);
const draftIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,100}$/, 'Gmail draft IDs only contain letters, digits, "-" and "_".');

function writeFailure(operation: string, account: AccountRecord, err: unknown) {
  if (err instanceof GmailApiError && isReauthRequiredError(err)) {
    return errorResult(reauthMessage(account));
  }
  if (err instanceof UnknownSendAsError) {
    log.error(`tool_${operation}_failed`, {
      account: account.alias,
      message: `unknown send-as (${err.availableCount} configured)`,
    });
    return errorResult(`${operation} failed for account "${account.alias}": ${err.message}`);
  }
  if (err instanceof UnverifiedSendAsError) {
    log.error(`tool_${operation}_failed`, { account: account.alias, message: 'unverified send-as' });
    return errorResult(`${operation} failed for account "${account.alias}": ${err.message}`);
  }
  log.error(`tool_${operation}_failed`, { account: account.alias, message: (err as Error).message });
  return errorResult(`${operation} failed for account "${account.alias}": ${(err as Error).message}`);
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'multi-gmail-cowork-mcp', version: '0.1.0' });

  server.registerTool(
    'list_accounts',
    {
      title: 'List connected Gmail accounts',
      description:
        'Returns the aliases, email addresses, and connection status of every Gmail account this ' +
        'server currently has access to. Never returns tokens or secrets.',
      inputSchema: {},
    },
    async () => {
      const accounts = await getAccountStore().list();
      return jsonResult(accounts.map(toSummary));
    },
  );

  server.registerTool(
    'search_emails',
    {
      title: 'Search one Gmail account',
      description:
        'Searches a single connected Gmail account using Gmail search syntax (e.g. "from:david@example.com ' +
        'newer_than:30d"). Returns lightweight metadata (sender, subject, date, snippet) — not full bodies. ' +
        'Every result is attributed to the account alias and email address it came from.',
      inputSchema: {
        account: aliasSchema.describe('The alias of the connected Gmail account to search, e.g. "work".'),
        query: z.string().min(1).max(500).describe('Gmail search query syntax.'),
        max_results: z.number().int().min(1).max(50).default(10).describe('Maximum results to return (1-50).'),
      },
    },
    async ({ account, query, max_results }) => {
      const record = await resolveAccount(account);
      log.info('tool_search_emails', { account });
      try {
        const results = await searchMessages(record.refreshToken, query, max_results);
        return jsonResult({ account: record.alias, email: record.email, results });
      } catch (err) {
        if (err instanceof GmailApiError && isReauthRequiredError(err)) {
          return errorResult(reauthMessage(record));
        }
        log.error('tool_search_emails_failed', { account, message: (err as Error).message });
        return errorResult(`Search failed for account "${account}": ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    'get_email',
    {
      title: 'Get one email',
      description:
        'Fetches the full content (headers, body, attachment metadata) of a single email from a connected ' +
        'Gmail account. The result clearly identifies which account it came from.',
      inputSchema: {
        account: aliasSchema.describe('The alias of the connected Gmail account the message belongs to.'),
        message_id: messageIdSchema.describe('The Gmail message ID, as returned by search_emails.'),
      },
    },
    async ({ account, message_id }) => {
      const record = await resolveAccount(account);
      log.info('tool_get_email', { account });
      try {
        const message = await getMessage(record.refreshToken, message_id);
        return jsonResult({ account: record.alias, email: record.email, message });
      } catch (err) {
        if (err instanceof GmailApiError && isReauthRequiredError(err)) {
          return errorResult(reauthMessage(record));
        }
        log.error('tool_get_email_failed', { account, message: (err as Error).message });
        return errorResult(`Fetching message failed for account "${account}": ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    'search_all_accounts',
    {
      title: 'Search every connected Gmail account',
      description:
        'Searches every connected Gmail account independently with the same Gmail search query. Results are ' +
        'grouped by account. If one account fails (e.g. revoked authorization), that account\'s failure is ' +
        'reported on its own — the other accounts\' results are still returned.',
      inputSchema: {
        query: z.string().min(1).max(500).describe('Gmail search query syntax.'),
        max_results_per_account: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe('Maximum results to return per account (1-50).'),
      },
    },
    async ({ query, max_results_per_account }) => {
      const accounts = await getAccountStore().list();
      log.info('tool_search_all_accounts', { accountCount: accounts.length });

      const outcomes = await Promise.allSettled(
        accounts.map(async (record) => ({
          account: record.alias,
          email: record.email,
          results: await searchMessages(record.refreshToken, query, max_results_per_account),
        })),
      );

      const results: { account: string; email: string; results: unknown[] }[] = [];
      const errors: { account: string; email: string; error: string }[] = [];

      outcomes.forEach((outcome, i) => {
        const record = accounts[i]!;
        if (outcome.status === 'fulfilled') {
          results.push(outcome.value);
        } else {
          const err = outcome.reason as Error;
          const message =
            err instanceof GmailApiError && isReauthRequiredError(err)
              ? 'Authorization expired or revoked — reconnect this account from the admin page.'
              : err.message;
          errors.push({ account: record.alias, email: record.email, error: message });
        }
      });

      return jsonResult({ results, errors });
    },
  );

  if (loadConfig().enableWriteTools) {
    server.registerTool(
      'create_draft',
      {
        title: 'Create a Gmail draft',
        description:
          'Creates a plain-text draft in exactly the connected Gmail account named by account. The account alias is ' +
          'required and is never inferred or substituted. Pass reply_to_message_id to draft a reply in that thread ' +
          'from the alias the original arrived at. Pass from to override the From address with a send-as alias. ' +
          'This tool does not send or delete anything.',
        inputSchema: {
          account: aliasSchema.describe('The alias of the connected Gmail account to receive the draft.'),
          to: recipientSchema.optional(),
          cc: recipientSchema.optional(),
          bcc: recipientSchema.optional(),
          subject: subjectSchema,
          body: bodySchema,
          from: fromSchema.optional(),
          reply_to_message_id: replyToMessageIdSchema.optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ account, to, cc, bcc, subject, body, from, reply_to_message_id }) => {
        const record = await resolveAccount(account);
        log.info('tool_create_draft', { account });
        try {
          const draft = await createDraft(record.refreshToken, {
            to,
            cc,
            bcc,
            subject,
            body,
            from,
            replyToMessageId: reply_to_message_id,
          });
          return jsonResult({
            account: record.alias,
            email: record.email,
            from: draft.from ?? record.email,
            draft_id: draft.id,
            message_id: draft.message?.id,
            thread_id: draft.message?.threadId,
          });
        } catch (err) {
          return writeFailure('create_draft', record, err);
        }
      },
    );

    server.registerTool(
      'send_email',
      {
        title: 'Send a Gmail email',
        description:
          'Sends a plain-text email from exactly the connected Gmail account named by account. The account alias is ' +
          'required and is never inferred or substituted. Without reply_to_message_id or from, Gmail sends from the ' +
          'account default send-as as before. Pass reply_to_message_id to reply in that thread from the alias the ' +
          'original arrived at (reply to sender only, not reply-all). Pass from to override From with a verified ' +
          'send-as alias. to is required unless replying.',
        inputSchema: {
          account: aliasSchema.describe('The alias of the connected Gmail account to send from.'),
          to: recipientSchema.optional().describe(
            'One or more comma-separated recipient email addresses. Required unless reply_to_message_id is set, ' +
              'in which case it defaults to the original sender (Reply-To or From).',
          ),
          cc: recipientSchema.optional(),
          bcc: recipientSchema.optional(),
          subject: subjectSchema,
          body: bodySchema,
          from: fromSchema.optional(),
          reply_to_message_id: replyToMessageIdSchema.optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ account, to, cc, bcc, subject, body, from, reply_to_message_id }) => {
        if (!to && !reply_to_message_id) {
          return errorResult('send_email requires to, or reply_to_message_id to default the recipient from the original message.');
        }
        const record = await resolveAccount(account);
        log.info('tool_send_email', { account });
        try {
          const sent = await sendMessage(record.refreshToken, {
            to,
            cc,
            bcc,
            subject,
            body,
            from,
            replyToMessageId: reply_to_message_id,
          });
          return jsonResult({
            account: record.alias,
            from: sent.from ?? record.email,
            message_id: sent.id,
            thread_id: sent.threadId,
          });
        } catch (err) {
          return writeFailure('send_email', record, err);
        }
      },
    );

    server.registerTool(
      'list_drafts',
      {
        title: 'List Gmail drafts',
        description:
          'Lists drafts in exactly the connected Gmail account named by account. Returns draft IDs, recipients, ' +
          'subjects, and snippets. The account alias is required and is never inferred or substituted. This tool ' +
          'does not send or delete anything.',
        inputSchema: {
          account: aliasSchema.describe('The alias of the connected Gmail account whose drafts to list.'),
          max_results: z.number().int().min(1).max(50).default(10).describe('Maximum drafts to return (1-50).'),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async ({ account, max_results }) => {
        const record = await resolveAccount(account);
        log.info('tool_list_drafts', { account });
        try {
          const drafts = await listDrafts(record.refreshToken, max_results);
          return jsonResult({
            account: record.alias,
            email: record.email,
            drafts: drafts.map((d) => ({
              draft_id: d.draftId,
              message_id: d.messageId,
              thread_id: d.threadId,
              from: d.from,
              to: d.to,
              cc: d.cc,
              subject: d.subject,
              date: d.date,
              snippet: d.snippet,
            })),
          });
        } catch (err) {
          return writeFailure('list_drafts', record, err);
        }
      },
    );

    server.registerTool(
      'delete_draft',
      {
        title: 'Delete a Gmail draft',
        description:
          'Permanently deletes one draft by draft ID in exactly the connected Gmail account named by account. ' +
          'Gmail drafts.delete removes the draft outright (it is not moved to Trash). It cannot delete sent or ' +
          'received mail. The account alias is required and is never inferred or substituted.',
        inputSchema: {
          account: aliasSchema.describe('The alias of the connected Gmail account that owns the draft.'),
          draft_id: draftIdSchema.describe('The Gmail draft ID, as returned by create_draft or list_drafts.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      async ({ account, draft_id }) => {
        const record = await resolveAccount(account);
        log.info('tool_delete_draft', { account });
        try {
          await deleteDraft(record.refreshToken, draft_id);
          return jsonResult({
            account: record.alias,
            email: record.email,
            deleted_draft_id: draft_id,
          });
        } catch (err) {
          return writeFailure('delete_draft', record, err);
        }
      },
    );
  }

  return server;
}
