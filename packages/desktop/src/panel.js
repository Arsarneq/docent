/**
 * Docent Desktop — Panel Entry Point
 *
 * Navigation:
 *   view-projects      → list of all projects
 *   view-new-project   → create project form
 *   view-project       → project detail (recording list)
 *   view-new-recording → create recording form
 *   view-recording     → active recording (recording + step list)
 *   view-rerecord      → re-record a single step
 *   view-history       → version history for a step
 *   view-step-detail   → read-only action list for a step
 *   view-settings      → theme + dispatch settings
 *   view-recording-selector → pick recording(s) to dispatch
 *   view-dispatch-confirm   → confirm before sending
 *   view-dispatch-result    → success / error after dispatch
 *
 * Unlike the Chrome extension, the desktop app manages session state
 * entirely in the frontend using the shared session model. Persistence
 * is handled via Tauri invoke("load_state") / invoke("save_state").
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */
// Governance declared in scripts/area-map.json (see its declared-governance entry): this panel assembles, exports, and dispatches .docent.json sessions; the per-platform schemas are authoritative for field semantics.

import {
  validateEndpointUrl,
  buildPayload,
  sendPayload,
  DispatchError,
} from '../shared/dispatch-core.js';
import { createDispatchCooldown } from '../shared/dispatch-cooldown.js';
import { validatePayload } from '../shared/lib/validate-import.js';
import { sync } from '../shared/sync-client.js';
import { saveSyncState, loadSyncState, getSettings, setSettings } from '../shared/sync-store.js';
import { testConnection, settingsFingerprint } from '../shared/connection-test.js';
import { createAutoSyncHost } from './auto-sync-host.js';
import { loadSessionState, saveSessionState } from './persistence.js';
import {
  UI_ACTIONS,
  deriveIndicators,
  getProjectRowIndicators,
  getRecordingIndicator,
  renderIndicatorBadge,
  renderProjectRowBadge,
  renderWorkflow,
} from '../shared/sync-conflict-ui.js';
import {
  acceptReview,
  declineReview,
  resolveConflict,
  buildKeepResolution,
  DELETE_RESOLUTION,
} from '../shared/conflict-resolution.js';
import { buildExport } from '../shared/lib/export-project.js';
import { buildImportedProject } from '../shared/lib/import-project.js';
import adapter, { commitWithCompleteness, stopWithCompleteness } from './adapter-tauri.js';
import {
  escapeHtml,
  renderProjectList as renderProjectListHtml,
  renderRecordingList as renderRecordingListHtml,
  renderStepList as renderStepListHtml,
  renderStepDetail as renderStepDetailHtml,
} from '../shared/views/render.js';
import {
  createProject,
  createRecording,
  createStep,
  addStepRecord,
  resolveActiveSteps,
  deleteStep,
  reorderSteps,
  getStepHistory,
  findRecording,
} from '../shared/lib/session.js';
import { invoke } from './tauri-bridge.js';

// ─── Elements ─────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const views = {
  projects: $('view-projects'),
  newProject: $('view-new-project'),
  project: $('view-project'),
  newRecording: $('view-new-recording'),
  recording: $('view-recording'),
  rerecord: null, // re-record is now a state within the recording view
  history: $('view-history'),
  stepDetail: $('view-step-detail'),
  settings: $('view-settings'),
  recordingSelector: $('view-recording-selector'),
  dispatchConfirm: $('view-dispatch-confirm'),
  dispatchResult: $('view-dispatch-result'),
};

const breadcrumb = $('breadcrumb');
const bcProjects = $('bc-projects');
const bcProject = $('bc-project');
const bcRecording = $('bc-recording');
const bcSep1 = $('bc-sep-1');
const bcSep2 = $('bc-sep-2');

const recordingBadge = $('recording-badge');

// Projects list
const projectList = $('project-list');
const projectsEmpty = $('projects-empty');
const btnNewProject = $('btn-new-project');
const btnImportProject = $('btn-import-project');
const importFileInput = $('import-file-input');

// New project form
const newProjectName = $('new-project-name');
const btnNewProjectCreate = $('btn-new-project-create');
const btnNewProjectCancel = $('btn-new-project-cancel');

// Project detail
const projectTitle = $('project-title');
const recordingList = $('recording-list');
const recordingsEmpty = $('recordings-empty');
const btnNewRecording = $('btn-new-recording');
const btnExportProject = $('btn-export-project');
const btnDispatchProject = $('btn-dispatch-project');

// New recording form
const newRecordingName = $('new-recording-name');
const btnNewRecordingCreate = $('btn-new-recording-create');
const btnNewRecordingCancel = $('btn-new-recording-cancel');

// Recording view
const recordingTitle = $('recording-title');
const btnToggleRecording = $('btn-toggle-recording');
const narrationInput = $('narration-input');
const btnClearStep = $('btn-clear-step');
const btnCommitStep = $('btn-commit-step');
const stepListEl = $('step-list');
const stepCount = $('step-count');

// Re-record
const rerecordBanner = $('rerecord-banner');
const rerecordBannerText = $('rerecord-banner-text');
const btnRerecordCancel = $('btn-rerecord-cancel');

// History
const historyList = $('history-list');
const btnHistoryBack = $('btn-history-back');

// Step detail
const stepDetailList = $('step-detail-list');
const stepDetailTitle = $('step-detail-title');
const btnStepDetailBack = $('btn-step-detail-back');

// Pending action list (live during recording)
const pendingActionsSection = $('pending-actions-section');
const pendingActionList = $('pending-action-list');
const pendingActionCount = $('pending-action-count');

// Settings
const btnSettings = $('btn-settings');
const btnSettingsBack = $('btn-settings-back');
const themeRadios = document.querySelectorAll('input[name="theme"]');
const recordingModeRadios = document.querySelectorAll('input[name="recording-mode"]');

// Simple mode elements
const narrationModeBox = $('narration-mode-box');
const simpleModeBox = $('simple-mode-box');
const stepTypeRadios = document.querySelectorAll('input[name="step-type"]');
const expectGroup = $('expect-group');
const btnCommitStepSimple = $('btn-commit-step-simple');
const btnClearStepSimple = $('btn-clear-step-simple');

// Metadata elements
const projectMetadataList = $('project-metadata-list');
const btnAddProjectMetadata = $('btn-add-project-metadata');
const recordingMetadataList = $('recording-metadata-list');
const btnAddRecordingMetadata = $('btn-add-recording-metadata');

// Dispatch settings
const settingsEndpointUrl = $('settings-endpoint-url');
const settingsEndpointError = $('settings-endpoint-error');
const settingsApiKey = $('settings-api-key');
const btnSettingsDispatchSave = $('btn-settings-dispatch-save');

// Sync settings
const settingsSyncUrl = $('settings-sync-url');
const settingsSyncError = $('settings-sync-error');
const settingsSyncApiKey = $('settings-sync-api-key');
const btnSettingsSyncSave = $('btn-settings-sync-save');
const btnSync = $('btn-sync');

// Reconciliation-policy + Auto-Sync settings
const toggleAutoAcceptUpdates = $('toggle-auto-accept-updates');
const toggleAutoAcceptDeletions = $('toggle-auto-accept-deletions');
const btnTestConnection = $('btn-test-connection');
const settingsConnectionStatus = $('settings-connection-status');
const toggleAutoSync = $('toggle-auto-sync');
const settingsAutoSyncHint = $('settings-auto-sync-hint');
const settingsAutoSyncStatus = $('settings-auto-sync-status');

// Recording selector
const recordingSelectorList = $('recording-selector-list');
const btnSelectorCancel = $('btn-selector-cancel');

// Dispatch confirmation
const confirmEndpoint = $('confirm-endpoint');
const confirmRecordings = $('confirm-recordings');
const confirmSteps = $('confirm-steps');
const btnConfirmCancel = $('btn-confirm-cancel');
const btnConfirmSend = $('btn-confirm-send');

// Dispatch result
const resultTitle = $('result-title');
const resultMessage = $('result-message');
const btnResultBack = $('btn-result-back');

// Desktop-specific elements
const targetAppSelect = $('target-app-select');
const btnRefreshApps = $('btn-refresh-apps');
const selfCaptureToggle = $('self-capture-toggle');

// ─── State ────────────────────────────────────────────────────────────────────

/** @type {{ projects: Array, syncState?: Object, settings: Object }} */
let sessionState = {
  projects: [],
  settings: {
    endpointUrl: null,
    apiKey: null,
    theme: 'auto',
    selfCaptureExclusion: true,
    syncUrl: null,
    syncApiKey: null,
  },
};

let activeProject = null;
let activeRecording = null;
let activeSteps = [];
let isRecording = false;
let pendingCount = 0;
let commitInProgress = false;
let rerecordLogicalId = null;
let previousRecordingView = null;
let dispatchSettings = { endpointUrl: null, apiKey: null };
let dispatchSelection = null;
const dispatchCooldown = createDispatchCooldown();
let cooldownTimer = null; // setInterval handle while the cooldown counts down
let syncSettings = { serverUrl: null, apiKey: null };
let isSyncing = false;
let recordingMode = 'narration'; // 'narration' or 'simple'

// ─── Persistence ──────────────────────────────────────────────────────────────

async function loadState() {
  // The persisted shape and its defaults live once in persistence.js.
  sessionState = await loadSessionState(invoke);
  dispatchSettings = {
    endpointUrl: sessionState.settings.endpointUrl,
    apiKey: sessionState.settings.apiKey,
  };
  syncSettings = {
    serverUrl: sessionState.settings.syncUrl ?? null,
    apiKey: sessionState.settings.syncApiKey ?? null,
  };
}

async function saveState() {
  try {
    await saveSessionState(invoke, sessionState);
  } catch (err) {
    console.error('[Docent] Failed to save state:', err);
  }
}

// ─── Conflict-handling state: SyncStore + LiveState adapters ────────────────────
//
// Graded sync conflict resolution lives entirely in packages/shared and is fed
// two platform-provided seams (see sync-types.js): a durable `SyncStore` and a
// synchronous `LiveState`. On desktop both are backed by panel state that is
// itself persisted through the Tauri load_state/save_state blob — identical in
// behavior to the extension's chrome.storage.local backing, so the shared
// orchestrator and resolution workflow behave the same on both platforms.

