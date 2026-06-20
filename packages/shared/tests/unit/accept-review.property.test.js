/**
 * accept-review.property.test.js — Property test for accepting a Review-and-Accept
 * item through the user-gated Conflict_Resolution workflow (`acceptReview`).
 *
 * A Review-and-Accept item defers an incoming change to a recording (or project)
 * the user already has, whose local copy was unchanged since the last-agreed
 * Sync_Baseline (`changed-incoming`). The incoming change is NEVER applied during
 * a sync cycle — it is adopted only when the user explicitly accepts it.
 * `acceptReview` is the single, auditable place that adoption happens.
 *
 * This property pins the post-condition of a successful accept on ANY PENDING
 * Review item, across arbitrary local projects and arbitrary incoming versions,
 * at both granularities (a recording-level item and a project-level item):
 *
 *   - APPLIES the incoming change — the affected unit in the returned
 *     projects equals the incoming version: for a recording-level item the named
 *     recording in its project becomes byte-identical to the incoming recording;
 *     for a project-level item the project becomes byte-identical to the incoming
 *     project (replacing a present local copy, or added when none existed).
 *   - ADVANCES the baseline to the **resolved-against incoming version**, PER-UNIT
 * — NOT to the adopted local state. A recording-level
 *     accept replaces ONLY the affected recording's entry in the per-project
 *     baseline with the incoming recording, leaving every sibling baseline entry
 *     untouched (so resolving one recording never marks a locally-changed sibling
 *     as agreed — the latent whole-project-baseline bug this revision fixes). A
 *     project-level accept advances the whole project baseline to the incoming
 *     project. For an accept the resolved-against version equals the adopted
 *     state, so the Unit reads as already-converged on a subsequent identical
 *     pull.
 *   - MARKS the item APPLIED — the returned item's status is `APPLIED`.
 *   - CLEARS the item — the Unit returns to the NONE state, so a later
 *     cycle processes it normally rather than as a duplicate.
 *
 * It also pins that everything NOT targeted is left untouched: sibling recordings
 * in the affected project (in local data AND in the baseline), and every other
 * local project, remain byte-identical, and the input `projects` array is never
 * mutated in place.
 *
 * Uses the Node.js built-in test runner + fast-check (fast-check v4: `fc.uuid()`
 * for ids), mirroring the generator conventions in the sibling property tests.
 *
 */

// Accepting a Review item applies the incoming change, advances baseline to the incoming version, and marks APPLIED

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { acceptReview } from '../../conflict-resolution.js';
import { createEmptySyncState, upsertReview, getItem } from '../../sync-store.js';
import { advanceBaseline, getBaseline, getRecordingBaselineDigest } from '../../sync-baseline.js';
import { digestProject, digestRecording } from '../../sync-digest.js';

const FIXED_CREATED_AT = '2024-01-01T00:00:00.000Z';

// A fixed clock so the baseline `agreedAt` stamp is deterministic; the property
// asserts nothing about its value, only that the baseline advanced.
const FIXED_NOW = () => 0;

// ─── Generators ──────────────────────────────────────────────────────────────

/** A committed step record (a versioned, append-only history entry). */
const arbStep = fc.record({
  uuid: fc.uuid(),
  logical_id: fc.constantFrom('a', 'b', 'c'),
  step_number: fc.integer({ min: 0, max: 10 }),
  deleted: fc.boolean(),
});

/** Content of a recording: a name suffix plus a small committed step history. */
const arbContent = fc.record({
  nameSuffix: fc.string({ maxLength: 8 }),
  steps: fc.array(arbStep, { maxLength: 4 }),
});

/** Build a RecordingCopy from an id and a content descriptor. */
function recFromContent(recording_id, content) {
  return {
    recording_id,
    name: `rec-${content.nameSuffix}`,
    created_at: FIXED_CREATED_AT,
    steps: content.steps,
  };
}

/** Build a ProjectCopy from an id, a name suffix, and an ordered recording list. */
function buildProject(project_id, nameSuffix, recordings) {
  return {
    project_id,
    name: `proj-${nameSuffix}`,
    created_at: FIXED_CREATED_AT,
    recordings,
  };
}

