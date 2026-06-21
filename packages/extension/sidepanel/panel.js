/**
 * Docent — Side Panel
 *
 * Navigation:
 *   view-projects      → list of all projects
 *   view-new-project   → create project form
 *   view-project       → project detail (recording list)
 *   view-new-recording → create recording form
 *   view-recording     → active recording (recording + step list)
 *   view-rerecord      → re-record a single step
 *   view-history       → version history for a step
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { validateEndpointUrl, buildPayload, sendPayload, DispatchError } from './dispatch.js';
import { createDispatchCooldown } from '../shared/dispatch-cooldown.js';
import { validatePayload } from '../shared/lib/validate-import.js';
import { sync } from '../shared/sync-client.js';
import { loadSyncState, saveSyncState, getSettings, setSettings } from '../shared/sync-store.js';
import { testConnection, settingsFingerprint } from '../shared/connection-test.js';
import { acceptReview, declineReview, resolveConflict } from '../shared/conflict-resolution.js';
import {
  deriveIndicators,
  getProjectRowIndicators,
  getRecordingIndicator,
  renderIndicatorBadge,
  renderProjectRowBadge,
  renderWorkflow,
  buildResolvedState,
  UI_ACTIONS,
} from '../shared/sync-conflict-ui.js';
import { buildExport } from '../shared/lib/export-project.js';
import adapter from './adapter-chrome.js';
import {
  escapeHtml,
  renderProjectList as renderProjectListHtml,
  renderRecordingList as renderRecordingListHtml,
  renderStepList as renderStepListHtml,
  renderStepDetail as renderStepDetailHtml,
} from '../shared/views/render.js';

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
  syncWorkflow: $('view-sync-workflow'),
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
const stepList = $('step-list');
const stepCount = $('step-count');

// Re-record
const rerecordBanner = $('rerecord-banner');
const rerecordBannerText = $('rerecord-banner-text');
const btnRerecordCancel = $('btn-rerecord-cancel');

// Storage-quota warning (#127)
const storageQuotaBanner = $('storage-quota-banner');
const storageQuotaBannerText = $('storage-quota-banner-text');
const btnStorageQuotaResume = $('btn-storage-quota-resume');

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

// Reconciliation-policy + Auto-Sync settings. The two Auto-Accept
// toggles set client-local reconciliation policy; the Auto-Sync toggle + the
// Connection_Test flow drive the enable state machine. On the extension the
// background SERVICE WORKER owns the actual trigger — it observes
// the persisted `autoSync` setting via chrome.storage.onChanged and runs the
// `chrome.alarms` + data-event cycle. The panel only SETS policy/state and
// REFLECTS what the SW did (e.g. a 401/403 auto-disable); it never wires
// the trigger itself.
const toggleAutoAcceptUpdates = $('toggle-auto-accept-updates');
const toggleAutoAcceptDeletions = $('toggle-auto-accept-deletions');
const btnTestConnection = $('btn-test-connection');
const settingsConnectionStatus = $('settings-connection-status');
const toggleAutoSync = $('toggle-auto-sync');
const settingsAutoSyncHint = $('settings-auto-sync-hint');
const settingsAutoSyncStatus = $('settings-auto-sync-status');

// Sync resolution workflow view
const syncWorkflowBody = $('sync-workflow-body');
const btnSyncWorkflowBack = $('btn-sync-workflow-back');

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

// ─── State ────────────────────────────────────────────────────────────────────

let activeProject = null;
let activeRecording = null;
let activeSteps = [];
let isRecording = false;
let pendingCount = 0; // actions recorded since last step commit
let commitInProgress = false; // prevents double-commit on rapid clicks
let rerecordLogicalId = null;
let previousRecordingView = null; // tracks pre-rerecord recording state
let dispatchSettings = { endpointUrl: null, apiKey: null };
let dispatchSelection = null; // { recordings: [], totalSteps: number }
const dispatchCooldown = createDispatchCooldown();
let cooldownTimer = null; // setInterval handle while the cooldown counts down
let syncSettings = { serverUrl: null, apiKey: null };
let isSyncing = false;
// Cached durable conflict-handling state (baselines, snapshots, reviews,
// conflicts), loaded from chrome.storage.local via the SyncStore adapter. Used
// to derive the attention indicators on the project/recording rows and to drive
// the resolution workflow. Refreshed after each sync cycle and each resolution.
let syncState = null;
// The unitRef whose resolution workflow is currently open, or null when none.
let workflowUnitRef = null;

// The SyncStore seam: a raw { load, save } pair over the
// chrome.storage.local blob. The shared `loadSyncState`/`saveSyncState` helpers
// (and `sync()` itself) normalize whatever `load()` returns into the full
// SyncState shape, so this only moves the raw value in and out of storage.
const adapterSyncStore = {
  load: () => adapter.loadSyncState(),
  save: (state) => adapter.saveSyncState(state),
};
let recordingMode = 'narration'; // 'narration' or 'simple'

// ─── Messaging ────────────────────────────────────────────────────────────────

function send(message) {
  return adapter.send(message);
}

// ─── SW restart recovery ──────────────────────────────────────────────────────
// pendingActions live in chrome.storage.local (written by the content
// script directly), so they survive SW suspension. The panel watches
// pendingCount from local storage to keep the commit button in sync.
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

// ─── Storage-quota warning (#127) ──────────────────────────────────────────────
// The service worker pauses capture and publishes a pressure band when
// chrome.storage.local nears its quota; the panel surfaces a non-blocking banner.
// It reflects live state — it clears itself once the user frees space.
function renderStorageQuota(state) {
  if (!storageQuotaBanner) return;
  const band = state?.band ?? 'ok';
  if (band === 'ok') {
    storageQuotaBanner.classList.add('hidden');
    return;
  }
  const paused = state?.paused === true;
  storageQuotaBanner.classList.toggle('exceeded', band === 'exceeded');
  storageQuotaBannerText.textContent =
    band === 'exceeded'
      ? 'Storage is full — capture stopped. Export or delete a project to free space.'
      : paused
        ? 'Storage is almost full — capture paused. Export or delete a project to free space.'
        : 'Storage is almost full — still recording. Export or delete a project to free space.';
  // Offer the override only while auto-paused at the soft warning — the user can
  // choose to keep recording (#127). A hard `exceeded` can't be overridden.
  btnStorageQuotaResume?.classList.toggle('hidden', !(band === 'warn' && paused));
  storageQuotaBanner.classList.remove('hidden');
}
btnStorageQuotaResume?.addEventListener('click', () => send({ type: 'STORAGE_RESUME' }));
adapter.onStorageQuotaChange(renderStorageQuota);
adapter.loadStorageQuota().then(renderStorageQuota);

// ─── View management ─────────────────────────────────────────────────────────

function showView(viewKey) {
  Object.values(views).forEach((v) => v && v.classList.add('hidden'));
  views[viewKey].classList.remove('hidden');
  // Clear recording context when leaving recording views
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
  await send({ type: 'RECORDING_STOP' });
  isRecording = false;
  activeProject = null;
  activeRecording = null;
  updateRecordingUI();
  await loadProjectsList();
});

bcProject.addEventListener('click', async () => {
  await send({ type: 'RECORDING_STOP' });
  isRecording = false;
  activeRecording = null;
  updateRecordingUI();
  const { project } = await send({ type: 'PROJECT_GET' });
  if (project) activeProject = project;
  renderProjectDetail();
  showView('project');
});

// ─── Projects list ────────────────────────────────────────────────────────────

async function loadProjectsList() {
  const { projects } = await send({ type: 'PROJECTS_LIST' });
  projectList.innerHTML = '';
  projectsEmpty.classList.toggle('hidden', projects.length > 0);

  const htmlItems = renderProjectListHtml(projects);
  const indicators = deriveIndicators(syncState);
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
    // (if it itself needs attention) plus rolled-up recording-conflict /
    // recording-review badges (if any child recording does), deduped to one of
    // each kind. The own badge opens its workflow; a roll-up opens the project.
    attachProjectRowBadges(li, getProjectRowIndicators(indicators, p.project_id));
    projectList.appendChild(li);
  });

  showView('projects');
}

async function openProject(project_id) {
  const { project } = await send({ type: 'PROJECT_OPEN', project_id });
  activeProject = project;
  activeRecording = null;
  isRecording = false;
  updateRecordingUI();
  renderProjectDetail();
  showView('project');
}

async function deleteProject(project_id, name) {
  if (!confirm(`Delete project "${name}"? This cannot be undone.`)) return;
  await send({ type: 'PROJECT_DELETE', project_id });
  loadProjectsList();
}

// New project
btnNewProject.addEventListener('click', () => {
  newProjectName.value = '';
  showView('newProject');
});

// Import project
btnImportProject.addEventListener('click', () => importFileInput.click());

importFileInput.addEventListener('change', async () => {
  const file = importFileInput.files[0];
  if (!file) return;
  importFileInput.value = ''; // reset so same file can be re-imported after fix

  let exportData;
  try {
    exportData = JSON.parse(await file.text());
  } catch {
    alert('Could not read file — make sure it is a valid .docent.json');
    return;
  }

  // Validate against the platform schema before handing it to the service
  // worker for persistence. Reject-but-log: on failure we surface the
  // reason and do not import.
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

  const response = await send({ type: 'PROJECT_IMPORT', exportData });
  if (!response?.ok) {
    alert(`Import failed: ${response?.error ?? 'unknown error'}`);
    return;
  }

  await loadProjectsList();
});

btnNewProjectCancel.addEventListener('click', () => showView('projects'));

btnNewProjectCreate.addEventListener('click', async () => {
  const name = newProjectName.value.trim() || 'Untitled Project';
  const { project } = await send({ type: 'PROJECT_CREATE', name });
  activeProject = project;
  activeRecording = null;
  renderProjectDetail();
  showView('project');
});

newProjectName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnNewProjectCreate.click();
});

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

  const htmlItems = renderRecordingListHtml(recordings);
  const indicators = deriveIndicators(syncState);
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
    // Recording-level attention indicator: always shown when the
    // recording needs attention, regardless of the project-level indicator.
    attachIndicatorBadge(
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
  const { project } = await send({ type: 'PROJECT_RENAME', name: next.trim() });
  if (project) {
    activeProject = project;
    renderProjectDetail();
    updateBreadcrumb('project');
  }
});

// New recording
btnNewRecording.addEventListener('click', () => {
  newRecordingName.value = '';
  showView('newRecording');
});

btnNewRecordingCancel.addEventListener('click', () => showView('project'));

btnNewRecordingCreate.addEventListener('click', async () => {
  const name = newRecordingName.value.trim() || 'Untitled Recording';
  // Stop any in-progress recording before switching recordings
  await send({ type: 'RECORDING_STOP' });
  const { recording, project } = await send({ type: 'RECORDING_CREATE', name });
  activeProject = project;
  activeRecording = recording;
  activeSteps = [];
  isRecording = true;
  enterRecordingView();
});

newRecordingName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnNewRecordingCreate.click();
});

async function openRecording(recording_id) {
  const { recording, activeSteps: steps } = await send({
    type: 'RECORDING_OPEN',
    recording_id,
  });
  activeRecording = recording;
  activeSteps = steps;
  isRecording = false;
  enterRecordingView();
}

async function deleteRecording(recording_id, name) {
  if (!confirm(`Delete recording "${name}"? This cannot be undone.`)) return;
  isRecording = false;
  const { project } = await send({ type: 'RECORDING_DELETE', recording_id });
  activeProject = project;
  activeRecording = null;
  updateRecordingUI();
  renderProjectDetail();
  showView('project');
}

// Export project
btnExportProject.addEventListener('click', async () => {
  const response = await send({ type: 'PROJECT_EXPORT' });
  if (!response?.ok) {
    alert(`Export failed: ${response?.error ?? 'unknown error'}`);
    return;
  }
  // Stamp the export with docent_format here in the panel, where the composed
  // schema is available (the service worker doesn't load it). The schema is the
  // single source of truth for the platform + version stamp.
  const schema = await adapter.loadSchema();
  const exportData = buildExport(response.project, schema);
  const blob = new Blob([JSON.stringify(exportData, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${activeProject.name.replace(/\s+/g, '_')}_${Date.now()}.docent.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// Dispatch project
btnDispatchProject.addEventListener('click', () => openDispatchFlow());

function resolveActiveStepsForRecording(r) {
  const groups = new Map();
  for (const s of r.steps ?? []) {
    const existing = groups.get(s.logical_id);
    if (!existing || s.uuid > existing.uuid) groups.set(s.logical_id, s);
  }
  return Array.from(groups.values()).filter((s) => !s.deleted);
}

function openDispatchFlow() {
  const recordings = activeProject?.recordings ?? [];
  // Resolve active steps for each recording
  const recordingsWithSteps = recordings
    .map((r) => ({ ...r, activeSteps: resolveActiveStepsForRecording(r) }))
    .filter((r) => r.activeSteps.length > 0);

  if (recordingsWithSteps.length === 0) return;

  if (recordingsWithSteps.length === 1) {
    // Skip selector, go directly to confirmation
    showConfirmation(recordingsWithSteps, recordingsWithSteps[0].activeSteps.length);
    return;
  }

  // Multiple recordings — show selector
  recordingSelectorList.innerHTML = '';

  // "Send all" option at the top
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

  // Individual recordings
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
  // Read actual pendingCount via adapter rather than assuming 0
  adapter.getPendingCount().then((count) => {
    pendingCount = count;
    updateCommitButton();
  });
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
  await send({
    type: 'RECORDING_RENAME',
    recording_id: activeRecording.recording_id,
    name: next.trim(),
  });
  activeRecording.name = next.trim();
  recordingTitle.textContent = next.trim();
  updateBreadcrumb('recording');
});

btnToggleRecording.addEventListener('click', async () => {
  if (isRecording) {
    await send({ type: 'RECORDING_STOP' });
    isRecording = false;
  } else {
    await send({ type: 'RECORDING_START' });
    isRecording = true;
  }
  updateRecordingUI();
});

// ─── Step narration ───────────────────────────────────────────────────────────

narrationInput.addEventListener('input', () => {
  updateCommitButton();
});

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
  await send({ type: 'RECORDING_CLEAR' });
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
  await send({ type: 'RECORDING_CLEAR' });
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
      await send({ type: 'RECORDING_STOP' });
      isRecording = false;
    }

    const payload = {
      type: 'STEP_COMMIT',
      step_type: stepType,
      logical_id: logicalId ?? undefined,
    };
    if (expect) payload.expect = expect;

    const response = await send(payload);

    if (response?.ok) {
      activeSteps = response.activeSteps;
      clearLiveActionList();
      renderStepList();
      // Clear re-record state if active
      if (rerecordLogicalId) {
        rerecordLogicalId = null;
        rerecordBanner.classList.add('hidden');
        previousRecordingView = null;
      }
    }

    if (wasRecording) {
      await send({ type: 'RECORDING_START' });
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

async function loadRecordingMode() {
  const mode = await adapter.loadRecordingMode();
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
    await adapter.saveRecordingMode(radio.value);
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
      await send({ type: 'RECORDING_STOP' });
      isRecording = false;
    }

    const response = await send({
      type: 'STEP_COMMIT',
      narration,
      narration_source: source,
      logical_id: logicalId ?? undefined,
    });

    if (response?.ok) {
      activeSteps = response.activeSteps;
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
    }

    if (wasRecording) {
      await send({ type: 'RECORDING_START' });
      isRecording = true;
    }
    updateRecordingUI();
  } finally {
    commitInProgress = false;
  }
}

// ─── Step list ────────────────────────────────────────────────────────────────

function renderStepList() {
  stepList.innerHTML = '';
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

    stepList.appendChild(li);
  });
}

// ─── Re-record ────────────────────────────────────────────────────────────────

async function openRerecord(step) {
  rerecordLogicalId = step.logical_id;
  previousRecordingView = isRecording;
  if (isRecording) {
    await send({ type: 'RECORDING_STOP' });
    isRecording = false;
  }
  // Clear pending actions and start fresh capture for re-recording
  await send({ type: 'RECORDING_CLEAR' });
  pendingCount = 0;
  clearLiveActionList();

  // Show re-record banner
  rerecordBanner.classList.remove('hidden');
  rerecordBannerText.textContent = `Re-recording: ${step.narration || step.step_type || 'step'}`;

  // Pre-fill narration if in narration mode
  if (recordingMode === 'narration' && step.narration) {
    narrationInput.value = step.narration;
  }

  await send({ type: 'RECORDING_START' });
  isRecording = true;
  updateRecordingUI();
  updateCommitButton();
}

btnRerecordCancel.addEventListener('click', async () => {
  rerecordLogicalId = null;
  rerecordBanner.classList.add('hidden');
  narrationInput.value = '';
  clearLiveActionList();

  // Restore recording state to what it was before entering re-record
  if (!previousRecordingView) {
    await send({ type: 'RECORDING_STOP' });
    isRecording = false;
  }
  previousRecordingView = null;
  updateRecordingUI();
  updateCommitButton();
});

// The commit buttons (both narration and simple mode) already pass
// rerecordLogicalId when it's set. After commit, hide the banner.
// We hook into the existing commitStep/commitStepSimple flow by
// clearing rerecordLogicalId after successful commit in those functions.

// ─── History ──────────────────────────────────────────────────────────────────

async function openHistory(logical_id) {
  const { project } = await send({ type: 'PROJECT_GET' });
  const recording = project?.recordings?.find(
    (r) => r.recording_id === activeRecording?.recording_id,
  );
  if (!recording) return;

  const versions = recording.steps
    .filter((s) => s.logical_id === logical_id)
    .sort((a, b) => (a.uuid > b.uuid ? -1 : 1));

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
  const { activeSteps: steps } = await send({ type: 'STEP_DELETE', logical_id });
  activeSteps = steps;
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
  const items = [...stepList.querySelectorAll('.step-item')];
  const srcIdx = items.indexOf(dragSrc);
  const dstIdx = items.indexOf(this);
  if (srcIdx < dstIdx) stepList.insertBefore(dragSrc, this.nextSibling);
  else stepList.insertBefore(dragSrc, this);
}

async function onDragEnd() {
  document
    .querySelectorAll('.step-item')
    .forEach((el) => el.classList.remove('dragging', 'drag-over'));
  // Only persist if the order actually changed
  const currentIds = [...stepList.querySelectorAll('.step-item')].map((el) => el.dataset.logical);
  const originalIds = activeSteps.map((s) => s.logical_id);
  const changed = currentIds.some((id, i) => id !== originalIds[i]);
  if (changed) await persistReorder();
}

async function persistReorder() {
  const orderedIds = [...stepList.querySelectorAll('.step-item')].map((el) => el.dataset.logical);
  const { activeSteps: steps } = await send({
    type: 'STEPS_REORDER',
    orderedLogicalIds: orderedIds,
  });
  activeSteps = steps;
  renderStepList();
}

// ─── Theme ────────────────────────────────────────────────────────────────────

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme ?? 'auto');
}

async function loadTheme() {
  const theme = await adapter.loadTheme();
  applyTheme(theme);
  themeRadios.forEach((r) => {
    r.checked = r.value === theme;
  });
}

themeRadios.forEach((radio) => {
  radio.addEventListener('change', async () => {
    if (!radio.checked) return;
    applyTheme(radio.value);
    await adapter.saveTheme(radio.value);
  });
});

// ─── Settings view ────────────────────────────────────────────────────────────

let settingsReturnView = 'projects';

// ─── Dispatch settings ────────────────────────────────────────────────────────

async function loadAndPopulateDispatchSettings() {
  dispatchSettings = await adapter.loadSettings();
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
  try {
    await adapter.saveSettings(url, apiKey);
    dispatchSettings = await adapter.loadSettings();
    updateDispatchButton();
  } catch (err) {
    settingsEndpointError.textContent = err.message;
    settingsEndpointError.classList.remove('hidden');
  }
});

function updateDispatchButton() {
  if (!dispatchSettings.endpointUrl) {
    btnDispatchProject.disabled = true;
    btnDispatchProject.title = 'Configure an endpoint in Settings to enable dispatch';
    return;
  }
  // Check if any recording has active steps
  const recordings = activeProject?.recordings ?? [];
  const hasActiveSteps = recordings.some((r) => {
    const groups = new Map();
    for (const s of r.steps ?? []) {
      const existing = groups.get(s.logical_id);
      if (!existing || s.uuid > existing.uuid) groups.set(s.logical_id, s);
    }
    return Array.from(groups.values()).some((s) => !s.deleted);
  });

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
  syncSettings = await adapter.loadSyncSettings();
  settingsSyncUrl.value = syncSettings.serverUrl ?? '';
  settingsSyncApiKey.value = syncSettings.apiKey ?? '';
  settingsSyncError.textContent = '';
  settingsSyncError.classList.add('hidden');
  // Refresh the durable state so the policy toggles, the Connection_Test status,
  // and the Auto-Sync enable state reflect the latest persisted settings —
  // including any background auto-disable the service worker performed after a
  // 401/403.
  syncState = await loadSyncState(adapterSyncStore);
  updateAutoSyncControls();
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
    // Fingerprint the server settings BEFORE and AFTER the save so we can tell
    // whether the endpoint or API key actually changed. The fingerprint
    // is computed over the PLAINTEXT key the panel holds in memory, never the
    // at-rest envelope, so a restart that re-encrypts the secret does not read
    // as a change.
    const prevFingerprint = settingsFingerprint(syncSettings.serverUrl, syncSettings.apiKey);
    await adapter.saveSyncSettings(url, apiKey);
    syncSettings = await adapter.loadSyncSettings();
    const nextFingerprint = settingsFingerprint(syncSettings.serverUrl, syncSettings.apiKey);

    // when a server setting changes, invalidate the prior Connection_Test
    // and disable Auto-Sync until a fresh test passes. Persisting `autoSync:false`
    // is what the service worker observes (via chrome.storage.onChanged) to tear
    // its background trigger down. When the settings are unchanged the
    // prior passing test still applies, so nothing is invalidated.
    if (nextFingerprint !== prevFingerprint) {
      await persistSettings({
        autoSync: false,
        connectionTest: null,
        testedSettingsFingerprint: null,
      });
    }
    updateSyncButton();
    updateAutoSyncControls();
  } catch (err) {
    settingsSyncError.textContent = err.message;
    settingsSyncError.classList.remove('hidden');
  }
});

// ─── Reconciliation-policy + Auto-Sync settings state machine ──────

// True while a Connection_Test request is in flight, so the test button stays
// disabled and the status line reads "Testing…" until it resolves.
let connectionTestInFlight = false;

/**
 * Persist a partial reconciliation/Auto-Sync settings change into the durable
 * SyncState. Reloads the latest state first so a concurrent
 * background write by the service worker (e.g. recording a new Review item) is
 * not clobbered, applies the patch through the shared `setSettings`, saves, and
 * refreshes the cached `syncState`. Settings live ONLY in the SyncStore and are
 * never transmitted to the Sync_Server.
 *
 * @param {Partial<import('../shared/sync-types.js').ReconciliationSettings>} patch
 * @returns {Promise<void>}
 */
