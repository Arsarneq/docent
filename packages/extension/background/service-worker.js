/**
 * Docent — Background Service Worker
 *
 * Hosts the message dispatcher (panel requests and the recorder's capture
 * path), recorder injection, the browser-chrome proxies, and the background
 * Auto-Sync host. Actions captured by the recorder arrive as APPEND_ACTION
 * messages: the worker validates the sender against the active-frame
 * registry, stamps context_id from the trusted sender, applies the
 * sensitive-value redaction chokepoint, and appends to pendingActions in
 * chrome.storage.local through a serialized write queue gated by storage
 * pressure. The worker also originates its own captures — the browser-chrome
 * navigation and context proxies below (extension capture-principles ECP-7)
 * — through the same queue and chokepoint; this worker owns every
 * pendingActions write (extension runtime ERT-3). The pending buffer and the
 * model are persisted, so they survive SW suspension; worker memory holds
 * only state safe to lose with the worker — mirrors of persisted keys
 * restored at each start, the active-frame registry lazily reseeded on
 * append, and correlation markers whose loss the proxy detections already
 * tolerate (extension runtime ERT-1).
 *
 * Core model and capture keys (chrome.storage.local — the complete key
 * inventory and write ownership is the ERT-3 table in the runtime doc):
 *   projects[]         — all saved projects
 *   activeProjectId    — project of the recording capture goes to, as the
 *                        panel that last opened or created one set it
 *   activeRecordingId  — recording capture goes to
 *   recording          — whether the content script should capture events
 *   pendingActions[]   — actions captured since last step boundary
 *   pendingCount       — length of pendingActions (for panel commit button)
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */
// Governance declared in scripts/area-map.json (see its declared-governance entry): the navigation and context actions this worker records enter the .docent.json action stream; the per-platform schemas are authoritative for field semantics.

import {
  createProject,
  createRecording,
  findRecording,
  createStep,
  addStepRecord,
  deleteStep,
  reorderSteps,
  resolveActiveSteps,
} from '../shared/lib/session.js';
import { uuidv7 } from '../shared/lib/uuid-v7.js';
import { redactSensitive, repeatsMaskedEntry } from '../lib/redaction-logic.js';
import {
  TAB_CREATED_USER_ACTION_WINDOW,
  TAB_CLOSED_USER_ACTION_WINDOW,
  TAB_CREATED_SWITCH_SUPPRESSION,
  TAB_REMOVED_SWITCH_SUPPRESSION,
  TAB_CREATED_NAVIGATION_SUPPRESSION,
  END_TYPING_BOUND,
} from '../lib/capture-timing.js';
import { STORAGE_QUOTA_KEY, classifyStoragePressure } from '../lib/storage-quota.js';
import { isTrustedActionSender } from '../lib/frame-trust.js';
import { createHeldKeysRelay } from '../lib/held-keys-relay.js';
import { NOT_ACTIVE_RECORDING, namesActiveRecording } from '../lib/active-recording.js';
import {
  classifyNavigation,
  normaliseNavigationUrl,
  isDuplicateNavigation,
  shouldCaptureTabCreated,
} from '../lib/navigation-logic.js';
// Auto-Sync background host. The triggered cycle calls
// the SAME shared `sync()` the manual panel path does, through the SAME
// chrome-backed adapter, so a background cycle and a manual cycle are identical
// apart from origin. The shared cooldown-debounced scheduler
// (sync-scheduler.js) owns coalescing/overlap/capture-drop.
import { createSyncTrigger, BACKSTOP_INTERVAL_MS } from '../shared/sync-scheduler.js';
import { sync } from '../shared/sync-client.js';
import { loadSyncState, saveSyncState, getSettings, setSettings } from '../shared/sync-store.js';
// The generated platform validator, applied to each pulled payload. The
// panel loads this via dynamic import (adapter-chrome.loadValidator), but a
// Manifest V3 service worker CANNOT use dynamic import() — so the background
// cycle imports it STATICALLY here. (A dynamic import in the SW throws, which
// previously surfaced as `validator is not a function` and aborted every
// Auto-Sync cycle before its push.)
import validateExtensionPayload from '../shared/generated/validate-extension.js';
// Reuse the panel's platform adapter for the durable SyncStore, LiveState
// signals, settings, and schema fetch the background cycle needs.
// adapter-chrome.js touches only chrome.* + fetch (no DOM). NOTE: its
// loadValidator() uses dynamic import(), which a Manifest V3 service worker
// cannot do — so the SW does NOT call loadValidator() and instead imports the
// generated validator statically (see above).
import chromeAdapter from '../sidepanel/adapter-chrome.js';

// ─── In-memory state (restored from storage on SW restart) ───────────────────

let projects = [];
let activeProjectId = null;
let activeRecordingId = null;
// In-memory mirror of the `recording` capture flag, kept in sync via
// chrome.storage.onChanged. The Auto-Sync scheduler's capture probe is
// synchronous (it drops triggers while capture is active), so the SW
// holds the flag in memory rather than awaiting a storage read on every trigger.
let liveRecording = false;

// Active-frame registry: tabId → Set<frameId> of the frames registered as
// trusted — seeded from the browser's frame table at record-start and written
// per frame by the on-load registration and each recorder's readiness beacon;
// an entry leaves as its subframe navigates away or its tab closes, and the
// whole registry is cleared at record-start ahead of the seed and on every
// record-stop path (extension capture-principles ECP-3). A frame is "trusted"
// (its APPEND_ACTION messages are appended, its POINTER_PRESSED acted on) only
// if it is in this registry —
// that is the per-frame sender check that stops an embedded third-party frame,
// or any page that can reach the message port, from injecting actions into a
// session.
//
// In-memory only — frameIds are session-scoped and churn as frames load/unload,
// so this is NOT persisted. An SW restart leaves it empty, and a clear can leave
// a live tab's key missing from a registry that is not; on either, the sender
// test of an APPEND_ACTION and of a POINTER_PRESSED lazily reseeds the sender's
// tab from chrome.webNavigation rather than false-rejecting a legitimate frame
// whose registration is gone, and a step commit and a stop reseed every
// capture-target tab that is missing before they ask the frames to end their
// typing.
const activeFrames = new Map();

/**
 * Add (tabId, frameId) to the active-frame registry. A write from a production
 * writer can land here after a record-stop's clear, harmlessly: it re-adds
 * entries no capture decision acts on while stopped, since an append is refused
 * whatever the registry holds and every start clears ahead of its seed. The
 * introspection handle's plant runs from no production event (extension runtime
 * ERT-5), so it lands at the moment a case plants it, outside that account.
 */
// The keys held across the frames of each recorded tab, as the recorders
// report them (HELD_KEY, POINTER_PRESSED): an action in one frame is given
// the keys held in the tab's other frames (#779). In memory only: after a
// suspension nothing is known to be held elsewhere until it is reported
// again. Its entries leave with the registry's: a frame that navigates, a
// tab that closes, every clear of the registry.
const heldKeysRelay = createHeldKeysRelay();

function registerFrame(tabId, frameId) {
  if (tabId == null || frameId == null) return;
  let frames = activeFrames.get(tabId);
  if (!frames) {
    frames = new Set();
    activeFrames.set(tabId, frames);
  }
  frames.add(frameId);
}

/** Seed the registry for a tab from the frames currently loaded in it. */
async function seedFramesForTab(tabId) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    for (const f of frames ?? []) registerFrame(tabId, f.frameId);
  } catch {
    // Tab may have gone away or not be queryable — leave the registry as-is.
  }
}

/**
 * The tabs a record-start targets, as ONE query: the record-start sweep injects
 * the recorder into them and the registry seed registers their frames, so the
 * two cover the same set by construction rather than by two matching literals
 * (the set extension capture-principles ECP-2 defines for record-start). It
 * bounds those two only: the per-frame writers extension capture-principles
 * ECP-3 states — the on-load registration below and each recorder's
 * readiness beacon — each admit the (tab, frame) pair their own event carries,
 * whatever tab it sits in.
 */
function queryCaptureTargetTabs() {
  return chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
}

