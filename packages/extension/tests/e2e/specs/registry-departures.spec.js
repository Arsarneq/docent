/**
 * Worker capture bookkeeping — observed through the worker's introspection
 * handle.
 *
 * The active-frame registry (extension capture-principles ECP-3) and the
 * programmatic-tab set are worker-internal. What this spec pins of the
 * registry's departures, no append can report — so the handle is the only
 * observer of it: a closed tab's frames can no longer send, while stopped
 * every append is refused whatever the registry holds, and each clear case
 * reads its clear off evidence it planted, which nothing that can send owns
 * (stated at each sentinel constant). The route that does leave an
 * append/stream pair, the subframe navigate-away drop, is pinned that way
 * instead (recorder-coverage.spec.js). The set's behaviours do reach the
 * stream, and the handle is what plants and wipes the membership they turn
 * on. Each case that observes those structures reaches them through the
 * introspection handle the worker exposes on its own globalThis (extension
 * runtime ERT-1), and the group such a case belongs to is the handle verb its
 * observation rests on — reading, planting, or wiping. The handle's
 * reachability is stated beside the principle it observes (extension runtime
 * ERT-1); here it means Playwright's serviceWorker.evaluate, so these
 * observations leak nothing to page-adjacent contexts.
 *
 * READING pins what production alone drives in and out of the registry: a
 * closed tab's frames leaving the registry with the tab.
 *
 * PLANTING supplies the entries a clear must destroy where its effect is
 * otherwise invisible. The orphan frame's situation is not synthetic — it is
 * the residue ECP-3's backstop names: a frame that reaches neither the
 * navigate-away drop nor the tab-close drop keeps its entry until the next
 * clear runs — and the orphan is the discriminator, since a prune of departed
 * tabs leaves it while only a clear that empties the registry removes it. It is
 * planted on both sides of the start seed's target set, so a clear narrowed to
 * the tabs that seed re-covers is told apart too. The dead-tab key is the
 * synthetic one, standing in for a departed tab's entry — the cell a prune
 * does reach, and one a full clear must reach as well. Every clear site the
 * record-start and record-stop routes carry is pinned this way: each of the
 * two operations is driven on the panel-protocol route and again by a direct
 * write of the recording flag — the worker reacts identically however the key
 * changes (the mirrors doctrine of ERT-1) — and each call-site clear is driven
 * additionally in the route-state where the flag does not transition — the
 * leading clear on the `RECORDING_START` and `RECORDING_CREATE` handlers, and
 * the stop chokepoint — so the watch never runs and that call-site clear is
 * the only one. A planted programmatic-tab entry serves the same purpose on
 * the set, and it carries both sides of the close suppression: planted
 * membership suppresses the close proxy for a tab closed after a user action
 * while the close lands inside the recent-action window, and past that window
 * the same planted membership leaves the proxy appended.
 *
 * WIPING simulates the in-memory loss an MV3 idle suspension causes, which
 * Playwright cannot force — a distinct limitation from the reload-reconnect
 * constraint the suspension-survival spec's header records. The wipe
 * members empty each structure outside any production trigger, and what is
 * pinned is the loss signature: the lazy reseed restoring the appending
 * tab's entry after a wiped registry, and a wiped programmatic-tab set
 * letting a scripted close append a context_close the user never performed,
 * the degradation the correlation-marker class already admits (extension
 * runtime ERT-1).
 *
 * One case belongs to none of those groups, because it reaches neither
 * structure the handle observes: the platform premise the same-value routes
 * above rest on. Those routes attribute a clear to a call site because the
 * flag write they drive changes nothing, and expectFlagAlreadyHolds asserts
 * that per-route precondition — the flag already holds the value the route is
 * about to write. The rule beneath it is the platform's, stated at the
 * worker's recording-flag watch: a write of the value a key already holds
 * fires no change event. That case holds the platform to it, on a key the
 * extension does not own.
 */

import {
  test as baseTest,
  expect,
  setTestContent,
  getPendingActions,
  waitForActionsToSettle,
} from '../helpers/extension-fixture.js';
import {
  TAB_CREATED_USER_ACTION_WINDOW,
  TAB_CLOSED_USER_ACTION_WINDOW,
} from '../../../lib/capture-timing.js';

// Waits derived from the production timing windows, so a window change moves
// them with it instead of silently shifting the scenarios' semantics: the
// scripted close must land INSIDE the recent-action window (a quarter of it,
// capped at 300 ms — at today's window the cap is what holds); the
// creation-window lapse must EXCEED the creation window, so a tab opened after
// it cannot be classified programmatic; and the closed-window lapse must
// EXCEED the close window, so a close landing after it falls outside the close
// suppression's timing conjunct. Each of these stays a duration because it is
// a window under test; every other wait keys on an observable signal.
const CLOSE_AFTER_ACTION_DELAY = Math.min(300, TAB_CLOSED_USER_ACTION_WINDOW / 4);
const CREATION_WINDOW_LAPSE = TAB_CREATED_USER_ACTION_WINDOW + 100;
const CLOSE_WINDOW_LAPSE = TAB_CLOSED_USER_ACTION_WINDOW + 100;

// A tab id no live tab owns, planted so a clear whose effect is otherwise
// invisible has something to destroy. One constant serves every case: the
// fixture gives each test its own browser context, so each starts against a
// fresh worker with an empty registry and cross-case distinctness would buy
// nothing.
const DEAD_TAB_ID = 999999;

