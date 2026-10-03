/**
 * Deadline polling — the one home of the bounded wait the e2e helpers and
 * specs share.
 *
 * `pollUntil` reads, tests the value, and sleeps until the predicate holds or
 * the deadline passes. A read always precedes the expiry check, so a value
 * that arrives on the read after the deadline still counts. Expiry is never
 * success-shaped: the caller supplies `onExpiry`, which receives the last value
 * read, and what it throws or returns is the call's outcome — a positive wait
 * throws its own message there, and a bounded absence returns there. The
 * timeout is a finite, non-negative number of milliseconds, so every wait
 * expires: any other value is refused with a TypeError at the call.
 *
 * `waitForState` is the general positive wait built on it: a timeout names
 * what was awaited and renders the last value read. The positive readiness
 * waits (`frame-ready.js`) and the debug-port read (`devtools-port.js`) are
 * built on `waitForState`, each naming what it awaits and how its last value
 * renders; the bounded absence (`expectNoFrameReady` in `frame-ready.js`) is
 * built on `pollUntil`, returning at expiry.
 */

/**
 * Poll `read()` until `predicate(value)` holds or `timeout` ms pass.
 *
 * Input contract: `timeout` is a finite, non-negative number of milliseconds —
 * any other value throws `TypeError: pollUntil needs a finite, non-negative
 * timeout in ms; got <value>` — and `onExpiry` is a function, without which the
 * call throws a TypeError likewise (`waitForState` always supplies one).
 *
 * @param {() => unknown} read - Reads the current value (may return a promise)
 * @param {(value: unknown) => boolean} predicate - The condition awaited
 * @param {{ timeout: number, interval: number, onExpiry: (last: unknown) => unknown }} opts
 * @returns {Promise<unknown>} The value the predicate held on, or what `onExpiry` returns
 */
export async function pollUntil(read, predicate, { timeout, interval, onExpiry }) {
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new TypeError(`pollUntil needs a finite, non-negative timeout in ms; got ${timeout}`);
  }
  if (typeof onExpiry !== 'function') {
    throw new TypeError('pollUntil needs an onExpiry handler');
  }
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() > deadline) return onExpiry(value);
    await new Promise((r) => setTimeout(r, interval));
  }
}

/**
 * Poll `read()` until `predicate(value)` holds; throws on timeout with the
 * message `Timed out waiting for <describe>; last: <format(last)>`.
 *
 * @param {() => unknown} read - Reads the current value (may return a promise)
 * @param {(value: unknown) => boolean} predicate - The condition awaited
 * @param {string} describe - What is awaited, named in the timeout message
 * @param {{ timeout?: number, interval?: number, format?: (value: unknown) => string }} [opts]
 * @returns {Promise<unknown>} The value the predicate held on
 */
export function waitForState(
  read,
  predicate,
  describe,
  { timeout = 10_000, interval = 50, format = JSON.stringify } = {},
) {
  return pollUntil(read, predicate, {
    timeout,
    interval,
    onExpiry: (last) => {
      throw new Error(`Timed out waiting for ${describe}; last: ${format(last)}`);
    },
  });
}
