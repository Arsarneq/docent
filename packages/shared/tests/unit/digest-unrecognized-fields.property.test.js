/**
 * digest-unrecognized-fields.property.test.js — Property tests for what the
 * digest projection admits: no unlisted field, and no invented listed one.
 *
 * The Conflict_Detector's notion of content identity is computed over an
 * allowlisted, canonicalized projection (`digestProject` / `digestRecording` in
 * `sync-digest.js`), and both complements of that allowlist matter.
 *
 * Outward: any top-level field the server returns that is not on the allowlist —
 * `last_modified` today, or a future optional concurrency-control token — must be
 * dropped before hashing, so it can never shift content identity and break
 * clients built against this contract.
 *
 * Inward: an allowlisted field's PRESENCE is copied, never defaulted — absent
 * stays absent and empty stays empty — while the values themselves are
 * canonicalized, which is what makes equal content compare equal regardless of
 * key order. An absent `metadata` and an empty one are therefore distinct inputs
 * (sync-protocol SP-9), so a client that materializes one into the other before
 * comparing reads a round-tripped unit as changed.
 *
 * Uses Node.js built-in test runner + fast-check.
 */

// The digest projection admits no unlisted field, and invents no listed one

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { digestProject, digestProjectMetadata, digestRecording } from '../../sync-digest.js';

// The explicit field allowlists the digest projects over. Any top-level field
// NOT in these sets must be dropped before hashing.
const RECORDING_ALLOWLIST = new Set(['recording_id', 'name', 'created_at', 'metadata', 'steps']);
const PROJECT_ALLOWLIST = new Set(['project_id', 'name', 'created_at', 'metadata', 'recordings']);

// ─── Generators ──────────────────────────────────────────────────────────────

const arbId = fc.uuid();

/** A step record with controlled logical_id reuse so tombstones/re-records arise. */
const arbStep = fc.record({
  uuid: arbId,
  logical_id: fc.constantFrom('a', 'b', 'c'),
  step_number: fc.integer({ min: 0, max: 20 }),
  actions: fc.array(
    fc.record({ type: fc.constantFrom('click', 'type', 'nav'), value: fc.string() }),
    { maxLength: 3 },
  ),
  deleted: fc.boolean(),
});

/** A recording projected over the allowlist (metadata optional, full step history). */
const arbRecording = fc.record(
  {
    recording_id: arbId,
    name: fc.string({ maxLength: 30 }),
    created_at: fc
      .date({ min: new Date('2020-01-01'), max: new Date('2030-01-01'), noInvalidDate: true })
      .map((d) => d.toISOString()),
    metadata: fc.option(fc.dictionary(fc.string({ minLength: 1, maxLength: 6 }), fc.jsonValue()), {
      nil: undefined,
    }),
    steps: fc.array(arbStep, { maxLength: 6 }),
  },
  { requiredKeys: ['recording_id', 'name', 'created_at', 'steps'] },
);

/** A project projected over the allowlist with an ordered list of recordings. */
const arbProject = fc.record(
  {
    project_id: arbId,
    name: fc.string({ maxLength: 30 }),
    created_at: fc
      .date({ min: new Date('2020-01-01'), max: new Date('2030-01-01'), noInvalidDate: true })
      .map((d) => d.toISOString()),
    metadata: fc.option(fc.dictionary(fc.string({ minLength: 1, maxLength: 6 }), fc.jsonValue()), {
      nil: undefined,
    }),
    recordings: fc.array(arbRecording, { maxLength: 4 }),
  },
  { requiredKeys: ['project_id', 'name', 'created_at', 'recordings'] },
);

/**
 * `arbServerExtraFields` — arbitrary UNRECOGNIZED top-level fields. Always
 * includes `last_modified` (a real, unreliable server field content
 * classification disregards — sync-protocol SP-9) so every iteration is
 * non-trivial, plus an arbitrary dictionary of other
 * keys with any keys that collide with the allowlist filtered out — those would
 * legitimately change identity and are not "unrecognized".
 */