/**
 * SyncStore adapter — durable read/write of the single
 * `SyncState` blob (baselines, snapshots, reviews, conflicts). It is persisted
 * as `sessionState.syncState`, so it rides the same Tauri `save_state` blob the
 * rest of the desktop state uses and survives application restarts. `load()`
 * returns the persisted value (or `{}` when nothing is stored yet — the shared
 * `loadSyncState` normalizes that into a complete empty state); `save(state)`
 * stores it back into `sessionState` and flushes via `saveState()`.
 *
 * @type {import('../shared/sync-types.js').SyncStore}
 */
const syncStore = {
  async load() {
    return sessionState.syncState ?? {};
  },
  async save(state) {
    sessionState.syncState = state;
    await saveState();
  },
};

/**
 * LiveState adapter — synchronous answers about what the user is
 * doing right now, mapped from the desktop panel's existing live flags:
 *   - `isCaptureActive()`            ← `isRecording`. The desktop's `isRecording`
 *     flag tracks whether the Rust capture backend is running (toggled by
 *     start_capture/stop_capture); while true, sync halts entirely.
 *   - `getLockedRecordingIds()`      ← `activeRecording`. `activeRecording` is
 *     non-null only while a recording is open in the Recording_View (showView
 *     clears it on every non-recording view), so it is exactly the
 *     Open_Recording — a Locked_Recording excluded from the inbound merge.
 *   - `recordingsWithPendingActions()` ← `pendingCount` + `activeRecording`.
 *     Uncommitted Pending Actions belong to the open recording, so a non-zero
 *     `pendingCount` marks that recording as holding Pending Actions; it is
 *     protected by the lock (it is the open recording) or, while capturing, the
 *     capture halt.
 *
 * @type {import('../shared/sync-types.js').LiveState}
 */
const liveState = {
  isCaptureActive() {
    return isRecording;
  },
  getLockedRecordingIds() {
    const ids = new Set();
    if (activeRecording && activeRecording.recording_id) {
      ids.add(activeRecording.recording_id);
    }
    return ids;
  },
  recordingsWithPendingActions() {
    const ids = new Set();
    if (pendingCount > 0 && activeRecording && activeRecording.recording_id) {
      ids.add(activeRecording.recording_id);
    }
    return ids;
  },
};

/**
 * The current durable {@link SyncState}, or `null` when nothing has been
 * persisted yet. Used by the render path to derive attention indicators and by
 * the resolution workflow to look up items. `deriveIndicators`/`renderWorkflow`
 * tolerate `null`, so callers need not normalize first.
 *
 * @returns {import('../shared/sync-types.js').SyncState | null}
 */
function getSyncState() {
  return sessionState.syncState ?? null;
}

// ─── Background Auto-Sync host ───
//
// Auto-Sync changes only *what triggers* a cycle: a ~60s backstop timer plus
// local data-event hooks, routed through the shared cooldown-debounced scheduler
// (sync-scheduler.js), invoke the SAME shared `sync()` with the SAME `syncStore`,
// `liveState`, schema, and validator the manual Sync button uses.
// The host lives in `auto-sync-host.js` (DOM-free) so the triggered cycle can run
// even when the window is closed/minimized — on desktop the Tauri webview is kept
// alive in that case (see src-tauri/src/lib.rs), so this JS host's timer and
// `sync()` invocation keep running headless. The host persists the
// resulting SyncState through `syncStore`, so the window — when next shown —
// derives attention indicators from it.

/** @type {ReturnType<typeof createAutoSyncHost> | null} The running host, or null when Auto-Sync is off. */
let autoSyncHost = null;

/**
 * The single data-event callback the running host registered. The panel
 * calls {@link notifyDataEvent} after a meaningful local data change (step
 * commit, recording close, project/recording create/delete); that forwards here,
 * which the shared scheduler coalesces with the backstop into at most one cycle
 * per cooldown window. `null` while Auto-Sync is off.
 *
 * @type {(() => void) | null}
 */
let autoSyncDataHook = null;

/**
 * Fire the Auto-Sync data-event trigger, if Auto-Sync is active. A no-op when
 * Auto-Sync is off, so call sites can invoke it unconditionally after a local
 * data mutation. The scheduler drops it while capture is active and coalesces a
 * burst into one cycle.
 *
 * @returns {void}
 */
function notifyDataEvent() {
  if (autoSyncDataHook) autoSyncDataHook();
}

/**
 * Read whether Auto-Sync is enabled from the persisted, normalized settings.
 * Tolerates a never-persisted state (defaults OFF).
 *
 * @returns {boolean}
 */
function isAutoSyncEnabled() {
  return getSettings(getSyncState() ?? {}).autoSync === true;
}

/**
 * Tell the Rust side whether to keep the webview alive when the window is closed.
 * While Auto-Sync is active the close request hides the window instead
 * of destroying the webview, so this host's timer + `sync()` keep running in the
 * background; while it is off the window closes (and quits) normally. Best-effort:
 * a missing command (older shell) is logged and ignored so the panel still works.
 *
 * @param {boolean} armed
 * @returns {Promise<void>}
 */
async function setBackgroundKeepAlive(armed) {
  try {
    await invoke('set_auto_sync_keepalive', { enabled: armed });
  } catch (err) {
    console.warn('[Docent] Failed to set Auto-Sync keep-alive:', err);
  }
}

/**
 * Start the background Auto-Sync host if it is not already running. Wires
 * the shared scheduler to the manual path's adapters and arms the webview
 * keep-alive so the cycle survives a closed/minimized window. Idempotent.
 *
 * @returns {void}
 */
function startAutoSyncHost() {
  if (autoSyncHost) return;
  if (!syncSettings.serverUrl) return; // enable rule requires an endpoint

  autoSyncHost = createAutoSyncHost({
    serverUrl: syncSettings.serverUrl,
    apiKey: syncSettings.apiKey,
    getProjects: () => sessionState.projects,
    setProjects: async (mergedProjects) => {
      sessionState.projects = mergedProjects;
      await saveState();
      // Refresh whatever list is in view so freshly pulled/updated projects and
      // their attention indicators appear even on a background cycle.
      refreshActiveProjectViews();
    },
    getSchema: () => adapter.loadSchema(),
    getValidator: () => adapter.loadValidator(),
    store: syncStore,
    liveState,
    // The host hands us the scheduler-bound notify; keep it so data events can
    // fire it. Cleared when the host stops.
    onDataEvent: (notify) => {
      autoSyncDataHook = notify;
    },
    onCycleComplete: () => {
      // Re-render so background-recorded Review/Conflict indicators surface when
      // the window is shown. Cheap and idempotent.
      refreshActiveProjectViews();
      updateSyncButton();
      updateAutoSyncControls();
    },
    onAuthDisable: async () => {
      // a 401/403 disables Auto-Sync and flags Settings for a re-test
      // rather than retrying bad credentials on the interval. Persist the change
      // and tear the host down; the user re-tests + re-enables from Settings.
      await disableAutoSync({ invalidateTest: 'auth' });
    },
  });

  autoSyncHost.start();
  autoSyncDataHook = null; // populated synchronously by start() via onDataEvent
  // start() calls wire(notify) → onDataEvent(notify) above, so autoSyncDataHook
  // is set by the time start() returns; guard re-read in case wiring changes.
  setBackgroundKeepAlive(true);
  updateSyncButton();
  updateAutoSyncControls();
}

/**
 * Stop the background Auto-Sync host if running and disarm the webview
 * keep-alive. Idempotent. Does NOT change the persisted `autoSync`
 * setting — use {@link disableAutoSync} for that.
 *
 * @returns {void}
 */
function stopAutoSyncHost() {
  if (autoSyncHost) {
    autoSyncHost.stop();
    autoSyncHost = null;
  }
  autoSyncDataHook = null;
  setBackgroundKeepAlive(false);
  updateSyncButton();
  updateAutoSyncControls();
}

/**
 * Persist `autoSync: false` and tear the host down. Used by the auth-disable
 * path, by a settings change, and by an explicit user toggle-off.
 *
 * The optional `invalidateTest` also clears the prior Connection_Test so Settings
 * demands a fresh pass before re-enabling. It distinguishes WHY
 * the pass no longer applies, which the UI surfaces differently:
 *   - `'auth'`     — a genuine 401/403 occurred; Settings shows an auth error.
 *   - `'untested'` — the endpoint/key changed, so the prior pass simply no longer
 *                    applies. This is NOT a failure, so it must NOT be labelled
 *                    `'auth'` (doing so wrongly shows "Authentication failed" after
 *                    a plain Save); the test reverts to the untested (`null`) state
 *                    and Settings prompts "Test the connection to enable Auto-sync."
 *   - `false`      — leave the Connection_Test untouched (e.g. a manual toggle-off).
 *
 * @param {object} [opts]
 * @param {('auth'|'untested'|false)} [opts.invalidateTest=false]
 * @returns {Promise<void>}
 */
async function disableAutoSync({ invalidateTest = false } = {}) {
  const state = (await loadSyncState(syncStore)) ?? {};
  const patch = { autoSync: false };
  if (invalidateTest) {
    patch.connectionTest = invalidateTest === 'auth' ? 'auth' : null;
    patch.testedSettingsFingerprint = null;
  }
  setSettings(state, patch);
  await saveSyncState(syncStore, state);
  stopAutoSyncHost();
}

/**
 * Bring the host into agreement with the persisted `autoSync` setting and the
 * current endpoint: start it when Auto-Sync is enabled and an endpoint is
 * present, stop it otherwise. Safe to call on boot and after any
 * settings change.
 *
 * @returns {void}
 */
function syncAutoSyncHostState() {
  if (isAutoSyncEnabled() && syncSettings.serverUrl) {
    startAutoSyncHost();
  } else {
    stopAutoSyncHost();
  }
}

/**
 * Re-resolve the active project from the (possibly replaced) projects array and
 * re-render whichever list is currently shown, so a background cycle's pulled
 * data and attention indicators appear without a manual refresh.
 *
 * @returns {void}
 */
function refreshActiveProjectViews() {
  if (activeProject) {
    activeProject =
      sessionState.projects.find((p) => p.project_id === activeProject.project_id) ?? null;
  }
  if (activeProject && !views.project.classList.contains('hidden')) {
    renderProjectDetail();
  } else if (!views.projects.classList.contains('hidden')) {
    renderProjectsList();
  }
}

