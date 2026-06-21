/**
 * Docent — Background Service Worker
 *
 * Handles on-demand requests from the side panel.
 * Does NOT hold transient recording state in memory — pending actions live in
 * chrome.storage.local (written directly by the content script) so they
 * survive SW suspension.
 *
 * Persistent state (chrome.storage.local):
 *   projects[]         — all saved projects
 *   activeProjectId    — project currently open in the panel
 *   activeRecordingId  — recording currently being recorded
 *   recording          — whether the content script should capture events
 *   pendingActions[]   — actions captured since last step boundary (written by content script)
 *   pendingCount       — length of pendingActions (for panel commit button)
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

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
import { isSensitiveField, redactUrl, SENSITIVE_MASK } from '../shared/lib/field-sensitivity.js';
import {
  TAB_CREATED_USER_ACTION_WINDOW,
  TAB_CLOSED_USER_ACTION_WINDOW,
  TAB_CREATED_SWITCH_SUPPRESSION,
  TAB_REMOVED_SWITCH_SUPPRESSION,
  TAB_CREATED_NAVIGATION_SUPPRESSION,
} from '../lib/capture-timing.js';
import { STORAGE_QUOTA_KEY, classifyStoragePressure } from '../lib/storage-quota.js';
import { isTrustedActionSender } from '../lib/frame-trust.js';
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

// Active-frame registry: tabId → Set<frameId> of frames we have injected the
// recorder into during the current recording. A frame is "trusted" (its
// APPEND_ACTION messages are appended) only if it is in this registry — that is
// the per-frame sender check that stops an embedded third-party frame, or any
// page that can reach the message port, from injecting actions into a session.
//
// In-memory only — frameIds are session-scoped and churn as frames load/unload,
// so this is NOT persisted. After an SW restart it is empty; the APPEND_ACTION
// handler lazily reseeds it from chrome.webNavigation rather than false-rejecting
// a legitimate frame whose registration was lost with the suspended worker.
const activeFrames = new Map();

/** Add (tabId, frameId) to the active-frame registry. */
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

/** Seed the registry for every http/https tab (mirrors injectContentScript's set). */
async function seedActiveFrames() {
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    await Promise.allSettled(tabs.map((tab) => seedFramesForTab(tab.id)));
  } catch {
    // Best-effort — a failed seed is recovered by the lazy reseed on append.
  }
}

/** Clear the whole registry on any record-stop path. */
function clearActiveFrames() {
  activeFrames.clear();
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    await chrome.storage.local.set({ projects: [], pendingActions: [], pendingCount: 0 });
  }
  console.log(`[Docent] onInstalled (${reason}).`);
});

// Restore persisted state on SW restart
(async () => {
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
  // pendingActions in session storage are preserved across SW restarts.

  // Seed the in-memory capture mirror so the Auto-Sync scheduler's synchronous
  // capture probe is correct from the first trigger, and reconcile the
  // background trigger with the persisted `autoSync` setting so Auto-Sync keeps
  // running with the panel closed across SW restarts.
  liveRecording = stored.recording === true;

  // Rehydrate the storage-quota gate (#127) so an MV3 suspension doesn't silently
  // forget the user's "keep recording" override or the warn hysteresis — otherwise
  // capture would re-pause on the next wake. (Only the SW writes this key, so the
  // stored value is the SW's own last state.)
  const quota = stored[STORAGE_QUOTA_KEY];
  if (quota) {
    userOverride = quota.override === true;
    wasWarn = quota.band === 'warn';
    storagePaused = quota.paused === true;
    publishedQuota = { band: quota.band, paused: quota.paused, override: quota.override === true };
  }

  await reconcileAutoSync();
  // Reconcile the gate against actual usage now (honouring any restored override),
  // so the in-memory gate and the published key agree immediately on wake rather
  // than after the next capture/persist/clear.
  await evaluateStoragePressure();
})();

// Open side panel when toolbar icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// When recording is enabled, inject content script into all frames
// (including about:srcdoc iframes that don't match manifest patterns).
// Also mirror the `recording` flag into memory so the Auto-Sync scheduler can
// drop triggers synchronously while capture is active.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.recording) {
    liveRecording = changes.recording.newValue === true;
    if (changes.recording.newValue === true) {
      // Inject into all current frames, then record which frames we injected
      // into so their actions are trusted. Clearing first keeps the registry
      // scoped to the new recording.
      clearActiveFrames();
      injectContentScript().then(() => seedActiveFrames());
    } else {
      // Capture stopped externally — drop the trust registry.
      clearActiveFrames();
    }
  }
});

