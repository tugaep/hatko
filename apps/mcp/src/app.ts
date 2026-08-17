import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  AuthorizationError,
  ConfigurationError,
  ProviderError,
  RateLimitError,
  config,
  requireMcpPermission,
  type SessionUser,
} from '@hatko/core';
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
 * Two credentials are accepted, and neither is verified here. An OAuth 2.1 / OIDC
 * access token is the normal path — the client discovers the endpoints from the 401
 * below, registers itself, and gets its own scoped token after a human approves it on
 * the consent screen. A Better Auth session token presented as a bearer is the path for
 * `curl` and CI, where a browser redirect makes no sense. Both resolve through
 * `requireMcpPermission` in @hatko/core, so there is one authorization decision rather
 * than one per credential. The authorization server is the HTTP API; see docs/mcp.md.
 */

/**
 * Turn a thrown value into text the caller may see.
 *
 * This function exists because of what the SDK does without it. A tool callback that
 * throws is caught upstream and answered with `error.message` verbatim — measured, a
 * raw `SQLITE_ERROR: no such column: secret_key in /Users/…/hatko.db` arrives at the
 * client as the tool's result. The HTTP API has refused to do that since step 3, and
 * the MCP surface reaching the same database had no equivalent boundary, so the same
 * failure disclosed a schema fragment and an absolute path to whoever asked.
 *
 * The classification mirrors `apps/api/src/errors.ts` deliberately, including which
 * messages are safe to forward:
 *
 * - A provider failure is worth naming, because the fix is to retry or check the key.
 * - A configuration error is written to be actionable and carries nothing internal,
 *   so it is forwarded as-is — a caller who cannot see "no API key is set" will read
 *   a broken retriever as an empty corpus.
 * - Anything unrecognised is logged here and generalised there. An unexpected error
 *   is exactly the case where the message is most likely to carry a path, a query or
 *   a credential.
 */
export function toToolErrorText(error: unknown): string {
  if (error instanceof ProviderError) {
    // Logged as well as reported, which the HTTP API does not bother doing for this
    // case — and the difference is justified. On the web a failure is visible to the
    // person who triggered it; this server is headless, so its log is the only place
    // an operator can find out the provider has been failing all afternoon.
    console.error('[mcp] provider failure:', error.message);
    return 'The model provider could not be reached, so this search could not run. Try again in a moment.';
  }

  if (error instanceof ConfigurationError) return error.message;

  /**
   * Out of allowance. Forwarded verbatim, and it names the wait in seconds, because the
   * reader here is a language model deciding what to do next: told only "rate limited" it
   * will retry immediately or give up, and both are wrong. It is a tool error rather than
   * an HTTP 429 on the transport deliberately — see `runSearchTool`, which counts tool
   * calls rather than requests so that `initialize` and `tools/list` stay free.
   */
  if (error instanceof RateLimitError) return error.message;

  if (error instanceof z.ZodError) {
    // Describes the arguments the caller just sent, not the server's internals.
    const detail = error.issues
      .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
      .join('; ');
    return `Those arguments could not be used: ${detail}`;
  }

  console.error('[mcp] search_corpus failed:', error);
  return 'The search failed for an unexpected reason. The error has been logged.';
}

/**
 * Build the MCP server for one authorized user.
 *
 * Constructed per request rather than once at module scope, which is what lets the
 * tool handler close over `user` instead of re-deriving the caller inside itself.
 * The alternative — one long-lived server that reads identity from ambient request
 * state — is how a tool ends up running with the wrong caller's permissions under
 * concurrency.
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
      try {
        return { content: [{ type: 'text', text: await runSearchTool(user, input) }] };
      } catch (error) {
        // `isError` rather than a throw, so the caller gets our message instead of
        // the SDK's verbatim copy of the exception. An abstention is deliberately
        // *not* routed here: "the corpus does not cover this" is a successful result.
        return { content: [{ type: 'text', text: toToolErrorText(error) }], isError: true };
      }
    },
  );

  return server;
}

/**
 * JSON-RPC codes for the two failures this file answers itself.
 *
 * JSON-RPC has no code for "unauthorized", and the MCP spec puts that signal in the
 * HTTP status instead — the 401 and its `WWW-Authenticate` header are what a client
 * acts on. So this is an implementation-defined code from the reserved -32000..-32099
 * band, chosen not to collide with the two the SDK's own `ErrorCode` enum already
 * occupies there (`ConnectionClosed` -32000 and `RequestTimeout` -32001). An earlier
 * version used -32001 and described it as the SDK's convention for unauthorized,
 * which was wrong twice: it is not a convention, and in this SDK that number already
 * means a timeout.
 */
