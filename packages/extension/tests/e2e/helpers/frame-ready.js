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