/** Seed the registry for the tabs a record-start targets. */
async function seedActiveFrames() {
  try {
    const tabs = await queryCaptureTargetTabs();
    await Promise.allSettled(tabs.map((tab) => seedFramesForTab(tab.id)));
  } catch {
    // Best-effort — a failed seed is recovered by the lazy reseed on append.
  }
}

/**
 * Clear the whole registry — the clears extension capture-principles ECP-3
 * states, at the call sites that run them: the record-start clear-and-seed
 * routes, every record-stop path, and both branches of the recording-flag
 * watch.
 */
function clearActiveFrames() {
  activeFrames.clear();
  // The keys held in the registered frames go with the registry.
  heldKeysRelay.forgetAll();
}

/**
 * Ask one frame to end its typing. Settles when the frame has answered, which
 * it does once what it wrote is stored; never rejects. Gives the recorder's
 * answer, and null where none came: a frame with no recorder, or one that
 * went away.
 */
async function askFrameToEndTyping(tabId, frameId) {
  try {
    return (await chrome.tabs.sendMessage(tabId, { type: 'END_TYPING' }, { frameId })) ?? null;
  } catch {
    // No recorder there, or the frame is gone: nothing to end.
    return null;
  }
}

/**
 * Ask one frame which of its reports of held keys is its last, with nothing
 * else asked of it. Gives the recorder's answer, and null where none came.
 */
async function askFrameForHeldKeyReports(tabId, frameId) {
  try {
    return (
      (await chrome.tabs.sendMessage(tabId, { type: 'HELD_KEY_REPORTS' }, { frameId })) ?? null
    );
  } catch {
    return null;
  }
}

/** Settles with `value` once `promise` has, or with null at END_TYPING_BOUND. */
function withinTheBound(promise) {
  let timer;
  const bound = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), END_TYPING_BOUND);
  });
  return Promise.race([promise, bound]).finally(() => clearTimeout(timer));
}

/**
 * Bring the held-keys relay level with one frame, from the answer it gave to
 * an ask: wait for the report the recorder names as its last, which can
 * arrive behind the answer. A frame that gave no answer, or whose last
 * report does not arrive within the bound, has said nothing sure of the keys
 * it reported as held: they are forgotten.
 */
async function levelHeldKeysWith(tabId, frameId, answer) {
  const last = answer?.heldReports;
  if (answer && !last) return;
  const seen =
    last &&
    (await withinTheBound(
      heldKeysRelay.whenSeen(tabId, frameId, last.recorder, last.seq).then(() => true),
    ));
  if (!seen) heldKeysRelay.forgetFrame(tabId, frameId);
}

/**
 * Ask the frames given to end their typing, and wait for the answers up to
 * END_TYPING_BOUND. A frame that has not answered by then is named in a
 * warning, so an entry that came late can be explained.
 *
 * @param {Array<[number, number]>} frames — (tabId, frameId) pairs
 * @returns {Promise<Map<[number, number], object|null>>} each frame's answer,
 *   null where no recorder gave one in that time
 */
async function endTypingIn(frames) {
  const answered = new Map(frames.map((frame) => [frame, null]));
  if (frames.length === 0) return answered;
  const unanswered = new Set(frames);
  const answers = Promise.all(
    frames.map((frame) =>
      askFrameToEndTyping(...frame).then((answer) => {
        unanswered.delete(frame);
        answered.set(frame, answer);
      }),
    ),
  );
  let timer;
  const bound = new Promise((resolve) => {
    timer = setTimeout(resolve, END_TYPING_BOUND);
  });
  await Promise.race([answers, bound]);
  clearTimeout(timer);
  if (unanswered.size > 0) {
    console.warn('[Docent] Frames did not end their typing within the bound', {
      frames: [...unanswered].map(([tabId, frameId]) => ({ tabId, frameId })),
    });
  }
  return answered;
}

/**
 * Seed the registry for the capture-target tabs it holds no entry for: a
 * suspension lost the registry, and typing sends the worker nothing, so the
 * tab typed into can be missing when the typing is to end.
 */
async function seedTabsMissingFromRegistry() {
  try {
    const tabs = await queryCaptureTargetTabs();
    await Promise.allSettled(
      tabs.filter((tab) => !activeFrames.has(tab.id)).map((tab) => seedFramesForTab(tab.id)),
    );
  } catch {
    // Best-effort, as the record-start seed is.
  }
}

/**
 * Ask every registered frame to end its typing, and wait for the answers up
 * to END_TYPING_BOUND: the end of typing at a step commit and at a stop. An
 * entry typed into a field or editable content that still has the focus is
 * the person's input of that step, and nothing in the page says the step has
 * ended.
 */
async function endTypingInEveryFrame() {
  await seedTabsMissingFromRegistry();
  const frames = [];
  for (const [tabId, frameIds] of activeFrames) {
    for (const frameId of frameIds) frames.push([tabId, frameId]);
  }
  await endTypingIn(frames);
}

/**
 * A pointer press in one frame ends the typing in the tab's other frames,
 * which see nothing of it. Settles once those frames have answered, or at the
 * bound; a press from a sender that is not trusted asks no frame.
 */
async function endTypingInOtherFrames(sender) {
  await restoreWhatSuspensionLost(sender);
  if (
    !isTrustedActionSender({ sender, runtimeId: chrome.runtime.id, liveRecording, activeFrames })
  ) {
    return;
  }
  const tabId = sender.tab.id;
  const others = [...(activeFrames.get(tabId) ?? [])].filter((id) => id !== sender.frameId);
  const answers = await endTypingIn(others.map((frameId) => [tabId, frameId]));
  // The press's own actions name the keys held in those frames as their
  // reports up to the answer leave them.
  await Promise.all(
    [...answers].map(([[, frameId], answer]) => levelHeldKeysWith(tabId, frameId, answer)),
  );
}

/**
 * The same for an action with no press before it: the frames whose keys it
 * would be given are asked for their last report, and nothing else.
 */
async function levelHeldKeysWithFrames(tabId, frameIds) {
  await Promise.all(
    frameIds.map(async (frameId) =>
      levelHeldKeysWith(
        tabId,
        frameId,
        await withinTheBound(askFrameForHeldKeyReports(tabId, frameId)),
      ),
    ),
  );
}

// Press holds: "tabId:frameId" → a promise that settles once the typing a
// press in that frame ended is written. What the pressing frame appends next
// (the `click` its release writes) waits on it, so that entry is stored ahead
// of the click however short the press was.
const pressHolds = new Map();

const pressHoldKey = (sender) =>
  sender?.tab?.id == null || sender.frameId == null ? null : `${sender.tab.id}:${sender.frameId}`;

/**
 * Open the watch for the keys an action is given beside its own: those held
 * in the tab's other frames (lib/held-keys-relay.js). Where a key of another
 * frame is among them, that frame is asked for its last report first, and
 * what the sender appends is held behind the answer, and behind any hold
 * that stands: a frame's reports can arrive late, and a key is named only by
 * what its frame has reported up to the action. Called synchronously as the
 * action's message arrives. Null for an action that carries no `held_keys`.
 */
function watchKeysHeldElsewhere(action, sender) {
  const tabId = sender?.tab?.id;
  if (!Array.isArray(action?.held_keys) || tabId == null || sender.frameId == null) return null;
  const frames = heldKeysRelay.framesHoldingFor(tabId, sender.frameId);
  if (frames.length > 0) holdAppendsBehind(sender, levelHeldKeysWithFrames(tabId, frames));
  return heldKeysRelay.watch(
    tabId,
    sender.frameId,
    action.type === 'key' ? action.code : undefined,
  );
}

/** Pass a registered frame's report to the held-keys relay. */
function reportToHeldKeysRelay(sender, report) {
  const trusted = isTrustedActionSender({
    sender,
    runtimeId: chrome.runtime.id,
    liveRecording,
    activeFrames,
  });
  if (trusted) heldKeysRelay.report(sender.tab.id, sender.frameId, report);
}

/**
 * Take a press hold for the frame that reported a pointer press. Called
 * synchronously from the message listener, so the hold stands before the
 * frame's next message is read.
 */
function holdAppendsBehindPress(sender) {
  holdAppendsBehind(sender, endTypingInOtherFrames(sender));
}