function arbServerExtraFields(allowlist) {
  return fc
    .dictionary(fc.string({ minLength: 1, maxLength: 8 }), fc.jsonValue(), { maxKeys: 5 })
    .map((extra) => {
      const cleaned = {};
      for (const key of Object.keys(extra)) {
        if (!allowlist.has(key)) cleaned[key] = extra[key];
      }
      // Guarantee at least one unrecognized field every iteration.
      cleaned.last_modified = '2024-06-01T12:00:00.000Z';
      return cleaned;
    });
}

describe('The digest projection admits no unlisted field, and invents no listed one', () => {
  it('augmenting a recording with arbitrary unrecognized top-level fields does not change its digest', () => {
    fc.assert(
      fc.property(arbRecording, arbServerExtraFields(RECORDING_ALLOWLIST), (recording, extra) => {
        const augmented = { ...recording, ...extra };
        assert.equal(digestRecording(augmented), digestRecording(recording));
      }),
      { numRuns: 200 },
    );
  });

  it('augmenting a project (and its recordings) with unrecognized top-level fields does not change its digest', () => {
    fc.assert(
      fc.property(
        arbProject,
        arbServerExtraFields(PROJECT_ALLOWLIST),
        arbServerExtraFields(RECORDING_ALLOWLIST),
        (project, projectExtra, recordingExtra) => {
          const augmented = {
            ...project,
            ...projectExtra,
            recordings: project.recordings.map((r) => ({ ...r, ...recordingExtra })),
          };
          assert.equal(digestProject(augmented), digestProject(project));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('an absent metadata and an empty one are distinct digest inputs', () => {
    // The sync protocol states this as part of what classification compares
    // (sync-protocol SP-9): the digest copies an allowlisted field's presence
    // rather than defaulting it, so a client that materializes an absent
    // `metadata` into an empty one before comparing reads a round-tripped unit
    // as changed. Values are canonicalized either way — key order never shifts
    // identity, which is this suite's other half. The property generators
    // above draw metadata from `fc.option(fc.dictionary(...))`, which reaches
    // `{}` only by chance, so the fact the specification now asserts gets a
    // deterministic case of its own rather than an incidental one.
    const base = {
      recording_id: 'rec-1',
      name: 'Login flow',
      created_at: '2024-01-01T00:00:00.000Z',
      steps: [],
    };
    const withEmpty = { ...base, metadata: {} };

    assert.notEqual(
      digestRecording(base),
      digestRecording(withEmpty),
      'absent and empty recording metadata must not collapse to one digest',
    );
    assert.equal(
      digestRecording(base),
      digestRecording({ ...base }),
      'control: the same shape digests identically, so the inequality above is meaningful',
    );

    // The same presence-copy rule holds at every digest that projects a
    // metadata field: the project digest and the project-metadata unit digest
    // (the digest the Conflict_Detector classifies a project-scoped metadata
    // change on) each keep absent and empty distinct.
    const projectBase = {
      project_id: 'proj-1',
      name: 'Demo',
      created_at: '2024-01-01T00:00:00.000Z',
      recordings: [],
    };
    const projectWithEmpty = { ...projectBase, metadata: {} };

    assert.notEqual(
      digestProject(projectBase),
      digestProject(projectWithEmpty),
      'absent and empty project metadata must not collapse to one digest',
    );
    assert.equal(
      digestProject(projectBase),
      digestProject({ ...projectBase }),
      'control: the same project shape digests identically',
    );

    assert.notEqual(
      digestProjectMetadata(projectBase),
      digestProjectMetadata(projectWithEmpty),
      'absent and empty metadata must stay distinct in the project-metadata unit digest',
    );
    assert.equal(
      digestProjectMetadata(projectBase),
      digestProjectMetadata({ ...projectBase }),
      'control: the same project shape yields the same project-metadata unit digest',
    );
  });

  it('the same content in two key insertion orders digests identically', () => {
    // The value half of the presence pin above (sync-protocol SP-9): an
    // allowlisted field's value is canonicalized — sync-digest.js's
    // `canonicalize` emits object keys sorted at every depth — so equal
    // content digests equal no matter what order its keys were inserted in.
    // Insertion order varies here at every depth a value passes through: the
    // metadata maps, a step record, and an action object.
    const stepA = {
      uuid: 'u1',
      logical_id: 'a',
      step_number: 0,
      actions: [{ type: 'click', value: 'ok' }],
      deleted: false,
    };
    const stepB = {
      deleted: false,
      actions: [{ value: 'ok', type: 'click' }],
      step_number: 0,
      logical_id: 'a',
      uuid: 'u1',
    };
    const recordingA = {
      recording_id: 'rec-1',
      name: 'Login flow',
      created_at: '2024-01-01T00:00:00.000Z',
      metadata: { env: 'prod', region: 'eu' },
      steps: [stepA],
    };
    const recordingB = {
      steps: [stepB],
      metadata: { region: 'eu', env: 'prod' },
      created_at: '2024-01-01T00:00:00.000Z',
      name: 'Login flow',
      recording_id: 'rec-1',
    };
    assert.equal(
      digestRecording(recordingA),
      digestRecording(recordingB),
      'a recording digest must not depend on key insertion order',
    );

    const projectA = {
      project_id: 'proj-1',
      name: 'Demo',
      created_at: '2024-01-01T00:00:00.000Z',
      metadata: { team: 'qa', owner: 'ops' },
      recordings: [recordingA],
    };
    const projectB = {
      recordings: [recordingB],
      metadata: { owner: 'ops', team: 'qa' },
      created_at: '2024-01-01T00:00:00.000Z',
      name: 'Demo',
      project_id: 'proj-1',
    };
    assert.equal(
      digestProject(projectA),
      digestProject(projectB),
      'a project digest must not depend on key insertion order',
    );

    // Controls: every depth this case reorders is part of identity — a changed
    // value at each moves the digest — so the equalities above compare content
    // the digest reads, not content it dropped.
    assert.notEqual(
      digestRecording(recordingA),
      digestRecording({ ...recordingA, metadata: { env: 'prod', region: 'us' } }),
      'control: a changed recording metadata value moves the digest',
    );
    assert.notEqual(
      digestProject(projectA),
      digestProject({ ...projectA, metadata: { team: 'qa', owner: 'eng' } }),
      'control: a changed project metadata value moves the digest',
    );
    assert.notEqual(
      digestRecording(recordingA),
      digestRecording({
        ...recordingA,
        steps: [{ ...stepA, actions: [{ type: 'click', value: 'no' }] }],
      }),
      'control: a changed action value moves the digest',
    );
    assert.notEqual(
      digestRecording(recordingA),
      digestRecording({ ...recordingA, steps: [{ ...stepA, deleted: true }] }),
      'control: a flipped step tombstone moves the digest',
    );
  });

  it('a concrete last_modified / version token does not shift identity (regression example)', () => {
    const recording = {
      recording_id: 'rec-1',
      name: 'Login flow',
      created_at: '2024-01-01T00:00:00.000Z',
      steps: [{ uuid: 'u1', logical_id: 'a', step_number: 0, actions: [], deleted: false }],
    };
    const project = {
      project_id: 'proj-1',
      name: 'Demo',
      created_at: '2024-01-01T00:00:00.000Z',
      recordings: [recording],
    };

    const augmentedRecording = { ...recording, last_modified: 'whenever', _etag: 'v9' };
    const augmentedProject = {
      ...project,
      last_modified: 'whenever',
      version_token: 42,
      recordings: [augmentedRecording],
    };

    assert.equal(digestRecording(augmentedRecording), digestRecording(recording));
    assert.equal(digestProject(augmentedProject), digestProject(project));
  });
});