async function persistSettings(patch) {
  const state = await loadSyncState(adapterSyncStore);
  setSettings(state, patch);
  await saveSyncState(adapterSyncStore, state);
  syncState = await loadSyncState(adapterSyncStore);
}

/**
 * Read whether Auto-Sync is currently enabled from the persisted settings.
 * Tolerates a never-persisted state (defaults OFF).
 *
 * @returns {boolean}
 */
function isAutoSyncEnabled() {
  return getSettings(syncState).autoSync === true;
}

/**
 * The enable rule for Auto-Sync: it can be turned on ONLY when
 * an endpoint is configured AND a Connection_Test has PASSED for the CURRENT
 * server settings. "For the current settings" is enforced by comparing the
 * stored `testedSettingsFingerprint` to the fingerprint of the settings the
 * panel holds now, so changing the endpoint/API key (which changes the
 * fingerprint) makes a prior pass no longer count.
 *
 * @returns {boolean}
 */
function canEnableAutoSync() {
  if (!syncSettings.serverUrl) return false; // endpoint must be present
  const settings = getSettings(syncState);
  return (
    settings.connectionTest === 'pass' &&
    settings.testedSettingsFingerprint ===
      settingsFingerprint(syncSettings.serverUrl, syncSettings.apiKey)
  );
}

