/**
 * sync-conflict-ui.test.js — Example/unit tests for the shared sync-state
 * indicators and resolution-workflow render module (sync-conflict-ui.js).
 *
 * Task 16.3: render the shared workflow with seeded items and assert each
 * Review and Conflict is presented with the correct controls, that opening an
 * item with the wrong interface is redirected, and that activating an indicator
 * opens the right workflow for that Unit.
 *
 * These are standard example tests (not property tests): a SyncState is seeded
 * — using the real sync-store helpers so the shapes match production — with one
 * recording-level Review item and one recording-level Conflict item, then the
 * pure render functions are exercised against it.
 *
 * Coverage:
 *   - R12.1 — the workflow presents each Review and each Conflict.
 *   - R12.2 — a Review opens the accept/decline view (ACCEPT_REVIEW /
 *             DECLINE_REVIEW controls).
 *   - R12.3 — a Conflict opens the local-vs-incoming chooser (RESOLVE_KEEP_LOCAL
 *             / RESOLVE_KEEP_INCOMING controls).
 *   - R12.4 — opening a Unit with the wrong interface is prevented and the user
 *             is redirected to the correct one.
 *   - R13.3 — activating an attention indicator opens the workflow for that Unit.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  UI_ACTIONS,
  deriveIndicators,
  getProjectIndicator,
  getRecordingIndicator,
  renderIndicatorBadge,
  routeWorkflow,
  renderWorkflow,
  renderReviewWorkflow,
  renderConflictWorkflow,
} from '../../sync-conflict-ui.js';
import { createEmptySyncState, upsertReview, upsertConflict } from '../../sync-store.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const REVIEW_PROJECT = 'proj-review';
const REVIEW_RECORDING = 'rec-review';
const REVIEW_REF = `${REVIEW_PROJECT}:${REVIEW_RECORDING}`;

const CONFLICT_PROJECT = 'proj-conflict';
const CONFLICT_RECORDING = 'rec-conflict';
const CONFLICT_REF = `${CONFLICT_PROJECT}:${CONFLICT_RECORDING}`;

/** A recoverable RecordingCopy with a resolvable Active View. */
function makeRecordingCopy(name, steps) {
  return {
    recording_id: 'rec-x',
    name,
    created_at: '2024-01-01T00:00:00.000Z',
    steps,
  };
}

/** The incoming recording version offered for review. */
function makeReviewIncoming() {
  return makeRecordingCopy('Login Flow (incoming)', [
    {
      logical_id: 'log-1',
      uuid: 'uuid-0001',
      step_number: 1,
      deleted: false,
      narration: 'Open the login page',
    },
    {
      logical_id: 'log-2',
      uuid: 'uuid-0002',
      step_number: 2,
      deleted: false,
      narration: 'Submit credentials',
    },
  ]);
}

/** The local side of the conflict. */
function makeConflictLocal() {
  return makeRecordingCopy('Search Flow (local)', [
    {
      logical_id: 'log-a',
      uuid: 'uuid-1001',
      step_number: 1,
      deleted: false,
      narration: 'Type a local query',
    },
  ]);
}

/** The incoming side of the conflict. */
function makeConflictIncoming() {
  return makeRecordingCopy('Search Flow (incoming)', [
    {
      logical_id: 'log-a',
      uuid: 'uuid-2001',
      step_number: 1,
      deleted: false,
      narration: 'Type an incoming query',
    },
    {
      logical_id: 'log-b',
      uuid: 'uuid-2002',
      step_number: 2,
      deleted: false,
      narration: 'Press search',
    },
  ]);
}

/**
 * Seed a SyncState carrying one Review item and one Conflict item, both at
 * recording granularity, built through the real store helpers so the shapes are
 * exactly what production produces.
 */
function seedState() {
  const state = createEmptySyncState();
  upsertReview(state, REVIEW_REF, makeReviewIncoming());
  upsertConflict(state, CONFLICT_REF, makeConflictLocal(), makeConflictIncoming());
  return state;
}

// ─── R12.2 — Review renders the accept/decline controls ───────────────────────

