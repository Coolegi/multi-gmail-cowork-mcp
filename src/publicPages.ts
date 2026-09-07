import { Router } from 'express';
import { loadConfig } from './config.js';
import { pageShell } from './html.js';

/**
 * Public, unauthenticated pages: a landing page, a privacy policy, and terms.
 *
 * Google requires an application home page, a privacy policy link, and a terms
 * link -- all on an Authorized Domain -- before an "External" OAuth app can move
 * from "Testing" to "In production". That move matters a lot here: while an app
 * stays in "Testing", Google expires every refresh token after 7 days, so each
 * connected Gmail account silently stops working about once a week. Serving
 * these pages from the deployment itself keeps the requirement self-contained --
 * the Cloud Run hostname is already an Authorized Domain, so every deployer gets
 * the three URLs on their own domain with no extra hosting to buy or configure.
 *
 * These pages deliberately describe the deployment generically and name no
 * individual operator, so the same source stays accurate for anyone who deploys
 * it. They are the only routes in this service that are meant to be readable by
 * someone other than the operator, so they must never include account aliases,
 * connected addresses, or any other deployment state.
 */
export function createPublicPagesRouter(): Router {
  const router = Router();
  const config = loadConfig();

  // The requested Gmail scope is gmail.modify unconditionally (see googleOAuth.ts) --
  // ENABLE_WRITE_TOOLS only controls which MCP tools are exposed, NOT what the token
  // is allowed to do. Describing the narrower tool surface as though it were the
  // granted permission would understate what the operator actually authorized, so the
  // grant is always stated in full and the tool restriction is disclosed separately.
  const writeToolsNote = config.enableWriteTools
    ? ''
    : `<p>In this particular deployment the assistant-facing write tools are switched off,
so the assistant can only search and read. The permission granted to the service itself is
still the broader one described above.</p>`;

  const policyLink =
    '<a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>';

  router.get('/', (_req, res) => {
    res.type('html').send(
      pageShell(
        'Multi-Gmail MCP',
        `<h1>Multi-Gmail MCP</h1>
<p class="sub">A private, self-hosted bridge between Gmail and an MCP client.</p>

<p>This is a single-operator deployment of an open-source
<a href="https://modelcontextprotocol.io">Model Context Protocol</a> server. It lets
the person who deployed it connect one or more of their own Gmail accounts to their
own AI assistant, so they can search and work with several mailboxes in one place.</p>

<h2>Who can use it</h2>
<p>Only the operator of this deployment. There is no public sign-up, and no account
on this server can be created by anyone else. Every Gmail account reachable through it
was explicitly connected by the operator through Google's own consent screen, and can
be disconnected by them at any time.</p>

<h2>Not affiliated</h2>
<p>This deployment is run privately by its operator. It is not operated by, endorsed
by, or affiliated with Google or Anthropic.</p>

<h2>More information</h2>
<ul>
  <li><a href="/privacy">Privacy policy</a></li>
  <li><a href="/terms">Terms of service</a></li>
</ul>`,
      ),
    );
  });

  router.get('/privacy', (_req, res) => {
    res.type('html').send(
      pageShell(
        'Privacy policy',
        `<h1>Privacy policy</h1>
<p class="sub">How this deployment handles Google user data.</p>

<p>This service is a private, self-hosted deployment run by one operator for their own
Gmail accounts. It has no other users, no shared backend, and no central operator. The
authors of the underlying open-source project receive no data from it.</p>

<h2>What is accessed</h2>
<p>When the operator connects a Gmail account, this service asks Google for permission to
read, compose, send, and organize mail in that account. Google shows the exact permissions
on its own consent screen before anything is granted. No other Google product or data is
requested, and this permission does not allow permanently erasing messages outright --
messages can only be moved to Trash.</p>
${writeToolsNote}

<h2>How it is used</h2>
<p>Message data is fetched from Gmail only in direct response to a request the operator
makes in their AI assistant -- for example, searching a mailbox or opening a specific
message. Results are returned to that assistant so it can answer. Nothing is fetched on a
schedule, in the background, or for any purpose the operator did not ask for.</p>

<h2>What is stored</h2>
<p>This service stores the OAuth refresh token for each connected account, plus that
account's alias and email address, in Google Secret Manager inside the operator's own
Google Cloud project. That is the only persistent storage. Message content, subjects,
senders, and attachments are never written to disk or to any database -- they pass through
memory to answer one request and are then discarded.</p>

<h2>Who it is shared with</h2>
<p>Message data is sent only to the AI assistant the operator connected, at the moment they
ask for it. It is not sold, rented, or shared with anyone else. It is not used for
advertising, for building profiles, or to train any generalized artificial intelligence or
machine learning model. There is no analytics, telemetry, or crash reporting in this
service of any kind.</p>

<p>This application's use and transfer of information received from Google APIs to any
other app adheres to the ${policyLink}, including the Limited Use requirements.</p>

<h2>Logging</h2>
<p>Operational logs record request timing, HTTP status codes, tool names, and account
aliases so the operator can debug their own deployment. They never contain OAuth tokens,
credentials, message bodies, subject lines, attachment content, or sender and recipient
addresses.</p>

<h2>Retention and deletion</h2>
<p>Disconnecting an account from this service's admin page deletes its stored token. The
operator can also revoke this application's access to any Google Account at any time from
<a href="https://myaccount.google.com/permissions">Google Account permissions</a>, which
immediately and permanently ends this service's access to that mailbox. Deleting the
underlying Google Cloud project destroys all stored data.</p>

<h2>Changes</h2>
<p>Because each deployment is independent and private, any change to this policy takes
effect for that deployment when its operator updates and redeploys the service.</p>`,
      ),
    );
  });

  router.get('/terms', (_req, res) => {
    res.type('html').send(
      pageShell(
        'Terms of service',
        `<h1>Terms of service</h1>
<p class="sub">Terms for this private deployment.</p>

<h2>What this is</h2>
<p>This is a private, single-operator deployment of an open-source project. It is not a
commercial product and is not offered as a service to the public. There is no sign-up, no
subscription, and no fee.</p>

<h2>Permitted use</h2>
<p>Only the operator of this deployment may use it, and only with Google Accounts they own
or are authorized to access. Attempting to access this service without authorization is
not permitted.</p>

<h2>No warranty</h2>
<p>This software is provided "as is", without warranty of any kind, express or implied,
including but not limited to the warranties of merchantability, fitness for a particular
purpose, and non-infringement. The operator runs it at their own risk, and the authors of
the underlying open-source project are not liable for any claim, damages, loss of data, or
other liability arising from its use.</p>

<h2>Availability</h2>
<p>There is no service-level agreement and no guarantee of availability. The operator may
change, suspend, or delete this deployment at any time without notice.</p>

<h2>Costs</h2>
<p>The operator is solely responsible for any Google Cloud charges their own deployment
incurs.</p>

<h2>Ending access</h2>
<p>Access ends when the operator disconnects an account, revokes this application at
<a href="https://myaccount.google.com/permissions">Google Account permissions</a>, or
deletes the deployment.</p>`,
      ),
    );
  });

  return router;
}