// Auto-Accept policy toggles: plain client-local booleans that
// the orchestrator reads to decide auto-apply-vs-defer. Changing one only
// affects the next sync cycle; it never retroactively resolves items.
toggleAutoAcceptUpdates.addEventListener('change', async () => {
  await persistSettings({ autoAcceptUpdates: toggleAutoAcceptUpdates.checked });
});

toggleAutoAcceptDeletions.addEventListener('change', async () => {
  await persistSettings({ autoAcceptDeletions: toggleAutoAcceptDeletions.checked });
});

// Connection_Test: issue GET /projects against the configured
// server and record the outcome (pass / auth / unreachable) plus the fingerprint
// of the settings it was taken against, so the enable rule can confirm a pass
// applies to the CURRENT settings.
btnTestConnection.addEventListener('click', async () => {
  if (connectionTestInFlight) return;
  // Defensive: the enable rule checks endpoint-present before a test is invoked,
  // and the button is disabled without one — but guard anyway.
  if (!syncSettings.serverUrl) return;

  connectionTestInFlight = true;
  settingsConnectionStatus.classList.remove('hidden', 'is-ok', 'is-error');
  settingsConnectionStatus.textContent = 'Testing…';
  btnTestConnection.disabled = true;

  try {
    const fingerprint = settingsFingerprint(syncSettings.serverUrl, syncSettings.apiKey);
    const { reason } = await testConnection(syncSettings.serverUrl, syncSettings.apiKey);
    // Record the outcome and the fingerprint it was taken against. A failing
    // result is stored too (with its fingerprint) so the status line can show
    // why and the enable rule keeps Auto-Sync off until a pass.
    await persistSettings({ connectionTest: reason, testedSettingsFingerprint: fingerprint });
  } catch {
    // testConnection itself classifies network failures as 'unreachable' and
    // never throws; this is a last-resort guard so the UI never wedges.
    await persistSettings({ connectionTest: 'unreachable' });
  } finally {
    connectionTestInFlight = false;
    updateAutoSyncControls();
  }
});