// ─── Pending actions tracking ─────────────────────────────────────────────────

adapter.onPendingCountChange((count) => {
  pendingCount = count;
  updateCommitButton();
});

// Live action list: render each action as it's captured
adapter.onActionEvent((action) => {
  appendLiveAction(action);
});

function appendLiveAction(action) {
  const html = renderStepDetailHtml([action]);
  pendingActionsSection.classList.remove('hidden');
  const li = document.createElement('template');
  li.innerHTML = html[0].trim();
  pendingActionList.appendChild(li.content.firstChild);
  pendingActionCount.textContent = pendingActionList.children.length;
}

function clearLiveActionList() {
  pendingActionList.innerHTML = '';
  pendingActionCount.textContent = '0';
  pendingActionsSection.classList.add('hidden');
}

// ─── View management ─────────────────────────────────────────────────────────

function showView(viewKey) {
  Object.values(views).forEach((v) => v && v.classList.add('hidden'));
  views[viewKey].classList.remove('hidden');
  if (['projects', 'newProject', 'project', 'newRecording'].includes(viewKey)) {
    activeRecording = null;
  }
  updateBreadcrumb(viewKey);
}

function updateBreadcrumb(viewKey) {
  const showBc = !['projects', 'newProject', 'settings'].includes(viewKey);
  breadcrumb.classList.toggle('hidden', !showBc);

  bcSep1.classList.toggle('hidden', !activeProject);
  bcProject.classList.toggle('hidden', !activeProject);
  bcSep2.classList.toggle('hidden', !activeRecording || viewKey === 'project');
  bcRecording.classList.toggle('hidden', !activeRecording || viewKey === 'project');

  if (activeProject) bcProject.textContent = activeProject.name;
  if (activeRecording) bcRecording.textContent = activeRecording.name;
}

// ─── Breadcrumb navigation ────────────────────────────────────────────────────

bcProjects.addEventListener('click', async () => {
  const wasRecordingOpen = activeRecording !== null;
  if (isRecording) {
    await invoke('stop_capture');
    isRecording = false;
  }
  activeProject = null;
  activeRecording = null;
  updateRecordingUI();
  renderProjectsList();
  if (wasRecordingOpen) notifyDataEvent(); // recording close
});

bcProject.addEventListener('click', async () => {
  const wasRecordingOpen = activeRecording !== null;
  if (isRecording) {
    await invoke('stop_capture');
    isRecording = false;
  }
  activeRecording = null;
  updateRecordingUI();
  renderProjectDetail();
  showView('project');
  if (wasRecordingOpen) notifyDataEvent(); // recording close
});

// ─── Projects list ────────────────────────────────────────────────────────────

function renderProjectsList() {
  const projects = sessionState.projects.map((p) => ({
    ...p,
    recording_count: (p.recordings ?? []).length,
  }));

  projectList.innerHTML = '';
  projectsEmpty.classList.toggle('hidden', projects.length > 0);

  // Derive sync-state attention indicators once for the whole list.
  const indicators = deriveIndicators(getSyncState());

  const htmlItems = renderProjectListHtml(projects);
  projects.forEach((p, i) => {
    const wrapper = document.createElement('template');
    wrapper.innerHTML = htmlItems[i].trim();
    const li = wrapper.content.firstChild;
    li.querySelector('[data-action="open"]').addEventListener('click', () =>
      openProject(p.project_id),
    );
    li.querySelector('[data-action="delete"]').addEventListener('click', () =>
      deleteProject(p.project_id, p.name),
    );
    // Project-row attention badges: the project Unit's own badge
    // (opens its workflow) plus rolled-up recording-conflict /
    // recording-review badges (open the project), deduped to one of each.
    attachProjectRowBadges(li, getProjectRowIndicators(indicators, p.project_id));
    projectList.appendChild(li);
  });

  showView('projects');
}

function openProject(project_id) {
  activeProject = sessionState.projects.find((p) => p.project_id === project_id) ?? null;
  activeRecording = null;
  isRecording = false;
  updateRecordingUI();
  renderProjectDetail();
  showView('project');
}

async function deleteProject(project_id, name) {
  if (!confirm(`Delete project "${name}"? This cannot be undone.`)) return;
  sessionState.projects = sessionState.projects.filter((p) => p.project_id !== project_id);
  await saveState();
  notifyDataEvent(); // project delete is a meaningful local data event
  if (activeProject?.project_id === project_id) {
    activeProject = null;
    activeRecording = null;
  }
  renderProjectsList();
}

// New project
btnNewProject.addEventListener('click', () => {
  newProjectName.value = '';
  showView('newProject');
});

btnNewProjectCancel.addEventListener('click', () => renderProjectsList());

btnNewProjectCreate.addEventListener('click', async () => {
  const name = newProjectName.value.trim() || 'Untitled Project';
  const project = createProject(name);
  sessionState.projects.push(project);
  await saveState();
  notifyDataEvent(); // project create is a meaningful local data event
  activeProject = project;
  activeRecording = null;
  renderProjectDetail();
  showView('project');
});

newProjectName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnNewProjectCreate.click();
});

// Import project
btnImportProject.addEventListener('click', async () => {
  if (adapter.hasNativeFileDialog) {
    try {
      const json = await invoke('import_file');
      if (!json) return; // user cancelled
      handleImportData(JSON.parse(json));
    } catch (err) {
      alert(`Import failed: ${err.message || err}`);
    }
  } else {
    importFileInput.click();
  }
});

if (importFileInput) {
  importFileInput.addEventListener('change', async () => {
    const file = importFileInput.files[0];
    if (!file) return;
    importFileInput.value = '';
    try {
      const exportData = JSON.parse(await file.text());
      handleImportData(exportData);
    } catch {
      alert('Could not read file — make sure it is a valid .docent.json');
    }
  });
}

async function handleImportData(exportData) {
  if (!exportData?.project?.project_id) {
    alert('Invalid file: missing project data.');
    return;
  }

  // Validate against the platform schema before persisting. Reject-but-log.
  const validator = await adapter.loadValidator();
  if (validator) {
    const { valid, errors } = validatePayload(validator, exportData);
    if (!valid) {
      console.warn('[Docent] Import rejected — schema validation failed:', errors);
      alert(
        `Import failed: file does not match the Docent format.\n\n${errors.slice(0, 5).join('\n')}`,
      );
      return;
    }
  } else {
    console.warn('[Docent] Import validator unavailable — proceeding without schema validation.');
  }

  const newProject = buildImportedProject(sessionState.projects, exportData);

  sessionState.projects.push(newProject);
  await saveState();
  renderProjectsList();
}

// ─── Project detail ───────────────────────────────────────────────────────────

function renderProjectDetail() {
  projectTitle.textContent = activeProject.name;
  projectTitle.title = 'Click to rename';
  projectTitle.style.cursor = 'pointer';
  recordingList.innerHTML = '';

  // Render project metadata
  renderMetadataList(projectMetadataList, activeProject.metadata);

  const recordings = activeProject.recordings ?? [];
  recordingsEmpty.classList.toggle('hidden', recordings.length > 0);

  // Derive recording-level attention indicators for this project.
  const indicators = deriveIndicators(getSyncState());

  const htmlItems = renderRecordingListHtml(recordings);
  recordings.forEach((r, i) => {
    const wrapper = document.createElement('template');
    wrapper.innerHTML = htmlItems[i].trim();
    const li = wrapper.content.firstChild;
    li.querySelector('[data-action="open"]').addEventListener('click', () =>
      openRecording(r.recording_id),
    );
    li.querySelector('[data-action="delete"]').addEventListener('click', () =>
      deleteRecording(r.recording_id, r.name),
    );
    // Recording-level attention badge: always shown when the recording needs
    // attention; activating it opens the workflow for that Unit.
    attachAttentionBadge(
      li,
      getRecordingIndicator(indicators, activeProject.project_id, r.recording_id),
    );
    recordingList.appendChild(li);
  });
  updateDispatchButton();
}

// Inline rename for project title
projectTitle.addEventListener('click', async () => {
  const current = activeProject.name;
  const next = prompt('Rename project:', current);
  if (!next || next.trim() === current) return;
  activeProject.name = next.trim();
  await saveState();
  renderProjectDetail();
  updateBreadcrumb('project');
});

// New recording
btnNewRecording.addEventListener('click', () => {
  newRecordingName.value = '';
  showView('newRecording');
});

btnNewRecordingCancel.addEventListener('click', () => showView('project'));

btnNewRecordingCreate.addEventListener('click', async () => {
  const name = newRecordingName.value.trim() || 'Untitled Recording';
  if (isRecording) {
    await invoke('stop_capture');
    isRecording = false;
  }
  const recording = createRecording(activeProject, name);
  await saveState();
  notifyDataEvent(); // recording create is a meaningful local data event
  activeRecording = recording;
  activeSteps = [];
  isRecording = true;
  adapter.clearPendingActions();
  await invoke('start_capture', { pid: null });
  enterRecordingView();
});

newRecordingName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnNewRecordingCreate.click();
});

function openRecording(recording_id) {
  const recording = findRecording(activeProject, recording_id);
  if (!recording) return;
  activeRecording = recording;
  activeSteps = resolveActiveSteps(recording);
  isRecording = false;
  enterRecordingView();
}

async function deleteRecording(recording_id, name) {
  if (!confirm(`Delete recording "${name}"? This cannot be undone.`)) return;
  if (isRecording) {
    await invoke('stop_capture');
    isRecording = false;
  }
  activeProject.recordings = activeProject.recordings.filter(
    (r) => r.recording_id !== recording_id,
  );
  await saveState();
  notifyDataEvent(); // recording delete is a meaningful local data event
  activeRecording = null;
  updateRecordingUI();
  renderProjectDetail();
  showView('project');
}

// Export project
btnExportProject.addEventListener('click', async () => {
  // Stamp the export with docent_format via the shared builder; the composed
  // schema (loaded by the adapter) is the single source of truth for the stamp.
  const schema = await adapter.loadSchema();
  const exportData = buildExport(activeProject, schema);

  if (adapter.hasNativeFileDialog) {
    try {
      const defaultName = `${activeProject.name.replace(/\s+/g, '_')}_${Date.now()}.docent.json`;
      await invoke('export_file', { data: JSON.stringify(exportData, null, 2), defaultName });
    } catch (err) {
      alert(`Export failed: ${err.message || err}`);
    }
  } else {
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeProject.name.replace(/\s+/g, '_')}_${Date.now()}.docent.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
});