/** Hold what the frame appends next behind `work`, and behind any hold it has. */
function holdAppendsBehind(sender, work) {
  const key = pressHoldKey(sender);
  if (key == null) return;
  const hold = Promise.all([pressHolds.get(key), work]).then(
    () => undefined,
    () => undefined,
  );
  pressHolds.set(key, hold);
  hold.then(() => {
    if (pressHolds.get(key) === hold) pressHolds.delete(key);
  });
}

// ─── Worker-state introspection handle ────────────────────────────────────────

/**
 * Introspection handle over the worker's in-memory capture bookkeeping — the
 * active-frame registry above and the programmatic-tab set declared with its
 * consumers below — and over the tab set a record-start would target, which is
 * no worker structure at all: it is answered by running the seed's own query
 * above, so an observer of what a clear spared never restates that set. The
 * member surface — what each member reaches and what it does — and why the
 * handle is not a page-visible surface are stated with the surface they
 * belong to (extension runtime ERT-5), which is also where a member
 * added, removed, or renamed here is stated in the same change. The object is
 * frozen, so no member can be replaced or added in place. The freeze does not
 * hold the surface, though — the globalThis binding is writable like every
 * worker global, so rebinding it installs a different handle with no edit here;
 * that direction is review-held. No capture decision reads the handle.
 */
globalThis.__docentCaptureBookkeeping = Object.freeze({
  /** Snapshot of the active-frame registry as [tabId, frameId[]] pairs. */
  frameRegistry: () => [...activeFrames].map(([tabId, frames]) => [tabId, [...frames]]),
  /** Snapshot of the programmatic-tab set as tabId[]. */
  programmaticTabs: () => [...programmaticTabs],
  /** The ids a record-start would target, read through the seed's own query. */
  captureTargetTabIds: async () => (await queryCaptureTargetTabs()).map((t) => t.id),
  /** Register a (tabId, frameId) entry the way a production registration does. */
  plantFrame: (tabId, frameId) => registerFrame(tabId, frameId),
  /** Plant a programmatic-tab entry. */
  plantProgrammaticTab: (tabId) => programmaticTabs.add(tabId),
  /** Simulate suspension loss of the registry (raw wipe, not a clear path). */
  wipeFrameRegistry: () => activeFrames.clear(),
  /** Simulate suspension loss of the programmatic-tab set. */
  wipeProgrammaticTabs: () => programmaticTabs.clear(),
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    await chrome.storage.local.set({ projects: [], pendingActions: [], pendingCount: 0 });
  }
  console.log(`[Docent] onInstalled (${reason}).`);
});

// Restore persisted state on SW restart. A message that woke the worker is
// read before this has finished, so the sender test waits on it: capture that
// was on is still on.
const stateRestored = (async () => {
  const stored = await chrome.storage.local.get([
    'projects',
    'activeProjectId',
    'activeRecordingId',
    'recording',
    STORAGE_QUOTA_KEY,
  ]);
  projects = stored.projects ?? [];
  activeProjectId = stored.activeProjectId ?? null;
  activeRecordingId = stored.activeRecordingId ?? null;
  // Do NOT reset recording — the user controls that, not the SW.
  // pendingActions stay in chrome.storage.local — preserved across SW restarts.

  // Seed the in-memory capture mirror so the Auto-Sync scheduler's synchronous
  // capture probe is correct from the first trigger, and reconcile the
  // background trigger with the persisted `autoSync` setting so Auto-Sync keeps
  // running with the panel closed across SW restarts.
  liveRecording = stored.recording === true;

  // Rehydrate the storage-quota gate (#127) so an MV3 suspension doesn't silently
  // forget the user's "keep recording" override or the warn hysteresis — otherwise
  // capture would re-pause on the next wake. (This worker is the key's writer —
  // extension runtime ERT-3 — so the stored value is its own last state.)
  const quota = stored[STORAGE_QUOTA_KEY];
  if (quota) {
    userOverride = quota.override === true;
    wasWarn = quota.band === 'warn';
    storagePaused = quota.paused === true;
    publishedQuota = { band: quota.band, paused: quota.paused, override: quota.override === true };
  }
})();

stateRestored
  .then(async () => {
    await reconcileAutoSync();
    // Reconcile the gate against actual usage now (honouring any restored override),
    // so the in-memory gate and the published key agree immediately on wake rather
    // than after the next capture/persist/clear.
    await evaluateStoragePressure();
  })
  .catch((err) => console.error('[Docent] Failed to restore state', err));

// Open side panel when toolbar icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// When the recording flag becomes true, run the record-start sequence: inject
// the recorder into every frame the browser lets the extension reach in
// every open http/https tab (extension capture-principles ECP-2), then seed
// the registry from the browser's frame table (ECP-3).
// Also mirror the `recording` flag into memory so the Auto-Sync scheduler can
// drop triggers synchronously while capture is active.
// The recording-flag watch keys the registry's clears to the flag itself
// (extension capture-principles ECP-3), so how the flag changes decides which
// clears run: storage.onChanged fires only when a stored value actually
// changes — a same-value write fires no event — so the watch repeats the start
// routes' clear-and-seed and the stop routes' clear only on a flag transition;
// on a same-value start or stop the call-site clear is the sole clear; and on
// a flag write that reaches no call-site clear at all — a writer outside the
// extension's own routes, which ERT-1's mirrors doctrine requires this watch to
// answer — this watch is the sole clear when that write transitions the flag,
// and no clear runs when it does not.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.recording) {
    liveRecording = changes.recording.newValue === true;
    if (changes.recording.newValue === true) {
      // Inject into the open http/https tabs' frames, then seed the registry
      // from the browser's frame table (ECP-3). Clearing first keeps the
      // registry scoped to the new recording.
      clearActiveFrames();
      injectContentScript().then(() => seedActiveFrames());
    } else {
      // The flag went false, on whatever route — drop the active-frame registry.
      clearActiveFrames();
    }
  }
});

// When a frame finishes loading while recording, inject the recorder into THAT
// specific frame and register it as trusted. This is the during-recording
// injection path (extension capture-principles ECP-2): it runs for every frame,
// not just the main frame, wherever the browser lets the extension reach it, so
// main frames, srcdoc iframes, dynamically created child frames, and the frames
// of tabs opened mid-recording are each covered as they finish loading. This
// route injects as early as the browser allows (injectImmediately), and it is
// where the inject-to-ready bound (extension capture-principles ECP-5) is
// measured.
chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (!(await isRecording())) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: details.tabId, frameIds: [details.frameId] },
      files: ['content/recorder.js'],
      injectImmediately: true,
    });
    registerFrame(details.tabId, details.frameId);
  } catch {
    // Frame may not be injectable (e.g. chrome:// pages) — ignore.
  }
});

// A subframe navigating away unloads its recorder; drop it from the
// active-frame registry so a stale frameId can't be reused. (A main
// frame's registration follows on the next onCompleted, so main frames
// are left alone here.)
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  // The release of a key held in a document that is leaving is not sure to
  // be reported: a main frame takes its tab's frames with it.
  if (details.frameId === 0) {
    heldKeysRelay.forgetTab(details.tabId);
    return;
  }
  heldKeysRelay.forgetFrameAndItsRecorder(details.tabId, details.frameId);
  const frames = activeFrames.get(details.tabId);
  if (frames) frames.delete(details.frameId);
});

// ─── Navigation & context lifecycle capture ──────────────────────────────────
// The SW records the browser-chrome proxies: cross-document navigations
// (including back/forward/reload), context opens, context closes, and context
// switches. In-page (SPA) navigations are not captured: no history-state
// listener (extension capture-principles ECP-8; ECP-12 lists the same-document
// back/forward exception).
// All actions are stamped with context_id so the receiving system knows which
// context the action occurred in.

// Serialised write queue — prevents race conditions when multiple SW events
// (e.g. context_open + navigate) fire simultaneously.
let swWriteQueue = Promise.resolve();

// Sensitive-data redaction at the storage chokepoint lives in
// lib/redaction-logic.js (pure, single-sourced with the unit suite — the
// frame-trust.js discipline). Applied at EVERY pendingActions write (here +
// the inline navigate writes), so no captured value reaches storage
// unredacted.

