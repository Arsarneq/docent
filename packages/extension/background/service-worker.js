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

// ─── In-memory state (restored from storage on SW restart) ───────────────────

let projects         = [];
let activeProjectId  = null;
let activeRecordingId = null;

// ─── Boot ─────────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    await chrome.storage.local.set({ projects: [], pendingActions: [], pendingCount: 0 });
  }
  console.log(`[Docent] onInstalled (${reason}).`);
});

// Restore persisted state on SW restart
(async () => {
  const stored = await chrome.storage.local.get(['projects', 'activeProjectId', 'activeRecordingId']);
  projects          = stored.projects          ?? [];
  activeProjectId   = stored.activeProjectId   ?? null;
  activeRecordingId = stored.activeRecordingId ?? null;
  // Do NOT reset recording — the user controls that, not the SW.
  // pendingActions in session storage are preserved across SW restarts.
})();

// Open side panel when toolbar icon is clicked
chrome.action.onClicked.addListener(tab => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// When recording is enabled, inject content script into all frames
// (including about:srcdoc iframes that don't match manifest patterns).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.recording?.newValue === true) {
    injectContentScript();
  }
});

// When a page finishes loading while recording, re-inject into all frames
// to cover srcdoc iframes and dynamically created frames.
chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return; // Only trigger on main frame completion
  if (!await isRecording()) return;
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

async function wasRecentUserAction(withinMs = 500) {
  const { lastUserActionTimestamp } = await chrome.storage.local.get('lastUserActionTimestamp');
  return lastUserActionTimestamp && (Date.now() - lastUserActionTimestamp < withinMs);
}

// Cross-document navigations: back, forward, reload, link, typed, form_submit, etc.
// Only record navigations that are browser chrome actions (typed, reload, back_forward,
// auto_bookmark). Navigations caused by in-page user actions (link clicks, form submits,
// window.location assignments) are effects of already-captured actions and are skipped.
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  if (!await isRecording()) return;
  if (!details.url || details.url.startsWith('chrome://') || details.url.startsWith('chrome-extension://') || details.url.startsWith('about:')) return;

  // Skip SPA navigations — those are handled by the content script
  const skipTypes = new Set(['auto_subframe', 'manual_subframe']);
  if (skipTypes.has(details.transitionType)) return;

  // If a tab was just created/reopened, this navigate is usually a cascading effect.
  // Exception: "link" navigations on newly created tabs are the proxy for
  // "Open in new tab" context menu selections — record those directly.
  if (Date.now() - lastTabCreatedTimestamp < 500) {
    if (details.transitionType === 'link') {
      // This is the initial navigation of a tab opened via context menu "Open in new tab".
      // Record it as the proxy for the context menu selection.
      await (swWriteQueue = swWriteQueue.then(async () => {
        const { pendingActions } = await chrome.storage.local.get('pendingActions');
        const updated = [...(pendingActions ?? []), {
          type:         'navigate',
          nav_type:     'link',
          timestamp:    Date.now(),
          url:          details.url,
          context_id:   details.tabId,
          capture_mode: 'dom',
          window_rect:  null,
        }];
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
  const browserChromeTypes = new Set(['typed', 'generated', 'reload', 'back_forward', 'auto_bookmark', 'start_page', 'keyword']);
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
    const updated = [...(pendingActions ?? []), {
      type:         'navigate',
      nav_type:     navType,
      timestamp:    Date.now(),
      url:          details.url,
      context_id:   details.tabId,
      capture_mode: 'dom',
      window_rect:  null,
    }];
    await chrome.storage.local.set({ pendingActions: updated, pendingCount: updated.length });
  }));
});

// Track recent tab removals to suppress auto-switch context_switch events.
// When a tab is closed, the browser auto-activates another tab — that's not a user action.
let lastTabRemovedTimestamp = 0;

// Track recent tab creations to suppress context_switch for newly opened tabs
// and to suppress navigations that are cascading effects of tab creation/reopen.
let lastTabCreatedTimestamp = 0;

// Track tabs opened programmatically (window.open, link target=_blank).
// Their close events should be suppressed (they were never captured as context_open).
const programmaticTabs = new Set();

// Context switch — only record when NO recent tab close and NO recent tab creation.
// If there's a recent tab close, the switch is an auto-activation by the browser.
// If there's a recent tab creation, the switch is the browser activating the new tab.
// If none of the above, the user clicked a tab in browser chrome.
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (!await isRecording()) return;
  if (Date.now() - lastTabRemovedTimestamp < 300) return;
  if (Date.now() - lastTabCreatedTimestamp < 300) return;
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) return;
  await appendSwAction({
    type:         'context_switch',
    timestamp:    Date.now(),
    context_id:   tabId,
    source:       tab.url,
    title:        tab.title ?? null,
    capture_mode: 'dom',
    window_rect:  null,
  });
});