// A frame id no document owns, planted under a LIVE tab's key — in that tab's
// existing entry, or creating the key where the host has none yet, as an
// off-seed host does. No collision guard stands here, unlike the dead-tab key:
// a collision can only red, never falsely green — inside a seed-covered tab
// the seed restores the real frame and the sentinel sweep fails on it, and
// elsewhere nothing restores it at all. Against the prune-vs-clear question
// the dead-tab key cannot settle — it is removed by anything that prunes
// entries for tabs that no longer exist — this one asks for more: a prune of
// that kind leaves it, so only a clear that empties the registry removes it.
// (The tab-close route removes it too, with its host entry; no case here
// closes a sentinel's host tab.) Neither reader of the browser's frame table —
// the record-start seed and the lazy reseed — can restore it or hide it: both
// go through seedFramesForTab, which registers the frames chrome.webNavigation
// reports, and registration ADDS to a tab's existing set rather than replacing
// it, so an orphan frame survives every seed and only a clear removes it.
const ORPHAN_FRAME_ID = 888888;

const test = baseTest.extend({
  // Extension id, derived from the service worker's own URL.
  extensionId: async ({ serviceWorker }, use) => {
    const match = serviceWorker.url().match(/chrome-extension:\/\/([^/]+)/);
    await use(match ? match[1] : '');
  },

  // Extension page used to drive the panel protocol: chrome.runtime.sendMessage
  // reaches the SW only from extension contexts, never from the SW to itself.
  // Readiness is the projects view rendering, not a clock bet.
  panelPage: async ({ context, extensionId }, use) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });
    await use(page);
    await page.close();
  },

  // A live tab OUTSIDE the start seed's target set — no seed re-covers an
  // about:blank tab — so the off-seed orphan below can be planted in
  // cases that open no extension page. It is a real tab chrome.tabs.query
  // reports, and the split below holds that classification against the seed's
  // own query rather than trusting this comment.
  offSeedPage: async ({ context }, use) => {
    const page = await context.newPage();
    await page.goto('about:blank');
    await use(page);
    await page.close();
  },
});

/** Send a panel-protocol message to the SW from an extension page context. */
async function sendSWMessage(panelPage, msg) {
  return await panelPage.evaluate(async (m) => {
    return await chrome.runtime.sendMessage(m);
  }, msg);
}

// ─── Handle accessors (all through serviceWorker.evaluate) ───────────────────
// Plants and wipes are synchronous inside the worker — when the evaluate
// resolves, the mutation is applied — so plant-then-verify reads directly
// instead of polling. Polls exist for the event-driven mutations only.
//
// The reads hand back different key types: frameRegistry() is built with
// Object.fromEntries, so its tab ids arrive as STRINGS, while
// programmaticTabs() and captureTargetTabIds() hand back the NUMBERS they
// hold. The registry snapshot being string-keyed is the rule behind every
// conversion here: an id used as a registry key is stringified whatever its
// origin — a read, a module constant, or an id taken off the action stream —
// and an id leaving the registry for anything else — a plant, or a comparison
// against the numbers the stream and the other reads hand back — is a number.

const readRegistry = (serviceWorker) =>
  serviceWorker.evaluate(() => globalThis.__docentCaptureBookkeeping.frameRegistry());

const readProgrammaticTabs = (serviceWorker) =>
  serviceWorker.evaluate(() => globalThis.__docentCaptureBookkeeping.programmaticTabs());

const plantFrame = (serviceWorker, tabId, frameId) => {
  // The registry keys tabs by NUMBER and the snapshot cannot show the
  // difference, so the type is held here, at the site the mistake would be
  // made — a string-keyed plant shadows the real entry rather than failing.
  expect(typeof tabId, 'a planted tab id must be a number').toBe('number');
  return serviceWorker.evaluate(
    ([t, f]) => globalThis.__docentCaptureBookkeeping.plantFrame(t, f),
    [tabId, frameId],
  );
};

const plantProgrammaticTab = (serviceWorker, tabId) =>
  serviceWorker.evaluate(
    (t) => globalThis.__docentCaptureBookkeeping.plantProgrammaticTab(t),
    tabId,
  );

const wipeFrameRegistry = (serviceWorker) =>
  serviceWorker.evaluate(() => globalThis.__docentCaptureBookkeeping.wipeFrameRegistry());

const wipeProgrammaticTabs = (serviceWorker) =>
  serviceWorker.evaluate(() => globalThis.__docentCaptureBookkeeping.wipeProgrammaticTabs());

/** Write the recording flag directly in extension storage (no message route). */
const writeRecordingFlag = (serviceWorker, value) =>
  serviceWorker.evaluate(async (v) => {
    await chrome.storage.local.set({ recording: v });
  }, value);

/** Read the recording flag straight from extension storage. */
const readRecordingFlag = (serviceWorker) =>
  serviceWorker.evaluate(async () => (await chrome.storage.local.get('recording')).recording);

/** Read the recorder-persisted recent-action marker from extension storage. */
const readLastUserActionTimestamp = (serviceWorker) =>
  serviceWorker.evaluate(async () => {
    const { lastUserActionTimestamp } = await chrome.storage.local.get('lastUserActionTimestamp');
    return lastUserActionTimestamp ?? null;
  });

/**
 * How old the recent-action marker is, measured the way the suppression
 * measures it: on the worker's own clock, against the marker the recorder
 * persisted. A marker the storage does not hold reads as null, which fails an
 * age assertion rather than satisfying one — the direction a case varying the
 * window needs, since a missing marker lapses every window vacuously.
 */
const readRecentActionAge = (serviceWorker) =>
  serviceWorker.evaluate(async () => {
    const { lastUserActionTimestamp } = await chrome.storage.local.get('lastUserActionTimestamp');
    return lastUserActionTimestamp == null ? null : Date.now() - lastUserActionTimestamp;
  });

/**
 * Poll `read()` until `predicate(value)` holds; throws on timeout with the
 * last value rendered by `format`.
 */
async function waitForState(
  read,
  predicate,
  describe,
  { timeout = 10_000, interval = 50, format = JSON.stringify } = {},
) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${describe}; last: ${format(value)}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