// Auto-Sync toggle. The panel only SETS the persisted `autoSync` value;
// the background service worker observes it via chrome.storage.onChanged and
// owns the `chrome.alarms` + data-event trigger. Enabling is gated
// by the enable rule; a refused enable snaps the checkbox back off.
toggleAutoSync.addEventListener('change', async () => {
  if (toggleAutoSync.checked) {
    if (!canEnableAutoSync()) {
      toggleAutoSync.checked = false; // not enableable yet
      updateAutoSyncControls();
      return;
    }
    await persistSettings({ autoSync: true });
  } else {
    await persistSettings({ autoSync: false });
  }
  updateAutoSyncControls();
  updateSyncButton();
});

/**
 * Render the Connection_Test status line for the CURRENT server settings. A
 * stored result taken against different settings (a stale fingerprint) reads as
 * "not tested" and is hidden, so the line never implies a pass for settings the
 * user has since changed.
 *
 * @param {import('../shared/sync-types.js').ReconciliationSettings} settings
 * @returns {void}
 */
function renderConnectionStatus(settings) {
  const el = settingsConnectionStatus;
  if (connectionTestInFlight) return; // leave the "Testing…" text in place
  el.classList.remove('is-ok', 'is-error');
  const currentFingerprint = syncSettings.serverUrl
    ? settingsFingerprint(syncSettings.serverUrl, syncSettings.apiKey)
    : null;
  const forCurrentSettings =
    settings.testedSettingsFingerprint != null &&
    settings.testedSettingsFingerprint === currentFingerprint;
  if (!forCurrentSettings || !settings.connectionTest) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  el.classList.remove('hidden');
  switch (settings.connectionTest) {
    case 'pass':
      el.textContent = 'Connection OK.';
      el.classList.add('is-ok');
      break;
    case 'auth':
      el.textContent = 'Authentication failed — check your API key, then test again.';
      el.classList.add('is-error');
      break;
    case 'unreachable':
    default:
      el.textContent = 'Server unreachable — check the address, then test again.';
      el.classList.add('is-error');
      break;
  }
}

