/**
 * sync-conflict-ui.js — Shared sync-state indicators and resolution-workflow render
 *
 * The parity-bearing UI half of the conflict-resolution feature. Both the Chrome
 * extension (`packages/extension/sidepanel/panel.js`) and the desktop app
 * (`packages/desktop/src/panel.js`) import this module so they surface the SAME
 * attention indicators and the SAME Conflict_Resolution workflow. Like
 * `views/render.js`, every function here is pure: it takes the durable
 * {@link SyncState} (plus a Unit reference) and returns plain data or an HTML
 * string — no DOM access, no platform APIs, no side effects. Each panel inserts
 * the returned HTML into its own DOM and wires listeners on the `[data-action]`
 * hooks.
 *
 * Two concerns live here:
 *
 *   1. **Attention-indicator derivation** ({@link deriveIndicators} +
 *      lookups) — from a `SyncState`, work out which Units need attention and
 *      whether each is a *Review* or a *Conflict*. A recording needing
 *      attention always yields a recording-level indicator; the
 *      project-level indicator is yielded only when the project Unit itself needs
 *      attention, in which case both show.
 *
 *   2. **Resolution-workflow rendering** ({@link renderWorkflow} +
 *      {@link routeWorkflow}) — a Review item opens the accept/decline view;
 * a Conflict opens the local-vs-incoming chooser; opening a
 *      Unit with the wrong interface is prevented and redirected to the correct
 *      one. Activating an indicator opens the workflow for that Unit
 * via the `data-action="open-workflow"` / `data-unit-ref` hooks.
 *
 * `reviews` and `conflicts` are mutually exclusive per `unitRef` (guaranteed by
 * sync-store.js), so a Unit routes to exactly one interface; routing checks
 * conflicts before reviews purely for determinism.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */
// see docs/technical/session-format.md — the conflict resolver appends step-history records (re-record copies and tombstones) directly, so it is bound by the format's append-only step-history rules; the per-platform schemas are authoritative for field semantics.

import { escapeHtml } from './views/render.js';
import { resolveActiveSteps } from './lib/session.js';
import { uuidv7 } from './lib/uuid-v7.js';

// ─── Stable interaction hooks (referenced by both panels) ─────────────────────

/**
 * `data-action` values placed on the rendered controls. Both panels match on
 * these to wire their listeners, so they are part of this module's contract and
 * must stay stable.
 *
 * @readonly
 */
export const UI_ACTIONS = Object.freeze({
  /** Activate an attention indicator → open the workflow for its Unit. */
  OPEN_WORKFLOW: 'open-workflow',
  /**
   * Activate a rolled-up recordings indicator on a project row → open the project
   * so its per-recording indicators are visible. A roll-up stands for one
   * or more recordings, not a single resolvable Unit, so it opens the project
   * rather than a workflow.
   */
  OPEN_PROJECT: 'open-project',
  /** Accept a Review item's incoming change. */
  ACCEPT_REVIEW: 'accept-review',
  /** Decline a Review item's incoming change. */
  DECLINE_REVIEW: 'decline-review',
  /** Resolve a Conflict by keeping the local version. */
  RESOLVE_KEEP_LOCAL: 'resolve-keep-local',
  /** Resolve a Conflict by keeping the incoming version. */
  RESOLVE_KEEP_INCOMING: 'resolve-keep-incoming',
});

// ─── Attention-indicator derivation ───────────────────────────────────────────

/**
 * A single derived attention indicator for one Unit needing attention.
 *
 * @typedef {Object} AttentionIndicator
 * @property {import('./sync-types.js').UnitRef} unitRef
 * @property {string} project_id
 * @property {string|null} recording_id - null for a project-level Unit
 * @property {'project'|'recording'} level - which row the indicator belongs on
 * @property {'review'|'conflict'} kind - Review-and-Accept vs Conflict
 */

