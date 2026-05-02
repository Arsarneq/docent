/**
 * render.js — Shared View Rendering Functions
 *
 * Pure rendering functions extracted from the extension's panel.js.
 * Each function takes data and returns an HTML string — no DOM
 * manipulation, no platform API calls, no side-effects.
 *
 * Both the Chrome extension and the Tauri desktop app import these
 * functions and insert the returned HTML into their own DOM.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Escape special HTML characters to prevent XSS when inserting
 * user-provided text into the DOM via innerHTML.
 *
 * @param {string} str — raw string
 * @returns {string} HTML-safe string
 */
export function escapeHtml(str = '') {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Return a human-readable description of a single captured action.
 *
 * @param {Object} action — an action object from a step's actions array
 * @returns {string} HTML-safe description string
 */
export function describeAction(action) {
  switch (action.type) {
    case 'navigate':    return escapeHtml(action.url);
    case 'click':       return escapeHtml(action.element?.text || action.element?.selector || '');
    case 'right_click': return `right-click ${escapeHtml(action.element?.text || action.element?.selector || '')}`;
    case 'type':        return `${escapeHtml(action.element?.selector || '')} → "${escapeHtml(action.value || '')}"`;
    case 'select':      return `${escapeHtml(action.element?.selector || '')} → "${escapeHtml(action.value || '')}"`;
    case 'key':         return `${escapeHtml(action.key)}${action.modifiers?.ctrl ? ' (Ctrl)' : ''}${action.modifiers?.shift ? ' (Shift)' : ''} on ${escapeHtml(action.element?.selector || '')}`;
    case 'focus':       return `focus ${escapeHtml(action.element?.selector || '')}`;
    case 'file_upload': return `${escapeHtml(action.element?.selector || '')} → ${(action.files ?? []).map(f => escapeHtml(f.name)).join(', ')}`;
    case 'drag_start':  return `drag ${escapeHtml(action.element?.text || action.element?.selector || '')}`;
    case 'drop':        return `drop onto ${escapeHtml(action.element?.text || action.element?.selector || '')}`;
    case 'scroll':      return `scroll ${action.delta_y > 0 ? '↓' : '↑'} ${Math.abs(action.delta_y)}px`;
    case 'context_switch':  return `switch to tab: ${escapeHtml(action.title || action.source || '')}`;
    case 'context_open':    return `new tab opened${action.source ? ': ' + escapeHtml(action.source) : ''}`;
    case 'context_close':   return `tab closed`;
    case 'file_dialog':     return `${escapeHtml(action.dialog_type || 'file')} dialog → ${escapeHtml(action.file_path || '')}`;
    default:            return '';
  }
}

// ─── SVG Icons ────────────────────────────────────────────────────────────────

const SVG_DELETE = `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M3 5h14M8 5V3h4v2M6 5l1 11h6l1-11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const SVG_EDIT = `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M13.5 3.5a2.121 2.121 0 0 1 3 3L7 16l-4 1 1-4 9.5-9.5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
</svg>`;

const SVG_HISTORY = `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <circle cx="10" cy="10" r="7.5" stroke="currentColor" stroke-width="1.6"/>
  <path d="M10 6v4l2.5 2.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// ─── Rendering Functions ──────────────────────────────────────────────────────

/**
 * Render the project list as HTML.
 *
 * Returns an array of HTML strings, one per project. The caller is
 * responsible for inserting them into the DOM and wiring up event
 * listeners on the `[data-action]` buttons.
 *
 * Each `<li>` contains:
 *   - `[data-action="open"]`   — open the project
 *   - `[data-action="delete"]` — delete the project
 *
 * @param {Array<{name: string, recording_count: number, project_id: string}>} projects
 * @returns {string[]} array of `<li>` HTML strings
 */
export function renderProjectList(projects) {
  return projects.map(p => `
    <li class="card-item" data-project-id="${escapeHtml(p.project_id)}">
      <div class="card-item-main">
        <span class="card-item-name">${escapeHtml(p.name)}</span>
        <span class="card-item-meta">${p.recording_count} recording${p.recording_count !== 1 ? 's' : ''}</span>
      </div>
      <div class="card-item-actions">
        <button class="btn btn--ghost btn--sm" data-action="open">Open</button>
        <button class="btn btn--ghost btn--sm btn--danger" data-action="delete" title="Delete">
          ${SVG_DELETE}
        </button>
      </div>
    </li>
  `);
}

/**
 * Resolve the active (latest, non-deleted) steps for a recording.
 *
 * Groups steps by logical_id, keeps the one with the highest uuid
 * (latest version), and filters out deleted steps.
 *
 * @param {Array<{logical_id: string, uuid: string, deleted?: boolean}>} steps
 * @returns {Array} active steps
 */
function resolveActiveSteps(steps) {
  const groups = new Map();
  for (const s of (steps ?? [])) {
    const existing = groups.get(s.logical_id);
    if (!existing || s.uuid > existing.uuid) groups.set(s.logical_id, s);
  }
  return Array.from(groups.values()).filter(s => !s.deleted);
}

/**
 * Render the recording list for a project as HTML.
 *
 * Returns an array of HTML strings, one per recording. The caller
 * wires up event listeners on `[data-action]` buttons.
 *
 * Each `<li>` contains:
 *   - `[data-action="open"]`   — open the recording
 *   - `[data-action="delete"]` — delete the recording
 *
 * @param {Array<{name: string, recording_id: string, steps?: Array}>} recordings
 * @returns {string[]} array of `<li>` HTML strings
 */
export function renderRecordingList(recordings) {
  return recordings.map(r => {
    const activeSteps = resolveActiveSteps(r.steps);
    const count = activeSteps.length;

    return `
      <li class="card-item" data-recording-id="${escapeHtml(r.recording_id)}">
        <div class="card-item-main">
          <span class="card-item-name">${escapeHtml(r.name)}</span>
          <span class="card-item-meta">${count} step${count !== 1 ? 's' : ''}</span>
        </div>
        <div class="card-item-actions">
          <button class="btn btn--ghost btn--sm" data-action="open">Open</button>
          <button class="btn btn--ghost btn--sm btn--danger" data-action="delete" title="Delete">
            ${SVG_DELETE}
          </button>
        </div>
      </li>
    `;
  });
}

/**
 * Render the step list for a recording as HTML.
 *
 * Returns an array of HTML strings, one per step. Each `<li>` is
 * draggable and contains action buttons the caller wires up:
 *   - `.step-narration` (click) — view step detail
 *   - `[data-action="edit"]`    — re-record
 *   - `[data-action="history"]` — view history
 *   - `[data-action="delete"]`  — delete step
 *
 * @param {Array<{logical_id: string, narration: string, step_number?: number, actions?: Array}>} steps
 * @returns {string[]} array of `<li>` HTML strings
 */
export function renderStepList(steps) {
  return steps.map((step, index) => `
    <li class="step-item" data-logical="${escapeHtml(step.logical_id)}" draggable="true">
      <span class="step-number">${index + 1}</span>
      <span class="step-narration step-narration--link" title="View actions">${escapeHtml(step.narration)}</span>
      <div class="step-actions">
        <button class="btn btn--ghost btn--sm" data-action="edit" title="Re-record">
          ${SVG_EDIT}
        </button>
        <button class="btn btn--ghost btn--sm" data-action="history" title="History">
          ${SVG_HISTORY}
        </button>
        <button class="btn btn--ghost btn--sm btn--danger" data-action="delete" title="Delete">
          ${SVG_DELETE}
        </button>
      </div>
    </li>
  `);
}

/**
 * Render the step detail view (list of actions within a step) as HTML.
 *
 * Returns an array of HTML strings, one per action. If the step has
 * no actions, returns a single empty-state `<li>`.
 *
 * @param {Array<{type: string, [key: string]: any}>} actions — the step's actions array
 * @returns {string[]} array of `<li>` HTML strings
 */
export function renderStepDetail(actions) {
  if (!actions?.length) {
    return ['<li class="step-detail-empty">No actions recorded.</li>'];
  }

  return actions.map((action, i) => `
    <li class="step-detail-item">
      <span class="step-detail-index">${i + 1}</span>
      <span class="step-detail-type">${escapeHtml(action.type)}</span>
      <span class="step-detail-desc">${describeAction(action)}</span>
    </li>
  `);
}