// Capture auto-pauses for storage pressure once usage crosses WARN_BYTES — UNLESS
// the user chose to keep recording (the override). While paused, new captures are
// dropped (not grown into storage) until the user frees space (usage < RESUME_BYTES,
// which also clears the override) or overrides. A hard `exceeded` always pauses —
// nothing writes past a full quota. All mirrored in memory so the queued write
// callbacks gate synchronously; `wasWarn` carries the band hysteresis across calls.
let storagePaused = false;
let userOverride = false; // the user chose to keep recording past the warning (#127)
let wasWarn = false; // band hysteresis: warn persists until usage < RESUME_BYTES
// Last { band, paused, override } published — avoids re-writing (and re-firing the
// panel's onChanged) when nothing the panel cares about has moved.
let publishedQuota = null;

function isQuotaError(err) {
  return !!err && (err.name === 'QuotaExceededError' || /quota/i.test(err?.message ?? ''));
}

// Re-read storage usage, classify the pressure band (with hysteresis), decide the
// pause (warn auto-pauses unless the user overrode; exceeded always pauses), update
// the in-memory gate, and publish the state to STORAGE_QUOTA_KEY for the panel —
// only when it changes, to avoid noisy onChanged churn.
async function evaluateStoragePressure({ exceeded = false } = {}) {
  let bytesInUse = 0;
  try {
    bytesInUse = await chrome.storage.local.getBytesInUse(null);
  } catch {
    if (!exceeded) return; // can't measure and nothing forced it — leave the gate as-is
  }
  const band = classifyStoragePressure(bytesInUse, wasWarn, exceeded);
  wasWarn = band === 'warn';
  if (band === 'ok') userOverride = false; // back under control — re-arm the warning
  const paused = band === 'exceeded' || (band === 'warn' && !userOverride);
  storagePaused = paused;
  if (
    publishedQuota &&
    publishedQuota.band === band &&
    publishedQuota.paused === paused &&
    publishedQuota.override === userOverride
  ) {
    return;
  }
  publishedQuota = { band, paused, override: userOverride };
  try {
    await chrome.storage.local.set({
      [STORAGE_QUOTA_KEY]: { band, paused, override: userOverride, bytesInUse },
    });
  } catch (err) {
    // Genuinely out of room even for this tiny status write — keep the in-memory
    // gate set, allow a retry next time, and rely on any prior warn state.
    publishedQuota = null;
    console.warn('[Docent] could not persist storageQuota state', err);
  }
}

// The user chose to keep recording despite the storage-pressure warning (#127).
// Override the auto-pause; capture resumes until usage drops back to ok (which
// clears the override) or hits the hard quota wall.
async function resumeCaptureDespitePressure() {
  userOverride = true;
  await evaluateStoragePressure();
}

// Append already-redacted actions to pendingActions with storage-quota handling.
// MUST be called inside swWriteQueue. Returns false when the append was dropped
// (capture paused for storage, or a hard quota failure); true on success.
// Every captured action is appended here, so this is where each one takes
// its `preferred_languages`: the browser's ordered language preference as this
// worker reads it, null where the browser gives no list (session-format states
// the field).
async function appendToPending(actions) {
  if (storagePaused) return false; // paused for storage pressure — drop new captures
  const { pendingActions } = await chrome.storage.local.get('pendingActions');
  const languages = globalThis.navigator?.languages;
  const preferred = Array.isArray(languages) ? [...languages] : null;
  // Typing into a sensitive field is one masked `type`: one that repeats the
  // action stored just before it is not stored again (lib/redaction-logic.js).
  const updated = [...(pendingActions ?? [])];
  for (const action of actions) {
    const stamped = { ...action, preferred_languages: preferred };
    if (!repeatsMaskedEntry(updated.at(-1), stamped)) updated.push(stamped);
  }
  if (updated.length === (pendingActions ?? []).length) return true;
  try {
    await chrome.storage.local.set({ pendingActions: updated, pendingCount: updated.length });
  } catch (err) {
    if (isQuotaError(err)) {
      // Hard quota failure. The failed set leaves prior storage intact (read-
      // modify-write), so existing recordings are safe. Surface it (paused +
      // exceeded) rather than swallow it, and stop appending.
      console.warn('[Docent] storage quota exceeded — pausing capture', err);
      await evaluateStoragePressure({ exceeded: true });
      return false;
    }
    throw err;
  }
  await evaluateStoragePressure();
  return true;
}

async function appendSwAction(action) {
  const safe = redactSensitive(action);
  swWriteQueue = swWriteQueue.then(() => appendToPending([safe]));
  return swWriteQueue;
}

/**
 * Bring back the two things a suspended worker comes back without, ahead of a
 * sender test (extension capture-principles ECP-3): the stored recording flag,
 * and the sender's tab in the registry. If a recording is live but the tab has
 * no entry, its registration is missing — a suspension lost the registry, or a
 * clear took a key the following seed does not re-cover — so the tab's frames
 * are rebuilt from webNavigation BEFORE the test, rather than false-rejecting
 * a legitimate frame.
 */
async function restoreWhatSuspensionLost(sender) {
  await stateRestored.catch(() => undefined);
  const tabId = sender?.tab?.id;
  if (liveRecording && tabId != null && !activeFrames.has(tabId)) {
    await seedFramesForTab(tabId);
  }
}

// Validate an APPEND_ACTION sender against the active-frame registry, then append
// on success. Drops untrusted senders silently (warn + return — never throw), so
// a frame outside the registry cannot write actions into the recording.
async function validateAndAppend(action, sender) {
  // The keys held in the tab's other frames are watched from the arrival of
  // the message, and taken once the hold is over: a key this frame releases
  // after the action was down at it, and one another frame reports released
  // in that time, its report late, is not known to have been. Where such a
  // key's frame is to be asked first, the watch takes a hold for it.
  const heldElsewhere = watchKeysHeldElsewhere(action, sender);
  // What a frame sends behind its pointer press is stored behind what the
  // press made the tab's other frames write. The hold is read before anything
  // is awaited, so the frame's messages keep their order, and waited on only
  // after the sender test: the sender is judged as its message arrives, while
  // the frame that sent it is still registered (the click that navigates its
  // own frame away, or closes its tab).
  const hold = pressHolds.get(pressHoldKey(sender));

  await restoreWhatSuspensionLost(sender);
  const tabId = sender?.tab?.id;
  const trusted = isTrustedActionSender({
    sender,
    runtimeId: chrome.runtime.id,
    liveRecording,
    activeFrames,
  });
  if (!trusted) {
    console.warn('[Docent] Dropped APPEND_ACTION from untrusted sender', {
      tabId,
      frameId: sender?.frameId,
    });
    heldElsewhere?.take();
    return;
  }

  // Stamp identity from the TRUSTED sender, not the message: a compromised frame
  // cannot spoof another tab's context_id. frame_src is left as reported — it is
  // descriptive context (cross-origin tests assert on it) and dropping legitimate
  // frame data would violate the conservative-fidelity rule.
  if (action && typeof action === 'object') {
    action.context_id = sender.tab.id;
  }
  if (hold) await hold;
  // A key held in another frame of the tab went down before this frame had
  // the focus: it is named ahead of the keys the frame saw go down (#779).
  const elsewhere = heldElsewhere?.take() ?? [];
  if (elsewhere.length > 0) action.held_keys = [...elsewhere, ...action.held_keys];
  await appendSwAction(action);
}

async function isRecording() {
  const { recording } = await chrome.storage.local.get('recording');
  return !!recording;
}

async function wasRecentUserAction(withinMs = TAB_CREATED_USER_ACTION_WINDOW) {
  const { lastUserActionTimestamp } = await chrome.storage.local.get('lastUserActionTimestamp');
  return lastUserActionTimestamp && Date.now() - lastUserActionTimestamp < withinMs;
}