/**
 * One attention badge to render on a project ROW. A project row
 * can show up to three of these at once (see {@link getProjectRowIndicators}).
 *
 * @typedef {Object} ProjectRowBadge
 * @property {'project-own'|'recording-rollup'} scope - the project Unit's own
 *   badge (opens its workflow), or a rolled-up child-recordings badge (opens the
 *   project)
 * @property {'review'|'conflict'} kind - Review-and-Accept vs Conflict
 * @property {string|null} unitRef - the project Unit's `unitRef` for a
 *   `'project-own'` badge; null for a `'recording-rollup'` badge (it stands for
 *   several recordings, not one Unit)
 * @property {string} project_id
 */

/**
 * Map one stored deferred item ({@link import('./sync-types.js').ReviewItem} or
 * {@link import('./sync-types.js').ConflictItem}) to an {@link AttentionIndicator}.
 * The item's own `kind` (`'review'`/`'conflict'`) and `recording_id` (null for a
 * project-level Unit) fully determine the indicator, so no `unitRef` parsing is
 * needed.
 *
 * @param {{kind: 'review'|'conflict', unitRef: string, project_id: string, recording_id: string|null}} item
 * @returns {AttentionIndicator}
 */
function indicatorFromItem(item) {
  return {
    unitRef: item.unitRef,
    project_id: item.project_id,
    recording_id: item.recording_id ?? null,
    level: item.recording_id == null ? 'project' : 'recording',
    kind: item.kind === 'conflict' ? 'conflict' : 'review',
  };
}

/**
 * Derive the full set of attention indicators from a {@link SyncState}.
 *
 * Exactly the Units recorded in `reviews` or `conflicts` need attention; each is
 * labelled `'review'` or `'conflict'` by its record type. A
 * recording-level item produces a `level: 'recording'` indicator (always shown); a project-level item produces a `level: 'project'` indicator, which is
 * the *only* reason a project row shows a badge — so a project whose only
 * attention is in a child recording gets no project-level indicator,
 * while a project that itself needs attention shows the project-level indicator
 * in addition to any recording-level ones.
 *
 * Pure derivation: returns plain data, never touches the DOM.
 *
 * @param {import('./sync-types.js').SyncState | null | undefined} state
 * @returns {AttentionIndicator[]}
 */
export function deriveIndicators(state) {
  const indicators = [];
  const reviews = state && state.reviews ? Object.values(state.reviews) : [];
  const conflicts = state && state.conflicts ? Object.values(state.conflicts) : [];
  for (const item of conflicts) indicators.push(indicatorFromItem(item));
  for (const item of reviews) indicators.push(indicatorFromItem(item));
  return indicators;
}

/**
 * Find the project-level indicator for a project, or `null` when the project
 * Unit itself does not need attention. Drives whether a project row shows a
 * badge.
 *
 * @param {AttentionIndicator[]} indicators - from {@link deriveIndicators}
 * @param {string} project_id
 * @returns {AttentionIndicator | null}
 */
export function getProjectIndicator(indicators, project_id) {
  return indicators.find((i) => i.level === 'project' && i.project_id === project_id) ?? null;
}

/**
 * Find the recording-level indicator for a recording, or `null` when it does not
 * need attention. A recording needing attention always has one.
 *
 * @param {AttentionIndicator[]} indicators - from {@link deriveIndicators}
 * @param {string} project_id
 * @param {string} recording_id
 * @returns {AttentionIndicator | null}
 */
export function getRecordingIndicator(indicators, project_id, recording_id) {
  return (
    indicators.find(
      (i) =>
        i.level === 'recording' && i.project_id === project_id && i.recording_id === recording_id,
    ) ?? null
  );
}

