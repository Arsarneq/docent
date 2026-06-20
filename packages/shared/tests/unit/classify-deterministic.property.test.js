/**
 * classify-deterministic.property.test.js — Property test that graded
 * classification (the Conflict_Detector) is DETERMINISTIC, SETTINGS-INDEPENDENT,
 * and free of any user-input or I/O interaction.
 *
 * Classification is the safe-vs-ask decision point of the whole feature, and the
 * design requires it to be a PURE function of its data inputs:
 *
 *   - DETERMINISTIC — calling `classifyProject` (and the shared core
 *     `classifyUnit`) repeatedly on the same inputs yields byte-for-byte
 *     identical results, independent of call count or ambient environment.
 * Because the function depends only on its arguments and never on
 *     platform globals, the same sequence of inputs classifies identically on
 *     the Chrome extension and the desktop app.
 *
 *   - SETTINGS-INDEPENDENT — the classifier returns the bare `ClassKind`; the
 *     reconciliation-policy settings (Auto-Accept-Updates / Auto-Accept-Deletions
 *     and the rest of {@link ReconciliationSettings}) are applied by the
 *     ORCHESTRATOR, never by the detector, so the detector stays pure and
 *     platform-independent. Its public contract takes only data
 *     — `classifyProject(local, incoming, baseline, lockedRecordingIds)` and
 *     `classifyUnit(digestLocal, digestIncoming, digestBaseline, locked)` — with
 *     no settings parameter. We demonstrate this two ways: (a) classification is
 *     unchanged across every Auto-Accept-* setting combination threaded in as an
 *     ignored trailing argument; and (b) a settings "probe" whose every policy
 *     field throws-on-read is never touched, proving the classifier reads no
 *     setting even when one is handed to it.
 *
 *   - FREE OF USER/IO INTERACTION — classification invokes no user-input prompt
 *     and performs no I/O (no `fetch`, no `prompt`/`confirm`), and never mutates
 *     its arguments. We demonstrate this three ways: (a) installing throwing/
 *     recording sentinels over the global I/O and user-input surfaces and
 *     asserting none are touched; (b) deep-FREEZING every input and asserting the
 *     call neither throws (an in-place mutation would throw in ES-module strict
 *     mode) nor changes the inputs; and (c) snapshotting the canonical content of
 *     the inputs before and after and asserting equality.
 *
 * Uses the Node.js built-in test runner + fast-check (fast-check v4: `fc.uuid()`
 * for ids), mirroring the generators in classify-decision-table.property.test.js.
 *
 */

// Classification is deterministic and free of user/IO interaction

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { classifyProject, classifyUnit } from '../../conflict-detector.js';
import { digestProject } from '../../sync-digest.js';

// ─── Generators (mirroring the decision-table test) ───────────────

// Digest symbols (plus null for absence) so every equality relationship between
// local, incoming and baseline arises frequently in the classifyUnit lattice.
const arbDigest = fc.constantFrom(null, 'A', 'B', 'C');

// Content variants used to build recordings/projects whose digests are equal iff
// the (id, variant) are equal — lets `classifyProject` compute real digests.
const arbVariant = fc.constantFrom('1', '2', '3');

const FIXED_CREATED_AT = '2024-01-01T00:00:00.000Z';

/** Build a recording whose digest is a deterministic function of (id, variant). */
function buildRecording(recording_id, variant) {
  return {
    recording_id,
    name: `rec-name-${variant}`,
    created_at: FIXED_CREATED_AT,
    steps: [
      { uuid: `uuid-${variant}`, logical_id: 'a', step_number: 0, actions: [], deleted: false },
    ],
  };
}

/** Build a project from a name variant and an ordered list of recordings. */
function buildProject(project_id, nameVariant, recordings) {
  return {
    project_id,
    name: `proj-name-${nameVariant}`,
    created_at: FIXED_CREATED_AT,
    recordings,
  };
}

