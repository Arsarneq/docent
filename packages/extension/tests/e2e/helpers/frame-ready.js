/**
 * Recorder-readiness helpers for e2e tests.
 *
 * The recorder runs in the content-script ISOLATED world, so the moment it
 * finishes wiring its listeners it cannot signal that via a `window.*` flag the
 * page's main world (or a Playwright main-world probe) can see. Instead it sends
 * the service worker a FRAME_READY message (`{ readyAt, url }`).
 *
 * These helpers install a probe in the SW that records each frame's ready
 * timestamp keyed by the frame's URL, then wait for / read it. The probe is a
 * second chrome.runtime.onMessage listener — Chrome dispatches each message to
 * every listener, so it observes FRAME_READY alongside the production handler
 * without interfering (it never calls sendResponse).
 *
 * `readyAt` is stamped in the recorder on the same machine's wall clock the SW
 * uses for webNavigation.onCompleted, so a test can subtract the two to measure
 * the inject→ready window with no cross-process clock skew.
 *
 * The same probe answers the negative direction: `expectNoFrameReady` holds a
 * frame to reporting nothing for a bounded window, which is how a test states
 * that no recorder is live in a document.
 */

/** Install the FRAME_READY probe in the service worker (idempotent). */
export async function installReadyProbe(serviceWorker) {
  await serviceWorker.evaluate(() => {
    globalThis.__frameReadyAt = globalThis.__frameReadyAt || {};
    if (globalThis.__frameReadyProbeInstalled) return;
    globalThis.__frameReadyProbeInstalled = true;
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'FRAME_READY') {
        // Last-write-wins per URL; tests use fresh URLs per frame.
        globalThis.__frameReadyAt[msg.url] = msg.readyAt;
      }
      // Never return true / call sendResponse — this is an observer only.
    });
  });
}

/** Read the recorded ready timestamp for a frame URL (null if not yet ready). */
export async function getFrameReadyAt(serviceWorker, url) {
  return serviceWorker.evaluate((u) => globalThis.__frameReadyAt?.[u] ?? null, url);
}

/** Wait until the recorder in the frame at `url` has reported FRAME_READY. */
export async function waitForFrameReady(
  serviceWorker,
  url,
  { timeout = 10_000, interval = 20 } = {},
) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const at = await getFrameReadyAt(serviceWorker, url);
    if (at != null) return at;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for FRAME_READY from ${url}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

/**
 * Hold the frame at `url` to reporting NO readiness for `within` milliseconds:
 * the probe stays silent for the whole window, and a FRAME_READY arriving
 * inside it throws.
 *
 * A negative is only worth what its window is worth, so callers derive `within`
 * from the inject→ready bound the extension capture doctrine pins and pair the
 * absence with a positive control that measures a live injection against the
 * same window. Like the positive waits, this keys on the frame URL and the map
 * is last-write-wins, so the caller navigates to a URL no earlier document in
 * the run used — an older document's timestamp under a reused URL would read as
 * this document's recorder.
 */
export async function expectNoFrameReady(serviceWorker, url, { within, interval = 20 } = {}) {
  const deadline = Date.now() + within;
  for (;;) {
    const at = await getFrameReadyAt(serviceWorker, url);
    if (at != null) {
      throw new Error(`FRAME_READY reported from ${url} (readyAt ${at}) within ${within}ms`);
    }
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, interval));
  }
}

/**
 * Wait until the recorder at `url` has reported FRAME_READY NEWER than
 * `sinceTs`. The probe map is last-write-wins per URL, so after a reload or a
 * revisit of the same URL the plain waitForFrameReady would return the stale
 * pre-navigation timestamp while the new document has no recorder yet. Callers
 * capture Date.now() before navigating and pass it here; suites whose URLs are
 * stable across loads (the capture corpus) must use this variant after every
 * navigation.
 */
export async function waitForFrameReadySince(
  serviceWorker,
  url,
  sinceTs,
  { timeout = 10_000, interval = 20 } = {},
) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const at = await getFrameReadyAt(serviceWorker, url);
    if (at != null && at > sinceTs) return at;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for FRAME_READY newer than ${sinceTs} from ${url}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
