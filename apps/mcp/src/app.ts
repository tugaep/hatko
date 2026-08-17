import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { AuthorizationError, config, requirePermission, type SessionUser } from '@hatko/core';
import { runSearchTool, searchToolInput } from './tool.ts';

/**
 * The MCP server.
 *
 * Transport is Streamable HTTP rather than stdio, and that choice is the reason the
 * rest of this file looks the way it does. stdio would have been less code — no
 * port, no headers — but a stdio server is spawned by the client as a local
 * subprocess, and a subprocess cannot be authenticated: whoever can run it already
 * has the machine. The brief requires access to be gated by role, so the retrieval
 * tool needs a caller identity, and an identity needs somewhere to travel. Over HTTP
 * it travels in the `Authorization` header.
 *
 * There is no OIDC here. That is the stated bonus and it is deliberately not built:
 * an OIDC provider is a substantial subsystem, and the honest trade was to spend the
 * time making one authorization path correct across three surfaces instead of
 * building a second, weaker one. Bearer tokens are Better Auth sessions, so they
 * carry a real user, a real role, a 7-day expiry and revocation on sign-out.
 */

/**
 * Build the MCP server for one authorized user.
 *
 * Constructed per request rather than once at module scope, which is what lets the
 * tool handler close over `user` instead of re-deriving the caller inside itself.
 * The alternative — one long-lived server that reads identity from ambient
 * request state — is how a tool ends up running with the wrong caller's
 * permissions under concurrency.
 */
function buildServer(user: SessionUser): McpServer {
  const server = new McpServer(
    { name: 'hatko', version: '0.1.0' },
    {
      instructions:
        'Hatko searches an internal document corpus. Use search_corpus for any question about ' +
        'internal projects, SDKs, builds, incidents or delivery history, and answer only from the ' +
        'passages it returns, citing their source paths. When it reports that nothing covers the ' +
        'question, say so — do not fall back on your own knowledge.',
    },
  );

  server.registerTool(
    'search_corpus',
    {
      title: 'Search the internal corpus',
      description:
        'Search the internal document corpus and return the passages that best answer a question, ' +
        'with the source document of each. Combines semantic and keyword retrieval, then reranks by ' +
        'judged relevance. Reports honestly when the corpus does not cover the question instead of ' +
        'returning the least bad passages as though they were answers.',
      inputSchema: searchToolInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      const { text } = await runSearchTool(user, input);
      return { content: [{ type: 'text', text }] };
    },
  );

  return server;
}

/**
 * Resolve and authorize the caller, or throw.
 *
 * The header is passed to `requirePermission` untouched: the bearer plugin
 * HMAC-verifies the token and turns it into a session, and the permission check is
 * the same call the HTTP API's middleware makes with the same `search:run`
 * permission. Nothing here parses a token, compares a secret, or reads a role from
 * the request — a second implementation of any of those is a second place for
 * authorization to be wrong.
 */
async function authorize(headers: Headers): Promise<SessionUser> {
  return requirePermission(headers, 'search:run');
}

/** JSON-RPC error codes used below. -32001 is the SDK's convention for unauthorized. */
const RPC_UNAUTHORIZED = -32001;
const RPC_INTERNAL = -32603;

/**
 * Host headers accepted by the DNS-rebinding check.
 *
 * Every loopback spelling, with and without the port, because the `Host` header is
 * whatever the client typed and all of these name this machine: a client
 * configured with `127.0.0.1` sends one, a client on `localhost` sends another, and
 * a request whose port is implicit sends no port at all. Listing only
 * `localhost:${port}` would have turned a security control into an outage for
 * anyone who wrote the address differently — a control that blocks legitimate
 * callers gets switched off, which is worse than a narrower control that stays on.
 *
 * `evil.example.com` is still rejected, which is the entire point: a page in the
 * user's browser cannot make this server answer under an attacker-controlled name.
 */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const allowedHosts = [
  ...LOOPBACK_HOSTS,
  ...LOOPBACK_HOSTS.map((host) => `${host}:${config.mcpPort}`),
];

/**
 * A JSON-RPC error envelope, with the HTTP status to send it under.
 *
 * MCP clients read the JSON-RPC `error` object; browsers, proxies and curl read the
 * status line. Sending only one of the two leaves whichever reader it was not
 * written for guessing, so both are set and they agree.
 */
function rpcError(status: 401 | 403 | 500, code: number, message: string) {
  return { status, body: { jsonrpc: '2.0' as const, error: { code, message }, id: null } };
}

export function createApp() {
  const app = new Hono();

  /**
   * Unauthenticated, and deliberately says nothing about the corpus. `/health` on
   * the HTTP API reports the passage count because it is reached from the same
   * trusted network as the dashboard; this port is the one an MCP client dials, so
   * it reports liveness only. An index size is a small leak, but it is a free one.
   */
  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.all('/mcp', async (c) => {
    let user: SessionUser;
    try {
      user = await authorize(c.req.raw.headers);
    } catch (error) {
      if (error instanceof AuthorizationError) {
        /**
         * `WWW-Authenticate` on a 401 is what tells a client *how* to
         * authenticate rather than merely that it failed. Without it, a client
         * that supports several schemes has to guess.
         */
        const { status, body } = rpcError(error.status, RPC_UNAUTHORIZED, error.message);
        if (status === 401) c.header('WWW-Authenticate', 'Bearer realm="hatko"');
        return c.json(body, status);
      }
      throw error;
    }

    /**
     * Stateless: no session id, so no server-side session map to grow, to evict, or
     * to leak a transport into when a client disconnects mid-stream. Every request
     * carries its own bearer token and is authorized on its own, which is also what
     * makes the transport disposable.
     *
     * `enableJsonResponse` answers each POST with a complete JSON body instead of
     * holding an SSE stream open. This tool is strictly request/response — it never
     * pushes a notification — so a stream would buy nothing and cost the thing that
     * is actually hard about it: knowing when a per-request transport may be closed.
     * With a plain body, `handleRequest` resolving *is* that moment.
     */
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      // Defence in depth behind the bearer check. A page in the user's browser can
      // POST to a localhost port, and while it cannot mint a valid token, pinning
      // the accepted Host closes the DNS-rebinding path the MCP spec calls out.
      enableDnsRebindingProtection: true,
      allowedHosts,
    });

    const server = buildServer(user);

    try {
      await server.connect(transport);
      const response = await transport.handleRequest(c.req.raw);
      // Both are per-request. Closing them is what keeps a long-running server from
      // accumulating one connected McpServer per call it has ever served.
      await server.close();
      return response;
    } catch (error) {
      await server.close().catch(() => {});
      // The transport owns the response, so a throw here means no response was
      // produced. Logged server-side and answered generically: an unexpected error
      // is exactly the case where the message is most likely to carry a file path
      // or a query.
      console.error('[mcp] unhandled error:', error);
      const { status, body } = rpcError(500, RPC_INTERNAL, 'Internal server error.');
      return c.json(body, status);
    }
  });

  app.notFound((c) =>
    c.json({ error: `No route for ${c.req.method} ${c.req.path}. The MCP endpoint is /mcp.` }, 404),
  );

  return app;
}
