/**
 * digest-unrecognized-fields.property.test.js — Property test for digest
 * stability against unrecognized top-level server fields.
 *
 * The Conflict_Detector's notion of content identity is computed over an
 * allowlisted, canonicalized projection (`digestProject` / `digestRecording` in
 * `sync-digest.js`). Any top-level field the server returns that is not on that
 * allowlist — `last_modified` today, or a future optional concurrency-control
 * token — must be dropped before hashing, so it can never shift content identity
 * and break clients built against this contract.
 *
 * Uses Node.js built-in test runner + fast-check.
 */

// Unrecognized server fields do not affect behavior

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { digestProject, digestRecording } from '../../sync-digest.js';

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

describe('Unrecognized server fields do not affect behavior', () => {
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
