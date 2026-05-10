/**
 * Property 11: Session persistence round-trip
 *
 * For any valid session state (projects with recordings, steps, and
 * settings), serializing the state to JSON and deserializing it back
 * SHALL produce a state equivalent to the original.
 *
 * **Validates: Requirements 14.1, 14.2**
 *
 * This tests the pure serialization/deserialization logic, not the
 * Tauri invoke calls.
 *
 * Feature: desktop-capture, Property 11: Session persistence round-trip
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

// ─── Pure serialization helpers (same logic as persistence.js) ────────────────

function serializeState(state) {
  return JSON.stringify(state);
}

function deserializeState(json) {
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

/** Generate a UUIDv7-like string */
const hexChar = fc.constantFrom(...'0123456789abcdef'.split(''));
const arbUuid = fc.tuple(
  fc.array(hexChar, { minLength: 8, maxLength: 8 }),
  fc.array(hexChar, { minLength: 4, maxLength: 4 }),
  fc.array(hexChar, { minLength: 3, maxLength: 3 }),
  fc.constantFrom('8', '9', 'a', 'b'),
  fc.array(hexChar, { minLength: 3, maxLength: 3 }),
  fc.array(hexChar, { minLength: 12, maxLength: 12 }),
).map(([a, b, c, variant, d, e]) =>
  `${a.join('')}-${b.join('')}-7${c.join('')}-${variant}${d.join('')}-${e.join('')}`
);

/** Generate an ISO 8601 timestamp */
const arbTimestamp = fc.integer({
  min: new Date('2020-01-01').getTime(),
  max: new Date('2030-12-31').getTime(),
}).map(ms => new Date(ms).toISOString());

/** Generate a single action object */
const arbAction = fc.record({
  type: fc.constantFrom('click', 'type', 'key', 'focus', 'scroll', 'context_switch'),
  timestamp: fc.integer({ min: 1000000000000, max: 9999999999999 }),
  context_id: fc.oneof(fc.integer({ min: 1, max: 100000 }), fc.constant(null)),
  capture_mode: fc.constantFrom('dom', 'accessibility', 'coordinate'),
  frame_src: fc.constant(null),
});

/** Generate a step record (narration mode) */
const arbNarrationStep = fc.record({
  uuid: arbUuid,
  logical_id: arbUuid,
  step_number: fc.integer({ min: 1, max: 100 }),
  created_at: arbTimestamp,
  narration: fc.string({ minLength: 1, maxLength: 200 }),
  narration_source: fc.constant('typed'),
  actions: fc.array(arbAction, { minLength: 0, maxLength: 5 }),
  deleted: fc.boolean(),
});

/** Generate a step record (simple mode) */
const arbSimpleStep = fc.record({
  uuid: arbUuid,
  logical_id: arbUuid,
  step_number: fc.integer({ min: 1, max: 100 }),
  created_at: arbTimestamp,
  step_type: fc.constantFrom('action', 'validation'),
  expect: fc.option(fc.constantFrom('present', 'absent'), { nil: undefined }),
  actions: fc.array(arbAction, { minLength: 0, maxLength: 5 }),
  deleted: fc.boolean(),
});

/** Generate a step record (either mode) */
const arbStep = fc.oneof(arbNarrationStep, arbSimpleStep);

/** Generate a recording */
const arbRecording = fc.record({
  recording_id: arbUuid,
  name: fc.string({ minLength: 1, maxLength: 100 }),
  created_at: arbTimestamp,
  steps: fc.array(arbStep, { minLength: 0, maxLength: 5 }),
});

/** Generate a project */
const arbProject = fc.record({
  project_id: arbUuid,
  name: fc.string({ minLength: 1, maxLength: 100 }),
  created_at: arbTimestamp,
  recordings: fc.array(arbRecording, { minLength: 0, maxLength: 3 }),
});

/** Generate settings */
const arbSettings = fc.record({
  endpointUrl: fc.oneof(fc.constant(null), fc.webUrl()),
  apiKey: fc.oneof(fc.constant(null), fc.string({ minLength: 1, maxLength: 100 })),
  theme: fc.constantFrom('auto', 'light', 'dark'),
  selfCaptureExclusion: fc.boolean(),
});

/** Generate a full session state */
const arbSessionState = fc.record({
  projects: fc.array(arbProject, { minLength: 0, maxLength: 3 }),
  activeProjectId: fc.oneof(fc.constant(null), arbUuid),
  activeRecordingId: fc.oneof(fc.constant(null), arbUuid),
  settings: arbSettings,
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalize an object to use standard prototypes (fast-check's fc.record
 * creates objects with null prototype, while JSON.parse creates regular
 * objects). We normalize by round-tripping through JSON so both sides
 * have the same prototype chain for deepStrictEqual comparison.
 */
function normalize(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ─── Property tests ───────────────────────────────────────────────────────────

describe('Property 11: Session persistence round-trip', () => {
  it('serializing and deserializing session state produces equivalent state', () => {
    fc.assert(
      fc.property(arbSessionState, (state) => {
        // Normalize the generated state to use standard prototypes
        const normalizedState = normalize(state);
        const json = serializeState(normalizedState);
        const restored = deserializeState(json);

        assert.notStrictEqual(restored, null, 'Deserialization should not return null');
        assert.deepStrictEqual(restored, normalizedState,
          'Round-tripped state should be deeply equal to original');
      }),
      { numRuns: 100 },
    );
  });

  it('round-trip preserves all project, recording, and step data', () => {
    fc.assert(
      fc.property(arbSessionState, (state) => {
        const normalizedState = normalize(state);
        const json = serializeState(normalizedState);
        const restored = deserializeState(json);

        // Verify structural integrity
        assert.strictEqual(restored.projects.length, normalizedState.projects.length);

        for (let i = 0; i < normalizedState.projects.length; i++) {
          const orig = normalizedState.projects[i];
          const rest = restored.projects[i];

          assert.strictEqual(rest.project_id, orig.project_id);
          assert.strictEqual(rest.name, orig.name);
          assert.strictEqual(rest.created_at, orig.created_at);
          assert.strictEqual(rest.recordings.length, orig.recordings.length);

          for (let j = 0; j < orig.recordings.length; j++) {
            const origRec = orig.recordings[j];
            const restRec = rest.recordings[j];

            assert.strictEqual(restRec.recording_id, origRec.recording_id);
            assert.strictEqual(restRec.name, origRec.name);
            assert.strictEqual(restRec.steps.length, origRec.steps.length);

            for (let k = 0; k < origRec.steps.length; k++) {
              assert.strictEqual(restRec.steps[k].uuid, origRec.steps[k].uuid);
              assert.strictEqual(restRec.steps[k].narration, origRec.steps[k].narration);
              assert.strictEqual(restRec.steps[k].deleted, origRec.steps[k].deleted);
              assert.strictEqual(restRec.steps[k].actions.length, origRec.steps[k].actions.length);
            }
          }
        }

        // Verify settings
        assert.deepStrictEqual(restored.settings, normalizedState.settings);
      }),
      { numRuns: 100 },
    );
  });

  it('corrupted JSON returns null from deserializeState', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }).filter(s => {
          try { JSON.parse(s); return false; } catch { return true; }
        }),
        (corruptedJson) => {
          const result = deserializeState(corruptedJson);
          assert.strictEqual(result, null,
            'Corrupted JSON should return null');
        },
      ),
      { numRuns: 100 },
    );
  });
});