/**
 * Render the helper line under the Auto-Sync toggle. When Auto-Sync is active or
 * already enableable nothing is shown; otherwise it explains what is missing —
 * an endpoint, a passing test, or a re-test after the service worker auto-
 * disabled Auto-Sync on a 401/403.
 *
 * @param {import('../shared/sync-types.js').ReconciliationSettings} settings
 * @param {boolean} active
 * @param {boolean} enableable
 * @returns {void}
 */
function renderAutoSyncHint(settings, active, enableable) {
  const el = settingsAutoSyncHint;
  el.classList.remove('is-error');
  if (active || enableable) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  let message;
  if (!syncSettings.serverUrl) {
    message = 'Configure a sync server above to enable auto-sync.';
  } else if (settings.connectionTest === 'auth') {
    // Reflect the SW's 401/403 auto-disable + needs-retest flag.
    message = 'Auto-sync was turned off after an authentication failure. Test again to re-enable.';
    el.classList.add('is-error');
  } else {
    message = 'Test the connection to enable auto-sync.';
  }
  el.textContent = message;
  el.classList.remove('hidden');
}

/**
 * Bring the reconciliation-policy toggles, the Connection_Test status, the
 * Auto-Sync toggle/hint, and the "Auto-sync active" indicator into agreement
 * with the persisted settings. Safe to call any
 * time; it only reads `syncState` and `syncSettings` and mutates the Settings
 * DOM. The manual Sync button's visibility is owned by {@link updateSyncButton}.
 *
 * @returns {void}
 */
