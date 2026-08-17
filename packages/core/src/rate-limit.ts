import { config } from './config.ts';

/**
 * Rate limiting for the paid retrieval paths, shared by the HTTP API and the MCP server.
 *
 * The reason this exists is money, not abuse. Every `/search` spends an embedding call
 * and a rerank call; every `/answer` spends those plus a generation call; the MCP tool
 * spends the same as a search. None of that was bounded — a valid token could drive an
 * unbounded number of provider requests, and a client stuck in a retry loop would look
 * exactly like normal traffic until the bill arrived. `docs/mcp.md` §7 and
 * `docs/deployment.md` §10 both named this as a known gap; this closes it.
 *
 * Lives in `packages/core` because both surfaces need it and there must be one limit
 * rather than one per surface. Same argument as `requireMcpPermission`: two
 * implementations of a control are two things to keep in step, and the one that drifts
 * is always the one nobody looks at.
 */

/** Thrown when a caller has spent its allowance. Carries what the caller needs: how long. */
export class RateLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(
      `Too many requests. Try again in ${retryAfterSeconds} second${
        retryAfterSeconds === 1 ? '' : 's'
      }.`,
    );
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface RateLimiterOptions {
  /** Requests allowed per window. Zero or less disables the limiter entirely. */
  max: number;
  windowMs: number;
}

export interface RateLimiter {
  /**
   * Record a request against `key`, or throw `RateLimitError`.
   *
   * `now` is a parameter so a test can drive the clock exactly. Asserting "the 31st
   * request in a minute is refused" against the wall clock means either sleeping for a
   * real minute or shrinking the window until the test is a race.
   */
  check(key: string, now?: number): void;
}

/**
 * Keys tracked before a sweep runs.
 *
 * The map is keyed by user id, so its natural size is the number of accounts that have
 * searched recently — a handful for an internal tool. The cap is a backstop against the
 * one case that grows without bound: a long-running process seeing many distinct users
 * over weeks, where expired entries would otherwise sit there for ever.
 */
const MAX_TRACKED_KEYS = 10_000;

/**
 * A sliding-window limiter: it keeps the timestamps of a key's recent requests and counts
 * the ones still inside the window.
 *
 * A fixed-window counter would have been marginally less code and is wrong at the
 * boundary — 30 requests at 11:59:59 and 30 more at 12:00:01 is 60 requests in two
 * seconds, every window, for ever. Keeping at most `max` timestamps per key costs a small
 * array and removes that hole, so there is no reason to accept it.
 *
 * ponytail: in-memory and per-process, so two API processes would each grant the full
 * allowance and a restart forgets everything. That is correct for the deployment
 * `docs/deployment.md` describes, which is one process per service behind a proxy. The
 * upgrade path if it ever runs multi-process is a shared store — a `rate_limits` table
 * keyed the same way, or Redis — and the interface above does not change.
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const hits = new Map<string, number[]>();

  /** Drop keys whose most recent request has fallen out of the window. */
  function sweep(now: number): void {
    const cutoff = now - options.windowMs;
    for (const [key, times] of hits) {
      const newest = times[times.length - 1];
      if (newest === undefined || newest <= cutoff) hits.delete(key);
    }
  }

  return {
    check(key: string, now: number = Date.now()): void {
      if (options.max <= 0) return;

      const cutoff = now - options.windowMs;
      const times = (hits.get(key) ?? []).filter((time) => time > cutoff);

      if (times.length >= options.max) {
        // Written back so the pruned list is not recomputed on every refused request,
        // which is exactly when calls arrive fastest.
        hits.set(key, times);
        const oldest = times[0]!;
        // The window slides, so the allowance returns when the oldest request leaves it.
        // Rounded up and floored at one second: "try again in 0 seconds" invites an
        // immediate retry that is guaranteed to fail.
        throw new RateLimitError(Math.max(1, Math.ceil((oldest + options.windowMs - now) / 1000)));
      }

      times.push(now);
      hits.set(key, times);

      if (hits.size > MAX_TRACKED_KEYS) sweep(now);
    },
  };
}

/**
 * The limiter both surfaces use, keyed by user id.
 *
 * By user rather than by IP, for two reasons. Every route it guards already requires a
 * session, so there is always a real account to charge — and the spend being capped is
 * per account, which makes the account the honest unit. IP would also be the wrong thing
 * to trust behind the reverse proxy the deploy guide recommends: it arrives in a header
 * the proxy sets, and treating a client-supplied header as identity is how a limiter
 * becomes decorative.
 *
 * Admins are limited too. A dashboard does not call these routes, and a provider bill
 * does not care about roles.
 */
export const retrievalRateLimiter = createRateLimiter({
  max: config.rateLimitMax,
  windowMs: config.rateLimitWindowSeconds * 1000,
});
