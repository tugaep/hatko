import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter, RateLimitError } from './rate-limit.ts';

/**
 * The limiter's own arithmetic.
 *
 * Every test drives `now` explicitly rather than sleeping. A limiter tested against the
 * wall clock is either slow or a race, and the thing worth pinning here — that the window
 * *slides* rather than resetting on a boundary — is precisely a statement about specific
 * instants.
 */

const limiter = (max: number, windowMs = 1000) => createRateLimiter({ max, windowMs });

test('requests inside the allowance pass', () => {
  const rl = limiter(3);
  rl.check('user-1', 0);
  rl.check('user-1', 100);
  rl.check('user-1', 200);
});

test('the request past the allowance is refused', () => {
  const rl = limiter(3);
  for (const now of [0, 100, 200]) rl.check('user-1', now);

  assert.throws(() => rl.check('user-1', 300), RateLimitError);
});

test('allowances are per key, so one caller cannot exhaust another', () => {
  // The whole point of keying by user id. If this failed, one client in a retry loop
  // would lock every other account out of search.
  const rl = limiter(2);
  rl.check('user-1', 0);
  rl.check('user-1', 10);
  assert.throws(() => rl.check('user-1', 20), RateLimitError);

  rl.check('user-2', 20);
  rl.check('user-2', 30);
});

test('the window slides rather than resetting, so a boundary burst cannot double it', () => {
  /**
   * The reason this is a sliding window and not a fixed-window counter. With fixed
   * windows, `max` requests just before a boundary and `max` just after is `2 * max`
   * within a moment — every window, for ever. Here the allowance returns one request at a
   * time, as each leaves the window.
   */
  const rl = limiter(2, 1000);
  rl.check('user-1', 0);
  rl.check('user-1', 500);
  // Both still inside the window at t=999, so this is refused. A fixed window ending at
  // t=1000 would have let it through and then allowed two more immediately after.
  assert.throws(() => rl.check('user-1', 999), RateLimitError);

  // t=1001 is past the first request's expiry, so exactly one slot is back — not two.
  rl.check('user-1', 1001);
  assert.throws(() => rl.check('user-1', 1002), RateLimitError);
});

test('the allowance returns once the window has fully passed', () => {
  const rl = limiter(2, 1000);
  rl.check('user-1', 0);
  rl.check('user-1', 1);
  assert.throws(() => rl.check('user-1', 2), RateLimitError);

  rl.check('user-1', 2000);
  rl.check('user-1', 2001);
});

test('the refusal says how long to wait, and never says zero', () => {
  // A client told to retry in 0 seconds retries immediately and is refused again. The
  // number is what a caller acts on, so it has to be usable.
  const rl = limiter(1, 5000);
  rl.check('user-1', 0);

  const error = (() => {
    try {
      rl.check('user-1', 100);
      return null;
    } catch (caught) {
      return caught as RateLimitError;
    }
  })();

  assert.ok(error instanceof RateLimitError);
  assert.equal(error.retryAfterSeconds, 5);
  assert.match(error.message, /5 seconds/);

  // Rounded up rather than down: at 4.1s remaining, "4" would be a wasted retry.
  const late = (() => {
    try {
      rl.check('user-1', 4900);
      return null;
    } catch (caught) {
      return caught as RateLimitError;
    }
  })();
  assert.equal(late?.retryAfterSeconds, 1);
});

test('a refused request does not consume allowance of its own', () => {
  /**
   * Otherwise a caller hammering a closed door would push its own recovery further away
   * on every attempt — the limiter would punish retrying rather than just refusing it, and
   * a well-behaved client polling once a second would never get back in.
   */
  const rl = limiter(1, 1000);
  rl.check('user-1', 0);

  for (const now of [100, 200, 300, 400]) {
    assert.throws(() => rl.check('user-1', now), RateLimitError);
  }

  // The single recorded request was at t=0, so the slot is back at t=1001 regardless of
  // how many refusals happened in between.
  rl.check('user-1', 1001);
});

test('max of zero disables the limiter rather than refusing everything', () => {
  // RATE_LIMIT_MAX=0 is the operator's escape hatch. If it meant "allow nothing" it would
  // be a footgun that reads like an off switch.
  const rl = limiter(0);
  for (let i = 0; i < 100; i++) rl.check('user-1', i);
});