function updateAutoSyncControls() {
  const settings = getSettings(syncState);

  // Reconciliation-policy toggles.
  toggleAutoAcceptUpdates.checked = settings.autoAcceptUpdates === true;
  toggleAutoAcceptDeletions.checked = settings.autoAcceptDeletions === true;

  const active = settings.autoSync === true;
  const enableable = canEnableAutoSync();

  // The Auto-Sync toggle reflects the persisted value and is interactive only
  // when it can be turned on (enable rule met) OR it is already on (so it can be
  // turned off); otherwise it is disabled and not enableable.
  toggleAutoSync.checked = active;
  toggleAutoSync.disabled = !active && !enableable;

  renderConnectionStatus(settings);
  renderAutoSyncHint(settings, active, enableable);

  // "Auto-sync active" status indicator, shown only while active.
  settingsAutoSyncStatus.classList.toggle('hidden', !active);

  // The Connection_Test button is meaningful only with an endpoint configured.
  btnTestConnection.disabled = !syncSettings.serverUrl || connectionTestInFlight;
}

function updateSyncButton() {
  // while Auto-Sync is active, hide the manual Sync button entirely and
  // provide no manual force-sync affordance (the ~60s service-worker backstop
  // makes one unnecessary). When Auto-Sync is OFF, show it and gate on an
  // endpoint being configured and no sync already in flight.
  const active = isAutoSyncEnabled();
  btnSync.classList.toggle('hidden', active);
  btnSync.disabled = active || !syncSettings.serverUrl || isSyncing;
}

// Reflect background changes the service worker made to the durable SyncState:
// a background Auto-Sync cycle may have recorded new Review/Conflict
// items, or auto-disabled Auto-Sync after a 401/403. Refresh the cached
// state and keep the manual Sync button + (when open) the Settings controls in
// agreement, without yanking the user out of whatever view they are in.
adapter.onSyncStateChange(async () => {
  syncState = await loadSyncState(adapterSyncStore);
  updateSyncButton();
  if (!views.settings.classList.contains('hidden')) {
    updateAutoSyncControls();
  }
});

btnSync.addEventListener('click', () => handleSync());

