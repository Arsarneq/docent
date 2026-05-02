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
import adapter from './adapter-chrome.js';
import {
  escapeHtml,
  renderProjectList as renderProjectListHtml,
  renderRecordingList as renderRecordingListHtml,
  renderStepList as renderStepListHtml,
  renderStepDetail as renderStepDetailHtml,
} from '../shared/views/render.js';

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
const stepList         = $('step-list');
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

// Settings
const btnSettings     = $('btn-settings');
const btnSettingsBack = $('btn-settings-back');
const themeRadios     = document.querySelectorAll('input[name="theme"]');

// Dispatch settings
const settingsEndpointUrl   = $('settings-endpoint-url');
const settingsEndpointError = $('settings-endpoint-error');
const settingsApiKey        = $('settings-api-key');
const btnSettingsDispatchSave = $('btn-settings-dispatch-save');

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

// ─── State ────────────────────────────────────────────────────────────────────

let activeProject    = null;
let activeRecording  = null;
let activeSteps      = [];
let isRecording      = false;
let pendingCount     = 0; // actions recorded since last step commit
let commitInProgress = false; // prevents double-commit on rapid clicks
let rerecordLogicalId = null;
let previousRecordingView = null; // tracks pre-rerecord recording state
let dispatchSettings = { endpointUrl: null, apiKey: null };
let dispatchSelection = null; // { recordings: [], totalSteps: number }

// ─── Messaging ────────────────────────────────────────────────────────────────

function send(message) {
  return adapter.send(message);
}

// ─── SW restart recovery ──────────────────────────────────────────────────────
// pendingActions live in chrome.storage.local (written by the content
// script directly), so they survive SW suspension. The panel watches
// pendingCount from local storage to keep the commit button in sync.
adapter.onPendingCountChange(count => {
  pendingCount = count;
  updateCommitButton();
});

// ─── View management ─────────────────────────────────────────────────────────

function showView(viewKey) {
  Object.values(views).forEach(v => v.classList.add('hidden'));
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
  isRecording    = false;
  activeProject  = null;
  activeRecording = null;
  updateRecordingUI();
  await loadProjectsList();
});

bcProject.addEventListener('click', async () => {
  await send({ type: 'RECORDING_STOP' });
  isRecording     = false;
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

async function openProject(project_id) {
  const { project } = await send({ type: 'PROJECT_OPEN', project_id });
  activeProject   = project;
  activeRecording = null;
  isRecording     = false;
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
  activeProject   = project;
  activeRecording = null;
  renderProjectDetail();
  showView('project');
});

newProjectName.addEventListener('keydown', e => {
  if (e.key === 'Enter') btnNewProjectCreate.click();
});

// ─── Project detail ───────────────────────────────────────────────────────────

function renderProjectDetail() {
  projectTitle.textContent = activeProject.name;
  projectTitle.title = 'Click to rename';
  projectTitle.style.cursor = 'pointer';
  recordingList.innerHTML   = '';

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
  activeProject   = project;
  activeRecording = recording;
  activeSteps     = [];
  isRecording     = true;
  enterRecordingView();
});

newRecordingName.addEventListener('keydown', e => {
  if (e.key === 'Enter') btnNewRecordingCreate.click();
});

async function openRecording(recording_id) {
  const { recording, activeSteps: steps } = await send({
    type: 'RECORDING_OPEN',
    recording_id,
  });
  activeRecording = recording;
  activeSteps     = steps;
  isRecording     = false;
  enterRecordingView();
}