/**
 * Allowlisted projection of a project's own scalar identity fields (no
 * recordings). Mirrors `projectMetaSkeleton` in conflict-resolution.js so the
 * independently-computed expected per-unit baseline is shaped exactly like the
 * one the module writes.
 */
function projectMetaSkeleton(project) {
  return {
    project_id: project.project_id,
    name: project.name,
    created_at: project.created_at,
    ...(project.metadata && { metadata: project.metadata }),
  };
}

/** Insert `item` into a copy of `arr` at a deterministic mid position. */
function insertMid(arr, item) {
  const copy = [...arr];
  copy.splice(Math.floor(copy.length / 2), 0, item);
  return copy;
}

// A whole accept scenario. `level` selects a recording-level or project-level
// Review item; the remaining fields populate the local projects, the incoming
// version, sibling recordings, other (untouched) projects, optional stale
// baseline, and — for a project-level item — whether the project is present
// locally (accept must replace it) or absent (accept must add it).
const arbScenario = fc.record({
  level: fc.constantFrom('recording', 'project'),
  project_id: fc.uuid(),
  recording_id: fc.uuid(),
  localContent: arbContent,
  incomingContent: arbContent,
  incomingSecondContent: arbContent, // a second incoming recording (project-level)
  siblings: fc.uniqueArray(fc.record({ id: fc.uuid(), content: arbContent }), {
    selector: (s) => s.id,
    maxLength: 2,
  }),
  others: fc.uniqueArray(fc.record({ id: fc.uuid(), content: arbContent }), {
    selector: (p) => p.id,
    maxLength: 2,
  }),
  projectPresentLocally: fc.boolean(),
  seedStaleBaseline: fc.boolean(),
});

/**
 * Materialize a scenario into the concrete inputs and the independently-computed
 * expected accepted state AND expected per-unit baseline. Defensively excludes
 * any generated id that collides with the target project/recording ids so the
 * target Unit is unambiguous.
 *
 * The whole materialized result is passed through a JSON round-trip so every
 * generated object has a plain prototype. fast-check builds records with a null
 * prototype; the module under test stores recoverable copies via a JSON
 * round-trip (plain prototype), and `deepStrictEqual` is prototype-sensitive — so
 * normalizing here keeps the comparison about VALUES (a genuine mutation) rather
 * than prototype artifacts, matching how the recoverable copies are actually
 * persisted.
 */
function materialize(scenario) {
  return jsonNormalize(materializeRaw(scenario));
}

/** Deep, plain-prototype copy via a JSON round-trip. */
function jsonNormalize(value) {
  return JSON.parse(JSON.stringify(value));
}

