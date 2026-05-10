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

import { validateEndpointUrl, buildPayload, sendPayload, DispatchError } from '../shared/dispatch-core.js';
import { sync } from '../shared/sync-client.js';
import adapter, { commitWithCompleteness } from './adapter-tauri.js';
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
import { uuidv7 } from '../shared/lib/uuid-v7.js';

const { invoke } = window.__TAURI__.core;

// ─── Elements ─────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const views = {
  projects:          $('view-projects'),
  newProject:        $('view-new-project'),
  project:           $('view-project'),
  newRecording:      $('view-new-recording'),
  recording:         $('view-recording'),
  rerecord:          $('view-rerecord'),
  history:           $('view-history'),
  stepDetail:        $('view-step-detail'),
  settings:          $('view-settings'),
  recordingSelector: $('view-recording-selector'),
  dispatchConfirm:   $('view-dispatch-confirm'),
  dispatchResult:    $('view-dispatch-result'),
};

const breadcrumb       = $('breadcrumb');
const bcProjects       = $('bc-projects');
const bcProject        = $('bc-project');
const bcRecording      = $('bc-recording');
const bcSep1           = $('bc-sep-1');
const bcSep2           = $('bc-sep-2');

const recordingBadge   = $('recording-badge');

// Projects list
const projectList      = $('project-list');
const projectsEmpty    = $('projects-empty');
const btnNewProject    = $('btn-new-project');
const btnImportProject = $('btn-import-project');
const importFileInput  = $('import-file-input');

// New project form
const newProjectName   = $('new-project-name');
const btnNewProjectCreate = $('btn-new-project-create');
const btnNewProjectCancel = $('btn-new-project-cancel');

// Project detail
const projectTitle     = $('project-title');
const recordingList    = $('recording-list');
const recordingsEmpty  = $('recordings-empty');
const btnNewRecording  = $('btn-new-recording');
const btnExportProject = $('btn-export-project');
const btnDispatchProject = $('btn-dispatch-project');

// New recording form
const newRecordingName         = $('new-recording-name');
const btnNewRecordingCreate    = $('btn-new-recording-create');
const btnNewRecordingCancel    = $('btn-new-recording-cancel');

// Recording view
const recordingTitle   = $('recording-title');
const btnToggleRecording = $('btn-toggle-recording');
const narrationInput   = $('narration-input');
const btnClearStep     = $('btn-clear-step');
const btnCommitStep    = $('btn-commit-step');
const stepListEl       = $('step-list');
const stepCount        = $('step-count');

// Re-record
const rerecordNarration  = $('rerecord-narration');
const btnRerecordCommit  = $('btn-rerecord-commit');
const btnRerecordCancel  = $('btn-rerecord-cancel');

// History
const historyList    = $('history-list');
const btnHistoryBack = $('btn-history-back');

// Step detail
const stepDetailList  = $('step-detail-list');
const stepDetailTitle = $('step-detail-title');
const btnStepDetailBack = $('btn-step-detail-back');

// Pending action list (live during recording)
const pendingActionsSection = $('pending-actions-section');
const pendingActionList     = $('pending-action-list');
const pendingActionCount    = $('pending-action-count');
const rerecordActionsSection = $('rerecord-actions-section');
const rerecordActionList     = $('rerecord-action-list');
const rerecordActionCount    = $('rerecord-action-count');

// Settings
const btnSettings     = $('btn-settings');
const btnSettingsBack = $('btn-settings-back');
const themeRadios     = document.querySelectorAll('input[name="theme"]');

// Dispatch settings
const settingsEndpointUrl   = $('settings-endpoint-url');
const settingsEndpointError = $('settings-endpoint-error');
const settingsApiKey        = $('settings-api-key');
const btnSettingsDispatchSave = $('btn-settings-dispatch-save');

// Sync settings
const settingsSyncUrl       = $('settings-sync-url');
const settingsSyncError     = $('settings-sync-error');
const settingsSyncApiKey    = $('settings-sync-api-key');
const btnSettingsSyncSave   = $('btn-settings-sync-save');
const btnSync               = $('btn-sync');