// When a frame finishes loading while recording, inject the recorder into THAT
// specific frame and register it as trusted. This covers main frames, srcdoc
// iframes, and dynamically created/child frames — it is the injection path that
// replaces the old static manifest `all_frames` auto-inject (which is gone with
// programmatic injection). Runs for every frame (not just the main frame): subframes are exactly the
// frames the static entry used to cover automatically.
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

// A subframe navigating away unloads its recorder; drop it from the trust
// registry so a stale frameId can't be reused. (Main-frame navigations reseed on
// the following onCompleted, so they are left alone here.)
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId === 0) return;
  const frames = activeFrames.get(details.tabId);
  if (frames) frames.delete(details.frameId);
});

// ─── Navigation & context lifecycle capture ──────────────────────────────────
// The content script handles in-page (SPA) navigations.
// The SW handles everything else: cross-document navigations (including
// back/forward/reload), context opens, context closes, and context switches.
// All actions are stamped with context_id so the receiving system knows which
// context the action occurred in.

// Serialised write queue — prevents race conditions when multiple SW events
// (e.g. context_open + navigate) fire simultaneously.
let swWriteQueue = Promise.resolve();

// Sensitive-data redaction at the storage chokepoint. The content script
// already masks passwords inline (native `type=password` signal); this catches
// the rest with the SHARED field-sensitivity util, before anything is persisted:
//   - a sensitive non-password field (cc/ssn/secret/payment-autocomplete) has its
//     value masked and its element text nulled + flagged `redacted`;
//   - a `navigate` URL has its sensitive query-param values stripped.
// Applied at EVERY pendingActions write (here + the inline navigate writes), so
// no captured value reaches storage unredacted. Mutates the soon-to-be-stored
// action in place.
function redactSensitive(action) {
  if (!action || typeof action !== 'object') return action;
  const el = action.element;
  if (el && typeof el === 'object' && !el.redacted && isSensitiveField(el)) {
    if (typeof action.value === 'string') action.value = SENSITIVE_MASK;
    el.text = null;
    el.redacted = true;
  }
  if (action.type === 'navigate' && typeof action.url === 'string') {
    action.url = redactUrl(action.url);
  }
  return action;
}

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
async function appendToPending(actions) {
  if (storagePaused) return false; // paused for storage pressure — drop new captures
  const { pendingActions } = await chrome.storage.local.get('pendingActions');
  const updated = [...(pendingActions ?? []), ...actions];
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

// Validate an APPEND_ACTION sender against the active-frame registry, then append
// on success. Drops untrusted senders silently (warn + return — never throw), so
// a frame we did not inject into cannot write actions into the recording.
async function validateAndAppend(action, sender) {
  // Lazy reseed: if a recording is live but the in-memory registry is empty, the
  // SW was suspended and lost it. Rebuild this tab's frames from webNavigation
  // BEFORE validating, rather than false-rejecting a legitimate frame.
  const tabId = sender?.tab?.id;
  if (liveRecording && tabId != null && !activeFrames.has(tabId)) {
    await seedFramesForTab(tabId);
  }

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
    return;
  }

  // Stamp identity from the TRUSTED sender, not the message: a compromised frame
  // cannot spoof another tab's context_id. frame_src is left as reported — it is
  // descriptive context (cross-origin tests assert on it) and dropping legitimate
  // frame data would violate the conservative-fidelity rule.
  if (action && typeof action === 'object') {
    action.context_id = sender.tab.id;
  }
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

// Cross-document navigations: back, forward, reload, link, typed, form_submit, etc.
// Only record navigations that are browser chrome actions (typed, reload, back_forward,
// auto_bookmark). Navigations caused by in-page user actions (link clicks, form submits,
// window.location assignments) are effects of already-captured actions and are skipped.
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  if (!(await isRecording())) return;
  if (
    !details.url ||
    details.url.startsWith('chrome://') ||
    details.url.startsWith('chrome-extension://') ||
    details.url.startsWith('about:')
  )
    return;

  // Skip SPA navigations — those are handled by the content script
  const skipTypes = new Set(['auto_subframe', 'manual_subframe']);
  if (skipTypes.has(details.transitionType)) return;

  // If a tab was just created/reopened, this navigate is usually a cascading effect.
  // Exception: "link" navigations on newly created tabs are the proxy for
  // "Open in new tab" context menu selections — record those directly.
  if (Date.now() - lastTabCreatedTimestamp < TAB_CREATED_NAVIGATION_SUPPRESSION) {
    if (details.transitionType === 'link') {
      // This is the initial navigation of a tab opened via context menu "Open in new tab".
      // Record it as the proxy for the context menu selection.
      await (swWriteQueue = swWriteQueue.then(() =>
        appendToPending([
          redactSensitive({
            type: 'navigate',
            nav_type: 'link',
            timestamp: Date.now(),
            url: details.url,
            context_id: details.tabId,
            capture_mode: 'dom',
            window_rect: null,
          }),
        ]),
      ));
    }
    // All other navigations on newly created tabs are cascading effects — skip.
    return;
  }

  // Determine if this is a browser chrome action or an effect of an in-page action.
  const qualifiers = details.transitionQualifiers ?? [];
  let navType = details.transitionType;
  if (qualifiers.includes('forward_back')) navType = 'back_forward';

  // Browser chrome actions — record as proxy for what the user did.
  const browserChromeTypes = new Set([
    'typed',
    'generated',
    'reload',
    'back_forward',
    'auto_bookmark',
    'start_page',
    'keyword',
  ]);
  if (!browserChromeTypes.has(navType)) return;

  // Redirect hops within a browser chrome navigation — suppress duplicates.
  if (qualifiers.includes('server_redirect') || qualifiers.includes('client_redirect')) return;

  // Deduplicate: don't record the same URL twice in a row (except reloads).
  await (swWriteQueue = swWriteQueue.then(async () => {
    const normalised = details.url.replace(/\/$/, '');

    if (navType !== 'reload') {
      const { lastTabNavUrl: stored } = await chrome.storage.local.get('lastTabNavUrl');
      if (normalised === stored) return;
    }
    const appended = await appendToPending([
      redactSensitive({
        type: 'navigate',
        nav_type: navType,
        timestamp: Date.now(),
        url: details.url,
        context_id: details.tabId,
        capture_mode: 'dom',
        window_rect: null,
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

// Context switch — only record when NO recent tab close and NO recent tab creation.
// If there's a recent tab close, the switch is an auto-activation by the browser.
// If there's a recent tab creation, the switch is the browser activating the new tab.
// If none of the above, the user clicked a tab in browser chrome.
chrome.tabs.onActivated.addListener(async ({ tabId, windowId: _windowId }) => {
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
    window_rect: null,
  });
});

// New context opened — capture as proxy for browser chrome actions (Ctrl+T, Ctrl+N).
// Suppress when it's a side-effect of an in-page action (window.open, link target=_blank).
// Distinguishing signal: window.open/link tabs have openerTabId; Ctrl+T/N tabs don't.
// Track the timestamp so onActivated can suppress the subsequent activation.
chrome.tabs.onCreated.addListener(async (tab) => {
  lastTabCreatedTimestamp = Date.now();
  lastTabCreatedId = tab.id;
  if (!(await isRecording())) return;
  // If there was a recent in-page user action, this tab is a side-effect
  // (window.open, link target=_blank, etc.) — suppress.
  if (await wasRecentUserAction()) {
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
    window_rect: null,
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
  const wasProgrammatic = programmaticTabs.delete(tabId);
  // The tab is gone — drop all of its frames from the trust registry.
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
    window_rect: null,
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

async function persist() {
  await chrome.storage.local.set({ projects, activeProjectId, activeRecordingId });
  // Project growth or deletion shifts the pressure band — re-evaluate so the warn
  // banner appears on growth and clears (capture resumes) when a project is deleted.
  await evaluateStoragePressure();
}

async function setRecording(value) {
  // Update the in-memory capture mirror eagerly so the Auto-Sync scheduler sees
  // the new value immediately — in particular, a RECORDING_STOP must clear the
  // flag BEFORE its recording-close trigger fires, or the scheduler would drop
  // that trigger as capture-active. The storage write below also fires
  // the onChanged listener, which keeps the mirror correct for any external
  // change as well.
  liveRecording = value === true;
  // Drop the trust registry the moment capture stops, on every record-stop path
  // (RECORDING_STOP, RECORDING_OPEN, PROJECT_OPEN/DELETE, RECORDING_DELETE). The
  // storage.onChanged listener also clears it, but doing it here makes the
  // record-stop chokepoint synchronous and independent of the async change event.
  if (value !== true) clearActiveFrames();
  await chrome.storage.local.set({ recording: value });
}

async function injectContentScript() {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  // Inject into all frames of all matching tabs.
  // The content script's __docentLoaded guard prevents double-initialization.
  await Promise.allSettled(
    tabs.map(async (tab) => {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ['content/recorder.js'],
          // Inject as early as possible to recover the document_start timing the
          // removed static content_scripts entry used to provide, so the recorder
          // is ready before the user's first interaction.
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
// commit, a recording close (capture stop), and project/recording create or
// delete. Fired centrally from the message dispatcher on a successful response.
const AUTO_SYNC_DATA_EVENTS = new Set([
  'STEP_COMMIT',
  'RECORDING_STOP',
  'PROJECT_CREATE',
  'PROJECT_DELETE',
  'RECORDING_CREATE',
  'RECORDING_DELETE',
]);

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

// Observe the `autoSync` setting (it lives inside the durable SyncState blob):
// when the panel toggles it, the blob changes and we start/stop the background
// trigger to match.
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
  if (message.type === 'FRAME_READY') {
    const tabId = sender.tab?.id;
    if (tabId != null && sender.frameId != null) registerFrame(tabId, sender.frameId);
    return false;
  }

  // APPEND_ACTION: content script sends actions here for serialized storage
  // writes (this also serializes them with clearPendingActions). Each sender is
  // validated against the active-frame registry before its action is appended,
  // so only frames we injected into during a live recording can write actions —
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

  handle(message)
    .then((response) => {
      // Fire an Auto-Sync trigger on a successful local data event: a
      // step commit, a recording close, or a project/recording create/delete.
      // The scheduler coalesces bursts and drops triggers while capture is
      // active; this is a no-op when Auto-Sync is off.
      if (response?.ok && AUTO_SYNC_DATA_EVENTS.has(message.type)) {
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
      await persist();
      return { ok: true };
    }

    case 'PROJECT_CREATE': {
      const project = createProject(msg.name);
      projects.push(project);
      activeProjectId = project.project_id;
      activeRecordingId = null;
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
      return { ok: true, project: getActiveProject() };
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
      const project = getActiveProject();
      if (!project) return { ok: false, error: 'No active project' };
      project.name = msg.name;
      await persist();
      return { ok: true, project };
    }

    case 'PROJECT_SET_METADATA': {
      const project = getActiveProject();
      if (!project) return { ok: false, error: 'No active project' };
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
      const project = getActiveProject();
      if (!project) return { ok: false, error: 'No active project' };
      const recording = createRecording(project, msg.name);
      activeRecordingId = recording.recording_id;
      await clearPending();
      await persist();
      clearActiveFrames();
      await injectContentScript();
      await seedActiveFrames();
      await setRecording(true);
      return { ok: true, recording, project };
    }

    case 'RECORDING_OPEN': {
      const project = getActiveProject();
      if (!project) return { ok: false, error: 'No active project' };
      const recording = findRecording(project, msg.recording_id);
      if (!recording) return { ok: false, error: 'Recording not found' };
      activeRecordingId = recording.recording_id;
      await clearPending();
      await setRecording(false);
      await chrome.storage.local.set({ activeRecordingId });
      return { ok: true, recording, activeSteps: resolveActiveSteps(recording) };
    }

    case 'RECORDING_DELETE': {
      const project = getActiveProject();
      if (!project) return { ok: false, error: 'No active project' };
      project.recordings = project.recordings.filter((r) => r.recording_id !== msg.recording_id);
      if (activeRecordingId === msg.recording_id) {
        activeRecordingId = null;
        await setRecording(false);
      }
      await persist();
      return { ok: true, project };
    }

    case 'RECORDING_RENAME': {
      const project = getActiveProject();
      if (!project) return { ok: false, error: 'No active project' };
      const recording = findRecording(project, msg.recording_id);
      if (!recording) return { ok: false, error: 'Recording not found' };
      recording.name = msg.name;
      await persist();
      return { ok: true };
    }

    case 'RECORDING_SET_METADATA': {
      const project = getActiveProject();
      if (!project) return { ok: false, error: 'No active project' };
      const recording = findRecording(project, msg.recording_id);
      if (!recording) return { ok: false, error: 'Recording not found' };
      if (msg.metadata) {
        recording.metadata = msg.metadata;
      } else {
        delete recording.metadata;
      }
      await persist();
      return { ok: true };
    }

    // ── Recording control ─────────────────────────────────────────────────────

    case 'RECORDING_START': {
      if (!getActiveRecording()) return { ok: false, error: 'No active recording' };
      clearActiveFrames();
      await injectContentScript();
      await seedActiveFrames();
      await setRecording(true);
      return { ok: true };
    }

    case 'RECORDING_STOP': {
      await setRecording(false);
      return { ok: true };
    }

    case 'RECORDING_CLEAR': {
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
      const recording = getActiveRecording();
      if (!recording) return { ok: false, error: 'No active recording' };

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
      const recording = getActiveRecording();
      if (!recording) return { ok: false, error: 'No active recording' };
      deleteStep(recording, msg.logical_id);
      await persist();
      return { ok: true, activeSteps: resolveActiveSteps(recording) };
    }

    case 'STEPS_REORDER': {
      const recording = getActiveRecording();
      if (!recording) return { ok: false, error: 'No active recording' };
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
      const project = getActiveProject();
      if (!project) return { ok: false, error: 'No active project' };
      // Return the raw project; the panel stamps + shapes it into the
      // `.docent.json` export via buildExport(), where the composed schema (the
      // source of the docent_format stamp) is available.
      return { ok: true, project };
    }

    default:
      return { ok: false, error: `Unknown message type: ${msg.type}` };
  }
}