// Cross-document navigations: only browser chrome actions (the address bar,
// back/forward, reload, bookmarks) become navigate proxies, plus the initial
// navigation of a tab opened through "Open in new tab"; navigations caused by
// in-page user actions are effects of already-captured actions and are skipped
// (extension capture-principles ECP-7). The decision rules live in
// lib/navigation-logic.js; this listener supplies the recording state, the clock
// and the new-tab timestamp, and owns the append and the last-URL marker.
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (!(await isRecording())) return;
  const decision = classifyNavigation(details, {
    now: Date.now(),
    lastTabCreatedTimestamp,
    tabCreatedSuppressionMs: TAB_CREATED_NAVIGATION_SUPPRESSION,
  });
  if (decision.action === 'skip') return;
  const { navType } = decision;

  if (decision.path === 'new-tab-link') {
    // The initial navigation of a tab opened via context menu "Open in new tab":
    // the proxy for the context menu selection, recorded directly — no duplicate
    // check and no marker.
    await (swWriteQueue = swWriteQueue.then(() =>
      appendToPending([
        redactSensitive({
          type: 'navigate',
          nav_type: navType,
          timestamp: Date.now(),
          url: details.url,
          context_id: details.tabId,
          capture_mode: 'dom',
        }),
      ]),
    ));
    return;
  }

  // Browser chrome navigation — deduplicate against the last recorded URL
  // (reloads never duplicate), read inside the write queue.
  await (swWriteQueue = swWriteQueue.then(async () => {
    const normalised = normaliseNavigationUrl(details.url);
    const { lastTabNavUrl: stored } = await chrome.storage.local.get('lastTabNavUrl');
    if (isDuplicateNavigation(normalised, navType, stored)) return;
    const appended = await appendToPending([
      redactSensitive({
        type: 'navigate',
        nav_type: navType,
        timestamp: Date.now(),
        url: details.url,
        context_id: details.tabId,
        capture_mode: 'dom',
      }),
    ]);
    // Only advance the dedup marker once the navigation is actually recorded.
    // If the capture was dropped by the storage pause, leaving the marker behind
    // would suppress a later genuine re-navigation to the same URL as a phantom
    // duplicate (#127 review).
    if (!appended) return;
    await chrome.storage.local.set({ lastTabNavUrl: normalised });
    setTimeout(async () => {
      const { lastTabNavUrl: cur } = await chrome.storage.local.get('lastTabNavUrl');
      if (cur === normalised) await chrome.storage.local.remove('lastTabNavUrl');
    }, 5000);
  }));
});

// Track recent tab removals to suppress auto-switch context_switch events.
// When a tab is closed, the browser auto-activates another tab — that's not a user action.
let lastTabRemovedTimestamp = 0;

// Track recent tab creations to suppress context_switch for newly opened tabs
// and to suppress navigations that are cascading effects of tab creation/reopen.
let lastTabCreatedTimestamp = 0;
let lastTabCreatedId = null;

// Track tabs opened programmatically (window.open, link target=_blank).
// Their close events should be suppressed (they were never captured as context_open).
const programmaticTabs = new Set();

// Another window or another program has the focus (or the browser has it
// back): the release of a key held in a recorded tab can have gone there
// unreported, so no key is known to be held across the frames of any tab.
// The event comes from the browser, which a busy page does not delay.
chrome.windows.onFocusChanged.addListener(() => {
  heldKeysRelay.forgetKeys();
});

// Context switch — only record when NO recent tab close and NO recent tab creation.
// If there's a recent tab close, the switch is an auto-activation by the browser.
// If there's a recent tab creation, the switch is the browser activating the new tab.
// If none of the above, the user clicked a tab in browser chrome.
chrome.tabs.onActivated.addListener(async ({ tabId, windowId: _windowId }) => {
  // Another tab has the focus: the release of a key held in a recorded tab
  // can go to it unreported. Read before anything is awaited, and from the
  // browser, which a busy page does not delay.
  heldKeysRelay.forgetKeys();
  if (!(await isRecording())) return;
  // Suppress auto-switch to a just-removed tab's replacement (fallback: timing)
  if (Date.now() - lastTabRemovedTimestamp < TAB_REMOVED_SWITCH_SUPPRESSION) return;
  // Suppress auto-switch to a just-created tab (primary: ID match, fallback: timing)
  if (
    tabId === lastTabCreatedId ||
    Date.now() - lastTabCreatedTimestamp < TAB_CREATED_SWITCH_SUPPRESSION
  ) {
    lastTabCreatedId = null; // consume the suppression
    return;
  }
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://'))
    return;
  await appendSwAction({
    type: 'context_switch',
    timestamp: Date.now(),
    context_id: tabId,
    source: tab.url,
    title: tab.title ?? null,
    capture_mode: 'dom',
  });
});

// New context opened — capture as proxy for browser chrome actions (Ctrl+T, Ctrl+N,
// Ctrl+Shift+T). A tab opened as a side-effect of an in-page action (window.open,
// link target=_blank) follows a recent in-page user action and is suppressed. The
// decision lives in lib/navigation-logic.js; this listener supplies the recording
// state and the recent-action read, and owns the append. Track the timestamp so
// onActivated can suppress the subsequent activation.
chrome.tabs.onCreated.addListener(async (tab) => {
  lastTabCreatedTimestamp = Date.now();
  lastTabCreatedId = tab.id;
  const recording = await isRecording();
  // A recent in-page user action makes this tab a side-effect (window.open, link
  // target=_blank, etc.); read only while recording.
  const decision = shouldCaptureTabCreated(tab, {
    isRecording: recording,
    hadRecentUserAction: recording
      ? !!(await wasRecentUserAction(TAB_CREATED_USER_ACTION_WINDOW))
      : false,
  });
  if (decision.action === 'skip') return;
  if (decision.action === 'suppress_programmatic') {
    programmaticTabs.add(tab.id);
    return;
  }
  // Otherwise it's a browser chrome action (Ctrl+T, Ctrl+N, Ctrl+Shift+T) — capture as proxy.
  await appendSwAction({
    type: 'context_open',
    timestamp: Date.now(),
    context_id: tab.id,
    opener_context_id: tab.openerTabId ?? null,
    source: tab.url || null,
    capture_mode: 'dom',
  });
});

// Context closed — capture as proxy for browser chrome actions (Ctrl+W, click X button).
// Suppress when it's a side-effect of window.close() or a cascading window close.
// Distinguishing signal: window.close() is preceded by a recent in-page user action;
// Ctrl+W and X button are not. Cascading closes have removeInfo.isWindowClosing = true.
// Track the timestamp so onActivated can suppress auto-switch.
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  lastTabRemovedTimestamp = Date.now();
  // Clean up tracking regardless of recording state.
  heldKeysRelay.forgetTab(tabId);
  const wasProgrammatic = programmaticTabs.delete(tabId);
  // The tab is gone — drop all of its frames from the active-frame registry.
  activeFrames.delete(tabId);
  if (!(await isRecording())) return;
  // Cascading close (entire window closing) — not a distinct user action.
  if (removeInfo.isWindowClosing) return;
  // If the tab was opened programmatically AND there's a recent in-page action,
  // this is window.close() called from JavaScript — a side-effect.
  // Use a longer window (2000ms) because window.close() can be delayed.
  // If there's NO recent action, the user closed it manually (Ctrl+W, X button).
  if (wasProgrammatic && (await wasRecentUserAction(TAB_CLOSED_USER_ACTION_WINDOW))) return;
  // Otherwise it's a browser chrome action (Ctrl+W, click X) — capture as proxy.
  await appendSwAction({
    type: 'context_close',
    timestamp: Date.now(),
    context_id: tabId,
    window_closing: false,
    capture_mode: 'dom',
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getActiveProject() {
  return projects.find((p) => p.project_id === activeProjectId) ?? null;
}

function getActiveRecording() {
  const project = getActiveProject();
  if (!project) return null;
  return findRecording(project, activeRecordingId) ?? null;
}

// A panel message names its target: each open panel shows a project and a
// recording of its own, while the active ones follow whichever panel last
// opened or created one (extension runtime, Panel protocol).

/** The stored project a message names by its `project_id`, or null. */
function namedProject(msg) {
  return projects.find((p) => p.project_id === msg.project_id) ?? null;
}

/** Whether a message names the active project and recording, the ones capture goes to. */
function namesActive(msg) {
  return namesActiveRecording(msg, { projectId: activeProjectId, recordingId: activeRecordingId });
}

const STATE_NOT_READ = { ok: false, error: 'Stored state could not be read' };
const PROJECT_NOT_FOUND = { ok: false, error: 'Project not found' };
const RECORDING_NOT_FOUND = { ok: false, error: 'Recording not found' };
const NOT_ACTIVE = { ok: false, error: NOT_ACTIVE_RECORDING };

async function persist() {
  await chrome.storage.local.set({ projects, activeProjectId, activeRecordingId });
  // Project growth or deletion shifts the pressure band — re-evaluate so the warn
  // banner appears on growth and clears (capture resumes) when a project is deleted.
  await evaluateStoragePressure();
}

async function setRecording(value) {
  // Update the in-memory capture mirror eagerly so the Auto-Sync scheduler sees
  // the new value immediately — in particular, a RECORDING_STOP must clear the
  // flag BEFORE its Auto-Sync trigger fires, or the scheduler would drop
  // that trigger as capture-active. The storage write below also fires the
  // recording-flag watch (this file registers two storage.onChanged listeners
  // — that one and the sync-state watch), which keeps the mirror correct for
  // any external change as well.
  liveRecording = value === true;
  // Drop the active-frame registry the moment capture stops, on every
  // record-stop path (RECORDING_STOP, RECORDING_OPEN, PROJECT_CREATE/OPEN/DELETE,
  // RECORDING_DELETE, PROJECTS_SET). This chokepoint stays synchronous, ahead of the
  // storage write below; doubling stated at the recording-flag watch.
  if (value !== true) clearActiveFrames();
  await chrome.storage.local.set({ recording: value });
}

async function injectContentScript() {
  const tabs = await queryCaptureTargetTabs();
  // Inject into all frames of all matching tabs.
  // The content script's __docentLoaded guard prevents double-initialization.
  await Promise.allSettled(
    tabs.map(async (tab) => {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ['content/recorder.js'],
          // Inject as early as the browser allows (injectImmediately), so a tab
          // still loading at record-start gets the recorder as soon as possible.
          // The inject-to-ready bound (extension capture-principles ECP-5) is
          // measured on the per-frame route, not on this sweep.
          injectImmediately: true,
        });
      } catch {
        // Tab may not be injectable (e.g. chrome:// pages) — ignore
      }
    }),
  );
}