// New context opened — capture as proxy for browser chrome actions (Ctrl+T, Ctrl+N).
// Suppress when it's a side-effect of an in-page action (window.open, link target=_blank).
// Distinguishing signal: window.open/link tabs have openerTabId; Ctrl+T/N tabs don't.
// Track the timestamp so onActivated can suppress the subsequent activation.
chrome.tabs.onCreated.addListener(async (tab) => {
  lastTabCreatedTimestamp = Date.now();
  if (!await isRecording()) return;
  // If there was a recent in-page user action, this tab is a side-effect
  // (window.open, link target=_blank, etc.) — suppress.
  if (await wasRecentUserAction()) {
    programmaticTabs.add(tab.id);
    return;
  }
  // Otherwise it's a browser chrome action (Ctrl+T, Ctrl+N, Ctrl+Shift+T) — capture as proxy.
  await appendSwAction({
    type:               'context_open',
    timestamp:          Date.now(),
    context_id:         tab.id,
    opener_context_id:  tab.openerTabId ?? null,
    source:             tab.url || null,
    capture_mode:       'dom',
    window_rect:        null,
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
  if (!await isRecording()) return;
  // Cascading close (entire window closing) — not a distinct user action.
  if (removeInfo.isWindowClosing) return;
  // If the tab was opened programmatically, its close is also a side-effect.
  if (wasProgrammatic) return;
  // Otherwise it's a browser chrome action (Ctrl+W, click X) — capture as proxy.
  await appendSwAction({
    type:           'context_close',
    timestamp:      Date.now(),
    context_id:     tabId,
    window_closing: false,
    capture_mode:   'dom',
    window_rect:    null,
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getActiveProject() {
  return projects.find(p => p.project_id === activeProjectId) ?? null;
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
  await chrome.storage.local.set({ recording: value });
}

async function injectContentScript() {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  // Inject into all frames of all matching tabs.
  // The content script's __docentLoaded guard prevents double-initialization.
  await Promise.allSettled(tabs.map(async tab => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files:  ['content/recorder.js'],
      });
    } catch {
      // Tab may not be injectable (e.g. chrome:// pages) — ignore
    }
  }));
}

async function clearPending() {
  await chrome.storage.local.set({ pendingActions: [], pendingCount: 0 });
}

async function getPendingActions() {
  const { pendingActions } = await chrome.storage.local.get('pendingActions');
  return pendingActions ?? [];
}

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
    .then(sendResponse)
    .catch(err => {
      console.error('[Docent]', err);
      sendResponse({ ok: false, error: err.message });
    });
  return true;
});

async function handle(msg) {
  switch (msg.type) {

    // ── Projects ──────────────────────────────────────────────────────────────

    case 'PROJECTS_LIST': {
      return { ok: true, projects: projects.map(p => ({
        project_id:      p.project_id,
        name:            p.name,
        created_at:      p.created_at,
        recording_count: p.recordings.length,
      }))};
    }

    case 'PROJECT_CREATE': {
      const project = createProject(msg.name);
      projects.push(project);
      activeProjectId   = project.project_id;
      activeRecordingId = null;
      await persist();
      return { ok: true, project };
    }

    case 'PROJECT_OPEN': {
      const project = projects.find(p => p.project_id === msg.project_id);
      if (!project) return { ok: false, error: 'Project not found' };
      activeProjectId   = project.project_id;
      activeRecordingId = null;
      await setRecording(false);
      await chrome.storage.local.set({ activeProjectId, activeRecordingId });
      return { ok: true, project };
    }

    case 'PROJECT_GET': {
      return { ok: true, project: getActiveProject() };
    }

    case 'PROJECT_DELETE': {
      projects = projects.filter(p => p.project_id !== msg.project_id);
      if (activeProjectId === msg.project_id) {
        activeProjectId   = null;
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
      project.recordings = project.recordings.filter(
        r => r.recording_id !== msg.recording_id
      );
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
      const activeSteps    = resolveActiveSteps(recording);
      const isRerecord     = !!msg.logical_id;

      if (!isRerecord && pendingActions.length === 0) {
        return { ok: false, error: 'No actions recorded for this step' };
      }

      let actions;
      if (pendingActions.length > 0) {
        actions = pendingActions;
      } else {
        // Narration-only re-record — reuse existing step's actions
        const existing = activeSteps.find(s => s.logical_id === msg.logical_id);
        actions = existing ? [...existing.actions] : [];
      }

      const stepNumber = msg.step_number ?? activeSteps.length + 1;

      const step = createStep({
        narration:        msg.narration,
        narration_source: msg.narration_source,
        step_number:      stepNumber,
        actions,
        logical_id:       msg.logical_id,
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
      const existing = projects.find(p => p.project_id === projectData.project_id);
      if (existing) {
        projectData = {
          ...projectData,
          project_id: uuidv7(),
          name:       `${projectData.name} (copy)`,
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
      const exportData = {
        project: {
          project_id: project.project_id,
          name:       project.name,
          created_at: project.created_at,
        },
        recordings: project.recordings.map(r => ({
          ...r,
          activeSteps: resolveActiveSteps(r),
        })),
      };
      return { ok: true, exportData };
    }

    default:
      return { ok: false, error: `Unknown message type: ${msg.type}` };
  }
}