// Dispatch project
btnDispatchProject.addEventListener('click', () => openDispatchFlow());

function resolveActiveStepsForRecording(r) {
  return resolveActiveSteps(r);
}

function openDispatchFlow() {
  const recordings = activeProject?.recordings ?? [];
  const recordingsWithSteps = recordings
    .map((r) => ({ ...r, activeSteps: resolveActiveStepsForRecording(r) }))
    .filter((r) => r.activeSteps.length > 0);

  if (recordingsWithSteps.length === 0) return;

  if (recordingsWithSteps.length === 1) {
    showConfirmation(recordingsWithSteps, recordingsWithSteps[0].activeSteps.length);
    return;
  }

  // Multiple recordings — show selector
  recordingSelectorList.innerHTML = '';

  const allLi = document.createElement('li');
  allLi.className = 'card-item';
  const totalSteps = recordingsWithSteps.reduce((n, r) => n + r.activeSteps.length, 0);
  allLi.innerHTML = `
    <div class="card-item-main">
      <span class="card-item-name">Send all recordings</span>
      <span class="card-item-meta">${recordingsWithSteps.length} recordings · ${totalSteps} steps</span>
    </div>
    <div class="card-item-actions">
      <button class="btn btn--primary btn--sm">Send all</button>
    </div>
  `;
  allLi.querySelector('button').addEventListener('click', () => {
    showConfirmation(recordingsWithSteps, totalSteps);
  });
  recordingSelectorList.appendChild(allLi);

  recordingsWithSteps.forEach((r) => {
    const li = document.createElement('li');
    li.className = 'card-item';
    li.innerHTML = `
      <div class="card-item-main">
        <span class="card-item-name">${escapeHtml(r.name)}</span>
        <span class="card-item-meta">${r.activeSteps.length} step${r.activeSteps.length !== 1 ? 's' : ''}</span>
      </div>
      <div class="card-item-actions">
        <button class="btn btn--ghost btn--sm">Select</button>
      </div>
    `;
    li.querySelector('button').addEventListener('click', () => {
      showConfirmation([r], r.activeSteps.length);
    });
    recordingSelectorList.appendChild(li);
  });

  showView('recordingSelector');
}

function showConfirmation(recordings, totalSteps) {
  dispatchSelection = { recordings, totalSteps };
  confirmEndpoint.textContent = dispatchSettings.endpointUrl ?? '';
  confirmRecordings.textContent = recordings.map((r) => r.name).join(', ');
  confirmSteps.textContent = String(totalSteps);
  showView('dispatchConfirm');
}

btnSelectorCancel.addEventListener('click', () => showView('project'));
btnConfirmCancel.addEventListener('click', () => showView('project'));

btnConfirmSend.addEventListener('click', async () => {
  if (!dispatchSelection) return;
  btnConfirmSend.disabled = true;
  btnDispatchProject.disabled = true;
  try {
    const guidance = await adapter.loadReadingGuidance();
    const schema = await adapter.loadSchema();
    const payload = buildPayload(activeProject, dispatchSelection.recordings, guidance, schema);
    await sendPayload(dispatchSettings.endpointUrl, dispatchSettings.apiKey, payload);
    dispatchCooldown.markSent();
    resultTitle.textContent = 'Sent';
    resultMessage.textContent = `Successfully dispatched ${dispatchSelection.totalSteps} step${dispatchSelection.totalSteps !== 1 ? 's' : ''} to ${dispatchSettings.endpointUrl}.`;
    showView('dispatchResult');
  } catch (err) {
    resultTitle.textContent = 'Error';
    if (err instanceof DispatchError && err.status !== null) {
      resultMessage.textContent = `Dispatch failed with HTTP ${err.status}: ${err.message}`;
    } else {
      resultMessage.textContent = err.message || 'An unknown error occurred.';
    }
    showView('dispatchResult');
  } finally {
    btnConfirmSend.disabled = false;
    updateDispatchButton();
  }
});

btnResultBack.addEventListener('click', () => showView('project'));

// ─── Recording view ───────────────────────────────────────────────────────────

function enterRecordingView() {
  recordingTitle.textContent = activeRecording.name;
  recordingTitle.title = 'Click to rename';
  recordingTitle.style.cursor = 'pointer';
  narrationInput.value = '';
  clearLiveActionList();
  pendingCount = adapter.getPendingActions().length;
  updateCommitButton();
  // Apply current recording mode visibility
  applyRecordingMode(recordingMode);
  // Render recording metadata
  renderMetadataList(recordingMetadataList, activeRecording.metadata);
  updateRecordingUI();
  renderStepList();
  showView('recording');
}

const SVG_PAUSE = `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="5" y="4" width="3.5" height="12" rx="1" fill="currentColor"/><rect x="11.5" y="4" width="3.5" height="12" rx="1" fill="currentColor"/></svg>`;
const SVG_RESUME = `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M6 4l10 6-10 6V4z" fill="currentColor"/></svg>`;
const SVG_REC_DOT = `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="10" cy="10" r="5" fill="currentColor"/></svg>`;

function updateRecordingUI() {
  if (isRecording) {
    recordingBadge.innerHTML = `${SVG_REC_DOT} Recording`;
    recordingBadge.className = 'badge badge--recording';
    btnToggleRecording.innerHTML = `${SVG_PAUSE} <span class="btn-label">Pause</span>`;
  } else if (activeRecording) {
    recordingBadge.textContent = 'Paused';
    recordingBadge.className = 'badge badge--idle';
    btnToggleRecording.innerHTML = `${SVG_RESUME} <span class="btn-label">Resume</span>`;
  } else {
    recordingBadge.textContent = 'Idle';
    recordingBadge.className = 'badge badge--idle';
  }
}

// Inline rename for recording title
recordingTitle.addEventListener('click', async () => {
  const current = activeRecording.name;
  const next = prompt('Rename recording:', current);
  if (!next || next.trim() === current) return;
  activeRecording.name = next.trim();
  await saveState();
  recordingTitle.textContent = next.trim();
  updateBreadcrumb('recording');
});

btnToggleRecording.addEventListener('click', async () => {
  if (isRecording) {
    await invoke('stop_capture');
    isRecording = false;
  } else {
    await invoke('start_capture', { pid: null });
    isRecording = true;
  }
  updateRecordingUI();
});

// ─── Step narration ───────────────────────────────────────────────────────────

narrationInput.addEventListener('input', () => updateCommitButton());

function updateCommitButton() {
  // Narration mode: need text + pending actions
  btnCommitStep.disabled = narrationInput.value.trim().length === 0 || pendingCount === 0;
  // Simple mode: only need pending actions (no text required)
  btnCommitStepSimple.disabled = pendingCount === 0;
}

btnCommitStep.addEventListener('click', () =>
  commitStep(narrationInput, 'typed', rerecordLogicalId),
);

btnClearStep.addEventListener('click', async () => {
  if (!confirm('Clear all recorded actions for this step?')) return;
  adapter.clearPendingActions();
  pendingCount = 0;
  updateCommitButton();
  clearLiveActionList();
});

// ─── Simple mode handlers ─────────────────────────────────────────────────────

stepTypeRadios.forEach((radio) => {
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    expectGroup.classList.toggle('hidden', radio.value !== 'validation');
  });
});

btnCommitStepSimple.addEventListener('click', () => commitStepSimple(rerecordLogicalId));

btnClearStepSimple.addEventListener('click', async () => {
  if (!confirm('Clear all recorded actions for this step?')) return;
  adapter.clearPendingActions();
  pendingCount = 0;
  updateCommitButton();
  clearLiveActionList();
});

async function commitStepSimple(logicalId) {
  if (commitInProgress) return;
  commitInProgress = true;
  try {
    const stepType = document.querySelector('input[name="step-type"]:checked')?.value ?? 'action';
    const expect =
      stepType === 'validation'
        ? (document.querySelector('input[name="step-expect"]:checked')?.value ?? 'present')
        : undefined;

    const wasRecording = isRecording;

    if (isRecording) {
      // Stop capture and run the fused in-order flush barrier in one call: wait
      // for its delivery sentinel so every action drained on stop is inserted
      // before we collect this step (docent#298).
      await stopWithCompleteness();
      isRecording = false;
    } else {
      // Not recording — nothing is in flight; just normalise the pending list.
      await commitWithCompleteness();
    }

    const actions = adapter.getPendingActions();
    const nextStepNumber = logicalId
      ? (activeSteps.find((s) => s.logical_id === logicalId)?.step_number ?? activeSteps.length + 1)
      : activeSteps.length + 1;

    const stepData = {
      step_type: stepType,
      step_number: nextStepNumber,
      actions: [...actions],
      logical_id: logicalId ?? undefined,
    };
    if (expect) stepData.expect = expect;

    const step = createStep(stepData);

    addStepRecord(activeRecording, step);
    adapter.clearPendingActions();
    pendingCount = 0;

    activeSteps = resolveActiveSteps(activeRecording);
    await saveState();
    notifyDataEvent(); // step commit is a meaningful local data event

    clearLiveActionList();
    renderStepList();

    // Clear re-record state if active
    if (rerecordLogicalId) {
      rerecordLogicalId = null;
      rerecordBanner.classList.add('hidden');
      previousRecordingView = null;
    }

    if (wasRecording) {
      await invoke('start_capture', { pid: null });
      isRecording = true;
    }
    updateRecordingUI();
  } finally {
    commitInProgress = false;
  }
}

// ─── Recording mode ───────────────────────────────────────────────────────────

function applyRecordingMode(mode) {
  recordingMode = mode;
  narrationModeBox.classList.toggle('hidden', mode !== 'narration');
  simpleModeBox.classList.toggle('hidden', mode !== 'simple');
}

function loadRecordingMode() {
  const mode = sessionState.settings.recordingMode ?? 'narration';
  recordingMode = mode;
  applyRecordingMode(mode);
  recordingModeRadios.forEach((r) => {
    r.checked = r.value === mode;
  });
}

recordingModeRadios.forEach((radio) => {
  radio.addEventListener('change', async () => {
    if (!radio.checked) return;
    applyRecordingMode(radio.value);
    sessionState.settings.recordingMode = radio.value;
    await saveState();
  });
});