/**
 * The full set of attention badges a single project ROW should show.
 *
 * A project row surfaces the attention of the project Unit AND of every child
 * recording, so the user can see a project needs attention without opening it.
 * It is a roll-up, deduplicated by kind: there is at most ONE badge of
 * each unique (level, kind) pairing, so e.g. three child recordings in conflict
 * still yield a single recording-level conflict badge. Up to THREE badges can
 * therefore show at once on one project row:
 *
 *   - the project Unit's OWN badge — present iff the project Unit itself is in
 *     review or conflict (its own `getProjectIndicator`); it carries the
 *     `open-workflow` hook for the project Unit;
 *   - a rolled-up recording-CONFLICT badge — present iff ANY child recording is
 *     in conflict; and
 *   - a rolled-up recording-REVIEW badge — present iff ANY child recording is in
 *     review.
 *
 * A roll-up badge stands for one or more child recordings, not a single
 * resolvable Unit, so it carries the `open-project` hook (open the project to see
 * which recordings need attention) rather than `open-workflow`. The
 * project's own badge keeps the `open-workflow` hook.
 *
 * Ordering is stable and meaningful: the project-own badge first, then the
 * recording conflict roll-up, then the recording review roll-up — conflicts
 * (a forced choice) read ahead of reviews (a softer prompt).
 *
 * @param {AttentionIndicator[]} indicators - from {@link deriveIndicators}
 * @param {string} project_id
 * @returns {ProjectRowBadge[]} 0..3 badges to render on the project row
 */
export function getProjectRowIndicators(indicators, project_id) {
  const own = getProjectIndicator(indicators, project_id);
  const recordingKinds = new Set(
    indicators
      .filter((i) => i.level === 'recording' && i.project_id === project_id)
      .map((i) => i.kind),
  );

  const badges = [];
  // 1. The project Unit's own badge (opens its workflow).
  if (own) {
    badges.push({ scope: 'project-own', kind: own.kind, unitRef: own.unitRef, project_id });
  }
  // 2. Rolled-up recording conflict (opens the project).
  if (recordingKinds.has('conflict')) {
    badges.push({ scope: 'recording-rollup', kind: 'conflict', unitRef: null, project_id });
  }
  // 3. Rolled-up recording review (opens the project).
  if (recordingKinds.has('review')) {
    badges.push({ scope: 'recording-rollup', kind: 'review', unitRef: null, project_id });
  }
  return badges;
}

// ─── Indicator rendering ──────────────────────────────────────────────────────

/**
 * Render one attention indicator as an activatable badge. The badge carries the
 * `data-action="open-workflow"` and `data-unit-ref` hooks so the panel can open
 * the workflow for that Unit when the badge is activated. The CSS
 * modifier and label distinguish Review from Conflict.
 *
 * @param {AttentionIndicator | null | undefined} indicator
 * @returns {string} a `<button>` HTML string, or `''` when there is no indicator
 */
export function renderIndicatorBadge(indicator) {
  if (!indicator) return '';
  const isConflict = indicator.kind === 'conflict';
  const label = isConflict ? 'Conflict' : 'Review';
  const modifier = isConflict ? 'attention-badge--conflict' : 'attention-badge--review';
  const title = isConflict
    ? 'In conflict — resolve to choose a version'
    : 'Incoming change — review to accept or decline';
  return (
    `<button type="button" class="attention-badge ${modifier}"` +
    ` data-action="${UI_ACTIONS.OPEN_WORKFLOW}"` +
    ` data-unit-ref="${escapeHtml(indicator.unitRef)}"` +
    ` title="${escapeHtml(title)}">${label}</button>`
  );
}

/**
 * Render one project-ROW badge. Distinguishes Review from Conflict
 * by the same CSS modifier and label as {@link renderIndicatorBadge}, so the
 * badges read identically wherever they appear. The activation hook differs by
 * scope:
 *
 *   - a `'project-own'` badge carries `data-action="open-workflow"` +
 *     `data-unit-ref` (the project Unit), so activating it opens that Unit's
 *     resolution workflow;
 *   - a `'recording-rollup'` badge carries `data-action="open-project"` +
 *     `data-project-id` (no `unitRef` — it stands for one or more recordings, not
 *     a single resolvable Unit), so activating it opens the project to reveal the
 *     per-recording badges.
 *
 * @param {ProjectRowBadge | null | undefined} badge
 * @returns {string} a `<button>` HTML string, or `''` when there is no badge
 */