async function clearPending() {
  await chrome.storage.local.set({ pendingActions: [], pendingCount: 0 });
  // Freeing pending actions may drop usage below the resume threshold — re-evaluate
  // so capture resumes (and the panel banner clears) without waiting for the next write.
  await evaluateStoragePressure();
}

async function getPendingActions() {
  const { pendingActions } = await chrome.storage.local.get('pendingActions');
  return pendingActions ?? [];
}

// ─── Auto-Sync background host ───────────────────────
// The side panel hosts the MANUAL sync path; it does not run while the panel is
// closed. `chrome.alarms` fires in the service worker, so the BACKGROUND
// Auto-Sync cycle is hosted here. A triggered cycle calls the SAME shared
// `sync()` the panel calls, through the SAME chrome-backed adapter, so a
// background cycle and a manual cycle are identical apart from origin.
// The shared cooldown-debounced scheduler (sync-scheduler.js)
// owns coalescing, never-overlap, and the capture-active drop; this file only
// wires the platform triggers and the cycle body.

// chrome.storage.local key the chrome adapter persists the durable SyncState
// blob under. Kept in sync with SYNC_STATE_KEY in sidepanel/adapter-chrome.js;
// the SW watches it so a panel toggle of the `autoSync` setting starts/stops the
// background trigger.
const SYNC_STATE_STORAGE_KEY = 'docentSyncState';

// chrome.alarms name for the ~60s periodic backstop. Persisted by the
// browser, so it wakes the SW and re-drives the cycle even after suspension.
const AUTO_SYNC_ALARM = 'docent-auto-sync-backstop';

// The raw SyncStore seam over chrome.storage.local — identical shape to the
// panel's `adapterSyncStore`. `sync()` and the sync-store helpers normalize the
// loaded value into the full SyncState shape, so this just moves the raw blob
// in and out of storage.
const adapterSyncStore = {
  load: () => chromeAdapter.loadSyncState(),
  save: (state) => chromeAdapter.saveSyncState(state),
};

// The scheduler's `notify`, set while the trigger is wired; null when Auto-Sync
// is off. The data-event hooks and the alarm listener call it through
// `fireAutoSyncTrigger()`.
let autoSyncNotify = null;
// Tracks whether the trigger is currently started, so start/stop are idempotent.
let autoSyncActive = false;

// Local data events that should fire an Auto-Sync trigger: a step
// commit, a recording close, and project/recording create or delete (sync
// SP-21). RECORDING_STOP stands in for the recording close and is sent more
// widely than the clause's leaving-the-recording-view moment — the departure
// SP-21 records. Fired centrally from the message dispatcher on a successful
// response, and on every RECORDING_STOP.
const AUTO_SYNC_DATA_EVENTS = new Set([
  'STEP_COMMIT',
  'RECORDING_STOP',
  'PROJECT_CREATE',
  'PROJECT_DELETE',
  'RECORDING_CREATE',
  'RECORDING_DELETE',
]);

// The data events that fire the trigger whatever they are answered: a
// RECORDING_STOP requests a cycle wherever the panel sends it, refused or not.
// A refused stop changed nothing, and capture is running then, so the
// scheduler drops the trigger.
const AUTO_SYNC_ON_EVERY_RESPONSE = new Set(['RECORDING_STOP']);

function fireAutoSyncTrigger() {
  // No-op when Auto-Sync is off (notify is null); the scheduler also drops the
  // trigger while capture is active, so this stays a thin pass-through.
  autoSyncNotify?.();
}

// The ~60s backstop fires onAlarm even after the SW was suspended. Registered
// once at module scope; it only acts when Auto-Sync is active (notify is set).
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_SYNC_ALARM) fireAutoSyncTrigger();
});

// The Sync_Trigger adapter: the shared scheduler owns the coalescing
// and the capture-active drop; `wire` registers the platform trigger sources
// (the ~60s alarm + the data-event hooks routed through `fireAutoSyncTrigger`)
// and returns a teardown that tears them down on stop.
const autoSyncTrigger = createSyncTrigger({
  // Synchronous capture probe: drop (do not queue) any trigger while capture is
  // active. Mirrors the `recording` flag the panel's LiveState reads.
  isCaptureActive: () => liveRecording === true,
  wire(notify) {
    autoSyncNotify = notify;
    // Periodic ~60s backstop so a locally-idle client still pulls others'
    // changes. periodInMinutes is the alarms API unit.
    chrome.alarms.create(AUTO_SYNC_ALARM, {
      periodInMinutes: BACKSTOP_INTERVAL_MS / 60000,
    });
    return () => {
      autoSyncNotify = null;
      chrome.alarms.clear(AUTO_SYNC_ALARM);
    };
  },
});

function startAutoSync() {
  if (autoSyncActive) return;
  autoSyncActive = true;
  autoSyncTrigger.start(runAutoSyncCycle);
}

function stopAutoSync() {
  if (!autoSyncActive) return;
  autoSyncActive = false;
  autoSyncTrigger.stop();
}

/**
 * Start or stop the background trigger to match the persisted `autoSync`
 * setting. Called on boot (so Auto-Sync survives SW suspension and browser
 * restart) and whenever the SyncState blob changes (so a panel toggle
 * takes effect with the panel open or closed).
 */
async function reconcileAutoSync() {
  let enabled = false;
  try {
    const state = await loadSyncState(adapterSyncStore);
    enabled = getSettings(state).autoSync === true;
  } catch {
    // A storage read failure leaves `enabled` at its safe default (false), so a
    // transient error never spuriously starts Auto-Sync.
  }
  if (enabled) startAutoSync();
  else stopAutoSync();
}

/**
 * One background Auto-Sync cycle. Invokes the SAME shared `sync()` the manual
 * panel path uses, with the SAME chrome-backed SyncStore, LiveState, schema, and
 * validator, so a background cycle and a manual cycle are identical apart from
 * origin. `sync()` persists the resulting SyncState through the
 * store, so the panel, when next shown, derives its indicators from it. On a 401/403 the cycle disables Auto-Sync rather than retrying bad
 * credentials on the interval; a transient error leaves Auto-Sync
 * enabled to retry on the next trigger, which the scheduler handles by
 * swallowing the rejection.
 */