// Recording selector
const recordingSelectorList = $('recording-selector-list');
const btnSelectorCancel     = $('btn-selector-cancel');

// Dispatch confirmation
const confirmEndpoint   = $('confirm-endpoint');
const confirmRecordings = $('confirm-recordings');
const confirmSteps      = $('confirm-steps');
const btnConfirmCancel  = $('btn-confirm-cancel');
const btnConfirmSend    = $('btn-confirm-send');

// Dispatch result
const resultTitle   = $('result-title');
const resultMessage = $('result-message');
const btnResultBack = $('btn-result-back');

// Desktop-specific elements
const targetAppSelect       = $('target-app-select');
const btnRefreshApps        = $('btn-refresh-apps');
const selfCaptureToggle     = $('self-capture-toggle');

// ─── State ────────────────────────────────────────────────────────────────────

/** @type {{ projects: Array, settings: Object }} */
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

let activeProject    = null;
let activeRecording  = null;
let activeSteps      = [];
let isRecording      = false;
let pendingCount     = 0;
let commitInProgress = false;
let rerecordLogicalId = null;
let previousRecordingView = null;
let dispatchSettings = { endpointUrl: null, apiKey: null };
let dispatchSelection = null;
let syncSettings = { serverUrl: null, apiKey: null };
let isSyncing = false;

// ─── Persistence ──────────────────────────────────────────────────────────────

async function loadState() {
  try {
    const json = await invoke('load_state');
    const parsed = JSON.parse(json);
    sessionState = {
      projects: parsed.projects ?? [],
      settings: {
        endpointUrl: parsed.settings?.endpointUrl ?? null,
        apiKey: parsed.settings?.apiKey ?? null,
        theme: parsed.settings?.theme ?? 'auto',
        selfCaptureExclusion: parsed.settings?.selfCaptureExclusion ?? true,
        syncUrl: parsed.settings?.syncUrl ?? null,
        syncApiKey: parsed.settings?.syncApiKey ?? null,
      },
    };
  } catch {
    // Missing or corrupted file — start fresh
    sessionState = {
      projects: [],
      settings: { endpointUrl: null, apiKey: null, theme: 'auto', selfCaptureExclusion: true, syncUrl: null, syncApiKey: null },
    };
  }
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
    await invoke('save_state', { data: JSON.stringify(sessionState) });
  } catch (err) {
    console.error('[Docent] Failed to save state:', err);
  }
}

// ─── Pending actions tracking ─────────────────────────────────────────────────

adapter.onPendingCountChange(count => {
  pendingCount = count;
  updateCommitButton();
});

// Live action list: render each action as it's captured
adapter.onActionEvent(action => {
  appendLiveAction(action);
});

function appendLiveAction(action) {
  const html = renderStepDetailHtml([action]);
  // Determine which list to append to (recording or re-record view)
  const isRerecording = views.rerecord && !views.rerecord.classList.contains('hidden');
  const targetList = isRerecording ? rerecordActionList : pendingActionList;
  const targetSection = isRerecording ? rerecordActionsSection : pendingActionsSection;
  const targetCount = isRerecording ? rerecordActionCount : pendingActionCount;

  targetSection.classList.remove('hidden');
  const li = document.createElement('template');
  li.innerHTML = html[0].trim();
  targetList.appendChild(li.content.firstChild);
  targetCount.textContent = targetList.children.length;
}

function clearLiveActionList() {
  pendingActionList.innerHTML = '';
  pendingActionCount.textContent = '0';
  pendingActionsSection.classList.add('hidden');
  rerecordActionList.innerHTML = '';
  rerecordActionCount.textContent = '0';
  rerecordActionsSection.classList.add('hidden');
}

// ─── View management ─────────────────────────────────────────────────────────

function showView(viewKey) {
  Object.values(views).forEach(v => v.classList.add('hidden'));
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
  if (isRecording) {
    await invoke('stop_capture');
    isRecording = false;
  }
  activeProject   = null;
  activeRecording = null;
  updateRecordingUI();
  renderProjectsList();
});