function materializeRaw(scenario) {
  const { project_id, recording_id } = scenario;

  // Other local projects, each with one recording, never colliding with target.
  const others = scenario.others
    .filter((p) => p.id !== project_id)
    .map((p) =>
      buildProject(p.id, p.content.nameSuffix, [recFromContent(`${p.id}-rec`, p.content)]),
    );

  if (scenario.level === 'recording') {
    // Sibling recordings in the target project, none equal to the target id.
    const siblings = scenario.siblings
      .filter((s) => s.id !== recording_id)
      .map((s) => recFromContent(s.id, s.content));

    const localTargetRecording = recFromContent(recording_id, scenario.localContent);
    const incoming = recFromContent(recording_id, scenario.incomingContent);

    const localTargetProject = buildProject(
      project_id,
      scenario.localContent.nameSuffix,
      insertMid(siblings, localTargetRecording),
    );

    const localProjects = insertMid(others, localTargetProject);
    const unitRef = `${project_id}:${recording_id}`;

    // Adopted (applied) project state = the local target project with the target
    // recording replaced by the incoming recording; siblings untouched, in order.
    const expectedAccepted = {
      ...localTargetProject,
      recordings: localTargetProject.recordings.map((r) =>
        r.recording_id === recording_id ? incoming : r,
      ),
    };

    // The seeded stale baseline (when present) is the prior AGREED project: every
    // sibling at a deliberately-distinct agreed version (name suffixed so its
    // digest differs from the local sibling) plus a stale agreed version of the
    // target recording. Proving these sibling entries are UNCHANGED after the
    // accept is exactly the per-unit guarantee — the old whole-project rule
    // would have overwritten them with the (changed) local siblings.
    let seededBaseline = null;
    let expectedBaselineAgreed;
    if (scenario.seedStaleBaseline) {
      const baselineSiblings = siblings.map((s) => ({ ...s, name: `${s.name}~baseline` }));
      const baselineTarget = {
        ...localTargetRecording,
        name: `${localTargetRecording.name}~baseline`,
      };
      seededBaseline = buildProject(
        project_id,
        'baseline',
        insertMid(baselineSiblings, baselineTarget),
      );
      // Per-unit advance: the current agreed project with ONLY the target
      // recording's entry replaced by the resolved-against incoming version.
      expectedBaselineAgreed = {
        ...projectMetaSkeleton(seededBaseline),
        recordings: seededBaseline.recordings.map((r) =>
          r.recording_id === recording_id ? incoming : r,
        ),
      };
    } else {
      // No prior baseline: the per-unit advance records agreement on ONLY the
      // target recording (the resolved-against incoming version), sourcing the
      // agreed project's metadata from the adopted project. Siblings that were
      // never agreed are NOT introduced into the baseline.
      expectedBaselineAgreed = {
        ...projectMetaSkeleton(expectedAccepted),
        recordings: [incoming],
      };
    }

    return {
      level: 'recording',
      project_id,
      recording_id,
      unitRef,
      incoming,
      localProjects,
      siblings,
      others,
      seededBaseline,
      expectedAccepted,
      expectedBaselineAgreed,
    };
  }

  // Project-level: the incoming version is a whole ProjectCopy.
  const incoming = buildProject(project_id, scenario.incomingContent.nameSuffix, [
    recFromContent(recording_id, scenario.incomingContent),
    recFromContent(`${recording_id}-b`, scenario.incomingSecondContent),
  ]);

  const localTargetProject = buildProject(project_id, scenario.localContent.nameSuffix, [
    recFromContent(recording_id, scenario.localContent),
  ]);

  const localProjects = scenario.projectPresentLocally
    ? insertMid(others, localTargetProject)
    : [...others];

  const unitRef = project_id;

  // Adopted (applied) project state = the incoming project verbatim.
  const expectedAccepted = incoming;

  // A project-level accept advances the WHOLE project baseline to the incoming
  // project (the resolved-against version) — distinct from any prior baseline.
  const seededBaseline = scenario.seedStaleBaseline
    ? buildProject(project_id, 'stale-baseline', [])
    : null;
  const expectedBaselineAgreed = incoming;

  return {
    level: 'project',
    project_id,
    recording_id,
    unitRef,
    incoming,
    localProjects,
    siblings: [],
    others,
    seededBaseline,
    expectedAccepted,
    expectedBaselineAgreed,
  };
}

/** Find a project by id in a projects array. */
function findProject(projects, project_id) {
  return projects.find((p) => p && p.project_id === project_id);
}

