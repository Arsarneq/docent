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
import {
  TAB_CREATED_USER_ACTION_WINDOW,
  TAB_CLOSED_USER_ACTION_WINDOW,
  TAB_CREATED_SWITCH_SUPPRESSION,
  TAB_REMOVED_SWITCH_SUPPRESSION,
  TAB_CREATED_NAVIGATION_SUPPRESSION,
} from '../lib/capture-timing.js';
// Auto-Sync background host (R23.10, R23.15, R23.16). The triggered cycle calls
// the SAME shared `sync()` the manual panel path does, through the SAME
// chrome-backed adapter, so a background cycle and a manual cycle are identical
// apart from origin (R23.13, R23.16). The shared cooldown-debounced scheduler
// (sync-scheduler.js, task 24.2) owns coalescing/overlap/capture-drop.
import { createSyncTrigger, BACKSTOP_INTERVAL_MS } from '../shared/sync-scheduler.js';
import { sync } from '../shared/sync-client.js';
import { loadSyncState, saveSyncState, getSettings, setSettings } from '../shared/sync-store.js';
// Reuse the panel's platform adapter verbatim so the background cycle reads the
// same durable SyncStore, LiveState signals, schema, and validator the manual
// path uses (R23.16). adapter-chrome.js touches only chrome.* + fetch + dynamic
// import at call time (no DOM), so it is safe to host in the service worker.
import chromeAdapter from '../sidepanel/adapter-chrome.js';

// ─── In-memory state (restored from storage on SW restart) ───────────────────

let projects = [];
let activeProjectId = null;
let activeRecordingId = null;
// In-memory mirror of the `recording` capture flag, kept in sync via
// chrome.storage.onChanged. The Auto-Sync scheduler's capture probe is
// synchronous (it drops triggers while capture is active, R23.9), so the SW
// holds the flag in memory rather than awaiting a storage read on every trigger.
let liveRecording = false;

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
  ]);
  projects = stored.projects ?? [];
  activeProjectId = stored.activeProjectId ?? null;
  activeRecordingId = stored.activeRecordingId ?? null;
  // Do NOT reset recording — the user controls that, not the SW.
  // pendingActions in session storage are preserved across SW restarts.

  // Seed the in-memory capture mirror so the Auto-Sync scheduler's synchronous
  // capture probe is correct from the first trigger (R23.9), and reconcile the
  // background trigger with the persisted `autoSync` setting so Auto-Sync keeps
  // running with the panel closed across SW restarts (R23.10, R23.15).
  liveRecording = stored.recording === true;
  await reconcileAutoSync();
})();

// Open side panel when toolbar icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// When recording is enabled, inject content script into all frames
// (including about:srcdoc iframes that don't match manifest patterns).
// Also mirror the `recording` flag into memory so the Auto-Sync scheduler can
// drop triggers synchronously while capture is active (R23.9).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.recording) {
    liveRecording = changes.recording.newValue === true;
    if (changes.recording.newValue === true) {
      injectContentScript();
    }
  }
});

// When a page finishes loading while recording, re-inject into all frames
// to cover srcdoc iframes and dynamically created frames.
chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return; // Only trigger on main frame completion
  if (!(await isRecording())) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: details.tabId, allFrames: true },
      files: ['content/recorder.js'],
    });
  } catch {
    // Tab may not be injectable — ignore
  }
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

async function appendSwAction(action) {
  swWriteQueue = swWriteQueue.then(async () => {
    const { pendingActions } = await chrome.storage.local.get('pendingActions');
    const updated = [...(pendingActions ?? []), action];
    await chrome.storage.local.set({ pendingActions: updated, pendingCount: updated.length });
  });
  return swWriteQueue;
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
      await (swWriteQueue = swWriteQueue.then(async () => {
        const { pendingActions } = await chrome.storage.local.get('pendingActions');
        const updated = [
          ...(pendingActions ?? []),
          {
            type: 'navigate',
            nav_type: 'link',
            timestamp: Date.now(),
            url: details.url,
            context_id: details.tabId,
            capture_mode: 'dom',
            window_rect: null,
          },
        ];
        await chrome.storage.local.set({ pendingActions: updated, pendingCount: updated.length });
      }));
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
    await chrome.storage.local.set({ lastTabNavUrl: normalised });
    setTimeout(async () => {
      const { lastTabNavUrl: cur } = await chrome.storage.local.get('lastTabNavUrl');
      if (cur === normalised) await chrome.storage.local.remove('lastTabNavUrl');
    }, 5000);

    const { pendingActions } = await chrome.storage.local.get('pendingActions');
    const updated = [
      ...(pendingActions ?? []),
      {
        type: 'navigate',
        nav_type: navType,
        timestamp: Date.now(),
        url: details.url,
        context_id: details.tabId,
        capture_mode: 'dom',
        window_rect: null,
      },
    ];
    await chrome.storage.local.set({ pendingActions: updated, pendingCount: updated.length });
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
}

async function setRecording(value) {
  // Update the in-memory capture mirror eagerly so the Auto-Sync scheduler sees
  // the new value immediately — in particular, a RECORDING_STOP must clear the
  // flag BEFORE its recording-close trigger fires, or the scheduler would drop
  // that trigger as capture-active (R23.9). The storage write below also fires
  // the onChanged listener, which keeps the mirror correct for any external
  // change as well.
  liveRecording = value === true;
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
        });
      } catch {
        // Tab may not be injectable (e.g. chrome:// pages) — ignore
      }
    }),
  );
}