bcProject.addEventListener('click', async () => {
  if (isRecording) {
    await invoke('stop_capture');
    isRecording = false;
  }
  activeRecording = null;
  updateRecordingUI();
  renderProjectDetail();
  showView('project');
});

// ─── Projects list ────────────────────────────────────────────────────────────

function renderProjectsList() {
  const projects = sessionState.projects.map(p => ({
    ...p,
    recording_count: (p.recordings ?? []).length,
  }));

  projectList.innerHTML = '';
  projectsEmpty.classList.toggle('hidden', projects.length > 0);

  const htmlItems = renderProjectListHtml(projects);
  projects.forEach((p, i) => {
    const wrapper = document.createElement('template');
    wrapper.innerHTML = htmlItems[i].trim();
    const li = wrapper.content.firstChild;
    li.querySelector('[data-action="open"]').addEventListener('click', () => openProject(p.project_id));
    li.querySelector('[data-action="delete"]').addEventListener('click', () => deleteProject(p.project_id, p.name));
    projectList.appendChild(li);
  });

  showView('projects');
}

function openProject(project_id) {
  activeProject = sessionState.projects.find(p => p.project_id === project_id) ?? null;
  activeRecording = null;
  isRecording = false;
  updateRecordingUI();
  renderProjectDetail();
  showView('project');
}

async function deleteProject(project_id, name) {
  if (!confirm(`Delete project "${name}"? This cannot be undone.`)) return;
  sessionState.projects = sessionState.projects.filter(p => p.project_id !== project_id);
  await saveState();
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
  activeProject   = project;
  activeRecording = null;
  renderProjectDetail();
  showView('project');
});