/**
 * The live tabs split by the record-start seed's own target query: the ids the
 * seed targets and the ids it does not. The in-seed half is the query itself,
 * read through the handle, not a restatement of what it matches — so widening
 * the seed's target set moves both halves with it instead of silently leaving
 * a sentinel the seed now re-covers, however the widening is written. One call
 * answers both halves and their union is every live tab, so no guard below
 * reads a different snapshot than its neighbour.
 */
const liveTabsBySeedTarget = (serviceWorker) =>
  serviceWorker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    const seededIds = new Set(await globalThis.__docentCaptureBookkeeping.captureTargetTabIds());
    return {
      inSeed: all.filter((t) => seededIds.has(t.id)).map((t) => t.id),
      offSeed: all.filter((t) => !seededIds.has(t.id)).map((t) => t.id),
    };
  });

/**
 * The registry keys the start seed re-covers: every key except one for a live
 * tab outside the seed's target set. That is what each caller needs of it —
 * such a key can host an in-seed sentinel, key a seed-liveness wait (a key
 * no seed brings back would hang instead of pinning anything), and key a
 * departure wait. A key whose tab has departed is not excluded here;
 * `plantSentinels` holds the list against the live query before planting.
 */
async function seedCoveredTabIds(serviceWorker, registry) {
  const nonSeed = new Set((await liveTabsBySeedTarget(serviceWorker)).offSeed.map(String));
  return Object.keys(registry).filter((t) => !nonSeed.has(t));
}

/**
 * The dead-tab key only stands for a departed tab while no live tab owns it.
 * Assert it rather than trusting the constant: on a seed-covered host a
 * collision puts the key back after the clear — the seed restores it on the
 * start routes, and on the stop routes a write still in flight can (what a
 * late write costs is stated at the worker's registerFrame) — and the checks
 * below would hang or fail without naming the collision. The
 * assertion covers every live tab regardless, since owning the id is what
 * disqualifies a tab either way. Callers holding a live-tab list already pass
 * it; callers planting the id on its own read one here.
 */
async function expectDeadTabIdUnowned(serviceWorker, liveIds) {
  const ids = liveIds ?? Object.values(await liveTabsBySeedTarget(serviceWorker)).flat();
  expect(ids, 'the dead-tab sentinel must not collide with a live tab').not.toContain(DEAD_TAB_ID);
}

/**
 * Plant one sentinel in each cell of the partition these cases discriminate
 * on: a registry key's tab liveness, and for a live tab its membership in the
 * start seed's target set. Those two facts partition the keys the registry can
 * hold — a key whose tab is GONE (the dead-tab key), a key whose tab is LIVE
 * and inside the start seed's target set, and a key whose tab is LIVE and
 * outside it. Only a clear that empties the registry destroys all three — a
 * prune of departed tabs leaves the two live-tab orphans, and a clear narrowed
 * to the tabs the seed will re-cover leaves the off-seed orphan. A clear
 * discriminating on some other property of a live tab is outside what these
 * sentinels see. The read-back is what keeps a plant that landed nowhere — an
 * id `registerFrame` drops for being null — from making a later check pass
 * vacuously. It cannot hold the key type at all; the plant helper asserts
 * that, for the reason stated there. The programmatic-tab plant needs no such
 * guard — that read hands back the values it holds, so a string plant fails
 * its own equality check.
 */
async function plantSentinels(serviceWorker, seedCoveredIds) {
  const { inSeed, offSeed: offSeedTabIds } = await liveTabsBySeedTarget(serviceWorker);
  // The caller derives its list from registry keys, so hold it against the
  // live query: a key whose tab has departed would otherwise take an in-seed
  // sentinel no seed restores, and the seed waits below would hang instead
  // of failing with a reason.
  const seedTargets = new Set(inSeed.map(String));
  expect(
    seedCoveredIds.filter((t) => !seedTargets.has(t)),
    'every in-seed sentinel host must be a live tab inside the seed target set',
  ).toEqual([]);
  expect(
    seedCoveredIds.length,
    'a live tab inside the seed target set is required to plant the in-seed sentinel',
  ).toBeGreaterThan(0);
  expect(
    offSeedTabIds.length,
    'a live tab outside the seed target set is required to plant the off-seed sentinel',
  ).toBeGreaterThan(0);
  // The two halves above are every live tab, so the collision guard reads the
  // same snapshot the guards above did.
  await expectDeadTabIdUnowned(serviceWorker, [...inSeed, ...offSeedTabIds]);
  // Past the guards the two lists differ in nothing the plants care about, so
  // they normalize to one key type here: a read's string keys becoming the
  // numbers a plant takes, which is the header's rule.
  const orphanHosts = [...seedCoveredIds.map(Number), ...offSeedTabIds];
  for (const t of orphanHosts) await plantFrame(serviceWorker, t, ORPHAN_FRAME_ID);
  await plantFrame(serviceWorker, DEAD_TAB_ID, 0);
  const planted = await readRegistry(serviceWorker);
  expect(planted).toHaveProperty(String(DEAD_TAB_ID));
  for (const t of orphanHosts) expect(planted[String(t)]).toContain(ORPHAN_FRAME_ID);
}

/**
 * No sentinel survives anywhere in the registry — how a case whose clear is
 * followed by a seed discriminates, since its registry is refilled by the time
 * it can be read. The cases that end on an empty registry assert the whole
 * snapshot instead, which covers the sentinels with everything else. Scanning
 * the whole snapshot rather than the planted keys is both shorter and
 * stronger: a clear that moved an orphan rather than removing it fails here
 * too.
 */
function expectSentinelsGone(registry) {
  expect(registry).not.toHaveProperty(String(DEAD_TAB_ID));
  for (const [tabId, frames] of Object.entries(registry)) {
    expect(frames, `sentinel frame survived under tab ${tabId}`).not.toContain(ORPHAN_FRAME_ID);
  }
}

const waitForRegistry = (serviceWorker, predicate, opts) =>
  waitForState(() => readRegistry(serviceWorker), predicate, 'registry state', opts);