async function handleSync() {
  if (isSyncing) return;
  isSyncing = true;
  updateSyncButton();
  btnSync.textContent = 'Syncing…';

  try {
    // Get all local projects from the service worker
    const { projects: localProjects } = await send({ type: 'PROJECTS_GET_ALL' });

    // Schema (for the push-side docent_format stamp) and the generated
    // validator (applied to each pulled payload) — both from the adapter, where
    // the composed schema is the single source of truth.
    const schema = await adapter.loadSchema();
    const validator = await adapter.loadValidator();

    // SyncStore — durable conflict-handling state backed by
    // chrome.storage.local. `sync()` normalizes whatever `load()` returns into
    // the full SyncState shape internally, so the raw adapter store is passed
    // straight through.
    const store = adapterSyncStore;

    // LiveState — synchronous live-work signals. The service worker
    // owns `recording` / `activeRecordingId` / `pendingCount` in
    // chrome.storage.local; snapshot them once so the gate is a hard block over
    // a consistent view:
    //   • isCaptureActive()             ← the `recording` flag
    //   • getLockedRecordingIds()       ← the open recording (`activeRecordingId`)
    //                                     is the Locked_Recording
    //   • recordingsWithPendingActions()← when pendingCount > 0 those uncommitted
    //                                     actions belong to the open recording
    const live = await adapter.loadLiveState();
    const lockedRecordingIds = live.activeRecordingId
      ? new Set([live.activeRecordingId])
      : new Set();
    const pendingRecordingIds =
      live.pendingCount > 0 && live.activeRecordingId
        ? new Set([live.activeRecordingId])
        : new Set();
    const liveState = {
      isCaptureActive: () => live.recording === true,
      getLockedRecordingIds: () => lockedRecordingIds,
      recordingsWithPendingActions: () => pendingRecordingIds,
    };

    const { result, projects: mergedProjects } = await sync(
      syncSettings.serverUrl,
      syncSettings.apiKey,
      localProjects,
      schema,
      validator,
      store,
      liveState,
    );

    // Persist merged projects back to the service worker
    await send({ type: 'PROJECTS_SET', projects: mergedProjects });

    // Refresh the cached conflict-handling state so the indicators and the
    // resolution workflow reflect what the cycle just recorded.
    syncState = await loadSyncState(adapterSyncStore);

    // Show summary
    showSyncSummary(result);

    // Refresh the projects list UI to reflect pulled/updated projects and any
    // newly-derived attention indicators.
    await loadProjectsList();
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
    // Distinguish WHY the cycle halted so the message is actionable.
    // All existing deferred state is preserved on every halt path.
    switch (result.haltReason) {
      case 'capture-active':
        alert("Sync paused while you're recording. Stop capture, then sync again.");
        return;
      case 'pending-actions-unprotected':
        alert(
          'Sync paused: a recording has uncommitted actions. Commit or clear them, then sync again.',
        );
        return;
      case 'internal-error':
        alert(
          'Sync stopped to protect your data and made no changes. Your work and any pending items are preserved.',
        );
        return;
      case 'auth':
      default:
        alert('Sync halted: authentication failed. Check your API key in Settings.');
        return;
    }
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
  // Settings-gated automatic outcomes: fast-forward updates and
  // server-side deletions applied without review because the matching
  // Auto-Accept policy is ON. Reported alongside the transport counts.
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
  // New deferral counts alongside the existing counts.
  const review = result.review ?? [];
  const conflicts = result.conflicts ?? [];
  if (review.length > 0)
    parts.push(`${review.length} change${review.length !== 1 ? 's' : ''} to review`);
  if (conflicts.length > 0)
    parts.push(`${conflicts.length} conflict${conflicts.length !== 1 ? 's' : ''}`);
  if (result.errors.length > 0)
    parts.push(`${result.errors.length} error${result.errors.length !== 1 ? 's' : ''}`);
  if (parts.length === 0) parts.push('Everything up to date');

  let message = parts.join('. ') + '.';
  // Point the user at where to act when there is anything needing attention.
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

// ─── Sync attention indicators & resolution workflow ─────────────────────────

/**
 * Attach a rendered attention badge to a card-item row, wiring its activation to
 * open the resolution workflow for that Unit. A null indicator (the Unit
 * does not need attention) attaches nothing.
 *
 * @param {HTMLElement} li - the card-item `<li>` produced by the shared renderer
 * @param {import('../shared/sync-conflict-ui.js').AttentionIndicator|null} indicator
 */
function attachIndicatorBadge(li, indicator) {
  if (!indicator) return;
  const html = renderIndicatorBadge(indicator);
  if (!html) return;
  const wrapper = document.createElement('template');
  wrapper.innerHTML = html.trim();
  const badge = wrapper.content.firstChild;
  badge.addEventListener('click', (e) => {
    // Don't let the badge click also trigger the row's open handler.
    e.stopPropagation();
    openWorkflow(indicator.unitRef);
  });
  // Place the badge in the row's main column so it reads with the name/meta.
  const main = li.querySelector('.card-item-main') ?? li;
  main.appendChild(badge);
}

/**
 * Attach the project-ROW attention badges to a project row. Renders
 * each {@link ProjectRowBadge} from {@link getProjectRowIndicators} and wires its
 * activation by scope: the project Unit's OWN badge opens that Unit's resolution
 * workflow (`open-workflow`); a rolled-up recordings badge opens the
 * project so its per-recording badges become visible (`open-project`).
 *
 * @param {HTMLElement} li - the project card-item `<li>`
 * @param {import('../shared/sync-conflict-ui.js').ProjectRowBadge[]} badges
 */
function attachProjectRowBadges(li, badges) {
  if (!badges || badges.length === 0) return;
  const main = li.querySelector('.card-item-main') ?? li;
  for (const badgeData of badges) {
    const html = renderProjectRowBadge(badgeData);
    if (!html) continue;
    const wrapper = document.createElement('template');
    wrapper.innerHTML = html.trim();
    const badge = wrapper.content.firstChild;
    badge.addEventListener('click', (e) => {
      // Don't let the badge click also trigger the row's open handler.
      e.stopPropagation();
      if (badge.dataset.action === UI_ACTIONS.OPEN_PROJECT) {
        openProject(badge.dataset.projectId);
      } else {
        openWorkflow(badge.dataset.unitRef);
      }
    });
    main.appendChild(badge);
  }
}

/**
 * Open the resolution workflow for a Unit. Renders the shared
 * workflow (a Review's accept/decline view or a Conflict's local-vs-incoming
 * chooser), wires the action buttons, and shows the workflow view. The
 * wrong-interface guard lives in the shared `renderWorkflow`/`resolveConflict`,
 * so the panel always opens whichever interface the item actually needs.
 *
 * @param {string} unitRef
 * @param {('review'|'conflict')} [requestedKind]
 */
function openWorkflow(unitRef, requestedKind) {
  const { kind, html } = renderWorkflow(syncState, unitRef, requestedKind);
  if (kind === null) {
    // Nothing to resolve (already resolved elsewhere) — just refresh the lists.
    refreshSyncViews();
    return;
  }
  workflowUnitRef = unitRef;
  syncWorkflowBody.innerHTML = html;
  wireWorkflowActions();
  showView('syncWorkflow');
}

/**
 * Wire the `[data-action]` controls the shared workflow rendered.
 * Each handler calls the shared resolution function, persists the mutated state
 * through the SyncStore, refreshes the cached state, and re-renders.
 */
function wireWorkflowActions() {
  const handlers = {
    [UI_ACTIONS.ACCEPT_REVIEW]: (ref) =>
      runResolution((projects) => acceptReview(syncState, projects, ref)),
    [UI_ACTIONS.DECLINE_REVIEW]: (ref) =>
      runResolution((projects) => declineReview(syncState, projects, ref)),
    [UI_ACTIONS.RESOLVE_KEEP_LOCAL]: (ref) => resolveConflictSide(ref, 'local'),
    [UI_ACTIONS.RESOLVE_KEEP_INCOMING]: (ref) => resolveConflictSide(ref, 'incoming'),
  };
  for (const [action, handler] of Object.entries(handlers)) {
    syncWorkflowBody.querySelectorAll(`[data-action="${action}"]`).forEach((btn) => {
      btn.addEventListener('click', () => handler(btn.dataset.unitRef ?? workflowUnitRef));
    });
  }
}

/**
 * Resolve a Conflict by keeping one side. The keep choice is translated into an
 * explicit append-only resolved state by the shared `buildResolvedState` (so both
 * platforms translate it identically) and applied via
 * `resolveConflict`.
 *
 * @param {string} unitRef
 * @param {'local'|'incoming'} side
 */
function resolveConflictSide(unitRef, side) {
  const item = syncState?.conflicts?.[unitRef];
  if (!item) {
    refreshSyncViews();
    return;
  }
  const resolvedState = buildResolvedState(item, side);
  runResolution((projects) => resolveConflict(syncState, projects, unitRef, resolvedState));
}

/**
 * Apply a resolution action against the current local projects, persist the
 * mutated SyncState, and re-render. The resolution helpers mutate `syncState`
 * in place and return the updated projects; persistence of the state blob is the
 * panel's responsibility. On failure the helpers leave the
 * state untouched, so nothing is persisted and the item stays pending.
 *
 * @param {(projects: object[]) => import('../shared/conflict-resolution.js').ResolutionResult} apply
 */
async function runResolution(apply) {
  try {
    const { projects: localProjects } = await send({ type: 'PROJECTS_GET_ALL' });
    const result = apply(localProjects);
    if (!result.ok) {
      // A failed/abandoned resolution retains the item. Re-render so any
      // wrong-interface redirect or empty state is surfaced.
      openWorkflow(result.item?.unitRef ?? workflowUnitRef, result.kind ?? undefined);
      return;
    }
    // Persist the adopted local projects and the mutated conflict-handling state.
    await send({ type: 'PROJECTS_SET', projects: result.projects });
    await saveSyncState(adapterSyncStore, syncState);
    syncState = await loadSyncState(adapterSyncStore);
    workflowUnitRef = null;
    await refreshSyncViews();
  } catch (err) {
    alert(`Could not resolve: ${err.message}`);
  }
}

/**
 * Re-render whichever list view is appropriate after a sync or resolution so the
 * attention indicators reflect the current SyncState. Returns to the project
 * detail when a project is open, otherwise the projects list.
 */
async function refreshSyncViews() {
  if (activeProject) {
    const { project } = await send({ type: 'PROJECT_GET' });
    if (project) activeProject = project;
    renderProjectDetail();
    showView('project');
  } else {
    await loadProjectsList();
  }
}

btnSyncWorkflowBack.addEventListener('click', () => {
  workflowUnitRef = null;
  refreshSyncViews();
});

btnSettings.addEventListener('click', () => {
  // If already in settings, treat as Back
  if (!views.settings.classList.contains('hidden')) {
    showView(settingsReturnView);
    if (settingsReturnView === 'project') updateDispatchButton();
    return;
  }
  // Find the currently visible non-settings view to return to
  const current = Object.entries(views).find(
    ([key, el]) => key !== 'settings' && !el.classList.contains('hidden'),
  );
  settingsReturnView = current ? current[0] : 'projects';
  loadAndPopulateDispatchSettings();
  loadAndPopulateSyncSettings();
  showView('settings');
});

btnSettingsBack.addEventListener('click', () => {
  showView(settingsReturnView);
  if (settingsReturnView === 'project') updateDispatchButton();
});

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
    await send({ type: 'PROJECT_SET_METADATA', metadata: metadata ?? null });
  }
});

