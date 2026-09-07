import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { createOAuthMetadata, mcpAuthMetadataRouter, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createAdminRouter } from './adminRouter.js';
import { loadConfig } from './config.js';
import { log } from './logger.js';
import { mcpOAuthAuth } from './mcpAuth.js';
import { createMcpOAuthProvider, mcpResourceUrl, MCP_SCOPE } from './mcpOAuth.js';
import { createMcpServer } from './mcpServer.js';
import { createOAuthCallbackRouter } from './oauthCallback.js';
import { createPublicPagesRouter } from './publicPages.js';
import { escapeHtml } from './html.js';

const config = loadConfig();
const app = express();
app.disable('x-powered-by');
const mcpOAuthProvider = createMcpOAuthProvider();

// No auth: used by uptime checks. Returns no sensitive information.
// Deliberately NOT "/healthz" -- Cloud Run's Knative queue-proxy sidecar reserves
// that exact literal path for its own internal probing and intercepts it before
// it ever reaches this container, regardless of what the app defines there.
app.get('/status', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use((req, res, next) => {
  const requestId = randomUUID();
  res.setHeader('X-Request-Id', requestId);
  const start = Date.now();
  res.on('finish', () => {
    log.info('http_request', {
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - start,
    });
  });
  next();
});

// Human admin UI — connect/disconnect Gmail accounts. Protected by HTTP Basic Auth.
app.use('/admin', createAdminRouter());

// Google's redirect target after a user approves (or denies) Gmail access for one alias.
app.use('/oauth', createOAuthCallbackRouter());

// OAuth authorization is intentionally separate from the Gmail OAuth flow. The
// deployment's admin credential is the local resource-owner consent step for the
// Claude connector; no Gmail account records are read or changed here.
app.post('/authorize/consent', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const result = await mcpOAuthProvider.completeAuthorization(
      String(req.body.request ?? ''),
      String(req.body.username ?? ''),
      String(req.body.password ?? ''),
      String(req.body.decision ?? 'deny'),
    );
    if (result.redirectUrl) {
      res.redirect(result.redirectUrl);
      return;
    }
    res.status(400).type('html').send(`<p>${escapeHtml(result.error ?? 'Authorization failed.')}</p>`);
  } catch (err) {
    log.error('mcp_authorization_failed', { message: (err as Error).message });
    res.status(500).type('html').send('<p>Authorization could not be completed.</p>');
  }
});

const oauthRouterOptions = {
  provider: mcpOAuthProvider,
  issuerUrl: new URL(config.publicBaseUrl),
  baseUrl: new URL(config.publicBaseUrl),
  scopesSupported: [MCP_SCOPE],
  resourceName: 'Multi-Gmail Cowork MCP',
  serviceDocumentationUrl: new URL(config.publicBaseUrl),
};

// MCP authorization-server metadata, DCR, PKCE authorization, and token
// endpoints. The official SDK router also serves RFC 9728 protected-resource
// metadata for the backward-compatible /mcp resource.
app.use(
  mcpAuthRouter({
    ...oauthRouterOptions,
    resourceServerUrl: mcpResourceUrl('/mcp'),
  }),
);

// /claude-mcp is a second, independently discoverable protected resource on
// this same OAuth authorization server. It must advertise its own resource
// URI instead of redirecting to /mcp, so Claude does not reuse an orphaned
// connector record keyed to the old resource URL.
app.use(
  mcpAuthMetadataRouter({
    oauthMetadata: createOAuthMetadata(oauthRouterOptions),
    resourceServerUrl: mcpResourceUrl('/claude-mcp'),
    scopesSupported: [MCP_SCOPE],
    resourceName: 'Multi-Gmail Cowork MCP',
    serviceDocumentationUrl: new URL(config.publicBaseUrl),
  }),
);

// The MCP endpoint Claude talks to. Stateless Streamable HTTP: a fresh MCP
// server and transport per request, so any Cloud Run instance can serve any
// request with no session affinity required. Gated by OAuth access tokens.
const requireMcpAuth = mcpOAuthAuth(mcpOAuthProvider, mcpResourceUrl('/mcp'));
const requireClaudeMcpAuth = mcpOAuthAuth(mcpOAuthProvider, mcpResourceUrl('/claude-mcp'));
const handleMcpPost = async (req: express.Request, res: express.Response) => {
  try {
    const mcpServer = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      mcpServer.close();
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    log.error('mcp_request_failed', { message: (err as Error).message });
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
};

app.post('/mcp', requireMcpAuth, express.json(), handleMcpPost);
app.post('/claude-mcp', requireClaudeMcpAuth, express.json(), handleMcpPost);

app.get('/mcp', requireMcpAuth, (_req, res) => {
  res
    .status(405)
    .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed in stateless mode.' }, id: null });
});
app.delete('/mcp', requireMcpAuth, (_req, res) => {
  res
    .status(405)
    .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed in stateless mode.' }, id: null });
});
app.get('/claude-mcp', requireClaudeMcpAuth, (_req, res) => {
  res
    .status(405)
    .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed in stateless mode.' }, id: null });
});
app.delete('/claude-mcp', requireClaudeMcpAuth, (_req, res) => {
  res
    .status(405)
    .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed in stateless mode.' }, id: null });
});

// Public landing page, privacy policy, and terms. Google requires all three on an
// Authorized Domain before an External OAuth app can leave "Testing" publishing
// status -- and apps left in "Testing" have every refresh token expired by Google
// after 7 days. Mounted last so it can never shadow a functional route.
app.use(createPublicPagesRouter());

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(config.port, () => {
  log.info('server_started', {
    port: config.port,
    publicBaseUrl: config.publicBaseUrl,
    tokenStore: config.tokenStore,
    writeToolsEnabled: config.enableWriteTools,
  });
});