const waitForProgrammaticTabs = (serviceWorker, predicate, opts) =>
  waitForState(
    () => readProgrammaticTabs(serviceWorker),
    predicate,
    'programmatic-tab state',
    opts,
  );

const waitForActions = (serviceWorker, predicate, opts) =>
  waitForState(() => getPendingActions(serviceWorker), predicate, 'actions', {
    interval: 100,
    format: (actions) => JSON.stringify(actions.map((a) => a.type)),
    ...opts,
  });

/**
 * The precondition every same-value route rests on: the flag already holds the
 * value the route is about to write, so the watch cannot run and the route's
 * own call-site clear is the sole clear. Asserted rather than narrated, since
 * any change that makes one of those writes change a value breaks the
 * attribution silently.
 */
async function expectFlagAlreadyHolds(serviceWorker, value) {
  expect(
    await readRecordingFlag(serviceWorker),
    'the flag must already hold the value this route writes, or the watch would run',
  ).toBe(value);
}

/**
 * Wait until at least one tab is registered, then take the registry keys the
 * start seed re-covers. Every case that plants sentinels opens on this pair,
 * so what counts as a usable sentinel host is decided in one place rather than
 * at each of them.
 */
async function seedCoveredOnceRegistered(serviceWorker) {
  const live = await waitForRegistry(serviceWorker, (r) => Object.keys(r).length >= 1);
  return await seedCoveredTabIds(serviceWorker, live);
}

/**
 * Click, then wait for the recorder to persist the recent-action marker that
 * click produced — the signal the close-proxy timing window keys on, waited on
 * rather than bet on with a clock. The planted-suppression case's two legs
 * use this, so their setups are the same by construction and not merely by
 * comment; the wiped-set case's legs key on the close window itself instead.
 */
async function clickAwaitingRecentAction(serviceWorker, page, selector) {
  const before = Date.now();
  await page.click(selector);
  await waitForState(
    () => readLastUserActionTimestamp(serviceWorker),
    (ts) => ts != null && ts >= before,
    'recent-action marker',
  );
}

/**
 * A record-start's end state as the same-value start routes read it:
 * directly, because nothing is left in flight to wait on. Awaiting the
 * route's own injection is not what buys that — a readiness beacon is sent
 * fire-and-forget. Callers must drive a route that re-injects only into
 * documents the fixture already loaded, where the recorder's double-injection
 * guard returns before the beacon send; otherwise that route's readiness
 * beacons are still in flight and the seed half of this read can race them (a
 * red, never a false green — the clear is synchronous and awaited, and no
 * sentinel arrives by beacon). They end on this one call, for the same reason
 * the transition routes share theirs.
 */
async function expectRescopedDirectly(serviceWorker, seedCoveredIds) {
  const rescoped = await readRegistry(serviceWorker);
  expectSentinelsGone(rescoped);
  for (const t of seedCoveredIds) expect(rescoped).toHaveProperty(t);
}

/**
 * A record-start's end state: the seed-covered keys are back and the dead-tab
 * key is gone — the wait's liveness half, which the planted state cannot
 * satisfy — and no sentinel survived anywhere, which the wait does not carry.
 * The transition start routes end on this one call, so they cannot drift from
 * each other.
 */
async function expectRescopedToSeedCovered(serviceWorker, seedCoveredIds) {
  const seeded = await waitForRegistry(
    serviceWorker,
    (r) => seedCoveredIds.every((t) => t in r) && !(String(DEAD_TAB_ID) in r),
  );
  expectSentinelsGone(seeded);
}

/**
 * A record-stop's end state: the real registrations depart (the wait) and the
 * whole snapshot is empty (the assertion), which covers every sentinel with
 * them. Shared by the transition stop routes, for the same reason. A write
 * still in flight would re-add an entry here (stated at the worker's
 * registerFrame), so that hazard can only fail this assertion, never satisfy
 * it falsely.
 */
async function expectRegistryEmptied(serviceWorker, seedCoveredIds) {
  const after = await waitForRegistry(serviceWorker, (r) => seedCoveredIds.every((t) => !(t in r)));
  expect(after).toEqual({});
}