projectMetadataList.addEventListener('change', async () => {
  const metadata = collectMetadata(projectMetadataList);
  if (metadata) activeProject.metadata = metadata;
  else delete activeProject.metadata;
  await send({ type: 'PROJECT_SET_METADATA', metadata: metadata ?? null });
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
    await send({
      type: 'RECORDING_SET_METADATA',
      recording_id: activeRecording.recording_id,
      metadata: metadata ?? null,
    });
  }
});

recordingMetadataList.addEventListener('change', async () => {
  const metadata = collectMetadata(recordingMetadataList);
  if (metadata) activeRecording.metadata = metadata;
  else delete activeRecording.metadata;
  await send({
    type: 'RECORDING_SET_METADATA',
    recording_id: activeRecording.recording_id,
    metadata: metadata ?? null,
  });
});

// ─── Init ─────────────────────────────────────────────────────────────────────

await loadTheme();
await loadRecordingMode();
dispatchSettings = await adapter.loadSettings();
syncSettings = await adapter.loadSyncSettings();
// Load the durable conflict-handling state so attention indicators render on the
// first project-list paint. A missing/empty blob normalizes to an empty
// SyncState, so this is safe before any sync has run.
syncState = await loadSyncState(adapterSyncStore);
// Reflect the persisted Auto-Sync setting in the manual Sync button immediately:
// when Auto-Sync is already active (e.g. enabled in a prior session and still
// running in the service worker) the button starts hidden.
updateSyncButton();
loadProjectsList();