async function commitStep(inputEl, source, logicalId) {
  if (commitInProgress) return;
  commitInProgress = true;
  try {
    const narration = inputEl.value.trim();
    if (!narration) return;

    const wasRecording = isRecording;

    if (isRecording) {
      // Stop capture and run the fused in-order flush barrier in one call: wait
      // for its delivery sentinel so every action drained on stop is inserted
      // before we collect this step (docent#298).
      await stopWithCompleteness();
      isRecording = false;
    } else {
      // Not recording — nothing is in flight; just normalise the pending list.
      await commitWithCompleteness();
    }

    const actions = adapter.getPendingActions();
    const nextStepNumber = logicalId
      ? (activeSteps.find((s) => s.logical_id === logicalId)?.step_number ?? activeSteps.length + 1)
      : activeSteps.length + 1;

    const step = createStep({
      narration,
      narration_source: source,
      step_number: nextStepNumber,
      actions: [...actions],
      logical_id: logicalId ?? undefined,
    });

    addStepRecord(activeRecording, step);
    adapter.clearPendingActions();
    pendingCount = 0;

    activeSteps = resolveActiveSteps(activeRecording);
    await saveState();
    notifyDataEvent(); // step commit is a meaningful local data event

    inputEl.value = '';
    if (inputEl === narrationInput) btnCommitStep.disabled = true;
    clearLiveActionList();
    renderStepList();

    // Clear re-record state if active
    if (rerecordLogicalId) {
      rerecordLogicalId = null;
      rerecordBanner.classList.add('hidden');
      previousRecordingView = null;
    }

    if (wasRecording) {
      await invoke('start_capture', { pid: null });
      isRecording = true;
    }
    updateRecordingUI();
  } finally {
    commitInProgress = false;
  }
}

// ─── Step list ────────────────────────────────────────────────────────────────

function renderStepList() {
  stepListEl.innerHTML = '';
  stepCount.textContent = activeSteps.length;

  const htmlItems = renderStepListHtml(activeSteps);
  activeSteps.forEach((step, index) => {
    const wrapper = document.createElement('template');
    wrapper.innerHTML = htmlItems[index].trim();
    const li = wrapper.content.firstChild;

    li.querySelector('.step-narration').addEventListener('click', () => openStepDetail(step));
    li.querySelector('[data-action="edit"]').addEventListener('click', () => openRerecord(step));
    li.querySelector('[data-action="history"]').addEventListener('click', () =>
      openHistory(step.logical_id),
    );
    li.querySelector('[data-action="delete"]').addEventListener('click', () =>
      confirmDeleteStep(step.logical_id),
    );

    li.addEventListener('dragstart', onDragStart);
    li.addEventListener('dragover', onDragOver);
    li.addEventListener('drop', onDrop);
    li.addEventListener('dragend', onDragEnd);

    stepListEl.appendChild(li);
  });
}

// ─── Re-record ────────────────────────────────────────────────────────────────

async function openRerecord(step) {
  rerecordLogicalId = step.logical_id;
  previousRecordingView = isRecording;
  if (isRecording) {
    await invoke('stop_capture');
    isRecording = false;
  }
  adapter.clearPendingActions();
  pendingCount = 0;
  clearLiveActionList();

  // Show re-record banner
  rerecordBanner.classList.remove('hidden');
  rerecordBannerText.textContent = `Re-recording: ${step.narration || step.step_type || 'step'}`;

  // Pre-fill narration if in narration mode
  if (recordingMode === 'narration' && step.narration) {
    narrationInput.value = step.narration;
  }

  // Start fresh capture for re-recording
  await invoke('start_capture', { pid: null });
  isRecording = true;
  updateRecordingUI();
  updateCommitButton();
}

btnRerecordCancel.addEventListener('click', async () => {
  rerecordLogicalId = null;
  rerecordBanner.classList.add('hidden');
  narrationInput.value = '';
  clearLiveActionList();
  adapter.clearPendingActions();
  pendingCount = 0;

  if (!previousRecordingView) {
    await invoke('stop_capture');
    isRecording = false;
  }
  previousRecordingView = null;
  updateRecordingUI();
  updateCommitButton();
});

// The commit buttons (both narration and simple mode) already pass
// rerecordLogicalId when it's set. After commit, hide the banner.

// ─── History ──────────────────────────────────────────────────────────────────

function openHistory(logical_id) {
  if (!activeRecording) return;
  const versions = getStepHistory(activeRecording, logical_id);

  historyList.innerHTML = '';
  versions.forEach((v, i) => {
    const li = document.createElement('li');
    li.className = 'history-item' + (i === 0 ? ' history-item--active' : '');
    li.innerHTML = `
      <span class="history-time">${new Date(v.created_at).toLocaleTimeString()}</span>
      <span class="history-narration">${escapeHtml(v.narration || v.step_type || '')}</span>
      ${v.deleted ? '<span class="badge badge--deleted">deleted</span>' : ''}
    `;
    historyList.appendChild(li);
  });

  showView('history');
}

btnHistoryBack.addEventListener('click', () => showView('recording'));

// ─── Step detail ──────────────────────────────────────────────────────────────

function openStepDetail(step) {
  const label =
    step.narration ||
    (step.step_type ? `${step.step_type}${step.expect ? ' (' + step.expect + ')' : ''}` : 'Step');
  stepDetailTitle.textContent = `Step ${step.step_number}: ${label}`;
  stepDetailList.innerHTML = '';

  const htmlItems = renderStepDetailHtml(step.actions);
  htmlItems.forEach((html) => {
    const wrapper = document.createElement('template');
    wrapper.innerHTML = html.trim();
    stepDetailList.appendChild(wrapper.content.firstChild);
  });

  showView('stepDetail');
}

btnStepDetailBack.addEventListener('click', () => showView('recording'));

// ─── Delete step ──────────────────────────────────────────────────────────────

async function confirmDeleteStep(logical_id) {
  if (!confirm('Delete this step? History will be preserved.')) return;
  deleteStep(activeRecording, logical_id);
  activeSteps = resolveActiveSteps(activeRecording);
  await saveState();
  renderStepList();
}

// ─── Drag-and-drop reorder ────────────────────────────────────────────────────

let dragSrc = null;

function onDragStart(e) {
  dragSrc = this;
  e.dataTransfer.effectAllowed = 'move';
  this.classList.add('dragging');
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  this.classList.add('drag-over');
}

function onDrop(e) {
  e.preventDefault();
  if (dragSrc === this) return;
  const items = [...stepListEl.querySelectorAll('.step-item')];
  const srcIdx = items.indexOf(dragSrc);
  const dstIdx = items.indexOf(this);
  if (srcIdx < dstIdx) stepListEl.insertBefore(dragSrc, this.nextSibling);
  else stepListEl.insertBefore(dragSrc, this);
}

async function onDragEnd() {
  document
    .querySelectorAll('.step-item')
    .forEach((el) => el.classList.remove('dragging', 'drag-over'));
  const currentIds = [...stepListEl.querySelectorAll('.step-item')].map((el) => el.dataset.logical);
  const originalIds = activeSteps.map((s) => s.logical_id);
  const changed = currentIds.some((id, i) => id !== originalIds[i]);
  if (changed) await persistReorder();
}

async function persistReorder() {
  const orderedIds = [...stepListEl.querySelectorAll('.step-item')].map((el) => el.dataset.logical);
  reorderSteps(activeRecording, orderedIds);
  activeSteps = resolveActiveSteps(activeRecording);
  await saveState();
  renderStepList();
}

// ─── Theme ────────────────────────────────────────────────────────────────────

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme ?? 'auto');
}

function loadTheme() {
  const theme = sessionState.settings.theme ?? 'auto';
  applyTheme(theme);
  themeRadios.forEach((r) => {
    r.checked = r.value === theme;
  });
}

themeRadios.forEach((radio) => {
  radio.addEventListener('change', async () => {
    if (!radio.checked) return;
    applyTheme(radio.value);
    sessionState.settings.theme = radio.value;
    await saveState();
  });
});

// ─── Settings view ────────────────────────────────────────────────────────────

let settingsReturnView = 'projects';

async function loadAndPopulateDispatchSettings() {
  settingsEndpointUrl.value = dispatchSettings.endpointUrl ?? '';
  settingsApiKey.value = dispatchSettings.apiKey ?? '';
  settingsEndpointError.textContent = '';
  settingsEndpointError.classList.add('hidden');
}

btnSettingsDispatchSave.addEventListener('click', async () => {
  const url = settingsEndpointUrl.value.trim();
  const apiKey = settingsApiKey.value.trim();
  const error = validateEndpointUrl(url, { hasApiKey: !!apiKey });
  if (error) {
    settingsEndpointError.textContent = error;
    settingsEndpointError.classList.remove('hidden');
    return;
  }
  settingsEndpointError.textContent = '';
  settingsEndpointError.classList.add('hidden');

  sessionState.settings.endpointUrl = url || null;
  sessionState.settings.apiKey = apiKey || null;
  dispatchSettings = {
    endpointUrl: sessionState.settings.endpointUrl,
    apiKey: sessionState.settings.apiKey,
  };
  await saveState();
  updateDispatchButton();
});

function updateDispatchButton() {
  if (!dispatchSettings.endpointUrl) {
    btnDispatchProject.disabled = true;
    btnDispatchProject.title = 'Configure an endpoint in Settings to enable dispatch';
    return;
  }
  const recordings = activeProject?.recordings ?? [];
  const hasActiveSteps = recordings.some((r) => resolveActiveSteps(r).length > 0);

  // Post-send cooldown: hold the button disabled briefly after a send to
  // guard against rapid re-dispatch, counting down a remaining-seconds hint.
  const cooldownRemaining = dispatchCooldown.remainingMs();
  if (cooldownRemaining > 0) {
    btnDispatchProject.disabled = true;
    btnDispatchProject.title = `Just sent — wait ${Math.ceil(cooldownRemaining / 1000)}s before sending again`;
    scheduleCooldownRefresh();
    return;
  }

  btnDispatchProject.disabled = !hasActiveSteps;
  btnDispatchProject.title = hasActiveSteps ? '' : 'No recordings with active steps';
}

/**
 * While a post-send cooldown is active, re-evaluate the dispatch button once a
 * second so the countdown hint advances and the button re-enables on its own.
 */