export function renderProjectRowBadge(badge) {
  if (!badge) return '';
  const isConflict = badge.kind === 'conflict';
  const label = isConflict ? 'Conflict' : 'Review';
  const modifier = isConflict ? 'attention-badge--conflict' : 'attention-badge--review';

  if (badge.scope === 'recording-rollup') {
    // A roll-up over child recordings: opens the project, no unitRef.
    const title = isConflict
      ? 'A recording in this project is in conflict — open to resolve'
      : 'A recording in this project has an incoming change to review — open to see it';
    return (
      `<button type="button" class="attention-badge ${modifier} attention-badge--rollup"` +
      ` data-action="${UI_ACTIONS.OPEN_PROJECT}"` +
      ` data-project-id="${escapeHtml(badge.project_id)}"` +
      ` title="${escapeHtml(title)}">${label}</button>`
    );
  }

  // The project Unit's own badge: opens its workflow, exactly like a
  // recording-level indicator badge.
  const title = isConflict
    ? 'This project is in conflict — resolve to choose a version'
    : 'Incoming change to this project — review to accept or decline';
  return (
    `<button type="button" class="attention-badge ${modifier}"` +
    ` data-action="${UI_ACTIONS.OPEN_WORKFLOW}"` +
    ` data-unit-ref="${escapeHtml(badge.unitRef)}"` +
    ` title="${escapeHtml(title)}">${label}</button>`
  );
}

// ─── Workflow routing (the wrong-interface guard) ─────────────────────────────

/**
 * The kind of deferred item, and the interface it routes to, or `null`.
 *
 * @typedef {('review'|'conflict'|null)} ItemKind
 */

/**
 * The outcome of routing a Unit to a resolution interface.
 *
 * @typedef {Object} WorkflowRoute
 * @property {ItemKind} kind - the item's actual kind, or null when there is none
 * @property {boolean} redirected - true when the requested interface did not
 *   match the item's kind and the user was redirected to the correct one
 * @property {(import('./sync-types.js').ReviewItem|import('./sync-types.js').ConflictItem|null)} item
 *   the stored item, or null when the Unit has no active deferral
 */

/**
 * Look up the active deferred item for a `unitRef`, preferring a Conflict when
 * (defensively) both are present — though sync-store keeps them mutually
 * exclusive.
 *
 * @param {import('./sync-types.js').SyncState | null | undefined} state
 * @param {import('./sync-types.js').UnitRef} unitRef
 * @returns {{kind: ItemKind, item: (import('./sync-types.js').ReviewItem|import('./sync-types.js').ConflictItem|null)}}
 */
function lookupItem(state, unitRef) {
  if (state && state.conflicts && state.conflicts[unitRef]) {
    return { kind: 'conflict', item: state.conflicts[unitRef] };
  }
  if (state && state.reviews && state.reviews[unitRef]) {
    return { kind: 'review', item: state.reviews[unitRef] };
  }
  return { kind: null, item: null };
}

/**
 * Route a Unit to the correct resolution interface, enforcing the wrong-interface
 * guard. When `requestedKind` is supplied and disagrees with the Unit's
 * actual kind, the route reports `redirected: true` and resolves to the actual
 * kind — never the requested one — so a Review can never be opened in the
 * Conflict interface (or vice-versa). When `requestedKind` is omitted (the normal
 * "activate the indicator" path), the actual kind is used with no redirect.
 *
 * @param {import('./sync-types.js').SyncState | null | undefined} state
 * @param {import('./sync-types.js').UnitRef} unitRef
 * @param {ItemKind} [requestedKind] - the interface the user tried to open
 * @returns {WorkflowRoute}
 */
export function routeWorkflow(state, unitRef, requestedKind = null) {
  const { kind, item } = lookupItem(state, unitRef);
  if (kind === null) {
    return { kind: null, redirected: false, item: null };
  }
  const redirected = requestedKind != null && requestedKind !== kind;
  return { kind, redirected, item };
}