// One recording "slot": a shared recording_id with an independently-chosen
// variant (or absent) per side, plus whether it is locked.
const arbSlot = fc.record({
  recording_id: fc.uuid(),
  local: fc.option(arbVariant, { nil: null }),
  incoming: fc.option(arbVariant, { nil: null }),
  baseline: fc.option(arbVariant, { nil: null }),
  locked: fc.boolean(),
});

// A whole scenario: shared project_id, per-side project presence, per-side
// project-name variant, and a set of recording slots with unique recording_ids.
const arbScenario = fc.record({
  project_id: fc.uuid(),
  localPresent: fc.boolean(),
  incomingPresent: fc.boolean(),
  baselinePresent: fc.boolean(),
  projNameLocal: arbVariant,
  projNameIncoming: arbVariant,
  projNameBaseline: arbVariant,
  slots: fc.uniqueArray(arbSlot, {
    selector: (s) => s.recording_id,
    minLength: 0,
    maxLength: 3,
  }),
});

// Every combination of the reconciliation-policy settings. The classifier
// must IGNORE these entirely — they are applied by the orchestrator, not the
// detector (design §"the policy settings are applied by the orchestrator")
// — so they are only ever threaded in to prove they make no difference.
const arbSettings = fc.record({
  autoAcceptUpdates: fc.boolean(),
  autoAcceptDeletions: fc.boolean(),
  autoSync: fc.boolean(),
});

/** Materialize a scenario into (local, incoming, baseline, lockedRecordingIds). */
function materialize(scenario) {
  const {
    project_id,
    localPresent,
    incomingPresent,
    baselinePresent,
    projNameLocal,
    projNameIncoming,
    projNameBaseline,
    slots,
  } = scenario;

  const recsFor = (side) =>
    slots.filter((s) => s[side] != null).map((s) => buildRecording(s.recording_id, s[side]));

  const local = localPresent ? buildProject(project_id, projNameLocal, recsFor('local')) : null;
  const incoming = incomingPresent
    ? buildProject(project_id, projNameIncoming, recsFor('incoming'))
    : null;
  const baselineProject = baselinePresent
    ? buildProject(project_id, projNameBaseline, recsFor('baseline'))
    : null;
  const baseline = baselineProject
    ? { digest: digestProject(baselineProject), agreedState: baselineProject }
    : null;

  const lockedRecordingIds = new Set(slots.filter((s) => s.locked).map((s) => s.recording_id));

  return { local, incoming, baseline, lockedRecordingIds };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Recursively deep-freeze a plain object/array graph (Sets/primitives left as-is). */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Set) {
    // Freezing the Set object is enough: classification only reads it (`.has`).
    return Object.freeze(value);
  }
  for (const key of Object.keys(value)) {
    deepFreeze(value[key]);
  }
  return Object.freeze(value);
}

/** Stable, key-order-independent snapshot of an input, used to detect mutation. */
function snapshot(value) {
  if (value instanceof Set) return JSON.stringify([...value].sort());
  return JSON.stringify(value);
}

/**
 * A settings object whose every policy field throws the moment it is READ. If the
 * classifier ever consults a reconciliation-policy setting (which it must
 * not), accessing it here throws and fails the property. The id-style fields a
 * classifier legitimately reads are absent, so only an illegitimate settings read
 * can trip the trap.
 */
function makeThrowingSettingsProbe(touched) {
  const trap = (name) => ({
    get() {
      touched.push(name);
      throw new Error(`classification must not read settings (read "${name}")`);
    },
  });
  return Object.defineProperties(
    {},
    {
      autoAcceptUpdates: trap('autoAcceptUpdates'),
      autoAcceptDeletions: trap('autoAcceptDeletions'),
      autoSync: trap('autoSync'),
    },
  );
}

