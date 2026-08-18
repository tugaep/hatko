import { z } from 'zod';

/**
 * What the dashboard needs to tell an admin about the MCP server.
 *
 * The MCP server is a separate process on its own port, so nothing the web app already
 * fetches knows any of this — the endpoint it advertises, the hostnames it will answer
 * to, or whether it is running at all. Those facts lived in a startup banner readable
 * only over SSH, which is where a misconfiguration went unnoticed for a whole deployment.
 */

/**
 * The published tool's name, in one place.
 *
 * It was a literal in `apps/mcp/src/app.ts` and again in its tests, and the dashboard is
 * now a third reader. A tool name is a contract with every client that has already been
 * configured against it, so renaming it must be one edit and not three.
 */
export const MCP_TOOL_NAME = 'search_corpus';

/**
 * Whether the MCP endpoint answered, and what that answer means.
 *
 * `authenticating` is the healthy state and it is a 401: an unauthenticated request is
 * supposed to be refused with a `WWW-Authenticate` header, which is what starts a client's
 * OAuth flow. Anything else means the request is not reaching the MCP process.
 *
 * Deliberately not a boolean. "Reachable" would collapse "refused me correctly" and
 * "answered with somebody else's error page" into one green tick.
 */
export const mcpReachabilitySchema = z.enum(['authenticating', 'unexpected', 'unreachable']);
export type McpReachability = z.infer<typeof mcpReachabilitySchema>;

export const mcpInfoSchema = z.object({
  /** The address clients dial, and the `resource` the OAuth metadata advertises. */
  url: z.string(),
  discovery: z.object({
    protectedResource: z.string(),
    authorizationServer: z.string(),
  }),
  /**
   * Every `Host` value the rebinding guard accepts.
   *
   * Shown because it cannot be probed. The guard runs after the bearer check, so an
   * unauthenticated request is refused with 401 whether or not the public hostname is
   * configured — the misconfiguration only appears later, as a 403 for every real client
   * at once. Reading the list is the only way to check it, and this puts it on a page
   * instead of in `journalctl`.
   */
  allowedHosts: z.array(z.string()),
  tool: z.object({
    name: z.string(),
    queryMaxChars: z.number().int().positive(),
    limitMax: z.number().int().positive(),
  }),
  rateLimit: z.object({
    /** Zero means the limiter is disabled, which the panel says rather than showing "0". */
    max: z.number().int().min(0),
    windowSeconds: z.number().int().positive(),
  }),
  status: mcpReachabilitySchema,
  /** What the probe actually saw, for the case where it was not the expected refusal. */
  statusDetail: z.string().nullable(),
});
export type McpInfo = z.infer<typeof mcpInfoSchema>;