// ─── Unit content summaries (read-only) ───────────────────────────────────────

/**
 * Human-readable label for one active step, mirroring `renderStepList` in
 * `views/render.js` (narration, else step type + optional expectation, else a
 * positional fallback).
 *
 * @param {{narration?: string, step_type?: string, expect?: string}} step
 * @param {number} index - zero-based position in the active view
 * @returns {string} HTML-safe label
 */
function stepLabel(step, index) {
  if (step.narration) return escapeHtml(step.narration);
  if (step.step_type) {
    return escapeHtml(step.step_type) + (step.expect ? ` (${escapeHtml(step.expect)})` : '');
  }
  return `Step ${index + 1}`;
}

/**
 * Render a compact, read-only summary of a Unit copy for side-by-side comparison.
 * A recording copy (has `steps`) shows its name and Active View; a project copy
 * (has `recordings`) shows its name and recording count; an absent copy (a
 * deletion side of a delete-vs-change Conflict) shows a deleted state.
 *
 * @param {import('./sync-types.js').UnitCopy | null | undefined} unit
 * @returns {string} HTML string
 */
function renderUnitSummary(unit) {
  if (!unit) {
    return '<p class="sync-unit-summary sync-unit-summary--deleted">Deleted (no version on this side)</p>';
  }

  const name = escapeHtml(unit.name ?? 'Untitled');

  if (Array.isArray(unit.steps)) {
    const active = resolveActiveSteps(unit);
    const count = active.length;
    const items = active
      .map((step, i) => `<li class="sync-step">${i + 1}. ${stepLabel(step, i)}</li>`)
      .join('');
    return (
      `<div class="sync-unit-summary sync-unit-summary--recording">` +
      `<p class="sync-unit-name">${name}</p>` +
      `<p class="sync-unit-meta">${count} step${count !== 1 ? 's' : ''}</p>` +
      `<ol class="sync-step-list">${items}</ol>` +
      `</div>`
    );
  }

  if (Array.isArray(unit.recordings)) {
    const count = unit.recordings.length;
    return (
      `<div class="sync-unit-summary sync-unit-summary--project">` +
      `<p class="sync-unit-name">${name}</p>` +
      `<p class="sync-unit-meta">${count} recording${count !== 1 ? 's' : ''}</p>` +
      `</div>`
    );
  }

  return `<div class="sync-unit-summary"><p class="sync-unit-name">${name}</p></div>`;
}

/**
 * Optional banner shown when the user was redirected to the correct interface
 * because they opened a Unit with the wrong one.
 *
 * @param {boolean} redirected
 * @param {'review'|'conflict'} kind - the correct interface the user landed on
 * @returns {string} HTML string, or `''` when no redirect happened
 */
function renderRedirectNotice(redirected, kind) {
  if (!redirected) return '';
  const target = kind === 'conflict' ? 'conflict resolution' : 'review';
  return (
    `<p class="sync-workflow-redirect" role="status">` +
    `This item is a ${kind}; showing the ${target} view instead.</p>`
  );
}

// ─── Workflow rendering ────────────────────────────────────────────────────────

/**
 * Render the accept/decline view for a Review-and-Accept item. Presents
 * the incoming change and the Accept / Decline controls; only the incoming
 * version is stored on a Review item, so only it is shown.
 *
 * @param {import('./sync-types.js').ReviewItem} item
 * @param {boolean} [redirected=false] - whether the user was redirected here
 * @returns {string} HTML string
 */