function scheduleCooldownRefresh() {
  if (cooldownTimer !== null) return;
  cooldownTimer = setInterval(() => {
    if (dispatchCooldown.canSend()) {
      clearInterval(cooldownTimer);
      cooldownTimer = null;
    }
    updateDispatchButton();
  }, 1000);
}

// ─── Sync settings ────────────────────────────────────────────────────────────

async function loadAndPopulateSyncSettings() {
  settingsSyncUrl.value = syncSettings.serverUrl ?? '';
  settingsSyncApiKey.value = syncSettings.apiKey ?? '';
  settingsSyncError.textContent = '';
  settingsSyncError.classList.add('hidden');
}

btnSettingsSyncSave.addEventListener('click', async () => {
  const url = settingsSyncUrl.value.trim();
  const apiKey = settingsSyncApiKey.value.trim();

  // Validate URL if non-empty
  if (url) {
    const error = validateEndpointUrl(url, { hasApiKey: !!apiKey });
    if (error) {
      settingsSyncError.textContent = error;
      settingsSyncError.classList.remove('hidden');
      return;
    }
  }

  settingsSyncError.textContent = '';
  settingsSyncError.classList.add('hidden');

  try {
    await adapter.saveSyncSettings(url, apiKey);
    // Update sessionState to reflect new sync settings
    sessionState.settings.syncUrl = url || null;
    sessionState.settings.syncApiKey = apiKey || null;
    syncSettings = {
      serverUrl: url || null,
      apiKey: apiKey || null,
    };
    // changing the endpoint or API key invalidates the prior
    // Connection_Test and disables Auto-Sync until a fresh test passes. Tear the
    // background host down here; the user re-tests + re-enables from Settings.
    // This is a settings change, not an auth failure — invalidate to the untested
    // state so Settings prompts a re-test rather than reporting "Authentication
    // failed".
    await disableAutoSync({ invalidateTest: 'untested' });
    // Clear any transient Connection_Test result from the previous settings; it
    // was taken against a now-stale endpoint/key. updateAutoSyncControls re-derives
    // the correct prompt ("Test the connection to enable Auto-sync.").
    settingsConnectionStatus.textContent = '';
    settingsConnectionStatus.classList.add('hidden');
    settingsConnectionStatus.classList.remove('is-ok', 'is-error');
    updateSyncButton();
    updateAutoSyncControls();
  } catch (err) {
    settingsSyncError.textContent = err.message;
    settingsSyncError.classList.remove('hidden');
  }
});

function updateSyncButton() {
  // while Auto-Sync is active, hide the manual Sync button entirely and
  // provide no manual force-sync affordance (the ~60s backstop makes one
  // unnecessary). When Auto-Sync is off, show it and gate on an endpoint being
  // configured and no sync already in flight.
  const autoActive = autoSyncHost !== null;
  btnSync.classList.toggle('hidden', autoActive);
  btnSync.disabled = autoActive || !syncSettings.serverUrl || isSyncing;
}

// ─── Reconciliation-policy + Auto-Sync settings ──────────────────────
//
// These three client-local toggles are the settings half of the feature: the
// two Auto-Accept policy toggles and the Auto-Sync enable state machine.
// They are byte-identical in semantics and labels to the extension's, and
// their values are per-client (persisted via setSettings, never synced). The
// orchestrator reads the policy toggles each cycle; the
// background host reads `autoSync` via syncAutoSyncHostState().

/**
 * Reflect the persisted reconciliation-policy + Auto-Sync settings into the
 * Settings controls. Reads the normalized settings from the
 * durable SyncState so a never-persisted state shows the documented OFF defaults.
 * Also recomputes the Auto-Sync enable rule and the connection/status indicators.
 *
 * @returns {void}
 */
function loadAndPopulateReconciliationSettings() {
  const settings = getSettings(getSyncState() ?? {});
  toggleAutoAcceptUpdates.checked = settings.autoAcceptUpdates === true;
  toggleAutoAcceptDeletions.checked = settings.autoAcceptDeletions === true;
  // Clear any transient Connection_Test result line from a previous visit; the
  // needs-retest case is re-derived by updateAutoSyncControls below.
  settingsConnectionStatus.textContent = '';
  settingsConnectionStatus.classList.add('hidden');
  settingsConnectionStatus.classList.remove('is-ok', 'is-error');
  updateAutoSyncControls();
}

/**
 * Persist a reconciliation-policy toggle. The two settings are
 * independent booleans applied on the *next* sync cycle; changing one
 * never retroactively applies or reverses a prior cycle's outcomes.
 *
 * @param {'autoAcceptUpdates'|'autoAcceptDeletions'} key
 * @param {boolean} value
 * @returns {Promise<void>}
 */
async function persistPolicySetting(key, value) {
  const state = (await loadSyncState(syncStore)) ?? {};
  setSettings(state, { [key]: value });
  await saveSyncState(syncStore, state);
}

toggleAutoAcceptUpdates.addEventListener('change', async () => {
  await persistPolicySetting('autoAcceptUpdates', toggleAutoAcceptUpdates.checked);
});

toggleAutoAcceptDeletions.addEventListener('change', async () => {
  await persistPolicySetting('autoAcceptDeletions', toggleAutoAcceptDeletions.checked);
});

/**
 * True when a passing Connection_Test is on record for the *current* server
 * settings: the stored outcome is `pass` AND the stored fingerprint
 * matches the plaintext fingerprint of the current endpoint + API key.
 * A settings change recomputes the fingerprint, so a stale pass no longer
 * matches and Auto-Sync is no longer enableable until a fresh test passes.
 *
 * @returns {boolean}
 */
function hasPassingConnectionTest() {
  if (!syncSettings.serverUrl) return false; // endpoint-present precondition
  const settings = getSettings(getSyncState() ?? {});
  if (settings.connectionTest !== 'pass') return false;
  const current = settingsFingerprint(syncSettings.serverUrl, syncSettings.apiKey);
  return settings.testedSettingsFingerprint === current;
}

/**
 * Recompute the Auto-Sync enable rule and refresh the three indicators in
 * Settings:
 *   - the Auto-Sync toggle is enableable ONLY when an endpoint is present AND a
 *     passing Connection_Test is on record for the current settings; otherwise
 *     it is disabled and (when off) shows a prompt explaining what is needed;
 *   - the toggle reflects the persisted `autoSync` value;
 *   - the "Auto-sync active" status shows only while the host is actually running;
 *   - the needs-retest flag (set by a 401/403 auto-disable) surfaces as an
 *     error-flavored connection status.
 *
 * @returns {void}
 */
function updateAutoSyncControls() {
  const settings = getSettings(getSyncState() ?? {});
  const enabled = settings.autoSync === true;
  const active = autoSyncHost !== null;
  const canEnable = hasPassingConnectionTest();

  // The toggle is enableable only when the rule is met; keep it checked only
  // while genuinely enabled so a forced-off state (settings change / auth
  // disable) is reflected immediately.
  toggleAutoSync.checked = enabled;
  toggleAutoSync.disabled = !canEnable && !enabled;

  // Active indicator: only while the background host is running.
  settingsAutoSyncStatus.classList.toggle('hidden', !active);

  // Enable prompt: when Auto-Sync is off and cannot yet be enabled, explain why
  // (no endpoint, or no fresh passing test). Hidden once it is enableable/on.
  if (!enabled && !canEnable) {
    settingsAutoSyncHint.textContent = !syncSettings.serverUrl
      ? 'Configure a sync server above to enable Auto-sync.'
      : 'Test the connection to enable Auto-sync.';
    settingsAutoSyncHint.classList.remove('hidden');
  } else {
    settingsAutoSyncHint.classList.add('hidden');
  }

  // a prior 401/403 auto-disable stored connectionTest='auth' and cleared
  // the tested fingerprint. Surface that as a needs-retest prompt so the user
  // knows to re-test rather than wondering why Auto-sync turned itself off.
  if (!enabled && settings.connectionTest === 'auth' && syncSettings.serverUrl) {
    showConnectionStatus('Authentication failed — re-test your connection.', 'is-error');
  }
}

/**
 * Render the Connection_Test result line under the Test-connection button.
 *
 * @param {string} message
 * @param {'is-ok'|'is-error'|''} [flavor='']
 * @returns {void}
 */
function showConnectionStatus(message, flavor = '') {
  settingsConnectionStatus.textContent = message;
  settingsConnectionStatus.classList.remove('hidden', 'is-ok', 'is-error');
  if (flavor) settingsConnectionStatus.classList.add(flavor);
}

btnTestConnection.addEventListener('click', async () => {
  // the enable rule verifies an endpoint is present BEFORE invoking the
  // Connection_Test; never call testConnection with an empty/absent endpoint.
  if (!syncSettings.serverUrl) {
    showConnectionStatus('Configure a sync server above first.', 'is-error');
    return;
  }

  btnTestConnection.disabled = true;
  showConnectionStatus('Testing…');
  try {
    const { ok, reason } = await testConnection(syncSettings.serverUrl, syncSettings.apiKey);
    const state = (await loadSyncState(syncStore)) ?? {};
    if (ok) {
      // Record the pass against the CURRENT plaintext fingerprint so a later
      // endpoint/key change invalidates it.
      setSettings(state, {
        connectionTest: 'pass',
        testedSettingsFingerprint: settingsFingerprint(syncSettings.serverUrl, syncSettings.apiKey),
      });
      await saveSyncState(syncStore, state);
      showConnectionStatus('Connection OK — Auto-sync can be enabled.', 'is-ok');
    } else {
      // A failing test clears any prior pass so Auto-Sync stays not-enableable.
      setSettings(state, { connectionTest: reason, testedSettingsFingerprint: null });
      await saveSyncState(syncStore, state);
      showConnectionStatus(
        reason === 'auth'
          ? 'Authentication failed — check your API key.'
          : 'Could not reach the server — check the endpoint.',
        'is-error',
      );
    }
  } catch {
    showConnectionStatus('Could not reach the server — check the endpoint.', 'is-error');
  } finally {
    btnTestConnection.disabled = false;
    updateAutoSyncControls();
  }
});

