/**
 * safeguard-composition.property.test.js — Property test that the existing sync
 * safeguards (stamp compatibility + schema validation + per-project error
 * isolation) compose with graded conflict handling WITHOUT any of them ever
 * being mistaken for a Conflict.
 *
 * The pull path layers two pre-existing safeguards in front of acceptance:
 *   1. **Stamp compatibility** — a pulled payload whose `docent_format` does not
 *      match this client's platform/schema version is skipped as a COMPATIBILITY
 *      issue and recorded in `mismatched`. It is never a failure and
 *      never a Conflict.
 *   2. **Schema validation** — a stamp-compatible payload that fails the platform
 *      validator is reported as an ERROR in `errors`. It is never a
 *      Conflict either.
 * Per-project errors are also isolated: a non-authentication failure for one
 * project (a network error or a non-401/403 HTTP status) does not stop the rest
 * of the cycle — the remaining projects are still processed.
 *
 * This property pins that the three safeguards COMPOSE over a large, mixed input
 * space. For ANY manifest mixing stamp-incompatible, schema-invalid, valid, and
 * (non-auth) erroring projects:
 *   - every stamp-incompatible project lands in `mismatched` (by name), and
 *   - every schema-invalid project lands in `errors`, and
 *   - every non-auth erroring project lands in `errors`, and
 *   - NONE of those three ever becomes a Conflict, a Review, or a retained
 *     Sync_Snapshot, and
 *   - every valid project is still processed (pulled + snapshotted), regardless
 *     of where the skips/errors fall in the manifest — proving the cycle
 *     continued past each per-project (non-auth) problem.
 *
 * The scenario keeps the LOCAL project list empty and starts from an empty
 * SyncState, so every accepted (valid) project is a `brand-new` auto-add — which
 * is the cleanest way to isolate the safeguard composition: nothing in the
 * cycle has any reason to produce a Conflict or Review, so the only way one could
 * appear is the bug this property guards against (a skip/error being mis-routed
 * into conflict handling).
 *
 * `fetch` is mocked exactly as in `sync-client.test.js` (`makeResponse`-style
 * Response stubs) and dispatches per project_id; a fake validator rejects the
 * schema-invalid ids; an in-memory `SyncStore` captures the saved `SyncState`
 * so snapshots/conflicts/reviews can be inspected; a permissive `LiveState`
 * lets the cycle run.
 *
 * Uses the Node.js built-in test runner + fast-check (fast-check v4:
 * `fc.uuid({ version: 7 })` supplies ids that pass the manifest's UUIDv7 guard).
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// Existing safeguards compose without becoming conflicts

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { sync } from '../../sync-client.js';
import { stampFromSchema } from '../../lib/format-stamp.js';
import { STUB_SCHEMA } from '../fixtures/stub-schema.js';

// The stamp this client expects — derived from the same schema sync() uses, so
// "compatible" / "incompatible" can never drift from the real check.
const LOCAL_STAMP = stampFromSchema(STUB_SCHEMA); // { platform: 'stub', schema_version: '0.0.0-stub' }

const FIXED_CREATED_AT = '2026-01-01T00:00:00.000Z';

// ─── fetch double (mirrors sync-client.test.js) ──────────────────────────────

/** Creates a Response-like object. */
function makeResponse(status, body = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Installs a mock `fetch` that serves a controllable manifest plus per-project
 * payloads keyed by project_id:
 *   - PUT (push)          → 200 (no local projects here, so this is never hit).
 *   - GET /projects       → the manifest array.
 *   - GET /projects/:id   → the project's payload, or a non-auth 500 for the
 *                           `fetch-error` category (so the cycle must continue).
 *
 * @param {{project_id: string, name: string}[]} manifest
 * @param {Map<string, {category: string, payload: object|null}>} byId
 */
function installMockFetch(manifest, byId) {
  globalThis.fetch = async (url, options) => {
    const method = (options && options.method) || 'GET';
    if (method === 'PUT') return makeResponse(200, { ok: true });
    if (url.endsWith('/projects')) return makeResponse(200, manifest);
    // GET /projects/:id — recover the id from the last path segment.
    const id = decodeURIComponent(url.split('/').pop());
    const entry = byId.get(id);
    if (!entry) return makeResponse(404);
    if (entry.category === 'fetch-error') return makeResponse(500); // non-auth per-project error
    return makeResponse(200, entry.payload);
  };
}

// ─── adapters (SyncStore + LiveState) ─────────────────────────────────────────

/**
 * In-memory {@link SyncStore} that captures the last saved {@link SyncState} so
 * the test can inspect snapshots/conflicts/reviews after the cycle.
 */
function makeStore() {
  let saved = null;
  return {
    async load() {
      return saved;
    },
    async save(state) {
      saved = state;
    },
    getState() {
      return saved;
    },
  };
}

/** Permissive {@link LiveState}: capture inactive, nothing locked, nothing pending. */
function makeLiveState() {
  return {
    isCaptureActive: () => false,
    getLockedRecordingIds: () => new Set(),
    recordingsWithPendingActions: () => new Set(),
  };
}

/**
 * A fake platform validator. Rejects payloads whose `project.project_id` is in
 * the schema-invalid set (so they are reported as errors after passing the stamp
 * check); accepts everything else.
 *
 * @param {Set<string>} invalidIds
 */
function makeValidator(invalidIds) {
  const validator = (payload) => !invalidIds.has(payload?.project?.project_id);
  validator.errors = [{ instancePath: '/project', message: 'stub schema rejection' }];
  return validator;
}

// ─── payload builders ─────────────────────────────────────────────────────────

/** Build a Full_Project_Payload with a given docent_format stamp. */
function buildPayload(project_id, name, stamp) {
  return {
    docent_format: stamp,
    project: { project_id, name, created_at: FIXED_CREATED_AT },
    recordings: [],
  };
}

/** A stamp that is incompatible with LOCAL_STAMP in the requested dimension. */
function incompatibleStamp(mismatchKind) {
  return mismatchKind === 'platform'
    ? { platform: 'other-platform', schema_version: LOCAL_STAMP.schema_version }
    : { platform: LOCAL_STAMP.platform, schema_version: '9.9.9-other' };
}

// ─── generators ──────────────────────────────────────────────────────────────

const arbCategory = fc.constantFrom('valid', 'stamp-incompatible', 'schema-invalid', 'fetch-error');

/** One project's spec: a unique UUIDv7 id, a category, and a stamp-mismatch dimension. */
const arbProjectSpec = fc.record({
  project_id: fc.uuid({ version: 7 }),
  category: arbCategory,
  mismatchKind: fc.constantFrom('platform', 'version'),
});

/** A manifest of 1..8 projects with unique ids and a mix of categories. */
const arbScenario = fc.uniqueArray(arbProjectSpec, {
  selector: (s) => s.project_id,
  minLength: 1,
  maxLength: 8,
});

/**
 * Materialize a scenario into the manifest + per-id dispatch map + the
 * schema-invalid id set, with a stable unique name per project.
 */
function materialize(specs) {
  const nameOf = (id) => `proj-${id}`;
  const schemaInvalidIds = new Set(
    specs.filter((s) => s.category === 'schema-invalid').map((s) => s.project_id),
  );

  const byId = new Map();
  for (const s of specs) {
    const name = nameOf(s.project_id);
    let payload = null;
    if (s.category === 'stamp-incompatible') {
      payload = buildPayload(s.project_id, name, incompatibleStamp(s.mismatchKind));
    } else if (s.category === 'valid' || s.category === 'schema-invalid') {
      // Both carry a COMPATIBLE stamp so they pass stage 1; the validator then
      // rejects only the schema-invalid ids at stage 2.
      payload = buildPayload(s.project_id, name, { ...LOCAL_STAMP });
    }
    byId.set(s.project_id, { category: s.category, payload });
  }

  const manifest = specs.map((s) => ({ project_id: s.project_id, name: nameOf(s.project_id) }));
  return { manifest, byId, schemaInvalidIds, nameOf };
}

describe('Existing safeguards compose without becoming conflicts', () => {
  it('stamp-incompatible → mismatched, schema-invalid/non-auth → errors, none ever a conflict; valid projects still processed', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (specs) => {
        const { manifest, byId, schemaInvalidIds, nameOf } = materialize(specs);
        installMockFetch(manifest, byId);

        const store = makeStore();
        const validator = makeValidator(schemaInvalidIds);

        // Local list is EMPTY: every accepted (valid) project is a brand-new
        // auto-add, so nothing in the cycle has any reason to defer to a
        // Conflict or Review — isolating the safeguard composition.
        const { result } = await sync(
          'https://srv.test',
          null,
          [],
          STUB_SCHEMA,
          validator,
          store,
          makeLiveState(),
        );

        // No auth failure anywhere → the cycle runs to completion.
        assert.equal(result.halted, false, 'a non-auth cycle never halts');
        assert.equal(result.haltReason, null);

        const idsByCategory = (cat) =>
          specs.filter((s) => s.category === cat).map((s) => s.project_id);
        const validIds = idsByCategory('valid');
        const stampIncompatibleIds = idsByCategory('stamp-incompatible');
        const schemaInvalidIdsList = idsByCategory('schema-invalid');
        const fetchErrorIds = idsByCategory('fetch-error');

        const state = store.getState();
        const snapshotKeys = new Set(Object.keys(state.snapshots ?? {}));
        const conflictKeys = Object.keys(state.conflicts ?? {});
        const reviewKeys = Object.keys(state.reviews ?? {});
        const pulledSet = new Set(result.pulled);
        const mismatchedNames = new Set(result.mismatched.map((e) => e.projectName));
        const errorNames = new Set(result.errors.map((e) => e.projectName));

        // ── Nothing ever becomes a Conflict or Review (the core invariant). ──
        // With an empty local side, NO Unit should ever be deferred — so a
        // safeguard skip/error mis-routed into conflict handling is the only way
        // these maps could be non-empty.
        assert.equal(conflictKeys.length, 0, 'no project ever becomes a Conflict');
        assert.equal(reviewKeys.length, 0, 'no project ever becomes a Review');
        assert.deepEqual(result.conflicts, [], 'no conflict unitRefs reported');
        assert.deepEqual(result.review, [], 'no review unitRefs reported');

        // ── stamp-incompatible: skipped as `mismatched`, never a
        // conflict, never a snapshot, never pulled. ──
        for (const id of stampIncompatibleIds) {
          assert.ok(
            mismatchedNames.has(nameOf(id)),
            `stamp-incompatible project ${id} must be recorded in mismatched`,
          );
          assert.ok(!pulledSet.has(id), 'stamp-incompatible project is not pulled');
          assert.ok(!snapshotKeys.has(id), 'stamp-incompatible project is not snapshotted');
          assert.ok(!conflictKeys.includes(id), 'stamp-incompatible project is not a conflict');
          assert.ok(!reviewKeys.includes(id), 'stamp-incompatible project is not a review');
        }

        // ── schema-invalid: reported in `errors`, never a conflict,
        // never a snapshot, never pulled. ──
        for (const id of schemaInvalidIdsList) {
          assert.ok(
            errorNames.has(nameOf(id)),
            `schema-invalid project ${id} must be reported in errors`,
          );
          assert.ok(!pulledSet.has(id), 'schema-invalid project is not pulled');
          assert.ok(!snapshotKeys.has(id), 'schema-invalid project is not snapshotted');
          assert.ok(!conflictKeys.includes(id), 'schema-invalid project is not a conflict');
          assert.ok(!reviewKeys.includes(id), 'schema-invalid project is not a review');
        }

        // ── a non-auth per-project error is isolated in `errors`; it
        // never becomes a conflict and never blocks the rest of the cycle. ──
        for (const id of fetchErrorIds) {
          assert.ok(
            errorNames.has(nameOf(id)),
            `erroring project ${id} must be reported in errors`,
          );
          assert.ok(!pulledSet.has(id), 'erroring project is not pulled');
          assert.ok(!snapshotKeys.has(id), 'erroring project is not snapshotted');
          assert.ok(!conflictKeys.includes(id), 'erroring project is not a conflict');
        }

        // ── every valid project is STILL processed, regardless of where
        // the skips/errors fell in the manifest: the cycle continued past each
        // per-project (non-auth) problem. ──
        assert.deepEqual(
          [...pulledSet].sort(),
          [...validIds].sort(),
          'exactly the valid projects are pulled',
        );
        assert.deepEqual(
          [...snapshotKeys].sort(),
          [...validIds].sort(),
          'snapshots retained for exactly the valid projects',
        );
      }),
      { numRuns: 200 },
    );
  });

  // ── Deterministic regression examples ────────────────────────────────────

  it('a stamp-incompatible, a schema-invalid, and an erroring project all preceding a valid one do not block it', async () => {
    const BAD_STAMP = '018f0000-0000-7000-8000-000000000001';
    const BAD_SCHEMA = '018f0000-0000-7000-8000-000000000002';
    const ERRORING = '018f0000-0000-7000-8000-000000000003';
    const VALID = '018f0000-0000-7000-8000-000000000004';

    const manifest = [
      { project_id: BAD_STAMP, name: 'p-bad-stamp' },
      { project_id: BAD_SCHEMA, name: 'p-bad-schema' },
      { project_id: ERRORING, name: 'p-erroring' },
      { project_id: VALID, name: 'p-valid' },
    ];
    const byId = new Map([
      [
        BAD_STAMP,
        {
          category: 'stamp-incompatible',
          payload: buildPayload(BAD_STAMP, 'p-bad-stamp', incompatibleStamp('platform')),
        },
      ],
      [
        BAD_SCHEMA,
        {
          category: 'schema-invalid',
          payload: buildPayload(BAD_SCHEMA, 'p-bad-schema', { ...LOCAL_STAMP }),
        },
      ],
      [ERRORING, { category: 'fetch-error', payload: null }],
      [VALID, { category: 'valid', payload: buildPayload(VALID, 'p-valid', { ...LOCAL_STAMP }) }],
    ]);
    installMockFetch(manifest, byId);

    const store = makeStore();
    const { result } = await sync(
      'https://srv.test',
      null,
      [],
      STUB_SCHEMA,
      makeValidator(new Set([BAD_SCHEMA])),
      store,
      makeLiveState(),
    );

    assert.equal(result.halted, false);
    // The valid project, last in the manifest behind three problems, is reached.
    assert.deepEqual(result.pulled, [VALID], 'the valid project is still processed');
    assert.deepEqual(
      result.mismatched.map((e) => e.projectName),
      ['p-bad-stamp'],
    );
    assert.deepEqual(
      result.errors.map((e) => e.projectName).sort(),
      ['p-bad-schema', 'p-erroring'],
      'schema-invalid and erroring both land in errors',
    );

    const state = store.getState();
    assert.deepEqual(Object.keys(state.conflicts), [], 'nothing became a conflict');
    assert.deepEqual(Object.keys(state.reviews), [], 'nothing became a review');
    assert.deepEqual(
      Object.keys(state.snapshots),
      [VALID],
      'only the valid project is snapshotted',
    );
  });

  it('a lone stamp-incompatible project is a compatibility skip, not a conflict', async () => {
    const ID = '018f0000-0000-7000-8000-00000000000a';
    const manifest = [{ project_id: ID, name: 'only' }];
    const byId = new Map([
      [
        ID,
        {
          category: 'stamp-incompatible',
          payload: buildPayload(ID, 'only', incompatibleStamp('version')),
        },
      ],
    ]);
    installMockFetch(manifest, byId);

    const store = makeStore();
    const { result } = await sync(
      'https://srv.test',
      null,
      [],
      STUB_SCHEMA,
      makeValidator(new Set()),
      store,
      makeLiveState(),
    );

    assert.equal(result.mismatched.length, 1);
    assert.equal(result.mismatched[0].projectName, 'only');
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.pulled, []);
    const state = store.getState();
    assert.deepEqual(Object.keys(state.conflicts), []);
    assert.deepEqual(Object.keys(state.snapshots), []);
  });

  it('a lone schema-invalid project is an error, not a conflict', async () => {
    const ID = '018f0000-0000-7000-8000-00000000000b';
    const manifest = [{ project_id: ID, name: 'only' }];
    const byId = new Map([
      [ID, { category: 'schema-invalid', payload: buildPayload(ID, 'only', { ...LOCAL_STAMP }) }],
    ]);
    installMockFetch(manifest, byId);

    const store = makeStore();
    const { result } = await sync(
      'https://srv.test',
      null,
      [],
      STUB_SCHEMA,
      makeValidator(new Set([ID])),
      store,
      makeLiveState(),
    );

    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].projectName, 'only');
    assert.deepEqual(result.mismatched, []);
    assert.deepEqual(result.pulled, []);
    const state = store.getState();
    assert.deepEqual(Object.keys(state.conflicts), []);
    assert.deepEqual(Object.keys(state.snapshots), []);
  });
});