export function renderReviewWorkflow(item, redirected = false) {
  const ref = escapeHtml(item.unitRef);
  const applied = item.status === 'APPLIED';
  return (
    `<div class="sync-workflow sync-workflow--review" data-unit-ref="${ref}">` +
    renderRedirectNotice(redirected, 'review') +
    `<h3 class="sync-workflow-title">Review incoming change</h3>` +
    `<p class="sync-workflow-desc">An incoming change is ready for your review. ` +
    `Accept it to apply the change, or decline to keep your local version.</p>` +
    `<div class="sync-workflow-body">${renderUnitSummary(item.incoming)}</div>` +
    `<div class="sync-workflow-actions">` +
    `<button type="button" class="btn btn--primary" data-action="${UI_ACTIONS.ACCEPT_REVIEW}"` +
    ` data-unit-ref="${ref}"${applied ? ' disabled' : ''}>Accept</button>` +
    `<button type="button" class="btn btn--secondary" data-action="${UI_ACTIONS.DECLINE_REVIEW}"` +
    ` data-unit-ref="${ref}"${applied ? ' disabled' : ''}>Decline</button>` +
    `</div>` +
    (applied ? '<p class="sync-workflow-status">Applied</p>' : '') +
    `</div>`
  );
}

/**
 * Render the local-vs-incoming chooser for a Conflict. Presents both the
 * local and the incoming versions side by side, each with a control to adopt that
 * side as the resolved outcome. A delete-vs-change Conflict has one absent side,
 * rendered as a deletion the user can accept by choosing the other version.
 *
 * @param {import('./sync-types.js').ConflictItem} item
 * @param {boolean} [redirected=false] - whether the user was redirected here
 * @returns {string} HTML string
 */
export function renderConflictWorkflow(item, redirected = false) {
  const ref = escapeHtml(item.unitRef);
  return (
    `<div class="sync-workflow sync-workflow--conflict" data-unit-ref="${ref}">` +
    renderRedirectNotice(redirected, 'conflict') +
    `<h3 class="sync-workflow-title">Resolve conflict</h3>` +
    `<p class="sync-workflow-desc">Both your copy and the incoming copy changed. ` +
    `Choose which version to keep — the other stays recoverable.</p>` +
    `<div class="sync-conflict-sides">` +
    `<div class="sync-conflict-side sync-conflict-side--local">` +
    `<h4 class="sync-conflict-side-title">Your version</h4>` +
    renderUnitSummary(item.local) +
    `<button type="button" class="btn btn--secondary" data-action="${UI_ACTIONS.RESOLVE_KEEP_LOCAL}"` +
    ` data-unit-ref="${ref}">Keep your version</button>` +
    `</div>` +
    `<div class="sync-conflict-side sync-conflict-side--incoming">` +
    `<h4 class="sync-conflict-side-title">Incoming version</h4>` +
    renderUnitSummary(item.incoming) +
    `<button type="button" class="btn btn--secondary" data-action="${UI_ACTIONS.RESOLVE_KEEP_INCOMING}"` +
    ` data-unit-ref="${ref}">Keep incoming version</button>` +
    `</div>` +
    `</div>` +
    `</div>`
  );
}

/**
 * Empty-state markup shown when a Unit has no active deferral (e.g. it was
 * already resolved in another view).
 *
 * @returns {string} HTML string
 */
function renderNoItem() {
  return '<div class="sync-workflow sync-workflow--empty"><p>Nothing to resolve for this item.</p></div>';
}

/**
 * Open the resolution workflow for a Unit. This is the single entry point a panel
 * calls when an indicator is activated or when the user opens an item
 * through a specific interface. It routes the Unit to its correct interface,
 * enforcing the wrong-interface guard: if `requestedKind` disagrees with
 * the Unit's actual kind, the correct interface is rendered and `redirected` is
 * set so the panel can surface the redirect.
 *
 * @param {import('./sync-types.js').SyncState | null | undefined} state
 * @param {import('./sync-types.js').UnitRef} unitRef
 * @param {ItemKind} [requestedKind] - the interface the user tried to open, or
 *   omit to open whichever interface the item requires
 * @returns {{kind: ItemKind, redirected: boolean, html: string}}
 */
export function renderWorkflow(state, unitRef, requestedKind = null) {
  const route = routeWorkflow(state, unitRef, requestedKind);
  if (route.kind === null) {
    return { kind: null, redirected: false, html: renderNoItem() };
  }
  const html =
    route.kind === 'conflict'
      ? renderConflictWorkflow(route.item, route.redirected)
      : renderReviewWorkflow(route.item, route.redirected);
  return { kind: route.kind, redirected: route.redirected, html };
}