describe('Review workflow rendering (R12.2)', () => {
  it('renders the incoming change with Accept and Decline controls', () => {
    const state = seedState();
    const result = renderWorkflow(state, REVIEW_REF);

    assert.equal(result.kind, 'review');
    assert.equal(result.redirected, false);
    // Accept/decline controls are present and carry the stable action hooks.
    assert.ok(result.html.includes(`data-action="${UI_ACTIONS.ACCEPT_REVIEW}"`));
    assert.ok(result.html.includes(`data-action="${UI_ACTIONS.DECLINE_REVIEW}"`));
    // The incoming version is presented for review.
    assert.ok(result.html.includes('Login Flow (incoming)'));
    assert.ok(result.html.includes('sync-workflow--review'));
    // It does NOT present the conflict chooser controls.
    assert.ok(!result.html.includes(`data-action="${UI_ACTIONS.RESOLVE_KEEP_LOCAL}"`));
    assert.ok(!result.html.includes(`data-action="${UI_ACTIONS.RESOLVE_KEEP_INCOMING}"`));
  });

  it('renderReviewWorkflow ties both controls to the item unitRef', () => {
    const state = seedState();
    const html = renderReviewWorkflow(state.reviews[REVIEW_REF]);

    assert.ok(html.includes(`data-action="${UI_ACTIONS.ACCEPT_REVIEW}"`));
    assert.ok(html.includes(`data-action="${UI_ACTIONS.DECLINE_REVIEW}"`));
    assert.ok(html.includes(`data-unit-ref="${REVIEW_REF}"`));
  });
});

// ─── R12.3 — Conflict renders the local-vs-incoming chooser ───────────────────

describe('Conflict workflow rendering (R12.3)', () => {
  it('renders both versions with keep-local and keep-incoming controls', () => {
    const state = seedState();
    const result = renderWorkflow(state, CONFLICT_REF);

    assert.equal(result.kind, 'conflict');
    assert.equal(result.redirected, false);
    // Both choice controls are present and carry the stable action hooks.
    assert.ok(result.html.includes(`data-action="${UI_ACTIONS.RESOLVE_KEEP_LOCAL}"`));
    assert.ok(result.html.includes(`data-action="${UI_ACTIONS.RESOLVE_KEEP_INCOMING}"`));
    // Both sides are presented side by side for the choice.
    assert.ok(result.html.includes('Search Flow (local)'));
    assert.ok(result.html.includes('Search Flow (incoming)'));
    assert.ok(result.html.includes('sync-workflow--conflict'));
    // It does NOT present the review accept/decline controls.
    assert.ok(!result.html.includes(`data-action="${UI_ACTIONS.ACCEPT_REVIEW}"`));
    assert.ok(!result.html.includes(`data-action="${UI_ACTIONS.DECLINE_REVIEW}"`));
  });

  it('renderConflictWorkflow ties both choices to the item unitRef', () => {
    const state = seedState();
    const html = renderConflictWorkflow(state.conflicts[CONFLICT_REF]);

    assert.ok(html.includes(`data-action="${UI_ACTIONS.RESOLVE_KEEP_LOCAL}"`));
    assert.ok(html.includes(`data-action="${UI_ACTIONS.RESOLVE_KEEP_INCOMING}"`));
    assert.ok(html.includes(`data-unit-ref="${CONFLICT_REF}"`));
  });
});

// ─── R12.4 — Wrong-interface guard redirects to the correct view ──────────────

describe('Wrong-interface guard (R12.4)', () => {
  it('redirects a Review opened with the Conflict interface to the review view', () => {
    const state = seedState();
    const result = renderWorkflow(state, REVIEW_REF, 'conflict');

    // Lands on the review interface despite requesting the conflict one.
    assert.equal(result.kind, 'review');
    assert.equal(result.redirected, true);
    assert.ok(result.html.includes(`data-action="${UI_ACTIONS.ACCEPT_REVIEW}"`));
    assert.ok(result.html.includes(`data-action="${UI_ACTIONS.DECLINE_REVIEW}"`));
    // Never renders the conflict chooser controls.
    assert.ok(!result.html.includes(`data-action="${UI_ACTIONS.RESOLVE_KEEP_LOCAL}"`));
    assert.ok(!result.html.includes(`data-action="${UI_ACTIONS.RESOLVE_KEEP_INCOMING}"`));
    // Surfaces a redirect notice to the user.
    assert.ok(result.html.includes('sync-workflow-redirect'));
  });

  it('redirects a Conflict opened with the Review interface to the conflict view', () => {
    const state = seedState();
    const result = renderWorkflow(state, CONFLICT_REF, 'review');

    // Lands on the conflict interface despite requesting the review one.
    assert.equal(result.kind, 'conflict');
    assert.equal(result.redirected, true);
    assert.ok(result.html.includes(`data-action="${UI_ACTIONS.RESOLVE_KEEP_LOCAL}"`));
    assert.ok(result.html.includes(`data-action="${UI_ACTIONS.RESOLVE_KEEP_INCOMING}"`));
    // Never renders the review accept/decline controls.
    assert.ok(!result.html.includes(`data-action="${UI_ACTIONS.ACCEPT_REVIEW}"`));
    assert.ok(!result.html.includes(`data-action="${UI_ACTIONS.DECLINE_REVIEW}"`));
    assert.ok(result.html.includes('sync-workflow-redirect'));
  });

  it('routeWorkflow reports the actual kind, never the wrongly-requested one', () => {
    const state = seedState();

    const reviewRoute = routeWorkflow(state, REVIEW_REF, 'conflict');
    assert.equal(reviewRoute.kind, 'review');
    assert.equal(reviewRoute.redirected, true);

    const conflictRoute = routeWorkflow(state, CONFLICT_REF, 'review');
    assert.equal(conflictRoute.kind, 'conflict');
    assert.equal(conflictRoute.redirected, true);

    // Opening with the matching interface is not a redirect.
    assert.equal(routeWorkflow(state, REVIEW_REF, 'review').redirected, false);
    assert.equal(routeWorkflow(state, CONFLICT_REF, 'conflict').redirected, false);
  });
});