async function clearPending() {
  await chrome.storage.local.set({ pendingActions: [], pendingCount: 0 });
}

async function getPendingActions() {
  const { pendingActions } = await chrome.storage.local.get('pendingActions');
  return pendingActions ?? [];
}

// ─── Auto-Sync background host (R23.10, R23.15, R23.16) ───────────────────────
// The side panel hosts the MANUAL sync path; it does not run while the panel is
// closed. `chrome.alarms` fires in the service worker, so the BACKGROUND
// Auto-Sync cycle is hosted here. A triggered cycle calls the SAME shared
// `sync()` the panel calls, through the SAME chrome-backed adapter, so a
// background cycle and a manual cycle are identical apart from origin
// (R23.13, R23.16). The shared cooldown-debounced scheduler (sync-scheduler.js)
// owns coalescing, never-overlap, and the capture-active drop (R23.7–23.9,
// R23.14); this file only wires the platform triggers and the cycle body.

// chrome.storage.local key the chrome adapter persists the durable SyncState
// blob under. Kept in sync with SYNC_STATE_KEY in sidepanel/adapter-chrome.js;
// the SW watches it so a panel toggle of the `autoSync` setting starts/stops the
// background trigger (R23.16).
const SYNC_STATE_STORAGE_KEY = 'docentSyncState';

// chrome.alarms name for the ~60s periodic backstop (R23.7). Persisted by the
// browser, so it wakes the SW and re-drives the cycle even after suspension.
const AUTO_SYNC_ALARM = 'docent-auto-sync-backstop';

// The raw SyncStore seam over chrome.storage.local — identical shape to the
// panel's `adapterSyncStore`. `sync()` and the sync-store helpers normalize the
// loaded value into the full SyncState shape, so this just moves the raw blob
// in and out of storage (R23.16).
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

// Local data events that should fire an Auto-Sync trigger (R23.7): a step
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
  // trigger while capture is active (R23.9), so this stays a thin pass-through.
  autoSyncNotify?.();
}

// The ~60s backstop fires onAlarm even after the SW was suspended. Registered
// once at module scope; it only acts when Auto-Sync is active (notify is set).
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_SYNC_ALARM) fireAutoSyncTrigger();
});

// The Sync_Trigger adapter (R23.13): the shared scheduler owns the coalescing
// and the capture-active drop; `wire` registers the platform trigger sources
// (the ~60s alarm + the data-event hooks routed through `fireAutoSyncTrigger`)
// and returns a teardown that tears them down on stop.
const autoSyncTrigger = createSyncTrigger({
  // Synchronous capture probe: drop (do not queue) any trigger while capture is
  // active (R23.9). Mirrors the `recording` flag the panel's LiveState reads.
  isCaptureActive: () => liveRecording === true,
  wire(notify) {
    autoSyncNotify = notify;
    // Periodic ~60s backstop so a locally-idle client still pulls others'
    // changes (R23.7). periodInMinutes is the alarms API unit.
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
 * restart, R23.15) and whenever the SyncState blob changes (so a panel toggle
 * takes effect with the panel open or closed, R23.16).
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
 * origin (R23.13, R23.16). `sync()` persists the resulting SyncState through the
 * store, so the panel, when next shown, derives its indicators from it (R23.16,
 * R13.1). On a 401/403 the cycle disables Auto-Sync rather than retrying bad
 * credentials on the interval (R23.11); a transient error leaves Auto-Sync
 * enabled to retry on the next trigger (R23.12), which the scheduler handles by
 * swallowing the rejection.
 */
async function runAutoSyncCycle() {
  const { serverUrl, apiKey } = await chromeAdapter.loadSyncSettings();
  // No endpoint configured → nothing to sync. (The panel's enable rule forbids
  // turning Auto-Sync on without an endpoint, R23.2; this is a defensive guard.)
  if (!serverUrl) return;

  // Schema (push-side docent_format stamp) + generated validator (applied to
  // each pulled payload), loaded by URL exactly as the panel does (R23.16, S12).
  const schema = await chromeAdapter.loadSchema();
  const validator = await chromeAdapter.loadValidator();

  // LiveState (R6, R7, R8) — the SW owns `recording` / `activeRecordingId` /
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
  // panel's PROJECTS_SET. `sync()` already persisted the SyncState blob (R23.16).
  projects = mergedProjects;
  await persist();

  // R23.11 — an auth failure disables Auto-Sync and invalidates the
  // Connection_Test so the panel surfaces a needs-attention state and requires a
  // fresh passing test before re-enabling, rather than retrying bad credentials.
  if (result.halted && result.haltReason === 'auth') {
    await disableAutoSyncOnAuthFailure();
  }
}

/**
 * Disable Auto-Sync after a 401/403 (R23.11): tear the trigger down immediately
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
// trigger to match (R23.16).
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

  // APPEND_ACTION: content script sends actions here for serialized storage writes.
  // This ensures proper ordering with clearPendingActions.
  if (message.type === 'APPEND_ACTION') {
    appendSwAction(message.action);
    sendResponse({ ok: true });
    return false;
  }

  handle(message)
    .then((response) => {
      // Fire an Auto-Sync trigger on a successful local data event (R23.7): a
      // step commit, a recording close, or a project/recording create/delete.
      // The scheduler coalesces bursts and drops triggers while capture is
      // active (R23.8, R23.9); this is a no-op when Auto-Sync is off.
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
      await injectContentScript();
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
      await injectContentScript();
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