async function runAutoSyncCycle() {
  // The projects synced are the stored ones, not the empty list of a worker
  // still reading them, or of one that could not read them.
  try {
    await stateRestored;
  } catch {
    return;
  }
  const { serverUrl, apiKey } = await chromeAdapter.loadSyncSettings();
  // No endpoint configured → nothing to sync. (The panel's enable rule forbids
  // turning Auto-Sync on without an endpoint; this is a defensive guard.)
  if (!serverUrl) return;

  // Schema (push-side docent_format stamp), loaded by URL exactly as the panel
  // does. The generated validator is imported STATICALLY at module
  // scope (see the import) because a Manifest V3 service worker cannot use the
  // dynamic import() that the panel's adapter.loadValidator() relies on.
  const schema = await chromeAdapter.loadSchema();
  const validator = validateExtensionPayload;

  // LiveState — the SW owns `recording` / `activeRecordingId` /
  // `pendingCount` in chrome.storage.local; snapshot them once and build the
  // synchronous accessors over a consistent view, identical to the panel.
  const live = await chromeAdapter.loadLiveState();
  const lockedRecordingIds = live.activeRecordingId ? new Set([live.activeRecordingId]) : new Set();
  const pendingRecordingIds =
    live.pendingCount > 0 && live.activeRecordingId ? new Set([live.activeRecordingId]) : new Set();
  const liveState = {
    isCaptureActive: () => live.recording === true,
    getLockedRecordingIds: () => lockedRecordingIds,
    recordingsWithPendingActions: () => pendingRecordingIds,
  };

  const { result, projects: mergedProjects } = await sync(
    serverUrl,
    apiKey,
    projects,
    schema,
    validator,
    adapterSyncStore,
    liveState,
  );

  // Persist the merged projects into the SW's own state + storage, mirroring the
  // panel's PROJECTS_SET. `sync()` already persisted the SyncState blob.
  projects = mergedProjects;
  await persist();

  // an auth failure disables Auto-Sync and invalidates the
  // Connection_Test so the panel surfaces a needs-attention state and requires a
  // fresh passing test before re-enabling, rather than retrying bad credentials.
  if (result.halted && result.haltReason === 'auth') {
    await disableAutoSyncOnAuthFailure();
  }
}

/**
 * Disable Auto-Sync after a 401/403: tear the trigger down immediately
 * so the next interval does not retry bad credentials, then persist the disable
 * and invalidate the Connection_Test result so the panel prompts a re-test.
 */
async function disableAutoSyncOnAuthFailure() {
  stopAutoSync();
  try {
    const state = await loadSyncState(adapterSyncStore);
    setSettings(state, { autoSync: false, connectionTest: 'auth' });
    await saveSyncState(adapterSyncStore, state);
  } catch (err) {
    console.error('[Docent] Failed to persist Auto-Sync auth-disable', err);
  }
}

// The sync-state watch: observe the `autoSync` setting (it lives inside the
// durable SyncState blob) — when the panel toggles it, the blob changes and we
// start/stop the background trigger to match.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SYNC_STATE_STORAGE_KEY]) {
    reconcileAutoSync();
  }
});

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // GET_TAB_ID must be handled synchronously here — sender.tab is not
  // available inside the async handle() function.
  if (message.type === 'GET_TAB_ID') {
    sendResponse({ tabId: sender.tab?.id ?? null });
    return false;
  }

  // FRAME_READY: the recorder reports (from its isolated world, after wiring all
  // its listeners) that this frame is live and capturing. Register the frame as
  // trusted — a stronger signal than mere frame existence, so its APPEND_ACTIONs
  // are accepted. No response is sent (the sender passes no callback).
  // Ungated by recording state: a beacon is accepted whether or not a recording
  // is live. What a late write costs is stated once at registerFrame.
  if (message.type === 'FRAME_READY') {
    const tabId = sender.tab?.id;
    if (tabId != null && sender.frameId != null) registerFrame(tabId, sender.frameId);
    return false;
  }

  // POINTER_PRESSED: a recorder reports a pointer press in its frame. The
  // worker asks the tab's other frames to end their typing, held to the same
  // sender test as an append, and holds what this frame appends next behind
  // their answers. No response is sent.
  if (message.type === 'POINTER_PRESSED') {
    reportToHeldKeysRelay(sender, { event: 'press' });
    holdAppendsBehindPress(sender);
    return false;
  }

  // HELD_KEY: a recorder reports a key it names as held, a key's release, or
  // what moves the focus in its frame. Read as it arrives, so one frame's
  // reports keep their order, and held to the sender test of an append with
  // no reseed: a report from a frame the registry does not hold is dropped,
  // which leaves a key unnamed. No response is sent.
  if (message.type === 'HELD_KEY') {
    reportToHeldKeysRelay(sender, message);
    return false;
  }

  // APPEND_ACTION: content script sends actions here for serialized storage
  // writes (this also serializes them with clearPendingActions). Each sender is
  // validated against the active-frame registry before its action is appended,
  // so only frames in the registry during a live recording can write actions —
  // an untrusted/spoofed sender (e.g. an embedded third-party frame reaching the
  // message port) is dropped silently, never appended and never thrown on.
  if (message.type === 'APPEND_ACTION') {
    validateAndAppend(message.action, sender)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        // A genuine append failure (storage error) — report it, but never throw
        // back into the message port.
        console.error('[Docent]', err);
        sendResponse({ ok: false, error: err?.message });
      });
    return true;
  }

  // A message that woke the worker is read before the stored state is: it
  // is handled once the projects and the active ids have been restored, or
  // it would act on an empty list, and the restore would then replace what
  // it did (#775). Where the stored state could not be read, the worker does
  // not know its projects: it answers so, and writes nothing over them.
  stateRestored
    .then(
      () => handle(message),
      () => STATE_NOT_READ,
    )
    .then((response) => {
      // Fire an Auto-Sync trigger on a local data event: a step commit, a
      // recording close, or a project/recording create/delete, when the
      // worker accepted it — and on every RECORDING_STOP, accepted or not.
      // The scheduler coalesces bursts and drops triggers while capture is
      // active; this is a no-op when Auto-Sync is off.
      const requests = response?.ok || AUTO_SYNC_ON_EVERY_RESPONSE.has(message.type);
      if (requests && AUTO_SYNC_DATA_EVENTS.has(message.type)) {
        fireAutoSyncTrigger();
      }
      sendResponse(response);
    })
    .catch((err) => {
      console.error('[Docent]', err);
      sendResponse({ ok: false, error: err.message });
    });
  return true;
});