// ─── R13.3 / R12.1 — Activating an indicator opens the right workflow ─────────

describe('Activating an indicator opens the workflow (R13.3, R12.1)', () => {
  it('derives one indicator per seeded item, labelled review vs conflict', () => {
    const state = seedState();
    const indicators = deriveIndicators(state);

    assert.equal(indicators.length, 2);

    const reviewIndicator = getRecordingIndicator(indicators, REVIEW_PROJECT, REVIEW_RECORDING);
    const conflictIndicator = getRecordingIndicator(
      indicators,
      CONFLICT_PROJECT,
      CONFLICT_RECORDING,
    );

    assert.ok(reviewIndicator);
    assert.equal(reviewIndicator.kind, 'review');
    assert.equal(reviewIndicator.level, 'recording');

    assert.ok(conflictIndicator);
    assert.equal(conflictIndicator.kind, 'conflict');
    assert.equal(conflictIndicator.level, 'recording');

    // Neither item is project-level, so no project row shows a badge (R13.4).
    assert.equal(getProjectIndicator(indicators, REVIEW_PROJECT), null);
    assert.equal(getProjectIndicator(indicators, CONFLICT_PROJECT), null);
  });

  it('renders an activatable badge carrying the open-workflow hook and unitRef', () => {
    const state = seedState();
    const indicators = deriveIndicators(state);
    const reviewIndicator = getRecordingIndicator(indicators, REVIEW_PROJECT, REVIEW_RECORDING);

    const badge = renderIndicatorBadge(reviewIndicator);
    assert.ok(badge.includes(`data-action="${UI_ACTIONS.OPEN_WORKFLOW}"`));
    assert.ok(badge.includes(`data-unit-ref="${REVIEW_REF}"`));
    assert.ok(badge.includes('attention-badge--review'));
    assert.ok(badge.includes('Review'));
  });

  it('activating each indicator opens the workflow matching that indicator kind', () => {
    const state = seedState();
    const indicators = deriveIndicators(state);

    // Simulate the panel: for every attention indicator, activate it (use its
    // unitRef from the data-unit-ref hook) and confirm the right workflow opens.
    for (const indicator of indicators) {
      const opened = renderWorkflow(state, indicator.unitRef);
      assert.equal(
        opened.kind,
        indicator.kind,
        `indicator ${indicator.unitRef} should open its own ${indicator.kind} workflow`,
      );
      assert.equal(opened.redirected, false);

      if (indicator.kind === 'review') {
        assert.ok(opened.html.includes(`data-action="${UI_ACTIONS.ACCEPT_REVIEW}"`));
        assert.ok(opened.html.includes(`data-action="${UI_ACTIONS.DECLINE_REVIEW}"`));
      } else {
        assert.ok(opened.html.includes(`data-action="${UI_ACTIONS.RESOLVE_KEEP_LOCAL}"`));
        assert.ok(opened.html.includes(`data-action="${UI_ACTIONS.RESOLVE_KEEP_INCOMING}"`));
      }
    }
  });

  it('opening a Unit with no active deferral yields the empty state', () => {
    const state = seedState();
    const result = renderWorkflow(state, 'proj-unknown:rec-unknown');

    assert.equal(result.kind, null);
    assert.equal(result.redirected, false);
    assert.ok(result.html.includes('Nothing to resolve'));
  });
});