toggleAutoSync.addEventListener('change', async () => {
  if (toggleAutoSync.checked) {
    // Enforce the enable rule defensively even though the toggle is disabled when
    // it is unmet: only persist autoSync=true when an endpoint is present AND a
    // fresh Connection_Test passes.
    if (!hasPassingConnectionTest()) {
      toggleAutoSync.checked = false;
      updateAutoSyncControls();
      return;
    }
    const state = (await loadSyncState(syncStore)) ?? {};
    setSettings(state, { autoSync: true });
    await saveSyncState(syncStore, state);
    // Start the background host (24.5) for the now-enabled setting.
    syncAutoSyncHostState();
  } else {
    // Toggling off persists autoSync=false and tears the host down, but does NOT
    // invalidate the passing Connection_Test (the user can flip it back on).
    await disableAutoSync();
  }
  updateAutoSyncControls();
});

btnSync.addEventListener('click', () => handleSync());

async function handleSync() {
  if (isSyncing) return;
  isSyncing = true;
  updateSyncButton();
  btnSync.textContent = 'Syncing…';

  try {
    // Schema (push-side docent_format stamp) + generated validator (applied to
    // each pulled payload), both from the adapter.
    const schema = await adapter.loadSchema();
    const validator = await adapter.loadValidator();

    const { result, projects: mergedProjects } = await sync(
      syncSettings.serverUrl,
      syncSettings.apiKey,
      sessionState.projects,
      schema,
      validator,
      syncStore,
      liveState,
    );

    // Persist merged projects via saveState()
    sessionState.projects = mergedProjects;
    await saveState();

    // Show summary
    showSyncSummary(result);

    // Refresh the projects list UI to reflect pulled/updated projects
    if (activeProject) {
      // Re-resolve activeProject from updated list
      activeProject =
        sessionState.projects.find((p) => p.project_id === activeProject.project_id) ?? null;
    }
    renderProjectsList();
  } catch (err) {
    alert(`Sync failed: ${err.message}`);
  } finally {
    isSyncing = false;
    btnSync.textContent = 'Sync';
    updateSyncButton();
  }
}

function showSyncSummary(result) {
  if (result.halted) {
    // Distinguish WHY the cycle halted so the user can act. Auth is the
    // only halt that maps to a settings fix; the live-work and internal halts are
    // transient and resolve by ending capture / closing the open recording / retrying.
    const haltMessages = {
      auth: 'Sync halted: authentication failed. Check your API key in Settings.',
      'capture-active': "Sync paused while you're recording. Stop capture, then sync again.",
      'pending-actions-unprotected':
        'Sync paused: a recording has uncommitted actions. Commit or clear them, then sync again.',
      'internal-error':
        'Sync stopped to protect your data and made no changes. Your work and any pending items are preserved.',
    };
    alert(haltMessages[result.haltReason] ?? 'Sync halted. Please try again.');
    return;
  }
  const parts = [];
  if (result.pushed.length > 0)
    parts.push(`Pushed ${result.pushed.length} project${result.pushed.length !== 1 ? 's' : ''}`);
  if (result.pulled.length > 0)
    parts.push(`Pulled ${result.pulled.length} project${result.pulled.length !== 1 ? 's' : ''}`);
  const mismatched = result.mismatched ?? [];
  if (mismatched.length > 0)
    parts.push(
      `Skipped ${mismatched.length} incompatible project${mismatched.length !== 1 ? 's' : ''}`,
    );
  // New graded-reconciliation counts: items deferred for the user to act
  // on — incoming changes to review-and-accept, and divergences in conflict.
  const review = result.review ?? [];
  const conflicts = result.conflicts ?? [];
  // Auto-applied outcomes: fast-forward updates and server-side
  // deletions applied automatically because the matching Auto-Accept policy is ON.
  const autoAppliedUpdates = result.autoAppliedUpdates ?? [];
  const autoAppliedDeletions = result.autoAppliedDeletions ?? [];
  if (autoAppliedUpdates.length > 0)
    parts.push(
      `Auto-applied ${autoAppliedUpdates.length} update${autoAppliedUpdates.length !== 1 ? 's' : ''}`,
    );
  if (autoAppliedDeletions.length > 0)
    parts.push(
      `Auto-applied ${autoAppliedDeletions.length} deletion${autoAppliedDeletions.length !== 1 ? 's' : ''}`,
    );
  if (review.length > 0)
    parts.push(`${review.length} change${review.length !== 1 ? 's' : ''} to review`);
  if (conflicts.length > 0)
    parts.push(`${conflicts.length} conflict${conflicts.length !== 1 ? 's' : ''}`);
  if (result.errors.length > 0)
    parts.push(`${result.errors.length} error${result.errors.length !== 1 ? 's' : ''}`);
  if (parts.length === 0) parts.push('Everything up to date');

  let message = parts.join('. ') + '.';
  // Nudge the user toward the attention indicators when there is something to resolve.
  if (review.length > 0 || conflicts.length > 0) {
    message +=
      '\n\nProjects and recordings needing your attention are marked in the list — ' +
      'select a marker to review or resolve them.';
  }
  // Spell out why incompatible projects were skipped so the user can act
  // (update Docent, or pin the producing version).
  if (mismatched.length > 0) {
    message +=
      '\n\nSkipped (incompatible format):\n' + mismatched.map((m) => `• ${m.message}`).join('\n');
  }
  alert(message);
}

// ─── Conflict-resolution workflow (shared indicators + workflow) ────────────────
//
// The resolution UI is the parity-bearing half of the feature: both panels
// render the SAME shared indicators (renderIndicatorBadge) and the SAME workflow
// (renderWorkflow) from sync-conflict-ui.js, and wire the UI_ACTIONS hooks to the
// shared resolution functions (acceptReview / declineReview / resolveConflict).
// Desktop has no static workflow <section> in the shared views.html, so the
// workflow is hosted in a lazily-created overlay rather than the showView() flow.

let workflowOverlay = null;
let workflowBody = null;

/**
 * Attach a shared attention badge to a list row when its Unit needs attention.
 * The badge HTML (with the stable `data-action="open-workflow"` / `data-unit-ref`
 * hooks) comes from the shared `renderIndicatorBadge`, so it is byte-identical to
 * the extension's. Activating it opens the workflow for that Unit.
 *
 * @param {HTMLElement} li - the rendered list row
 * @param {import('../shared/sync-conflict-ui.js').AttentionIndicator | null} indicator
 * @returns {void}
 */
function attachAttentionBadge(li, indicator) {
  const html = renderIndicatorBadge(indicator);
  if (!html) return;
  const wrapper = document.createElement('template');
  wrapper.innerHTML = html.trim();
  const badge = wrapper.content.firstChild;
  // The badge lives alongside the open/delete controls in the row's action area.
  const actions = li.querySelector('.card-item-actions') ?? li;
  actions.insertBefore(badge, actions.firstChild);
  badge.addEventListener('click', () => {
    if (badge.dataset.action === UI_ACTIONS.OPEN_WORKFLOW) {
      openConflictWorkflow(badge.dataset.unitRef);
    }
  });
}

/**
 * Attach the project-ROW attention badges to a project row. Renders
 * each {@link ProjectRowBadge} from {@link getProjectRowIndicators} and wires its
 * activation by scope: the project Unit's OWN badge opens that Unit's resolution
 * workflow (`open-workflow`); a rolled-up recordings badge opens the
 * project so its per-recording badges become visible (`open-project`).
 *
 * @param {HTMLElement} li - the project list row
 * @param {import('../shared/sync-conflict-ui.js').ProjectRowBadge[]} badges
 */
function attachProjectRowBadges(li, badges) {
  if (!badges || badges.length === 0) return;
  const actions = li.querySelector('.card-item-actions') ?? li;
  // Insert in reverse so the rendered order (own, conflict roll-up, review
  // roll-up) is preserved when each is placed before the existing controls.
  for (let i = badges.length - 1; i >= 0; i--) {
    const html = renderProjectRowBadge(badges[i]);
    if (!html) continue;
    const wrapper = document.createElement('template');
    wrapper.innerHTML = html.trim();
    const badge = wrapper.content.firstChild;
    badge.addEventListener('click', () => {
      if (badge.dataset.action === UI_ACTIONS.OPEN_PROJECT) {
        openProject(badge.dataset.projectId);
      } else if (badge.dataset.action === UI_ACTIONS.OPEN_WORKFLOW) {
        openConflictWorkflow(badge.dataset.unitRef);
      }
    });
    actions.insertBefore(badge, actions.firstChild);
  }
}

/** Lazily create the overlay that hosts the resolution workflow HTML. */
function ensureWorkflowOverlay() {
  if (workflowOverlay) return;
  workflowOverlay = document.createElement('div');
  workflowOverlay.id = 'sync-workflow-overlay';
  workflowOverlay.className = 'sync-workflow-overlay hidden';
  workflowOverlay.innerHTML =
    '<div class="sync-workflow-dialog" role="dialog" aria-modal="true" aria-label="Resolve sync item">' +
    '<button type="button" class="btn btn--ghost btn--sm sync-workflow-close" aria-label="Close">Close</button>' +
    '<div class="sync-workflow-host"></div>' +
    '</div>';
  document.body.appendChild(workflowOverlay);
  workflowBody = workflowOverlay.querySelector('.sync-workflow-host');
  // Close on the explicit button or by clicking the backdrop.
  workflowOverlay.querySelector('.sync-workflow-close').addEventListener('click', closeWorkflow);
  workflowOverlay.addEventListener('click', (e) => {
    if (e.target === workflowOverlay) closeWorkflow();
  });
}

function closeWorkflow() {
  if (workflowOverlay) workflowOverlay.classList.add('hidden');
}

/**
 * Open the shared resolution workflow for a Unit. The shared
 * `renderWorkflow` routes the Unit to the correct interface and enforces the
 * wrong-interface guard: a Review opens the accept/decline view, a
 * Conflict opens the local-vs-incoming chooser. The returned HTML is inserted
 * into the overlay and its UI_ACTIONS controls are wired to the shared resolution
 * functions.
 *
 * @param {string} unitRef - the Unit to resolve (from the badge's data-unit-ref)
 * @param {('review'|'conflict')} [requestedKind] - the interface the user tried
 *   to open; omit for the normal activate-the-indicator path
 * @returns {void}
 */