async function handle(msg) {
  switch (msg.type) {
    // ── Projects ──────────────────────────────────────────────────────────────

    case 'PROJECTS_LIST': {
      return {
        ok: true,
        projects: projects.map((p) => ({
          project_id: p.project_id,
          name: p.name,
          created_at: p.created_at,
          recording_count: p.recordings.length,
        })),
      };
    }

    case 'PROJECTS_GET_ALL': {
      return { ok: true, projects };
    }

    case 'PROJECTS_SET': {
      projects = msg.projects;
      // Capture is on only while its recording exists: a set without it (a
      // resolution that accepted its deletion) stops capture.
      if (!getActiveRecording()) await setRecording(false);
      await persist();
      return { ok: true };
    }

    case 'PROJECT_CREATE': {
      const project = createProject(msg.name);
      projects.push(project);
      activeProjectId = project.project_id;
      activeRecordingId = null;
      // No recording is active, so capture stops, as on PROJECT_OPEN.
      await setRecording(false);
      await persist();
      return { ok: true, project };
    }

    case 'PROJECT_OPEN': {
      const project = projects.find((p) => p.project_id === msg.project_id);
      if (!project) return { ok: false, error: 'Project not found' };
      activeProjectId = project.project_id;
      activeRecordingId = null;
      await setRecording(false);
      await chrome.storage.local.set({ activeProjectId, activeRecordingId });
      return { ok: true, project };
    }

    case 'PROJECT_GET': {
      const project = namedProject(msg);
      if (!project) return PROJECT_NOT_FOUND;
      return { ok: true, project };
    }

    case 'PROJECT_DELETE': {
      projects = projects.filter((p) => p.project_id !== msg.project_id);
      if (activeProjectId === msg.project_id) {
        activeProjectId = null;
        activeRecordingId = null;
        await setRecording(false);
      }
      await persist();
      return { ok: true };
    }

    case 'PROJECT_RENAME': {
      const project = namedProject(msg);
      if (!project) return PROJECT_NOT_FOUND;
      project.name = msg.name;
      await persist();
      return { ok: true, project };
    }

    case 'PROJECT_SET_METADATA': {
      const project = namedProject(msg);
      if (!project) return PROJECT_NOT_FOUND;
      if (msg.metadata) {
        project.metadata = msg.metadata;
      } else {
        delete project.metadata;
      }
      await persist();
      return { ok: true };
    }

    // ── Recordings ────────────────────────────────────────────────────────────

    case 'RECORDING_CREATE': {
      const project = namedProject(msg);
      if (!project) return PROJECT_NOT_FOUND;
      const recording = createRecording(project, msg.name);
      // The new recording is the one capture goes to.
      activeProjectId = project.project_id;
      activeRecordingId = recording.recording_id;
      await clearPending();
      await persist();
      // Leading clear ahead of this route's seed; doubling stated at the recording-flag watch.
      clearActiveFrames();
      await injectContentScript();
      await seedActiveFrames();
      await setRecording(true);
      return { ok: true, recording, project };
    }

    case 'RECORDING_OPEN': {
      const project = namedProject(msg);
      if (!project) return PROJECT_NOT_FOUND;
      const recording = findRecording(project, msg.recording_id);
      if (!recording) return RECORDING_NOT_FOUND;
      activeProjectId = project.project_id;
      activeRecordingId = recording.recording_id;
      await clearPending();
      await setRecording(false);
      await chrome.storage.local.set({ activeProjectId, activeRecordingId });
      return { ok: true, recording, activeSteps: resolveActiveSteps(recording) };
    }

    case 'RECORDING_DELETE': {
      const project = namedProject(msg);
      if (!project) return PROJECT_NOT_FOUND;
      if (!findRecording(project, msg.recording_id)) return RECORDING_NOT_FOUND;
      project.recordings = project.recordings.filter((r) => r.recording_id !== msg.recording_id);
      if (activeRecordingId === msg.recording_id) {
        activeRecordingId = null;
        await setRecording(false);
      }
      await persist();
      return { ok: true, project };
    }

    case 'RECORDING_RENAME': {
      const project = namedProject(msg);
      if (!project) return PROJECT_NOT_FOUND;
      const recording = findRecording(project, msg.recording_id);
      if (!recording) return RECORDING_NOT_FOUND;
      recording.name = msg.name;
      await persist();
      return { ok: true };
    }

    case 'RECORDING_SET_METADATA': {
      const project = namedProject(msg);
      if (!project) return PROJECT_NOT_FOUND;
      const recording = findRecording(project, msg.recording_id);
      if (!recording) return RECORDING_NOT_FOUND;
      if (msg.metadata) {
        recording.metadata = msg.metadata;
      } else {
        delete recording.metadata;
      }
      await persist();
      return { ok: true };
    }

    // ── Recording control ─────────────────────────────────────────────────────
    // Capture and the pending buffer are one per browser, so these messages,
    // and STEP_COMMIT below, act only for the panel showing the active recording;
    // a stop while capture is off has nothing to protect and is accepted.

    case 'RECORDING_START': {
      if (!namesActive(msg)) return NOT_ACTIVE;
      if (!getActiveRecording()) return { ok: false, error: 'No active recording' };
      // Leading clear ahead of this route's seed; doubling stated at the recording-flag watch.
      clearActiveFrames();
      await injectContentScript();
      await seedActiveFrames();
      await setRecording(true);
      return { ok: true };
    }

    case 'RECORDING_STOP': {
      // With capture off there is nothing to protect, whatever the stop names.
      const capturing = await isRecording();
      if (capturing && !namesActive(msg)) return NOT_ACTIVE;
      // The typing not yet written is input of this recording.
      if (capturing) await endTypingInEveryFrame();
      await setRecording(false);
      return { ok: true };
    }

    case 'RECORDING_CLEAR': {
      if (!namesActive(msg)) return NOT_ACTIVE;
      await clearPending();
      return { ok: true };
    }

    // The user chose to keep recording past the storage-pressure warning (#127).
    // Override the auto-pause so capture resumes; it re-arms once they free space.
    case 'STORAGE_RESUME': {
      await resumeCaptureDespitePressure();
      return { ok: true };
    }

    // ── Steps ─────────────────────────────────────────────────────────────────

    case 'STEP_COMMIT': {
      if (!namesActive(msg)) return NOT_ACTIVE;
      const recording = getActiveRecording();
      if (!recording) return { ok: false, error: 'No active recording' };

      // The typing not yet written is input of this step. The panel and the
      // control channel stop capture ahead of their commit, so their typing
      // has ended at that stop; this is the commit sent with capture on.
      if (await isRecording()) await endTypingInEveryFrame();
      const pendingActions = await getPendingActions();
      const activeSteps = resolveActiveSteps(recording);
      const isRerecord = !!msg.logical_id;

      if (!isRerecord && pendingActions.length === 0) {
        return { ok: false, error: 'No actions recorded for this step' };
      }

      let actions;
      if (pendingActions.length > 0) {
        actions = pendingActions;
      } else {
        // Narration-only re-record — reuse existing step's actions
        const existing = activeSteps.find((s) => s.logical_id === msg.logical_id);
        actions = existing ? [...existing.actions] : [];
      }

      const stepNumber = msg.step_number ?? activeSteps.length + 1;

      const step = createStep({
        narration: msg.narration,
        narration_source: msg.narration_source,
        step_type: msg.step_type,
        expect: msg.expect,
        step_number: stepNumber,
        actions,
        logical_id: msg.logical_id,
      });

      addStepRecord(recording, step);
      await clearPending();
      await persist();

      return { ok: true, step, activeSteps: resolveActiveSteps(recording) };
    }

    case 'STEP_DELETE': {
      const project = namedProject(msg);
      if (!project) return PROJECT_NOT_FOUND;
      const recording = findRecording(project, msg.recording_id);
      if (!recording) return RECORDING_NOT_FOUND;
      deleteStep(recording, msg.logical_id);
      await persist();
      return { ok: true, activeSteps: resolveActiveSteps(recording) };
    }

    case 'STEPS_REORDER': {
      const project = namedProject(msg);
      if (!project) return PROJECT_NOT_FOUND;
      const recording = findRecording(project, msg.recording_id);
      if (!recording) return RECORDING_NOT_FOUND;
      reorderSteps(recording, msg.orderedLogicalIds);
      await persist();
      return { ok: true, activeSteps: resolveActiveSteps(recording) };
    }

    // ── Import / Export ───────────────────────────────────────────────────────

    case 'PROJECT_IMPORT': {
      const { exportData } = msg;
      if (!exportData?.project || !exportData?.recordings) {
        return { ok: false, error: 'Invalid export file' };
      }

      let projectData = exportData.project;

      // If project_id already exists, import as a copy with a new ID and modified name
      const existing = projects.find((p) => p.project_id === projectData.project_id);
      if (existing) {
        projectData = {
          ...projectData,
          project_id: uuidv7(),
          name: `${projectData.name} (copy)`,
          created_at: new Date().toISOString(),
        };
      }

      const project = {
        ...projectData,
        recordings: exportData.recordings.map(({ activeSteps: _, ...r }) => r),
      };

      projects.push(project);
      await persist();
      return { ok: true, project };
    }

    case 'PROJECT_EXPORT': {
      const project = namedProject(msg);
      if (!project) return PROJECT_NOT_FOUND;
      // Return the raw project; the panel stamps + shapes it into the
      // `.docent.json` export via buildExport(), where the composed schema (the
      // source of the docent_format stamp) is available.
      return { ok: true, project };
    }

    default:
      return { ok: false, error: `Unknown message type: ${msg.type}` };
  }
}