test.describe('worker capture bookkeeping through the introspection handle', () => {
  test("a closed tab's frames leave the registry with the tab", async ({
    testPage,
    serviceWorker,
    context,
  }) => {
    // The recording tab is registered — the handle observes the real
    // registration the readiness beacon and the seed produced.
    const before = await waitForRegistry(serviceWorker, (r) => Object.keys(r).length >= 1);
    const baseTabs = new Set(Object.keys(before));

    // A second recorded tab arrives and registers.
    const page2 = await context.newPage();
    await setTestContent(page2, '<h1>second tab</h1>');
    const withSecond = await waitForRegistry(
      serviceWorker,
      (r) => Object.keys(r).length === baseTabs.size + 1,
    );
    const page2TabId = Object.keys(withSecond).find((k) => !baseTabs.has(k));
    expect(page2TabId).toBeTruthy();
    expect(withSecond[page2TabId]).toContain(0); // its main frame is registered

    // Close the tab: its whole frame set departs with it, and the first tab's
    // registration is untouched.
    await page2.close();
    const after = await waitForRegistry(serviceWorker, (r) => !(page2TabId in r));
    for (const k of baseTabs) expect(after).toHaveProperty(k);
  });

  test('a record-start on the panel-protocol route clears every planted entry and seeds the registry to the live frames', async ({
    serviceWorker,
    context,
    panelPage,
  }) => {
    // Start a recording through the panel protocol, with a real recorded page.
    expect((await sendSWMessage(panelPage, { type: 'PROJECT_CREATE', name: 'P' })).ok).toBe(true);
    expect((await sendSWMessage(panelPage, { type: 'RECORDING_CREATE', name: 'R' })).ok).toBe(true);
    const page = await context.newPage();
    await setTestContent(page, '<h1>recorded page</h1>');
    const seedCoveredIds = await seedCoveredOnceRegistered(serviceWorker);

    // Stop by a DIRECT flag write, not the panel route: a direct write leaves
    // the watch's clear as the stop's sole clear (stated at the worker's
    // recording-flag watch), where a panel stop also runs the chokepoint clear
    // synchronously and the wait below is satisfiable by that one alone. Driven
    // this way an empty registry IS the watch's clear observed, so the
    // sentinels planted after it can only be destroyed by the start under test.
    await writeRecordingFlag(serviceWorker, false);
    await waitForRegistry(serviceWorker, (r) => Object.keys(r).length === 0);
    await plantSentinels(serviceWorker, seedCoveredIds);

    // Record-start again (the message route runs its own clear-and-seed and the
    // recording-flag watch repeats it): the observable invariant is that the
    // registry ends scoped to the new recording — every sentinel is gone and
    // the live page's frames are seeded back in. The wait carries the seed's
    // liveness (the live tabs are back and the dead-tab key is gone — the
    // planted state has that key, so it cannot satisfy this); the assertion
    // carries the discriminators the wait does not, that no sentinel survived
    // anywhere in the registry.
    expect((await sendSWMessage(panelPage, { type: 'RECORDING_START' })).ok).toBe(true);
    await expectRescopedToSeedCovered(serviceWorker, seedCoveredIds);
  });

  test('a record-start while already recording clears every planted entry without a flag transition', async ({
    testPage,
    serviceWorker,
    panelPage,
  }) => {
    // The fixture starts capture by a direct flag write and waits for the
    // recorder's readiness beacon, which rides the watch's own injection — and
    // the watch clears synchronously before it injects — so the setup's watch
    // clear is already spent when the sentinels go in. The RECORDING_CREATE
    // below writes the flag the value it already holds, so it fires no watch.
    expect((await sendSWMessage(panelPage, { type: 'PROJECT_CREATE', name: 'P' })).ok).toBe(true);
    expect((await sendSWMessage(panelPage, { type: 'RECORDING_CREATE', name: 'R' })).ok).toBe(true);
    const seedCoveredIds = await seedCoveredOnceRegistered(serviceWorker);
    await plantSentinels(serviceWorker, seedCoveredIds);

    // Start again WITHOUT stopping: the flag already holds the value this
    // route writes, so the handler's leading clear is the sole clear on this
    // route-state (why a same-value write leaves the watch idle is stated at
    // the worker's recording-flag watch). Nothing asynchronous is left behind
    // either, for the reason the direct-read helper states.
    await expectFlagAlreadyHolds(serviceWorker, true);
    expect((await sendSWMessage(panelPage, { type: 'RECORDING_START' })).ok).toBe(true);
    await expectRescopedDirectly(serviceWorker, seedCoveredIds);
  });

  test('a record-create while already recording clears every planted entry ahead of its seed', async ({
    testPage,
    serviceWorker,
    panelPage,
  }) => {
    // The fixture starts capture by a direct flag write and waits for the
    // recorder's readiness beacon, which rides the watch's own injection — and
    // the watch clears synchronously before it injects — so the setup's watch
    // clear is already spent when the sentinels go in.
    const seedCoveredIds = await seedCoveredOnceRegistered(serviceWorker);
    await plantSentinels(serviceWorker, seedCoveredIds);

    // Create a recording WITHOUT stopping first (creating one is not gated on
    // capture being idle): the flag already holds the value this route writes,
    // so the handler's leading clear is the sole clear on this route-state
    // (mechanism stated at the worker's recording-flag watch). Nothing
    // asynchronous is left behind either, for the reason the direct-read
    // helper states. The guard sits after PROJECT_CREATE so it holds the flag
    // at the moment RECORDING_CREATE is sent, not merely at the case's start.
    expect((await sendSWMessage(panelPage, { type: 'PROJECT_CREATE', name: 'P' })).ok).toBe(true);
    await expectFlagAlreadyHolds(serviceWorker, true);
    expect((await sendSWMessage(panelPage, { type: 'RECORDING_CREATE', name: 'R' })).ok).toBe(true);
    await expectRescopedDirectly(serviceWorker, seedCoveredIds);
  });

  test('a record-stop on the panel-protocol route empties the registry', async ({
    serviceWorker,
    context,
    panelPage,
  }) => {
    // Live recording with a real registered page plus the planted sentinels, so
    // the stop must destroy both real registrations and every sentinel cell.
    expect((await sendSWMessage(panelPage, { type: 'PROJECT_CREATE', name: 'P' })).ok).toBe(true);
    expect((await sendSWMessage(panelPage, { type: 'RECORDING_CREATE', name: 'R' })).ok).toBe(true);
    const page = await context.newPage();
    await setTestContent(page, '<h1>recorded page</h1>');
    const seedCoveredIds = await seedCoveredOnceRegistered(serviceWorker);
    await plantSentinels(serviceWorker, seedCoveredIds);

    // Stop. While stopped every append is refused whatever the registry holds
    // (the trust predicate — packages/extension/lib/frame-trust.js), so only
    // the handle can observe that the clear actually ran.
    // The wait carries the real registrations' departure; the assertion is the
    // whole registry going, which covers every sentinel with it.
    expect((await sendSWMessage(panelPage, { type: 'RECORDING_STOP' })).ok).toBe(true);
    await expectRegistryEmptied(serviceWorker, seedCoveredIds);
  });

  test('a second record-stop empties a registry planted after the first stop', async ({
    testPage,
    serviceWorker,
    panelPage,
  }) => {
    // Stop once by a DIRECT flag write, which leaves the watch's clear as the
    // stop's sole clear (stated at the worker's recording-flag watch) — and
    // plant an ordering probe BEFORE the write, so that clear is the only
    // thing that can consume it. One flag transition fires the watch exactly
    // once, so the probe's disappearance IS that clear, and once it is
    // observed the first stop has no clear left in flight. That is what makes
    // the pin below unconditional: the sentinels planted after it can be
    // destroyed only by the second stop's own clear. The plant here precedes
    // the flag write, so this clear can be observed rather than avoided —
    // which is why the same-value start cases can instead let their fixture's
    // one watch spend its clear before planting.
    const seedCoveredIds = await seedCoveredOnceRegistered(serviceWorker);
    // Same collision guard plantSentinels applies below, hoisted ahead of the
    // probe plant: no seed runs on this route, but a live tab owning this id
    // would still get the key back after the clear — a write from the setup's
    // injection can land late (stated at the worker's registerFrame) — and the
    // wait below would hang instead of failing with a reason.
    await expectDeadTabIdUnowned(serviceWorker);
    await plantFrame(serviceWorker, DEAD_TAB_ID, 0);
    // The read-back the plant discipline states: the wait below is satisfied by
    // absence, so a probe that landed nowhere would pass it vacuously.
    expect(await readRegistry(serviceWorker)).toHaveProperty(String(DEAD_TAB_ID));
    await writeRecordingFlag(serviceWorker, false);
    await waitForRegistry(serviceWorker, (r) => !(String(DEAD_TAB_ID) in r));

    // Plant BETWEEN the two stops, so the second stop meets a registry that is
    // not already empty.
    await plantSentinels(serviceWorker, seedCoveredIds);

    // Stop again: the flag already holds the value this route writes, so the
    // stop chokepoint is the sole clear on this route-state (mechanism stated
    // at the worker's recording-flag watch). It clears before its own storage
    // write, so the read is direct.
    await expectFlagAlreadyHolds(serviceWorker, false);
    expect((await sendSWMessage(panelPage, { type: 'RECORDING_STOP' })).ok).toBe(true);
    // Direct read; the emptied-state helper states the one-directional
    // late-write hazard.
    expect(await readRegistry(serviceWorker)).toEqual({});
  });

  test('a record-start driven by a direct write of the recording flag clears every planted entry and seeds the registry to the live frames', async ({
    testPage,
    offSeedPage,
    serviceWorker,
  }) => {
    // No panel-protocol message anywhere on this route: capture is stopped and
    // restarted by writing the recording flag the way any writer outside the
    // extension would, so only the flag watch's clear-and-seed runs.
    // Other cases drive the watch's start clear too, but never with the
    // partition planted and no call-site clear beside it — so none of them can
    // attribute a width to the watch's clear alone. This case opens its own
    // off-seed page, because it opens no panel page to host that sentinel.
    const seedCoveredIds = await seedCoveredOnceRegistered(serviceWorker);

    // Stop by a direct flag write and let the watch finish processing it, then
    // plant the sentinels.
    await writeRecordingFlag(serviceWorker, false);
    await waitForRegistry(serviceWorker, (r) => Object.keys(r).length === 0);
    await plantSentinels(serviceWorker, seedCoveredIds);

    // Restart by a direct flag write: the watch's clear-and-seed must end with
    // every sentinel gone and the live page's frames seeded back in. The wait
    // carries the seed's liveness (the live tabs are back and the dead-tab
    // key is gone — the planted state has that key, so it cannot satisfy
    // this); the assertion carries the discriminators the wait does not.
    await writeRecordingFlag(serviceWorker, true);
    await expectRescopedToSeedCovered(serviceWorker, seedCoveredIds);
  });

  test('a record-stop driven by a direct write of the recording flag empties the registry', async ({
    testPage,
    offSeedPage,
    serviceWorker,
  }) => {
    // The registered page plus the planted sentinels, then a stop with no
    // message and no setRecording call anywhere on the route — only the flag
    // watch clears. Other cases drive the watch's stop clear too, but never
    // with the partition planted and no call-site clear beside it — so none of
    // them can attribute a width to the watch's clear alone. This case opens
    // its own off-seed page, because it opens no panel page to host that
    // sentinel. The wait carries the real registrations' departure; the
    // assertion is the whole registry going.
    const seedCoveredIds = await seedCoveredOnceRegistered(serviceWorker);
    await plantSentinels(serviceWorker, seedCoveredIds);

    await writeRecordingFlag(serviceWorker, false);
    await expectRegistryEmptied(serviceWorker, seedCoveredIds);
  });

  test('a planted programmatic-tab entry suppresses the close proxy for a tab closed after a user action', async ({
    testPage,
    serviceWorker,
    context,
  }) => {
    await setTestContent(testPage, '<button id="btn">go</button>');
    const base = await waitForRegistry(serviceWorker, (r) => Object.keys(r).length >= 1);
    const baseTabs = new Set(Object.keys(base));

    // A tab created with no recent user action is not tracked as programmatic.
    const page2 = await context.newPage();
    await setTestContent(page2, '<h1>tab two</h1>');
    const withP2 = await waitForRegistry(
      serviceWorker,
      (r) => Object.keys(r).length === baseTabs.size + 1,
    );
    const page2Id = Number(Object.keys(withP2).find((k) => !baseTabs.has(k)));
    expect(await readProgrammaticTabs(serviceWorker)).toEqual([]);

    // Plant it, then close it right after a real user action: the planted
    // entry is consumed at the close and the proxy is suppressed.
    await plantProgrammaticTab(serviceWorker, page2Id);
    expect(await readProgrammaticTabs(serviceWorker)).toEqual([page2Id]);
    // The close must follow a recent user action.
    await clickAwaitingRecentAction(serviceWorker, testPage, '#btn');
    await page2.close();
    await waitForRegistry(serviceWorker, (r) => !(String(page2Id) in r));
    // The registry drop is observed before the close handler finishes deciding,
    // so let the stream settle before the negative read.
    await waitForActionsToSettle(serviceWorker, testPage);
    const afterPlanted = await getPendingActions(serviceWorker);
    expect(
      afterPlanted.filter((a) => a.type === 'context_close' && a.context_id === page2Id),
    ).toHaveLength(0);

    // Control: the same close without a planted entry appends the proxy. Let
    // the recent-action window from the click above lapse first, so this tab's
    // creation is not itself classified programmatic.
    await testPage.waitForTimeout(CREATION_WINDOW_LAPSE);
    const page3 = await context.newPage();
    await setTestContent(page3, '<h1>tab three</h1>');
    const withP3 = await waitForRegistry(
      serviceWorker,
      (r) => Object.keys(r).length === baseTabs.size + 1,
    );
    const page3Id = Number(Object.keys(withP3).find((k) => !baseTabs.has(k)));
    expect(await readProgrammaticTabs(serviceWorker)).toEqual([]);
    // Same precondition as the planted leg above.
    await clickAwaitingRecentAction(serviceWorker, testPage, '#btn');
    await page3.close();
    await waitForActions(
      serviceWorker,
      (actions) =>
        actions.filter((a) => a.type === 'context_close' && a.context_id === page3Id).length === 1,
    );
  });

  test('a programmatic tab closed after the recent-action window lapses still appends the close proxy', async ({
    testPage,
    serviceWorker,
    context,
  }) => {
    // The paired control is the planted-suppression case above: that one holds
    // the close inside the recent-action window and varies the membership,
    // this one holds the membership planted and varies the window. Between
    // them each conjunct of the suppression is what decides an outcome.
    await setTestContent(testPage, '<button id="btn">go</button>');
    const base = await waitForRegistry(serviceWorker, (r) => Object.keys(r).length >= 1);
    const baseTabs = new Set(Object.keys(base));

    // A tab created with no recent user action is not tracked as programmatic.
    const page2 = await context.newPage();
    await setTestContent(page2, '<h1>tab two</h1>');
    const withP2 = await waitForRegistry(
      serviceWorker,
      (r) => Object.keys(r).length === baseTabs.size + 1,
    );
    const page2Id = Number(Object.keys(withP2).find((k) => !baseTabs.has(k)));
    expect(await readProgrammaticTabs(serviceWorker)).toEqual([]);

    // Plant the membership this case holds, and read it back: the conjunct
    // this case does not vary is present from here on.
    await plantProgrammaticTab(serviceWorker, page2Id);
    expect(await readProgrammaticTabs(serviceWorker)).toEqual([page2Id]);

    // Stamp the marker on the click's own signal, then let the close window
    // lapse.
    await clickAwaitingRecentAction(serviceWorker, testPage, '#btn');
    await testPage.waitForTimeout(CLOSE_WINDOW_LAPSE);

    // Both conjuncts are asserted immediately before the close, membership
    // FIRST: the close handler deletes the entry before it reads the window,
    // so nothing after the close can observe the membership it decided on. The
    // marker age is read LAST, so it abuts page2.close() — a stray stamp
    // between the click and the close would reset it and fail here by name,
    // which is what makes the lapse an asserted precondition rather than a
    // clock bet. The age only grows between this read and the close, so what
    // is asserted here holds there too.
    expect(await readProgrammaticTabs(serviceWorker)).toEqual([page2Id]);
    expect(
      await readRecentActionAge(serviceWorker),
      'the close must land outside the recent-action window this case varies',
    ).toBeGreaterThanOrEqual(TAB_CLOSED_USER_ACTION_WINDOW);

    // Membership present and the window lapsed: the proxy the same membership
    // suppresses inside the window is appended here, once for this tab.
    await page2.close();
    await waitForActions(
      serviceWorker,
      (actions) =>
        actions.filter((a) => a.type === 'context_close' && a.context_id === page2Id).length === 1,
    );
  });

  test('a simulated suspension loss is healed for the appending tab by the lazy reseed', async ({
    testPage,
    serviceWorker,
  }) => {
    await setTestContent(testPage, '<button id="btn">go</button>');
    await waitForRegistry(serviceWorker, (r) => Object.keys(r).length >= 1);

    // SIMULATED suspension loss (the header states that Playwright cannot
    // force a real one): the wipe member simulates the in-memory loss one
    // causes.
    await wipeFrameRegistry(serviceWorker);
    expect(await readRegistry(serviceWorker)).toEqual({});

    // The next real append from the wiped tab is rescued by the lazy reseed:
    // the action reaches the stream and the appending tab is re-registered.
    // The reseed rebuilds THAT tab's frames and no others, so the appending
    // tab is read off the append itself rather than off the pre-wipe
    // snapshot: `context_id` is stamped from the trusted sender
    // (extension capture-principles ECP-4), so it names the sender's tab.
    const clicksBefore = (await getPendingActions(serviceWorker)).filter(
      (a) => a.type === 'click',
    ).length;
    await testPage.click('#btn');
    const settled = await waitForActions(
      serviceWorker,
      (actions) => actions.filter((a) => a.type === 'click').length === clicksBefore + 1,
    );
    const appendingTabId = settled.filter((a) => a.type === 'click').at(-1).context_id;
    expect(typeof appendingTabId, 'the rescued append must carry a numeric context_id').toBe(
      'number',
    );
    const healed = await readRegistry(serviceWorker);
    expect(healed).toHaveProperty(String(appendingTabId));
  });

  test('a simulated suspension loss of the programmatic-tab set turns a scripted close into a recorded context_close', async ({
    testPage,
    serviceWorker,
  }) => {
    // Real user clicks drive both the open and the close: #opener calls
    // window.open directly in its handler; #closer closes the popup on a short
    // delay so the captured click's recent-action marker lands first.
    await setTestContent(
      testPage,
      '<button id="opener">open</button><button id="closer">close</button>',
    );
    await testPage.evaluate((closeDelay) => {
      let w = null;
      // A bare _blank open lands in a TAB of the same window: the later close
      // must arrive as a tab close, not a whole-window close (which the close
      // proxy suppresses as cascading regardless of the tracking set).
      document.getElementById('opener').addEventListener('click', () => {
        w = window.open('about:blank', '_blank');
      });
      document.getElementById('closer').addEventListener('click', () => {
        if (w) setTimeout(() => w.close(), closeDelay);
      });
    }, CLOSE_AFTER_ACTION_DELAY);

    // Control: an organically tracked programmatic tab's scripted close is
    // suppressed — no context_close enters the stream.
    await testPage.click('#opener');
    const withPopup1 = await waitForProgrammaticTabs(serviceWorker, (tabs) => tabs.length === 1);
    const popup1Id = withPopup1[0];
    await testPage.click('#closer');
    await waitForProgrammaticTabs(serviceWorker, (tabs) => tabs.length === 0);
    // The set-delete is observed before the close handler finishes deciding, so
    // let the stream settle before the negative read.
    await waitForActionsToSettle(serviceWorker, testPage);
    const afterControl = await getPendingActions(serviceWorker);
    expect(
      afterControl.filter((a) => a.type === 'context_close' && a.context_id === popup1Id),
    ).toHaveLength(0);

    // SIMULATED suspension loss: wipe the set the way a worker suspension
    // would lose it, then run the identical flow. The close proxy now appends
    // a context_close the user never performed — the loss signature of the
    // degradation the correlation-marker class already admits.
    await testPage.click('#opener');
    const withPopup2 = await waitForProgrammaticTabs(serviceWorker, (tabs) => tabs.length === 1);
    const popup2Id = withPopup2[0];
    await wipeProgrammaticTabs(serviceWorker);
    expect(await readProgrammaticTabs(serviceWorker)).toEqual([]);
    await testPage.click('#closer');
    await waitForActions(
      serviceWorker,
      (actions) =>
        actions.filter((a) => a.type === 'context_close' && a.context_id === popup2Id).length === 1,
    );
  });
});