function openConflictWorkflow(unitRef, requestedKind = null) {
  ensureWorkflowOverlay();
  const { html } = renderWorkflow(getSyncState(), unitRef, requestedKind);
  workflowBody.innerHTML = html;
  workflowOverlay.classList.remove('hidden');

  // Wire the shared action hooks to the shared resolution functions. Each
  // handler persists the mutated SyncState through the SyncStore and re-renders.
  const onClick = (action, handler) => {
    const el = workflowBody.querySelector(`[data-action="${action}"]`);
    if (el && !el.disabled) el.addEventListener('click', handler);
  };
  onClick(UI_ACTIONS.ACCEPT_REVIEW, () => handleAcceptReview(unitRef));
  onClick(UI_ACTIONS.DECLINE_REVIEW, () => handleDeclineReview(unitRef));
  onClick(UI_ACTIONS.RESOLVE_KEEP_LOCAL, () => handleResolveConflict(unitRef, 'local'));
  onClick(UI_ACTIONS.RESOLVE_KEEP_INCOMING, () => handleResolveConflict(unitRef, 'incoming'));
}

/**
 * Persist the mutated SyncState through the SyncStore adapter and refresh the
 * affected views. Shared by all resolution outcomes so the durable store and the
 * UI are updated in lock-step.
 *
 * @param {import('../shared/conflict-resolution.js').ResolutionResult} result
 * @returns {Promise<void>}
 */
async function persistResolution(result) {
  // The shared resolution functions return the updated projects array and mutate
  // the in-memory SyncState in place. Persisting through the SyncStore adapter
  // (saveSyncState → syncStore.save) writes the SyncState back into sessionState
  // AND flushes the whole Tauri blob, so the durable conflict state and the
  // local projects are persisted together in one write.
  sessionState.projects = result.projects;
  await saveSyncState(syncStore, getSyncState() ?? {});
  // Refresh whichever list is in view so the now-cleared indicator disappears.
  if (activeProject) {
    activeProject =
      sessionState.projects.find((p) => p.project_id === activeProject.project_id) ?? null;
  }
  if (activeProject && !views.project.classList.contains('hidden')) {
    renderProjectDetail();
  } else {
    renderProjectsList();
  }
}

async function handleAcceptReview(unitRef) {
  const result = acceptReview(getSyncState(), sessionState.projects, unitRef);
  if (!result.ok) {
    alert('Could not apply this change. It may already have been resolved.');
    return;
  }
  await persistResolution(result);
  closeWorkflow();
}

async function handleDeclineReview(unitRef) {
  const result = declineReview(getSyncState(), sessionState.projects, unitRef);
  if (!result.ok) {
    alert('Could not decline this change. It may already have been resolved.');
    return;
  }
  await persistResolution(result);
  closeWorkflow();
}

/**
 * Resolve a Conflict by adopting one side. The shared `resolveConflict` requires
 * an explicit append-only resolved state: keeping a side means
 * adopting that side's full version while RETAINING every step record from both
 * histories, so the chosen recording/project copy is augmented with any step
 * records unique to the other side. A delete-vs-change Conflict where the chosen
 * side is absent is resolved via the DELETE_RESOLUTION sentinel.
 *
 * @param {string} unitRef
 * @param {('local'|'incoming')} side - which version the user chose to keep
 * @returns {Promise<void>}
 */
async function handleResolveConflict(unitRef, side) {
  const state = getSyncState();
  const item = state && state.conflicts ? state.conflicts[unitRef] : null;
  if (!item) {
    alert('Could not resolve this item. It may already have been resolved.');
    return;
  }

  const chosen = side === 'local' ? item.local : item.incoming;
  const other = side === 'local' ? item.incoming : item.local;
  // A delete-vs-change Conflict: the chosen side is absent → accept the deletion.
  // Otherwise build the explicit append-only resolved state that adopts
  // the chosen side's Active View while retaining both histories,
  // using the shared builder so the extension and desktop resolve identically.
  const resolvedState = chosen == null ? DELETE_RESOLUTION : buildKeepResolution(chosen, other);

  const result = resolveConflict(state, sessionState.projects, unitRef, resolvedState);
  if (!result.ok) {
    alert('Could not resolve this conflict. Please try again.');
    return;
  }
  await persistResolution(result);
  closeWorkflow();
}

btnSettings.addEventListener('click', () => {
  if (!views.settings.classList.contains('hidden')) {
    showView(settingsReturnView);
    if (settingsReturnView === 'project') updateDispatchButton();
    return;
  }
  const current = Object.entries(views).find(
    ([key, el]) => key !== 'settings' && !el.classList.contains('hidden'),
  );
  settingsReturnView = current ? current[0] : 'projects';
  loadAndPopulateDispatchSettings();
  loadAndPopulateSyncSettings();
  loadAndPopulateReconciliationSettings();
  showView('settings');
});

btnSettingsBack.addEventListener('click', () => {
  showView(settingsReturnView);
  if (settingsReturnView === 'project') updateDispatchButton();
});

// ─── Target application selection (desktop-specific) ──────────────────────────

async function loadWindowList() {
  if (!targetAppSelect) return;
  try {
    const windows = await invoke('list_windows');
    targetAppSelect.innerHTML = '<option value="">All applications</option>';
    for (const win of windows) {
      const opt = document.createElement('option');
      opt.value = String(win.pid);
      opt.textContent = `${win.process_name} — ${win.title}`;
      targetAppSelect.appendChild(opt);
    }
    // Sync the target PID with current selection (resets to "all" after refresh)
    await syncTargetPid();
  } catch (err) {
    console.warn('[Docent] Failed to list windows:', err);
  }
}

async function syncTargetPid() {
  if (!targetAppSelect) return;
  const pid = targetAppSelect.value ? parseInt(targetAppSelect.value, 10) : null;
  try {
    await invoke('set_target_pid', { pid });
  } catch (err) {
    console.warn('[Docent] Failed to set target PID:', err);
  }
}

if (btnRefreshApps) {
  btnRefreshApps.addEventListener('click', () => loadWindowList());
}

if (targetAppSelect) {
  targetAppSelect.addEventListener('change', () => syncTargetPid());
}

// ─── Self-capture exclusion toggle ────────────────────────────────────────────

if (selfCaptureToggle) {
  selfCaptureToggle.checked = sessionState.settings.selfCaptureExclusion ?? true;
  selfCaptureToggle.addEventListener('change', async () => {
    sessionState.settings.selfCaptureExclusion = selfCaptureToggle.checked;
    await saveState();
    try {
      await invoke('set_self_capture_exclusion', { enabled: selfCaptureToggle.checked });
    } catch (err) {
      console.warn('[Docent] Failed to set self-capture exclusion:', err);
    }
  });
}

// ─── Metadata editor ──────────────────────────────────────────────────────────

function renderMetadataList(container, metadata) {
  container.innerHTML = '';
  if (!metadata || Object.keys(metadata).length === 0) return;
  for (const [key, value] of Object.entries(metadata)) {
    const row = document.createElement('div');
    row.className = 'metadata-row';
    const displayValue = Array.isArray(value) ? value.join(', ') : value;
    row.innerHTML = `
      <input class="metadata-key" type="text" value="${escapeHtml(key)}" placeholder="key" />
      <span class="metadata-eq">=</span>
      <input class="metadata-value" type="text" value="${escapeHtml(displayValue)}" placeholder="value (comma = list)" />
      <button class="btn btn--ghost btn--sm metadata-remove" title="Remove">&times;</button>
    `;
    container.appendChild(row);
  }
}

function collectMetadata(container) {
  const rows = container.querySelectorAll('.metadata-row');
  const metadata = {};
  for (const row of rows) {
    const key = row.querySelector('.metadata-key').value.trim();
    const value = row.querySelector('.metadata-value').value.trim();
    if (key) {
      // If value contains commas, store as array
      metadata[key] = value.includes(',')
        ? value
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean)
        : value;
    }
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function addMetadataRow(container) {
  const row = document.createElement('div');
  row.className = 'metadata-row';
  row.innerHTML = `
    <input class="metadata-key" type="text" value="" placeholder="key" />
    <span class="metadata-eq">=</span>
    <input class="metadata-value" type="text" value="" placeholder="value (comma = list)" />
    <button class="btn btn--ghost btn--sm metadata-remove" title="Remove">&times;</button>
  `;
  container.appendChild(row);
}

// Project metadata
btnAddProjectMetadata.addEventListener('click', () => {
  addMetadataRow(projectMetadataList);
});

projectMetadataList.addEventListener('click', async (e) => {
  if (e.target.classList.contains('metadata-remove')) {
    e.target.closest('.metadata-row').remove();
    const metadata = collectMetadata(projectMetadataList);
    if (metadata) activeProject.metadata = metadata;
    else delete activeProject.metadata;
    await saveState();
  }
});

projectMetadataList.addEventListener('change', async () => {
  const metadata = collectMetadata(projectMetadataList);
  if (metadata) activeProject.metadata = metadata;
  else delete activeProject.metadata;
  await saveState();
});

// Recording metadata
btnAddRecordingMetadata.addEventListener('click', () => {
  addMetadataRow(recordingMetadataList);
});

recordingMetadataList.addEventListener('click', async (e) => {
  if (e.target.classList.contains('metadata-remove')) {
    e.target.closest('.metadata-row').remove();
    const metadata = collectMetadata(recordingMetadataList);
    if (metadata) activeRecording.metadata = metadata;
    else delete activeRecording.metadata;
    await saveState();
  }
});

recordingMetadataList.addEventListener('change', async () => {
  const metadata = collectMetadata(recordingMetadataList);
  if (metadata) activeRecording.metadata = metadata;
  else delete activeRecording.metadata;
  await saveState();
});

// ─── Init ─────────────────────────────────────────────────────────────────────

await loadState();
loadTheme();
loadRecordingMode();
await loadWindowList();
updateSyncButton();

// Set initial self-capture exclusion based on persisted setting
try {
  await invoke('set_self_capture_exclusion', {
    enabled: sessionState.settings.selfCaptureExclusion ?? true,
  });
} catch (err) {
  console.warn('[Docent] Failed to set initial self-capture exclusion:', err);
}
renderProjectsList();

// Bring the background Auto-Sync host into agreement with the persisted setting:
// start the ~60s backstop + data-event trigger when Auto-Sync is
// enabled and an endpoint is configured, so triggered cycles run even when the
// window is later closed/minimized. A no-op when Auto-Sync is off.
syncAutoSyncHostState();