const RPC_UNAUTHORIZED = -32002;
/** This one is standard: JSON-RPC's own internal-error code. */
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
 *
 * Deployed behind a reverse proxy, the `Host` arriving here is the public hostname, so
 * `MCP_ALLOWED_HOSTS` has to name it or every request becomes a 403. That is the failure
 * mode this control dies of in practice — an operator meets a blanket 403 on a fresh
 * deployment and turns the protection off rather than adding one hostname.
 */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const allowedHosts = [
  ...LOOPBACK_HOSTS,
  ...LOOPBACK_HOSTS.map((host) => `${host}:${config.mcpPort}`),
  ...config.mcpAllowedHosts,
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

  /**
   * Anything that escapes the handler below.
   *
   * Without this, Hono's default answers a plain-text "Internal Server Error", which
   * a JSON-RPC client cannot parse — so a database fault during the session lookup
   * would reach the client as a parse error and be reported as a broken protocol
   * rather than a broken server.
   */
  app.onError((error, c) => {
    console.error('[mcp] unhandled error:', error);
    const { status, body } = rpcError(500, RPC_INTERNAL, 'Internal server error.');
    return c.json(body, status);
  });

  app.all('/mcp', async (c) => {
    let user: SessionUser;
    try {
      /**
       * The headers go through untouched. `requireMcpPermission` accepts either an
       * OAuth access token from the OIDC flow or a Better Auth session token as a
       * bearer, and lands both on the same role check the HTTP API's middleware uses
       * with the same `search:run` permission. Nothing here parses a token, compares
       * a secret, or reads a role from the request — a second implementation of any
       * of those is a second place for authorization to be wrong.
       */
      user = await requireMcpPermission(c.req.raw.headers, 'search:run');
    } catch (error) {
      if (error instanceof AuthorizationError) {
        /**
         * `WWW-Authenticate` on a 401 is what starts the OAuth flow, not just a
         * statement that authentication failed. `resource_metadata` is the pointer
         * the MCP spec has clients follow to find the authorization server, so a
         * client meeting this server for the first time can discover, register and
         * get a token without anyone editing a config file. Omit it and the only way
         * in is a hand-pasted token.
         */
        const { status, body } = rpcError(error.status, RPC_UNAUTHORIZED, error.message);
        if (status === 401) {
          c.header(
            'WWW-Authenticate',
            `Bearer realm="hatko", resource_metadata="${config.apiUrl}/.well-known/oauth-protected-resource"`,
          );
        }
        return c.json(body, status);
      }
      throw error;
    }

    /**
     * Stateless, and a fresh transport per request because the SDK requires exactly
     * that — reusing one throws "Stateless transport cannot be reused across
     * requests". So there is no server-side session map to grow, to evict, or to
     * leak a transport into when a client disconnects. Every request carries its own
     * bearer token and is authorized on its own.
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
      return await transport.handleRequest(c.req.raw);
    } finally {
      // `finally`, so the one close covers both paths — it runs after the response
      // is in hand but before control leaves, which is why it does not truncate a
      // body. Without it, a long-running process accumulates one connected
      // McpServer per call it has ever served. The previous version closed in two
      // places and duplicated `onError`'s envelope and logging in the second.
      await server.close();
    }
  });

  app.notFound((c) =>
    c.json({ error: `No route for ${c.req.method} ${c.req.path}. The MCP endpoint is /mcp.` }, 404),
  );

  return app;
}