// ─── Conflict resolved-state builder (keep-local / keep-incoming) ─────────────

/**
 * The latest (highest-`uuid`) version record per `logical_id` in a step history,
 * matching how `resolveActiveSteps` (session.js) picks the active version.
 *
 * @param {object[]} steps
 * @returns {Map<string, object>}
 */
function latestPerLogicalId(steps) {
  const latest = new Map();
  for (const step of steps ?? []) {
    if (!step || step.logical_id == null) continue;
    const existing = latest.get(step.logical_id);
    if (!existing || step.uuid > existing.uuid) latest.set(step.logical_id, step);
  }
  return latest;
}

/**
 * Union the step records of two histories by `uuid` (first occurrence wins),
 * preserving the append-only history of BOTH sides. The result contains every
 * record from each side, so it satisfies `resolveConflict`'s append-only superset
 * requirement before any chosen-side overlay is applied.
 *
 * @param {object[]} localSteps
 * @param {object[]} incomingSteps
 * @returns {object[]}
 */
function unionStepsByUuid(localSteps, incomingSteps) {
  const byUuid = new Map();
  for (const step of [...(localSteps ?? []), ...(incomingSteps ?? [])]) {
    if (step && step.uuid != null && !byUuid.has(step.uuid)) byUuid.set(step.uuid, step);
  }
  return [...byUuid.values()];
}

/**
 * Build the resolved committed step history for one recording so that, over the
 * APPEND-ONLY union of both sides' records, the *chosen* side's Active View wins.
 *
 * The union (every record from local and incoming) is the append-only base.
 * On top of it, for each `logical_id` we append a single fresh-`uuid`
 * version record that makes the chosen side's intent the latest version — exactly
 * the re-record / tombstone mechanism `session.js` already uses, so tombstones
 * stay tombstoned and there is at most one active step per `logical_id`:
 *   - the chosen side wants the step LIVE  → append a fresh copy of the chosen
 *     side's active record (so it becomes the latest, live version);
 *   - the chosen side wants it GONE (its latest version is a tombstone, or it has
 *     no record for that `logical_id`) → append a fresh tombstone, so the step is
 *     absent from the resolved Active View.
 * A fresh record is appended only when the union's current latest version does
 * not already match the chosen intent, so an already-agreed step is untouched.
 *
 * @param {object|null} localRec - the local recording copy (or null if absent)
 * @param {object|null} incomingRec - the incoming recording copy (or null if absent)
 * @param {object|null} chosenRec - whichever of the two the user chose to keep
 * @param {() => string} newUuid - fresh-uuid source (injectable; defaults to uuidv7)
 * @returns {object[]} the resolved append-only step history
 */
function buildResolvedSteps(localRec, incomingRec, chosenRec, newUuid) {
  const localSteps = (localRec && localRec.steps) || [];
  const incomingSteps = (incomingRec && incomingRec.steps) || [];
  const steps = unionStepsByUuid(localSteps, incomingSteps);

  const unionLatest = latestPerLogicalId(steps);
  const chosenLatest = latestPerLogicalId((chosenRec && chosenRec.steps) || []);

  for (const [logicalId, current] of unionLatest) {
    const chosen = chosenLatest.get(logicalId);
    if (chosen && !chosen.deleted) {
      // Chosen side wants this step live with its content; make it the latest.
      if (!(current.uuid === chosen.uuid && !current.deleted)) {
        steps.push({ ...chosen, uuid: newUuid(), deleted: false });
      }
    } else if (!current.deleted) {
      // Chosen side wants it gone (tombstoned or absent) — append a tombstone.
      steps.push({ ...current, uuid: newUuid(), deleted: true });
    }
  }
  return steps;
}