describe('Accepting a Review item applies the incoming change, advances baseline to the incoming version, and marks APPLIED', () => {
  it('a successful accept applies the incoming version, advances the baseline per-unit to the incoming version (siblings untouched), marks APPLIED, and clears the item', () => {
    fc.assert(
      fc.property(arbScenario, (scenario) => {
        const m = materialize(scenario);

        // Build a store holding exactly this PENDING Review item.
        const state = createEmptySyncState();
        upsertReview(state, m.unitRef, m.incoming, FIXED_NOW);

        // Optionally seed a STALE baseline so we can prove accept advances the
        // baseline PER-UNIT to the resolved-against incoming version, overwriting
        // only the target entry and leaving sibling entries untouched.
        if (m.seededBaseline) {
          advanceBaseline(state, m.project_id, m.seededBaseline, FIXED_NOW);
        }

        // Snapshot the input projects to prove the array is not mutated in place.
        const inputSnapshot = structuredClone(m.localProjects);

        const result = acceptReview(state, m.localProjects, m.unitRef, { now: FIXED_NOW });

        // ── Outcome shape ──────────────────────────────────────────────────
        assert.equal(result.ok, true, 'accept of a PENDING review must succeed');
        assert.equal(result.kind, 'review');
        assert.equal(result.reason, null);

        // ── the item is marked APPLIED ──────────────────────────────
        assert.equal(result.item.status, 'APPLIED', 'accepted item must be APPLIED');

        // ── the item is cleared (Unit returns to NONE) ─────────────
        assert.equal(
          getItem(state, m.unitRef),
          null,
          'accepted item must be cleared from the store',
        );

        // ── the incoming change is applied to the affected unit ─────
        const appliedProject = findProject(result.projects, m.project_id);
        assert.ok(appliedProject, 'the affected project must be present after accept');

        if (m.level === 'recording') {
          const appliedRecording = appliedProject.recordings.find(
            (r) => r.recording_id === m.recording_id,
          );
          assert.ok(appliedRecording, 'the affected recording must be present after accept');
          // The affected recording equals the incoming version.
          assert.deepStrictEqual(appliedRecording, m.incoming);
          assert.equal(
            digestRecording(appliedRecording),
            digestRecording(m.incoming),
            'affected recording digest must equal the incoming digest',
          );
        } else {
          // The whole project equals the incoming version.
          assert.deepStrictEqual(appliedProject, m.incoming);
        }

        // The applied project as a whole equals the independently-computed
        // adopted state.
        assert.deepStrictEqual(appliedProject, m.expectedAccepted);

        // ── baseline advanced PER-UNIT to the incoming
        //    (resolved-against) version, NOT to the adopted local state ──────
        const baseline = getBaseline(state, m.project_id);
        assert.ok(baseline, 'baseline must exist after a successful accept');

        // The full per-unit baseline equals the independently-computed expected
        // agreed state: the target entry is the incoming version and every other
        // entry is exactly what it was before (untouched).
        assert.deepStrictEqual(
          baseline.agreedState,
          m.expectedBaselineAgreed,
          'baseline must advance per-unit to the resolved-against incoming version',
        );
        assert.equal(
          baseline.digest,
          digestProject(m.expectedBaselineAgreed),
          'baseline digest must equal the per-unit advanced agreed-state digest',
        );

        if (m.level === 'recording') {
          // the affected recording's baseline entry is the incoming version.
          assert.equal(
            getRecordingBaselineDigest(baseline, m.recording_id),
            digestRecording(m.incoming),
            'affected recording baseline entry must equal the incoming version',
          );

          // sibling baseline entries are untouched. When a stale baseline
          // was seeded, each sibling's baseline entry still equals its prior
          // AGREED version (and NOT the changed local version), proving the
          // accept never advanced the whole-project baseline to the local state.
          if (m.seededBaseline) {
            for (const baselineSibling of m.seededBaseline.recordings) {
              if (baselineSibling.recording_id === m.recording_id) continue;
              assert.equal(
                getRecordingBaselineDigest(baseline, baselineSibling.recording_id),
                digestRecording(baselineSibling),
                'sibling baseline entry must be left untouched',
              );
            }
          }
        } else {
          // Project-level: the whole project baseline is the incoming project.
          assert.deepStrictEqual(baseline.agreedState, m.incoming);
        }

        // ── Nothing else is disturbed ──────────────────────────────────────
        // Sibling recordings in the affected project (local data) are untouched.
        if (m.level === 'recording') {
          for (const sibling of m.siblings) {
            const stillThere = appliedProject.recordings.find(
              (r) => r.recording_id === sibling.recording_id,
            );
            assert.deepStrictEqual(stillThere, sibling, 'sibling recordings must be untouched');
          }
        }
        // Every other local project is byte-identical.
        for (const other of m.others) {
          const otherProject = findProject(result.projects, other.id);
          const expectedOther = findProject(m.localProjects, other.id);
          assert.deepStrictEqual(otherProject, expectedOther, 'other projects must be untouched');
        }
        // The input projects array is not mutated in place.
        assert.deepStrictEqual(
          m.localProjects,
          inputSnapshot,
          'input projects must not be mutated',
        );
      }),
      { numRuns: 200 },
    );
  });

  it('accepting a recording-level review advances ONLY the target baseline entry, never a locally-changed sibling (regression example)', () => {
    // Prior AGREED baseline: target rec-1 and sibling rec-2 both at their agreed
    // versions.
    const baselineProject = {
      project_id: 'proj-1',
      name: 'Checkout',
      created_at: FIXED_CREATED_AT,
      recordings: [
        {
          recording_id: 'rec-1',
          name: 'Add to cart (agreed)',
          created_at: FIXED_CREATED_AT,
          steps: [{ uuid: 'u1', logical_id: 'a', step_number: 0, deleted: false }],
        },
        {
          recording_id: 'rec-2',
          name: 'Sibling (agreed)',
          created_at: FIXED_CREATED_AT,
          steps: [{ uuid: 'u9', logical_id: 'b', step_number: 0, deleted: false }],
        },
      ],
    };
    // Local state: target rec-1 unchanged since baseline; sibling rec-2 has been
    // edited LOCALLY (so it differs from its baseline entry).
    const localProject = {
      project_id: 'proj-1',
      name: 'Checkout',
      created_at: FIXED_CREATED_AT,
      recordings: [
        {
          recording_id: 'rec-1',
          name: 'Add to cart (agreed)',
          created_at: FIXED_CREATED_AT,
          steps: [{ uuid: 'u1', logical_id: 'a', step_number: 0, deleted: false }],
        },
        {
          recording_id: 'rec-2',
          name: 'Sibling (LOCALLY EDITED)',
          created_at: FIXED_CREATED_AT,
          steps: [
            { uuid: 'u9', logical_id: 'b', step_number: 0, deleted: false },
            { uuid: 'u10', logical_id: 'b', step_number: 1, deleted: false },
          ],
        },
      ],
    };
    const incoming = {
      recording_id: 'rec-1',
      name: 'Add to cart (server)',
      created_at: FIXED_CREATED_AT,
      steps: [
        { uuid: 'u1', logical_id: 'a', step_number: 0, deleted: false },
        { uuid: 'u2', logical_id: 'a', step_number: 0, deleted: false },
      ],
    };

    const state = createEmptySyncState();
    advanceBaseline(state, 'proj-1', baselineProject, FIXED_NOW);
    upsertReview(state, 'proj-1:rec-1', incoming, FIXED_NOW);

    const result = acceptReview(state, [localProject], 'proj-1:rec-1', { now: FIXED_NOW });

    assert.equal(result.ok, true);
    assert.equal(result.item.status, 'APPLIED');
    assert.equal(getItem(state, 'proj-1:rec-1'), null);

    // the incoming change is applied; the sibling local data is untouched.
    const applied = result.projects[0].recordings.find((r) => r.recording_id === 'rec-1');
    assert.deepStrictEqual(applied, incoming);
    assert.deepStrictEqual(
      result.projects[0].recordings.find((r) => r.recording_id === 'rec-2'),
      localProject.recordings[1],
    );

    const baseline = getBaseline(state, 'proj-1');
    // the target's baseline entry is advanced to the incoming version.
    assert.equal(getRecordingBaselineDigest(baseline, 'rec-1'), digestRecording(incoming));
    // the sibling's baseline entry is UNCHANGED: still the agreed version,
    // and crucially NOT the locally-edited version. The old whole-project rule
    // would have set it to the local sibling, wrongly marking it agreed.
    assert.equal(
      getRecordingBaselineDigest(baseline, 'rec-2'),
      digestRecording(baselineProject.recordings[1]),
    );
    assert.notEqual(
      getRecordingBaselineDigest(baseline, 'rec-2'),
      digestRecording(localProject.recordings[1]),
    );
  });

  it('accepting a project-level review for an absent local project adds it and advances the whole baseline to the incoming project (regression example)', () => {
    const incoming = {
      project_id: 'proj-new',
      name: 'Incoming Project',
      created_at: FIXED_CREATED_AT,
      recordings: [],
    };

    const state = createEmptySyncState();
    upsertReview(state, 'proj-new', incoming, FIXED_NOW);

    const result = acceptReview(state, [], 'proj-new', { now: FIXED_NOW });

    assert.equal(result.ok, true);
    assert.equal(result.item.status, 'APPLIED');
    assert.deepStrictEqual(findProject(result.projects, 'proj-new'), incoming);

    const baseline = getBaseline(state, 'proj-new');
    // a project-level accept advances the whole project baseline to the
    // resolved-against incoming project.
    assert.deepStrictEqual(baseline.agreedState, incoming);
    assert.equal(baseline.digest, digestProject(incoming));
  });
});