async function deleteRecording(recording_id, name) {
  if (!confirm(`Delete recording "${name}"? This cannot be undone.`)) return;
  isRecording = false;
  const { project } = await send({ type: 'RECORDING_DELETE', recording_id });
  activeProject   = project;
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
  const blob = new Blob([JSON.stringify(response.exportData, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${activeProject.name.replace(/\s+/g, '_')}_${Date.now()}.docent.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// Dispatch project
btnDispatchProject.addEventListener('click', () => openDispatchFlow());

function resolveActiveStepsForRecording(r) {
  const groups = new Map();
  for (const s of (r.steps ?? [])) {
    const existing = groups.get(s.logical_id);
    if (!existing || s.uuid > existing.uuid) groups.set(s.logical_id, s);
  }
  return Array.from(groups.values()).filter(s => !s.deleted);
}

function openDispatchFlow() {
  const recordings = activeProject?.recordings ?? [];
  // Resolve active steps for each recording
  const recordingsWithSteps = recordings
    .map(r => ({ ...r, activeSteps: resolveActiveStepsForRecording(r) }))
    .filter(r => r.activeSteps.length > 0);

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
  btnConfirmSend.disabled    = true;
  btnDispatchProject.disabled = true;
  try {
    const guidance = await adapter.loadReadingGuidance();
    const payload  = buildPayload(activeProject, dispatchSelection.recordings, guidance);
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
    btnConfirmSend.disabled    = false;
    btnDispatchProject.disabled = !dispatchSettings.endpointUrl;
  }
});

btnResultBack.addEventListener('click', () => showView('project'));

// ─── Recording view ───────────────────────────────────────────────────────────

function enterRecordingView() {
  recordingTitle.textContent = activeRecording.name;
  recordingTitle.title = 'Click to rename';
  recordingTitle.style.cursor = 'pointer';
  narrationInput.value      = '';
  // Read actual pendingCount via adapter rather than assuming 0
  adapter.getPendingCount().then(count => {
    pendingCount = count;
    updateCommitButton();
  });
  updateRecordingUI();
  renderStepList();
  showView('recording');
}

const SVG_PAUSE    = `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="5" y="4" width="3.5" height="12" rx="1" fill="currentColor"/><rect x="11.5" y="4" width="3.5" height="12" rx="1" fill="currentColor"/></svg>`;
const SVG_RESUME   = `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M6 4l10 6-10 6V4z" fill="currentColor"/></svg>`;
const SVG_REC_DOT  = `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="10" cy="10" r="5" fill="currentColor"/></svg>`;

function updateRecordingUI() {
  if (isRecording) {
    recordingBadge.innerHTML   = `${SVG_REC_DOT} Recording`;
    recordingBadge.className   = 'badge badge--recording';
    btnToggleRecording.innerHTML = `${SVG_PAUSE} <span class="btn-label">Pause</span>`;
  } else if (activeRecording) {
    recordingBadge.textContent = 'Paused';
    recordingBadge.className   = 'badge badge--idle';
    btnToggleRecording.innerHTML = `${SVG_RESUME} <span class="btn-label">Resume</span>`;
  } else {
    recordingBadge.textContent = 'Idle';
    recordingBadge.className   = 'badge badge--idle';
  }
}

// Inline rename for recording title
recordingTitle.addEventListener('click', async () => {
  const current = activeRecording.name;
  const next = prompt('Rename recording:', current);
  if (!next || next.trim() === current) return;
  await send({ type: 'RECORDING_RENAME', recording_id: activeRecording.recording_id, name: next.trim() });
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
  btnCommitStep.disabled = narrationInput.value.trim().length === 0 || pendingCount === 0;
}

btnCommitStep.addEventListener('click', () =>
  commitStep(narrationInput, 'typed', null)
);

btnClearStep.addEventListener('click', async () => {
  if (!confirm('Clear all recorded actions for this step?')) return;
  await send({ type: 'RECORDING_CLEAR' });
  pendingCount = 0;
  updateCommitButton();
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
      type:             'STEP_COMMIT',
      narration,
      narration_source: source,
      logical_id:       logicalId ?? undefined,
    });

    if (response?.ok) {
      activeSteps    = response.activeSteps;
      inputEl.value  = '';
      if (inputEl === narrationInput) btnCommitStep.disabled = true;
      renderStepList();
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
  stepList.innerHTML        = '';
  stepCount.textContent     = activeSteps.length;

  const htmlItems = renderStepListHtml(activeSteps);
  activeSteps.forEach((step, index) => {
    const wrapper = document.createElement('template');
    wrapper.innerHTML = htmlItems[index].trim();
    const li = wrapper.content.firstChild;

    li.querySelector('.step-narration').addEventListener('click', () => openStepDetail(step));

    li.querySelector('[data-action="edit"]').addEventListener('click',    () => openRerecord(step));
    li.querySelector('[data-action="history"]').addEventListener('click', () => openHistory(step.logical_id));
    li.querySelector('[data-action="delete"]').addEventListener('click',  () => confirmDeleteStep(step.logical_id));

    li.addEventListener('dragstart', onDragStart);
    li.addEventListener('dragover',  onDragOver);
    li.addEventListener('drop',      onDrop);
    li.addEventListener('dragend',   onDragEnd);

    stepList.appendChild(li);
  });
}

// ─── Re-record ────────────────────────────────────────────────────────────────

async function openRerecord(step) {
  rerecordLogicalId       = step.logical_id;
  rerecordNarration.value = step.narration;
  previousRecordingView = isRecording;
  if (isRecording) {
    await send({ type: 'RECORDING_STOP' });
    isRecording = false;
  }
  showView('rerecord');
}

btnRerecordCancel.addEventListener('click', async () => {
  rerecordLogicalId = null;
  // Restore recording state to what it was before entering re-record
  if (previousRecordingView) {
    await send({ type: 'RECORDING_START' });
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

async function openHistory(logical_id) {
  const { project } = await send({ type: 'PROJECT_GET' });
  const recording = project?.recordings?.find(r => r.recording_id === activeRecording?.recording_id);
  if (!recording) return;

  const versions = recording.steps
    .filter(s => s.logical_id === logical_id)
    .sort((a, b) => (a.uuid > b.uuid ? -1 : 1));

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
  const items   = [...stepList.querySelectorAll('.step-item')];
  const srcIdx  = items.indexOf(dragSrc);
  const dstIdx  = items.indexOf(this);
  if (srcIdx < dstIdx) stepList.insertBefore(dragSrc, this.nextSibling);
  else stepList.insertBefore(dragSrc, this);
}

async function onDragEnd() {
  document.querySelectorAll('.step-item').forEach(el =>
    el.classList.remove('dragging', 'drag-over')
  );
  // Only persist if the order actually changed
  const currentIds = [...stepList.querySelectorAll('.step-item')].map(el => el.dataset.logical);
  const originalIds = activeSteps.map(s => s.logical_id);
  const changed = currentIds.some((id, i) => id !== originalIds[i]);
  if (changed) await persistReorder();
}

async function persistReorder() {
  const orderedIds = [...stepList.querySelectorAll('.step-item')]
    .map(el => el.dataset.logical);
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
  themeRadios.forEach(r => { r.checked = r.value === theme; });
}

themeRadios.forEach(radio => {
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
  const hasActiveSteps = recordings.some(r => {
    const groups = new Map();
    for (const s of (r.steps ?? [])) {
      const existing = groups.get(s.logical_id);
      if (!existing || s.uuid > existing.uuid) groups.set(s.logical_id, s);
    }
    return Array.from(groups.values()).some(s => !s.deleted);
  });
  btnDispatchProject.disabled = !hasActiveSteps;
  btnDispatchProject.title = hasActiveSteps ? '' : 'No recordings with active steps';
}

btnSettings.addEventListener('click', () => {
  // If already in settings, treat as Back
  if (!views.settings.classList.contains('hidden')) {
    showView(settingsReturnView);
    if (settingsReturnView === 'project') updateDispatchButton();
    return;
  }
  // Find the currently visible non-settings view to return to
  const current = Object.entries(views).find(([key, el]) => key !== 'settings' && !el.classList.contains('hidden'));
  settingsReturnView = current ? current[0] : 'projects';
  loadAndPopulateDispatchSettings();
  showView('settings');
});

btnSettingsBack.addEventListener('click', () => {
  showView(settingsReturnView);
  if (settingsReturnView === 'project') updateDispatchButton();
});

// ─── Init ─────────────────────────────────────────────────────────────────────

await loadTheme();
dispatchSettings = await adapter.loadSettings();
loadProjectsList();