/**
 * Build a {@link import('./sync-types.js').RecordingCopy} shell carrying the
 * chosen side's identity (name/metadata/created_at) and the resolved steps.
 *
 * @param {object} chosenRec - the chosen recording (its identity is adopted)
 * @param {object[]} steps - the resolved append-only history
 * @returns {import('./sync-types.js').RecordingCopy}
 */
function recordingShell(chosenRec, steps) {
  return {
    recording_id: chosenRec.recording_id,
    name: chosenRec.name,
    created_at: chosenRec.created_at,
    ...(chosenRec.metadata && { metadata: chosenRec.metadata }),
    steps,
  };
}

/**
 * Build the explicit `resolvedState` for a Conflict from the user's keep-local /
 * keep-incoming choice, suitable to pass straight to `resolveConflict`.
 *
 * The two panels call this so the choice is translated IDENTICALLY on both
 * platforms; it is the single shared place a conflict choice
 * becomes an append-only resolved state.
 *
 *   - When the chosen side is ABSENT (the deletion side of a delete-vs-change
 *     Conflict), the user chose to accept the deletion → returns the
 *     `{ deleted: true }` sentinel `resolveConflict` recognises.
 *   - When the other side is absent (keeping the surviving changed version of a
 *     delete-vs-change Conflict), the chosen copy alone is already an append-only
 *     superset (the absent side contributes no records) → returns it verbatim.
 *   - For a genuinely diverged Unit (both sides present), returns an append-only
 *     superset whose Active View equals the chosen side's, at the Unit's
 *     granularity (a recording copy, or a project copy with each recording
 *     resolved the same way over the union of recording ids).
 *
 * @param {import('./sync-types.js').ConflictItem} item - the Conflict being resolved
 * @param {'local'|'incoming'} side - the version the user chose to keep
 * @param {{ newUuid?: () => string }} [options] - fresh-uuid source (injectable for tests)
 * @returns {import('./sync-types.js').UnitCopy | { deleted: true }}
 */
export function buildResolvedState(item, side, options = {}) {
  const newUuid = options.newUuid ?? uuidv7;
  const chosen = side === 'local' ? item.local : item.incoming;
  const other = side === 'local' ? item.incoming : item.local;

  // Accept-the-deletion: the chosen side has no version (delete-vs-change).
  if (chosen == null) return { deleted: true };
  // Keep the surviving version: the other side contributes no records, so the
  // chosen copy is already an append-only superset.
  if (other == null) return chosen;

  if (item.recording_id != null) {
    // Recording-level Conflict.
    return recordingShell(chosen, buildResolvedSteps(item.local, item.incoming, chosen, newUuid));
  }

  // Project-level Conflict: resolve every recording across the union of ids.
  const localRecs = Array.isArray(item.local.recordings) ? item.local.recordings : [];
  const incomingRecs = Array.isArray(item.incoming.recordings) ? item.incoming.recordings : [];
  const chosenRecs = Array.isArray(chosen.recordings) ? chosen.recordings : [];
  const byId = (recs, id) => recs.find((r) => r && r.recording_id === id) ?? null;

  const order = [];
  const seen = new Set();
  for (const r of [...localRecs, ...incomingRecs]) {
    if (r && r.recording_id != null && !seen.has(r.recording_id)) {
      seen.add(r.recording_id);
      order.push(r.recording_id);
    }
  }

  const recordings = order.map((id) => {
    const localRec = byId(localRecs, id);
    const incomingRec = byId(incomingRecs, id);
    const chosenRec = byId(chosenRecs, id);
    const steps = buildResolvedSteps(localRec, incomingRec, chosenRec, newUuid);
    // Adopt the chosen side's recording identity when it has this recording,
    // else fall back to whichever side carries it (its records are retained).
    const shellSource = chosenRec ?? incomingRec ?? localRec;
    return recordingShell(shellSource, steps);
  });

  return {
    project_id: chosen.project_id,
    name: chosen.name,
    created_at: chosen.created_at,
    ...(chosen.metadata && { metadata: chosen.metadata }),
    recordings,
  };
}