newProjectName.addEventListener('keydown', e => {
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

  const imported = exportData.project;
  const exists = sessionState.projects.some(p => p.project_id === imported.project_id);

  const newProject = {
    project_id: exists ? uuidv7() : imported.project_id,
    name: exists ? `${imported.name} (copy)` : imported.name,
    created_at: imported.created_at ?? new Date().toISOString(),
    recordings: (exportData.recordings ?? []).map(r => ({
      recording_id: r.recording_id,
      name: r.name,
      created_at: r.created_at,
      steps: (r.steps ?? []).map(s => ({
        uuid: s.uuid ?? uuidv7(),
        logical_id: s.logical_id,
        step_number: s.step_number,
        created_at: s.created_at,
        narration: s.narration,
        narration_source: s.narration_source ?? 'imported',
        actions: s.actions ?? [],
        deleted: s.deleted ?? false,
      })),
    })),
  };

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

  const recordings = activeProject.recordings ?? [];
  recordingsEmpty.classList.toggle('hidden', recordings.length > 0);

  const htmlItems = renderRecordingListHtml(recordings);
  recordings.forEach((r, i) => {
    const wrapper = document.createElement('template');
    wrapper.innerHTML = htmlItems[i].trim();
    const li = wrapper.content.firstChild;
    li.querySelector('[data-action="open"]').addEventListener('click', () => openRecording(r.recording_id));
    li.querySelector('[data-action="delete"]').addEventListener('click', () => deleteRecording(r.recording_id, r.name));
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
  activeRecording = recording;
  activeSteps     = [];
  isRecording     = true;
  adapter.clearPendingActions();
  await invoke('start_capture', { pid: null });
  enterRecordingView();
});

newRecordingName.addEventListener('keydown', e => {
  if (e.key === 'Enter') btnNewRecordingCreate.click();
});

function openRecording(recording_id) {
  const recording = findRecording(activeProject, recording_id);
  if (!recording) return;
  activeRecording = recording;
  activeSteps     = resolveActiveSteps(recording);
  isRecording     = false;
  enterRecordingView();
}

async function deleteRecording(recording_id, name) {
  if (!confirm(`Delete recording "${name}"? This cannot be undone.`)) return;
  if (isRecording) {
    await invoke('stop_capture');
    isRecording = false;
  }
  activeProject.recordings = activeProject.recordings.filter(r => r.recording_id !== recording_id);
  await saveState();
  activeRecording = null;
  updateRecordingUI();
  renderProjectDetail();
  showView('project');
}

// Export project
btnExportProject.addEventListener('click', async () => {
  const exportData = {
    project: {
      project_id: activeProject.project_id,
      name: activeProject.name,
      created_at: activeProject.created_at,
      ...(activeProject.metadata && { metadata: activeProject.metadata }),
    },
    recordings: (activeProject.recordings ?? []).map(r => ({
      recording_id: r.recording_id,
      name: r.name,
      created_at: r.created_at,
      ...(r.metadata && { metadata: r.metadata }),
      steps: r.steps,
    })),
  };

  if (adapter.hasNativeFileDialog) {
    try {
      const defaultName = `${activeProject.name.replace(/\s+/g, '_')}_${Date.now()}.docent.json`;
      await invoke('export_file', { data: JSON.stringify(exportData, null, 2), defaultName });
    } catch (err) {
      alert(`Export failed: ${err.message || err}`);
    }
  } else {
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
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
    .map(r => ({ ...r, activeSteps: resolveActiveStepsForRecording(r) }))
    .filter(r => r.activeSteps.length > 0);

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

  recordingsWithSteps.forEach(r => {
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
  confirmEndpoint.textContent   = dispatchSettings.endpointUrl ?? '';
  confirmRecordings.textContent = recordings.map(r => r.name).join(', ');
  confirmSteps.textContent      = String(totalSteps);
  showView('dispatchConfirm');
}

btnSelectorCancel.addEventListener('click', () => showView('project'));
btnConfirmCancel.addEventListener('click', () => showView('project'));

btnConfirmSend.addEventListener('click', async () => {
  if (!dispatchSelection) return;
  btnConfirmSend.disabled     = true;
  btnDispatchProject.disabled = true;
  try {
    const guidance = await adapter.loadReadingGuidance();
    const schema   = await adapter.loadSchema();
    const payload  = buildPayload(activeProject, dispatchSelection.recordings, guidance, schema);
    await sendPayload(dispatchSettings.endpointUrl, dispatchSettings.apiKey, payload);
    resultTitle.textContent   = 'Sent';
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
    btnConfirmSend.disabled     = false;
    btnDispatchProject.disabled = !dispatchSettings.endpointUrl;
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
  updateRecordingUI();
  renderStepList();
  showView('recording');
}

const SVG_PAUSE  = `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="5" y="4" width="3.5" height="12" rx="1" fill="currentColor"/><rect x="11.5" y="4" width="3.5" height="12" rx="1" fill="currentColor"/></svg>`;
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
  btnCommitStep.disabled = narrationInput.value.trim().length === 0 || pendingCount === 0;
}

btnCommitStep.addEventListener('click', () =>
  commitStep(narrationInput, 'typed', null)
);

btnClearStep.addEventListener('click', async () => {
  if (!confirm('Clear all recorded actions for this step?')) return;
  adapter.clearPendingActions();
  pendingCount = 0;
  updateCommitButton();
  clearLiveActionList();
});

async function commitStep(inputEl, source, logicalId) {
  if (commitInProgress) return;
  commitInProgress = true;
  try {
    const narration = inputEl.value.trim();
    if (!narration) return;

    const wasRecording = isRecording;

    if (isRecording) {
      await invoke('stop_capture');
      isRecording = false;
    }

    // Wait for all in-flight worker events to arrive
    await commitWithCompleteness();

    const actions = adapter.getPendingActions();
    const nextStepNumber = logicalId
      ? (activeSteps.find(s => s.logical_id === logicalId)?.step_number ?? activeSteps.length + 1)
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

    inputEl.value = '';
    if (inputEl === narrationInput) btnCommitStep.disabled = true;
    clearLiveActionList();
    renderStepList();

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
  stepListEl.innerHTML    = '';
  stepCount.textContent   = activeSteps.length;

  const htmlItems = renderStepListHtml(activeSteps);
  activeSteps.forEach((step, index) => {
    const wrapper = document.createElement('template');
    wrapper.innerHTML = htmlItems[index].trim();
    const li = wrapper.content.firstChild;

    li.querySelector('.step-narration').addEventListener('click', () => openStepDetail(step));
    li.querySelector('[data-action="edit"]').addEventListener('click', () => openRerecord(step));
    li.querySelector('[data-action="history"]').addEventListener('click', () => openHistory(step.logical_id));
    li.querySelector('[data-action="delete"]').addEventListener('click', () => confirmDeleteStep(step.logical_id));

    li.addEventListener('dragstart', onDragStart);
    li.addEventListener('dragover', onDragOver);
    li.addEventListener('drop', onDrop);
    li.addEventListener('dragend', onDragEnd);

    stepListEl.appendChild(li);
  });
}

// ─── Re-record ────────────────────────────────────────────────────────────────

async function openRerecord(step) {
  rerecordLogicalId       = step.logical_id;
  rerecordNarration.value = step.narration;
  previousRecordingView   = isRecording;
  if (isRecording) {
    await invoke('stop_capture');
    isRecording = false;
  }
  adapter.clearPendingActions();
  pendingCount = 0;
  clearLiveActionList();
  // Start fresh capture for re-recording
  await invoke('start_capture', { pid: null });
  isRecording = true;
  showView('rerecord');
}

btnRerecordCancel.addEventListener('click', async () => {
  rerecordLogicalId = null;
  if (previousRecordingView) {
    await invoke('start_capture', { pid: null });
    isRecording = true;
  }
  previousRecordingView = null;
  updateRecordingUI();
  showView('recording');
});

btnRerecordCommit.addEventListener('click', async () => {
  await commitStep(rerecordNarration, 'typed', rerecordLogicalId);
  rerecordLogicalId     = null;
  previousRecordingView = null;
  showView('recording');
});

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
      <span class="history-narration">${escapeHtml(v.narration)}</span>
      ${v.deleted ? '<span class="badge badge--deleted">deleted</span>' : ''}
    `;
    historyList.appendChild(li);
  });

  showView('history');
}

btnHistoryBack.addEventListener('click', () => showView('recording'));

// ─── Step detail ──────────────────────────────────────────────────────────────

function openStepDetail(step) {
  stepDetailTitle.textContent = `Step ${step.step_number}: ${step.narration}`;
  stepDetailList.innerHTML = '';

  const htmlItems = renderStepDetailHtml(step.actions);
  htmlItems.forEach(html => {
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
  const items  = [...stepListEl.querySelectorAll('.step-item')];
  const srcIdx = items.indexOf(dragSrc);
  const dstIdx = items.indexOf(this);
  if (srcIdx < dstIdx) stepListEl.insertBefore(dragSrc, this.nextSibling);
  else stepListEl.insertBefore(dragSrc, this);
}

async function onDragEnd() {
  document.querySelectorAll('.step-item').forEach(el =>
    el.classList.remove('dragging', 'drag-over')
  );
  const currentIds  = [...stepListEl.querySelectorAll('.step-item')].map(el => el.dataset.logical);
  const originalIds = activeSteps.map(s => s.logical_id);
  const changed     = currentIds.some((id, i) => id !== originalIds[i]);
  if (changed) await persistReorder();
}

async function persistReorder() {
  const orderedIds = [...stepListEl.querySelectorAll('.step-item')].map(el => el.dataset.logical);
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
  themeRadios.forEach(r => { r.checked = r.value === theme; });
}

themeRadios.forEach(radio => {
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
  settingsApiKey.value      = dispatchSettings.apiKey ?? '';
  settingsEndpointError.textContent = '';
  settingsEndpointError.classList.add('hidden');
}

btnSettingsDispatchSave.addEventListener('click', async () => {
  const url    = settingsEndpointUrl.value.trim();
  const apiKey = settingsApiKey.value.trim();
  const error  = validateEndpointUrl(url);
  if (error) {
    settingsEndpointError.textContent = error;
    settingsEndpointError.classList.remove('hidden');
    return;
  }
  settingsEndpointError.textContent = '';
  settingsEndpointError.classList.add('hidden');

  sessionState.settings.endpointUrl = url || null;
  sessionState.settings.apiKey      = apiKey || null;
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
  const hasActiveSteps = recordings.some(r => resolveActiveSteps(r).length > 0);
  btnDispatchProject.disabled = !hasActiveSteps;
  btnDispatchProject.title = hasActiveSteps ? '' : 'No recordings with active steps';
}

// ─── Sync settings ────────────────────────────────────────────────────────────

async function loadAndPopulateSyncSettings() {
  settingsSyncUrl.value    = syncSettings.serverUrl ?? '';
  settingsSyncApiKey.value = syncSettings.apiKey ?? '';
  settingsSyncError.textContent = '';
  settingsSyncError.classList.add('hidden');
}

btnSettingsSyncSave.addEventListener('click', async () => {
  const url    = settingsSyncUrl.value.trim();
  const apiKey = settingsSyncApiKey.value.trim();

  // Validate URL if non-empty (R1-AC2)
  if (url) {
    const error = validateEndpointUrl(url);
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
    updateSyncButton();
  } catch (err) {
    settingsSyncError.textContent = err.message;
    settingsSyncError.classList.remove('hidden');
  }
});

function updateSyncButton() {
  btnSync.disabled = !syncSettings.serverUrl || isSyncing;
}

btnSync.addEventListener('click', () => handleSync());

async function handleSync() {
  if (isSyncing) return;
  isSyncing = true;
  updateSyncButton();
  btnSync.textContent = 'Syncing…';

  try {
    const { result, projects: mergedProjects } = await sync(
      syncSettings.serverUrl,
      syncSettings.apiKey,
      sessionState.projects
    );

    // Persist merged projects via saveState() (R5-AC5)
    sessionState.projects = mergedProjects;
    await saveState();

    // Show summary (R5-AC5)
    showSyncSummary(result);

    // Refresh the projects list UI to reflect pulled/updated projects
    if (activeProject) {
      // Re-resolve activeProject from updated list
      activeProject = sessionState.projects.find(p => p.project_id === activeProject.project_id) ?? null;
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
    alert('Sync halted: authentication failed. Check your API key in Settings.');
    return;
  }
  const parts = [];
  if (result.pushed.length > 0) parts.push(`Pushed ${result.pushed.length} project${result.pushed.length !== 1 ? 's' : ''}`);
  if (result.pulled.length > 0) parts.push(`Pulled ${result.pulled.length} project${result.pulled.length !== 1 ? 's' : ''}`);
  if (result.errors.length > 0) parts.push(`${result.errors.length} error${result.errors.length !== 1 ? 's' : ''}`);
  if (parts.length === 0) parts.push('Everything up to date');
  alert(parts.join('. ') + '.');
}

btnSettings.addEventListener('click', () => {
  if (!views.settings.classList.contains('hidden')) {
    showView(settingsReturnView);
    if (settingsReturnView === 'project') updateDispatchButton();
    return;
  }
  const current = Object.entries(views).find(([key, el]) => key !== 'settings' && !el.classList.contains('hidden'));
  settingsReturnView = current ? current[0] : 'projects';
  loadAndPopulateDispatchSettings();
  loadAndPopulateSyncSettings();
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
  } catch (err) {
    console.warn('[Docent] Failed to list windows:', err);
  }
}

if (btnRefreshApps) {
  btnRefreshApps.addEventListener('click', () => loadWindowList());
}

if (targetAppSelect) {
  targetAppSelect.addEventListener('change', async () => {
    // Target selection is informational — capture always captures all apps
    // The selected target is used for context in the UI
  });
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

// ─── Init ─────────────────────────────────────────────────────────────────────

await loadState();
loadTheme();
await loadWindowList();
updateSyncButton();

// Set initial self-capture exclusion based on persisted setting
try {
  await invoke('set_self_capture_exclusion', { enabled: sessionState.settings.selfCaptureExclusion ?? true });
} catch (err) {
  console.warn('[Docent] Failed to set initial self-capture exclusion:', err);
}
renderProjectsList();
