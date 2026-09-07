# Security

This document explains the trust model, the specific design decisions made for this
project, and their known limitations. Read it before deploying, and especially before
publishing a fork or making changes to authentication or token storage.

**This document does not claim the deployment is "100% secure."** No such claim is
credible for any internet-facing service. What follows is an honest account of what is
and is not protected against, so you can decide if it's an acceptable trade-off for you.

## Trust boundaries

```
Google  <->  Your Google Cloud deployment  <->  Claude / Anthropic
```

- **Google** issues and can revoke the OAuth grant for each connected Gmail account. It
  sees the standard OAuth authorization traffic for your project (nothing beyond what any
  OAuth app sees).
- **Your Google Cloud deployment** is the only party that ever holds Gmail refresh tokens.
  It is provisioned and owned entirely by you, in your own GCP project, with your own
  billing.
- **Claude / Anthropic** calls the MCP tools you expose (`list_accounts`, `search_emails`,
  `get_email`, `search_all_accounts`) and sees whatever those tools return — sender,
  subject, snippets, and bodies for messages you ask Claude to look at. It never sees
  Gmail refresh tokens or your admin password. Claude receives only the OAuth access token
  issued for the MCP resource and never receives Gmail credentials.
- **No one else.** There is no analytics, telemetry, crash reporting, or logging service
  in this project. The repository author does not operate any shared backend and receives
  no data from your deployment — every deployment is fully independent (see "One-user
  deployment model" in [README.md](README.md)).

## Two separate OAuth flows — don't confuse them

1. **Claude to this server.** MCP OAuth 2.1 authorization-code flow with PKCE/S256,
   Protected Resource Metadata, Dynamic Client Registration, short-lived access tokens,
   and rotating refresh tokens. Authorization state and registered clients are stored in a
   separate Secret Manager secret owned by the deployment.
2. **This server to Google, once per connected Gmail account.** Standard OAuth 2.0
   authorization-code flow with PKCE, `access_type=offline` for a refresh token, the narrow
   `gmail.modify` scope. Each account's refresh token is stored independently.

These never touch each other: the OAuth access token Claude sends is never forwarded to
Google, and no Gmail token is ever returned to Claude or appears in any MCP tool result.

## Why the Claude connection uses self-hosted MCP OAuth

The server follows the MCP authorization profile: it publishes RFC 9728 protected-resource
metadata, advertises its authorization server, requires PKCE with S256, validates the
resource audience on every access token, and returns a standards-compliant 401 challenge
when `/mcp` is called without a token. Dynamic Client Registration lets Claude create its
own public OAuth client; no client secret needs to be copied into Claude. The deployment
admin is the resource owner and approves the authorization request on a local consent page.

Access tokens expire quickly and refresh tokens rotate. The server keeps only hashed
one-time authorization codes and refresh-token records in the separate `mcp-oauth-state`
Secret Manager secret. This preserves the self-hosted model without Auth0, Clerk, Supabase,
or a central identity service.

## Why the admin page uses a separate password

`/admin` (connect/disconnect Gmail accounts) is gated by HTTP Basic Auth against its own
`ADMIN_PASSWORD` secret — deliberately separate from the Claude OAuth flow. The Claude
connector's access token cannot add or remove which Gmail accounts this server has access to.

## Why Cloud Run allows unauthenticated invocations

`scripts/bootstrap.sh` (Cloud Shell) and `scripts/deploy.ps1` (Windows) both deploy
with `--allow-unauthenticated`. This looks alarming out of
context, so to be explicit about why: Cloud Run's own IAM layer authenticates callers via
Google-issued identity tokens. Claude's servers are not a Google Cloud principal and
cannot present one, so IAM-level auth is not available for this use case regardless of
what we'd prefer. It also wouldn't be fine-grained enough on its own — `/oauth/google/callback`
must be reachable by a plain browser redirect from Google with no credential at all.

Every route is instead authenticated at the application layer, individually:

| Route | Protected by |
|---|---|
| `POST /mcp`, `POST /claude-mcp` | OAuth access token with `mcp:tools` scope (`src/mcpAuth.ts`) |
| `GET /.well-known/oauth-protected-resource/mcp` | Public metadata only; points clients at the authorization server |
| `GET /authorize`, `POST /token`, `POST /register` | OAuth authorization-server endpoints; authorization requires admin consent |
| `GET /admin/*` | HTTP Basic Auth (`src/adminAuth.ts`) |
| `POST /admin/accounts/start`, `POST /admin/accounts/:alias/disconnect` | HTTP Basic Auth + same-origin check (`requireSameOrigin`, see "CSRF protection" below) |
| `GET /oauth/google/callback` | Encrypted, single-purpose, 10-minute state token (`src/oauthState.ts`) |
| `GET /status` | Nothing — returns only `{"status":"ok"}` |
| `GET /`, `GET /privacy`, `GET /terms` | Nothing — static public pages (`src/publicPages.ts`). Required by Google to publish the OAuth app; see "Google OAuth verification status". They render no deployment state: no aliases, no connected addresses, no configuration. |

## Gmail account-linking flow: CSRF, PKCE, and no server-side session

Starting the linking flow generates a PKCE pair and an **encrypted** `state` token
(`src/oauthState.ts`, AES-256-GCM keyed from `OAUTH_STATE_SECRET`) that embeds the alias,
the PKCE code verifier, and a 10-minute expiry. The code verifier deliberately travels
inside the token rather than in server-side session storage: Cloud Run may route the
callback to a different instance than the one that started the flow, and the token must be
independently verifiable by any instance without shared state.

This token is *encrypted*, not merely signed, because it also travels as a URL query
parameter on both legs of the Google redirect — a merely-signed-but-plaintext token would
let anyone who happens to observe that URL (browser history, or Cloud Run's own request
logging, which records full request URLs) read the code verifier and hijack the linking
flow by redeeming it against a Google account of their own choosing. Encryption makes the
token opaque to anyone without `OAUTH_STATE_SECRET`; GCM's authentication tag still gives
the same tamper-evidence a signature would. This does not add cross-instance single-use
tracking (that would need shared state this project deliberately avoids) — the accepted
mitigation is that replaying a state token still requires a matching Google authorization
`code`, and Google's own authorization server already rejects a `code` on a second use.

Google's redirect always lands on `/oauth/google/callback`, which never redirects on to any
caller-supplied URL — only back to `/admin` — so there is no open-redirect surface here.

## CSRF protection on the admin panel

The admin panel has no session/cookie of its own (it's stateless HTTP Basic Auth), so a
standard cookie-based CSRF token doesn't apply. Browsers cache Basic Auth credentials
per-origin and reattach them to *any* request to that origin — including a plain HTML form
POST submitted from a completely different site the admin happens to visit — so Basic Auth
alone does not stop a cross-site request. `src/adminAuth.ts`'s `requireSameOrigin`
middleware closes this: every state-changing admin route (`POST /accounts/start`,
`POST /accounts/:alias/disconnect`) requires the request's `Origin` (or, failing that,
`Referer`) header to match this deployment's own origin, rejecting anything else with 403.

## Concurrent writes to the account store

`SecretManagerAccountStore` does an unsynchronized read-modify-write of the whole account
list — Secret Manager has no compare-and-swap primitive, and adding real distributed
locking would be disproportionate for a single-admin tool used a handful of times. Two
account changes racing each other can still lose one *update* (the standard lost-update
problem). What's guaranteed instead: a write only ever destroys the exact secret version it
was based on, never "every other version", so a race can never permanently destroy a
concurrently-written account's data — at worst it's temporarily orphaned from the "latest"
view and still recoverable via `gcloud secrets versions list`. A detected race is also
logged (`account_store_possible_concurrent_write`) rather than silently swallowed.

## Token storage

Refresh tokens live in a single Secret Manager secret (`gmail-mcp-accounts`) as a JSON
array. Secret Manager versions are immutable, so every account add/remove writes a new
version; the version it was based on is destroyed immediately after a successful write to
limit how long a superseded refresh token remains recoverable (see "Concurrent writes to
the account store" above for why cleanup is scoped this narrowly rather than sweeping every
old version). Access is IAM-gated to a
dedicated, least-privilege Cloud Run service account (`secretAccessor` on all secrets,
`secretVersionAdder` only on the account store) rather than the project's default compute
service account. There is no additional application-level encryption layer on top —
Secret Manager's own encryption at rest plus IAM access control is the protection, kept
deliberately minimal per this project's "small codebase" goal rather than adding a
hand-rolled KMS envelope-encryption layer whose main effect would be more code to get
wrong.

## Input handling

- Account aliases are validated against `^[a-z0-9_-]{1,32}$` everywhere they're accepted
  (admin form, MCP tool arguments) — no path traversal or injection surface, and aliases
  are never used to construct filesystem paths (even the local-dev file store keeps every
  account in one JSON file, not one-file-per-alias).
- No user-supplied URL is ever fetched by the server (no SSRF surface) — the only outbound
  calls are to fixed Google API/OAuth hostnames.
- Gmail message IDs (the `get_email` tool's `message_id` argument) are validated against
  `^[a-zA-Z0-9_-]{1,100}$` both at the MCP tool-schema layer (`src/mcpServer.ts`) and again
  in `src/gmail.ts` before being interpolated into a Gmail API URL path, so a value like
  `../settings/forwardingAddresses` can't redirect a request to a different Gmail API
  endpoint than the one the tool is meant to call. This is checked twice deliberately —
  message IDs are the kind of value an LLM can copy directly out of email content it just
  read, so this input can arrive via indirect prompt injection, not only a typed argument.
- All HTML output (admin page, OAuth callback pages) is escaped before rendering.
- Account resolution is a hard lookup that throws on a miss — there is no code path that
  tries a different account after a requested one fails to resolve. See README's
  acceptance test 6.

## Logging

Structured JSON logs include request IDs, tool names, account aliases, HTTP status, and
timing. They never include OAuth tokens, client secrets, Authorization headers, email
bodies, attachment content, subject lines, or sender/recipient addresses. `LOG_LEVEL=debug`
adds more timing/internal detail but the redaction above is not configurable — there is no
verbosity setting that exposes Gmail content or credentials.

## Google OAuth verification status

This app requests `gmail.modify`, a **restricted** Gmail scope. Full Google verification
(including a CASA security assessment) is only required if you complete Google's
verification process — e.g., to remove the "unverified app" warning or exceed 100 users.
For a personal or small-team self-hosted deployment, Google's documented exemption applies:
you can move the OAuth consent screen to "In production" (avoiding the 7-day refresh-token
expiry that applies to apps left in "Testing") while remaining unverified, as long as you
stay under 100 connected Google accounts for the app's lifetime. Each newly connected
account will see a one-time "Google hasn't verified this app" click-through screen. This is
expected and does not indicate misconfiguration. Do not attempt to pursue verification for
this use case — it's a process built for public multi-tenant SaaS, not a self-hosted
personal tool.

**Publishing is gated on two things that are easy to miss**, and until both are done the
console shows only a vague "Your app's OAuth configuration is incomplete" banner with the
**Publish app** button greyed out — while refresh tokens keep silently expiring every 7 days:

1. **Declare the scope.** Google Auth Platform → *Data Access* must list
   `https://www.googleapis.com/auth/gmail.modify`. This is a separate registration from
   what the code requests at authorization time; an app works fine in "Testing" with this
   list empty, because test users can consent to any scope the client asks for, so the gap
   only surfaces at publish time. Declare exactly the scope the code requests and nothing
   else — Google's minimum-scope policy is about what you *declare*, not just what you use.
2. **Provide the three App domain URLs.** Google requires an application home page, a
   privacy policy link, and a terms-of-service link for *all* external production apps, each
   on an Authorized Domain. This deployment serves all three itself
   (`/`, `/privacy`, `/terms` — see `src/publicPages.ts`), so the Cloud Run hostname that is
   already an Authorized Domain satisfies the requirement with no extra hosting.

After publishing, **reconnect every account.** Refresh tokens issued while the app was in
"Testing" keep their 7-day expiry; only tokens issued after the switch to "In production"
are long-lived.

## Known limitations

- The deployment admin password is the resource-owner credential for the self-hosted MCP
  authorization page. Anyone who obtains it can authorize a new MCP client, so keep it in
  Secret Manager and do not reuse it elsewhere.
- OAuth client and grant state is stored in one Secret Manager secret. Secret Manager access
  is least-privilege, but a deployment with concurrent administrators should still avoid
  simultaneous authorization changes.
- `search_all_accounts` and `search_emails` cap results and return metadata/snippets, not
  full bodies, to keep tool responses small — but an authorized OAuth client can read every
  connected account's mail via `get_email`.
- Dependencies are kept minimal by design (see README) but you are responsible for keeping
  them updated (`npm audit`, `npm outdated`) on your own deployment.

## Reporting a problem

This is a self-hosted, community project with no central operator. If you find a
vulnerability, open an issue (avoiding any real credentials/URLs in the report) or send a
pull request. There is no bug bounty or SLA.