// ─── The platform premise beneath the same-value routes ──────────────────────

// A storage key the extension does not own, held before use against every key
// its surfaces store — the worker's own writes, the panel adapter's settings
// keys, and the recorder's marker — so this case observes its own writes and
// nothing else observes them. The case pre-asserts the key reads back unset
// besides, so a key introduced under this name later cannot decide it
// silently.
const PREMISE_KEY = 'docentSameValueWriteProbe';

/** Read the premise key straight from extension storage. */
const readPremiseKey = (serviceWorker) =>
  serviceWorker.evaluate(async (k) => (await chrome.storage.local.get(k))[k], PREMISE_KEY);

/** Write a value to the premise key. */
const writePremiseKey = (serviceWorker, value) =>
  serviceWorker.evaluate(
    async ([k, v]) => {
      await chrome.storage.local.set({ [k]: v });
    },
    [PREMISE_KEY, value],
  );

/**
 * Record the new value of every change event the premise key reports, in the
 * order they arrive. The listener is an observer installed beside the
 * production ones — Chrome dispatches a change to every listener — the shape
 * the readiness probe uses (helpers/frame-ready.js).
 */
const installPremiseProbe = (serviceWorker) =>
  serviceWorker.evaluate((k) => {
    globalThis.__premiseProbeEvents = [];
    globalThis.__premiseProbeListener = (changes, area) => {
      if (area === 'local' && k in changes)
        globalThis.__premiseProbeEvents.push(changes[k].newValue);
    };
    chrome.storage.onChanged.addListener(globalThis.__premiseProbeListener);
  }, PREMISE_KEY);