describe('Classification is deterministic and free of user/IO interaction', () => {
  it('classifyUnit is deterministic and settings-independent: repeated calls (and an ignored settings arg) yield identical results', () => {
    fc.assert(
      fc.property(
        arbDigest,
        arbDigest,
        arbDigest,
        fc.boolean(),
        arbSettings,
        (dl, di, db, locked, settings) => {
          const first = classifyUnit(dl, di, db, locked);
          const second = classifyUnit(dl, di, db, locked);
          const third = classifyUnit(dl, di, db, locked);
          assert.equal(first, second);
          assert.equal(second, third);
          // The shared core takes no settings; threading one in as an extra arg
          // must not change the classification.
          assert.equal(classifyUnit(dl, di, db, locked, settings), first);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('classifyProject is deterministic: repeated calls on identical inputs yield deep-equal results', () => {
    fc.assert(
      fc.property(arbScenario, (scenario) => {
        const { local, incoming, baseline, lockedRecordingIds } = materialize(scenario);
        const first = classifyProject(local, incoming, baseline, lockedRecordingIds);
        const second = classifyProject(local, incoming, baseline, lockedRecordingIds);
        const third = classifyProject(local, incoming, baseline, lockedRecordingIds);
        // Stable RESULTS: identical content and identical ordering across calls.
        assert.deepEqual(second, first);
        assert.deepEqual(third, first);
      }),
      { numRuns: 200 },
    );
  });

  it('classifyProject is settings-independent: result is identical across every reconciliation-policy setting combination', () => {
    // The classifier returns the bare ClassKind; the orchestrator (not the
    // detector) applies the Auto-Accept-* policy. Threading any settings
    // combination in as an ignored trailing argument must not change the
    // classification, so the same inputs classify identically regardless of the
    // client-local policy.
    fc.assert(
      fc.property(arbScenario, arbSettings, arbSettings, (scenario, settingsA, settingsB) => {
        const { local, incoming, baseline, lockedRecordingIds } = materialize(scenario);
        // Reference: the documented 4-arg contract, with no settings at all.
        const reference = classifyProject(local, incoming, baseline, lockedRecordingIds);
        // Same inputs, two different settings objects passed as an extra arg the
        // pure classifier must ignore.
        const withA = classifyProject(local, incoming, baseline, lockedRecordingIds, settingsA);
        const withB = classifyProject(local, incoming, baseline, lockedRecordingIds, settingsB);
        assert.deepEqual(withA, reference, 'classification changed under settings A');
        assert.deepEqual(withB, reference, 'classification changed under settings B');
      }),
      { numRuns: 200 },
    );
  });

  it('classifyProject reads no reconciliation-policy setting even when one is supplied', () => {
    // Hand the classifier a settings object whose every policy field throws on
    // read. If classification consults any setting, the getter throws and the
    // property fails; surviving proves the detector never reads settings.
    fc.assert(
      fc.property(arbScenario, (scenario) => {
        const { local, incoming, baseline, lockedRecordingIds } = materialize(scenario);
        const touched = [];
        const probe = makeThrowingSettingsProbe(touched);
        // Must not throw: the classifier must not touch any settings field.
        const result = classifyProject(local, incoming, baseline, lockedRecordingIds, probe);
        const reference = classifyProject(local, incoming, baseline, lockedRecordingIds);
        assert.deepEqual(touched, [], `classifier read a setting: ${JSON.stringify(touched)}`);
        assert.deepEqual(result, reference);
      }),
      { numRuns: 200 },
    );
  });

  it('classifyProject does not mutate its arguments (pure: no in-place side effects)', () => {
    fc.assert(
      fc.property(arbScenario, (scenario) => {
        const { local, incoming, baseline, lockedRecordingIds } = materialize(scenario);

        const beforeLocal = snapshot(local);
        const beforeIncoming = snapshot(incoming);
        const beforeBaseline = snapshot(baseline);
        const beforeLocked = snapshot(lockedRecordingIds);

        classifyProject(local, incoming, baseline, lockedRecordingIds);

        // No argument was mutated by the call.
        assert.equal(snapshot(local), beforeLocal, 'local was mutated');
        assert.equal(snapshot(incoming), beforeIncoming, 'incoming was mutated');
        assert.equal(snapshot(baseline), beforeBaseline, 'baseline was mutated');
        assert.equal(snapshot(lockedRecordingIds), beforeLocked, 'lockedRecordingIds was mutated');
      }),
      { numRuns: 200 },
    );
  });

  it('classifyProject runs over deeply-frozen inputs without throwing (no attempted mutation)', () => {
    // In ES-module strict mode, any attempt to write a frozen property throws a
    // TypeError. Surviving a fully-frozen input graph proves the function never
    // tries to mutate its arguments — a stronger form of the purity guarantee.
    fc.assert(
      fc.property(arbScenario, (scenario) => {
        const { local, incoming, baseline, lockedRecordingIds } = materialize(scenario);
        deepFreeze(local);
        deepFreeze(incoming);
        deepFreeze(baseline);
        deepFreeze(lockedRecordingIds);

        const frozenResult = classifyProject(local, incoming, baseline, lockedRecordingIds);
        // Frozen inputs still produce the same classification as unfrozen copies.
        const unfrozen = materialize(scenario);
        const refResult = classifyProject(
          unfrozen.local,
          unfrozen.incoming,
          unfrozen.baseline,
          unfrozen.lockedRecordingIds,
        );
        assert.deepEqual(frozenResult, refResult);
      }),
      { numRuns: 200 },
    );
  });

  it('classifyProject invokes no user-input prompt and performs no I/O', () => {
    // Install recording sentinels over the global I/O and user-input surfaces a
    // classifier might (but must not) reach for. Classification must complete
    // without touching any of them.
    const calls = [];
    const had = {
      fetch: 'fetch' in globalThis,
      prompt: 'prompt' in globalThis,
      confirm: 'confirm' in globalThis,
    };
    const original = {
      fetch: globalThis.fetch,
      prompt: globalThis.prompt,
      confirm: globalThis.confirm,
    };
    globalThis.fetch = (...args) => {
      calls.push(['fetch', args]);
      throw new Error('classification must not perform I/O (fetch)');
    };
    globalThis.prompt = (...args) => {
      calls.push(['prompt', args]);
      throw new Error('classification must not request user input (prompt)');
    };
    globalThis.confirm = (...args) => {
      calls.push(['confirm', args]);
      throw new Error('classification must not request user input (confirm)');
    };

    try {
      fc.assert(
        fc.property(arbScenario, (scenario) => {
          const { local, incoming, baseline, lockedRecordingIds } = materialize(scenario);
          classifyProject(local, incoming, baseline, lockedRecordingIds);
          classifyUnit('A', 'B', 'C', false);
        }),
        { numRuns: 150 },
      );
    } finally {
      // Restore the originals so we don't leak sentinels into other tests.
      if (had.fetch) globalThis.fetch = original.fetch;
      else delete globalThis.fetch;
      if (had.prompt) globalThis.prompt = original.prompt;
      else delete globalThis.prompt;
      if (had.confirm) globalThis.confirm = original.confirm;
      else delete globalThis.confirm;
    }

    assert.deepEqual(
      calls,
      [],
      `classification touched I/O or user-input hooks: ${JSON.stringify(calls)}`,
    );
  });

  it('classification is independent of ambient platform globals (cross-platform parity)', () => {
    // Result depends ONLY on the data inputs, never on the surrounding platform.
    // Simulate the extension vs desktop environments by toggling ambient globals
    // between calls and asserting the classification is unchanged.
    fc.assert(
      fc.property(arbScenario, (scenario) => {
        const a = materialize(scenario);
        const extResult = classifyProject(a.local, a.incoming, a.baseline, a.lockedRecordingIds);

        const hadChrome = 'chrome' in globalThis;
        const originalChrome = globalThis.chrome;
        globalThis.chrome = { runtime: { id: 'fake-extension' } }; // pretend Chrome extension
        let deskResult;
        try {
          const b = materialize(scenario);
          deskResult = classifyProject(b.local, b.incoming, b.baseline, b.lockedRecordingIds);
        } finally {
          if (hadChrome) globalThis.chrome = originalChrome;
          else delete globalThis.chrome;
        }

        assert.deepEqual(deskResult, extResult);
      }),
      { numRuns: 150 },
    );
  });
});