const readPremiseProbeEvents = (serviceWorker) =>
  serviceWorker.evaluate(() => globalThis.__premiseProbeEvents);

/** Retire the observer and the key it watched. */
const removePremiseProbe = (serviceWorker) =>
  serviceWorker.evaluate(async (k) => {
    chrome.storage.onChanged.removeListener(globalThis.__premiseProbeListener);
    delete globalThis.__premiseProbeListener;
    delete globalThis.__premiseProbeEvents;
    await chrome.storage.local.remove(k);
  }, PREMISE_KEY);

const waitForPremiseEvents = (serviceWorker, predicate) =>
  waitForState(() => readPremiseProbeEvents(serviceWorker), predicate, 'premise-key change events');

test.describe('the storage premise the same-value routes rest on', () => {
  test('a write of the value a key already holds fires no change event', async ({
    serviceWorker,
  }) => {
    // The premise the same-value cases above attribute their clears to, whose
    // prose home is the worker's recording-flag watch: storage.onChanged fires
    // only when a stored value actually changes. The rule is the platform's,
    // so it is pinned here on a key the extension does not own rather than on
    // the recording flag, which production writers also watch.
    expect(
      await readPremiseKey(serviceWorker),
      'the premise key must start unset, or a value left by something else would decide this case',
    ).toBeUndefined();
    await installPremiseProbe(serviceWorker);

    // Establish a value and observe its event. This entry is the structural
    // control: an observer that sees nothing at all cannot reach the equality
    // assertion below, because the list it holds is never empty there.
    await writePremiseKey(serviceWorker, 'established');
    await waitForPremiseEvents(serviceWorker, (events) => events.length >= 1);

    // The write under test, then a write of a DIFFERENT value, each awaited
    // before the next. storage.onChanged dispatches in write order, so once
    // the different-value event is observed, a same-value event would already
    // have landed were it ever coming — the ordering barrier that replaces a
    // duration wait here. The different-value write is also what exercises the
    // barrier: making the same-value write carry a different value puts a
    // third entry between these two and reds the assertion below.
    await writePremiseKey(serviceWorker, 'established');
    await writePremiseKey(serviceWorker, 'different');
    const observed = await waitForPremiseEvents(serviceWorker, (events) =>
      events.includes('different'),
    );

    // Exactly the two writes that changed the value, in the order they ran.
    expect(observed).toEqual(['established', 'different']);

    await removePremiseProbe(serviceWorker);
  });
});
