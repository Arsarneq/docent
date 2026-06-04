/**
 * placement-contract.test.js — Placement & protocol-contract smoke tests.
 *
 * A standard smoke/contract suite (NOT a property test) for task 17.3. It pins
 * three architectural guarantees the rest of the feature relies on:
 *
 *   1. PLACEMENT (R16.1, R17.1) — detection, snapshot retention, deferral, and
 *      resolution all live in `packages/shared`. The parity-bearing modules
 *      (conflict-detector, sync-store, conflict-resolution, sync-conflict-ui,
 *      sync-baseline, sync-digest) exist in this package and export their key
 *      functions.
 *
 *   2. PANEL IMPORTS (R17.2) — both platform panels (extension + desktop) import
 *      the shared `sync()`, the shared workflow module (sync-conflict-ui), and
 *      the shared resolution functions (conflict-resolution), so neither panel
 *      forks its own conflict-handling logic. Asserted by reading the panel
 *      source files (NOT executing them — they need a DOM / chrome / Tauri).
 *
 *   3. PROTOCOL CONTRACT (R16.3, R16.4) — `sync()` talks to the opaque server
 *      using ONLY the existing endpoints (`GET`/`PUT /projects` and
 *      `GET /projects/:id`) and the existing `Full_Project_Payload` shape, with
 *      NO server-side conflict state. Asserted by driving `sync()` with a fake
 *      fetch that records every requested URL + method, then checking that every
 *      URL is `/projects` or `/projects/:id`, every method is GET/PUT, and the
 *      pushed body is a clean Full_Project_Payload carrying no conflict /
 *      baseline / review fields.
 *
 *   4. CONNECTION_TEST CONTRACT (R16.5) — the Auto-Sync `testConnection` helper
 *      uses ONLY the existing read endpoint (`GET /projects`) and requires no
 *      test-specific server support: a normal success is a pass, a 401/403 is an
 *      auth failure, anything else is unreachable. Asserted by driving
 *      `testConnection` with a fake fetch that records the request and confirming
 *      the single call is a bodiless `GET /projects`. The `settingsFingerprint`
 *      is asserted to be a purely client-local value that is never transmitted.
 *
 *   5. SYNC_TRIGGER CONTRACT (R16.6) — the Auto-Sync Sync_Trigger / scheduler is
 *      a client-side adapter that only decides *when* to invoke the shared
 *      `sync()`; it adds NO server-side state and makes NO requests of its own.
 *      Asserted by driving the shared scheduler + trigger with a fake fetch that
 *      records every request and confirming that triggering, coalescing, and
 *      tearing the trigger down issues no network traffic — only the `sync()`
 *      cycle it invokes talks to the server, over the contract-pinned endpoints.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── The shared modules under test (placement) ────────────────────────────────
import { classifyProject } from '../../conflict-detector.js';
import { loadSyncState, saveSyncState, upsertReview, upsertConflict } from '../../sync-store.js';
import { acceptReview, declineReview, resolveConflict } from '../../conflict-resolution.js';
import { deriveIndicators, renderWorkflow } from '../../sync-conflict-ui.js';
import { advanceBaseline } from '../../sync-baseline.js';
import { digestProject } from '../../sync-digest.js';
import { sync, buildPayloadForProject } from '../../sync-client.js';
import { testConnection, settingsFingerprint } from '../../connection-test.js';
import { createSyncScheduler, createSyncTrigger } from '../../sync-scheduler.js';
import { STUB_SCHEMA } from '../fixtures/stub-schema.js';

// ── Paths (resolved from this test file, so they survive a move) ─────────────
const SHARED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
const EXTENSION_PANEL = path.resolve(SHARED_DIR, '../extension/sidepanel/panel.js');
const DESKTOP_PANEL = path.resolve(SHARED_DIR, '../desktop/src/panel.js');

// ─── (1) PLACEMENT — modules live in packages/shared (R16.1, R17.1) ───────────

describe('Placement: conflict-handling logic lives in packages/shared (R16.1, R17.1)', () => {
  // Module file → the concern it carries, per the design Module Layout.
  const sharedModules = [
    ['conflict-detector.js', 'detection'],
    ['sync-digest.js', 'detection (content identity)'],
    ['sync-store.js', 'snapshot retention + deferral state'],
    ['sync-baseline.js', 'baseline (deferral support)'],
    ['conflict-resolution.js', 'resolution'],
    ['sync-conflict-ui.js', 'resolution workflow UI'],
  ];

  for (const [file, concern] of sharedModules) {
    it(`${file} (${concern}) exists under packages/shared`, () => {
      assert.ok(
        existsSync(path.join(SHARED_DIR, file)),
        `${file} should live in packages/shared (carries ${concern})`,
      );
    });
  }

  it('detection exports classifyProject (conflict-detector) and digestProject (sync-digest)', () => {
    assert.equal(typeof classifyProject, 'function');
    assert.equal(typeof digestProject, 'function');
  });

  it('snapshot retention + deferral export their store/baseline helpers', () => {
    assert.equal(typeof loadSyncState, 'function');
    assert.equal(typeof saveSyncState, 'function');
    assert.equal(typeof upsertReview, 'function');
    assert.equal(typeof upsertConflict, 'function');
    assert.equal(typeof advanceBaseline, 'function');
  });

  it('resolution exports acceptReview / declineReview / resolveConflict', () => {
    assert.equal(typeof acceptReview, 'function');
    assert.equal(typeof declineReview, 'function');
    assert.equal(typeof resolveConflict, 'function');
  });

  it('resolution workflow exports deriveIndicators / renderWorkflow', () => {
    assert.equal(typeof deriveIndicators, 'function');
    assert.equal(typeof renderWorkflow, 'function');
  });
});

// ─── (2) PANEL IMPORTS — both panels import the shared logic (R17.2) ──────────

/**
 * Extract the import clause (`{ a, b }` or a default name) for the first import
 * whose module specifier ends with `moduleSuffix`, or null when there is none.
 * A negated-class `[^}]*` matches across newlines, so multi-line `{ ... }` import
 * blocks are captured without needing the dotAll flag.
 *
 * @param {string} source
 * @param {string} moduleSuffix - e.g. 'sync-client.js'
 * @returns {string|null} the matched clause text, or null
 */
function importClauseFor(source, moduleSuffix) {
  const escaped = moduleSuffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `import\\s*(\\{[^}]*\\}|[A-Za-z_$][\\w$]*)\\s*from\\s*['"][^'"]*${escaped}['"]`,
  );
  const match = source.match(re);
  return match ? match[1] : null;
}

describe('Panel imports: both panels use the shared sync() + workflow + resolution (R17.2)', () => {
  const panels = [
    ['extension', EXTENSION_PANEL],
    ['desktop', DESKTOP_PANEL],
  ];

  for (const [name, panelPath] of panels) {
    describe(`${name} panel`, () => {
      let source;

      it('panel source file exists', () => {
        assert.ok(existsSync(panelPath), `${name} panel should exist at ${panelPath}`);
        source = readFileSync(panelPath, 'utf8');
      });

      it('imports sync() from the shared sync-client', () => {
        const clause = importClauseFor(source, 'sync-client.js');
        assert.ok(clause, `${name} panel should import from sync-client.js`);
        assert.match(clause, /\bsync\b/, `${name} panel should import the shared sync()`);
      });

      it('imports the shared workflow module (sync-conflict-ui) including renderWorkflow', () => {
        const clause = importClauseFor(source, 'sync-conflict-ui.js');
        assert.ok(clause, `${name} panel should import the shared workflow module`);
        assert.match(
          clause,
          /\brenderWorkflow\b/,
          `${name} panel should import the shared resolution workflow render`,
        );
        assert.match(
          clause,
          /\bderiveIndicators\b/,
          `${name} panel should import the shared sync-state indicator derivation`,
        );
      });

      it('imports the shared resolution functions (conflict-resolution)', () => {
        const clause = importClauseFor(source, 'conflict-resolution.js');
        assert.ok(clause, `${name} panel should import from conflict-resolution.js`);
        for (const fn of ['acceptReview', 'declineReview', 'resolveConflict']) {
          assert.match(
            clause,
            new RegExp(`\\b${fn}\\b`),
            `${name} panel should import the shared ${fn}()`,
          );
        }
      });
    });
  }
});

// ─── (3) PROTOCOL CONTRACT — endpoints + payload shape only (R16.3, R16.4) ────

const SERVER_URL = 'https://server.test';
// A valid UUIDv7 (version nibble 7, variant 8) so the pull manifest entry is not
// rejected by the untrusted-id guard in pullProjects.
const PROJECT_ID = '018f4e2a-1234-7abc-8def-000000000000';

/** A permissive validator — the contract test exercises transport, not schema. */
function passValidator() {
  return true;
}
passValidator.errors = [];

/** Minimal Response-like object. */
function jsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

/** A local project with one recording at a committed step (Full_Project_Payload-able). */
function makeLocalProject() {
  return {
    project_id: PROJECT_ID,
    name: 'Checkout Flow',
    created_at: '2026-01-01T00:00:00.000Z',
    recordings: [
      {
        recording_id: '018f4e2a-9999-7aaa-8bbb-000000000001',
        name: 'Happy path',
        created_at: '2026-01-01T00:00:00.000Z',
        steps: [
          {
            uuid: '018f4e2a-aaaa-7ccc-8ddd-000000000002',
            logical_id: '018f4e2a-aaaa-7ccc-8ddd-000000000002',
            step_number: 1,
            created_at: '2026-01-01T00:00:00.000Z',
            narration: 'Open the cart',
            narration_source: 'typed',
            actions: [],
            deleted: false,
          },
        ],
      },
    ],
  };
}

/** In-memory SyncStore adapter (client-side state only — never touches the wire). */
function makeMemoryStore() {
  let saved = null;
  return {
    load: async () => saved,
    save: async (state) => {
      saved = state;
    },
    get saved() {
      return saved;
    },
  };
}

/** LiveState with nothing live — no locks, no capture, no pending actions. */
const idleLiveState = {
  isCaptureActive: () => false,
  getLockedRecordingIds: () => new Set(),
  recordingsWithPendingActions: () => new Set(),
};

/** Recursively collect every object key in a value (for the forbidden-field scan). */
function collectKeys(value, out = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      out.add(key);
      collectKeys(value[key], out);
    }
  }
  return out;
}

describe('Protocol contract: sync() uses only /projects + /projects/:id, no server conflict state (R16.3, R16.4)', () => {
  const originalFetch = globalThis.fetch;
  let calls;

  /**
   * Install a fake fetch that records every URL + method and serves the opaque
   * last-write-wins protocol: GET /projects (manifest), GET /projects/:id (the
   * stored Full_Project_Payload, identical to local so the cycle converges
   * cleanly), and PUT /projects/:id (push, acknowledged verbatim).
   */
  function installFakeFetch(serverPayload) {
    calls = [];
    globalThis.fetch = async (url, options = {}) => {
      const method = options.method ?? 'GET';
      calls.push({ url, method, body: options.body ?? null });

      if (method === 'GET' && url === `${SERVER_URL}/projects`) {
        return jsonResponse(200, [{ project_id: PROJECT_ID, name: 'Checkout Flow' }]);
      }
      if (method === 'GET' && url.startsWith(`${SERVER_URL}/projects/`)) {
        return jsonResponse(200, serverPayload);
      }
      if (method === 'PUT' && url.startsWith(`${SERVER_URL}/projects/`)) {
        return jsonResponse(200, { ok: true });
      }
      // Anything else is off-contract; surface it as a hard failure.
      return jsonResponse(404, null);
    };
  }

  beforeEach(() => {
    calls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('every request targets only /projects or /projects/:id with GET/PUT', async () => {
    const local = makeLocalProject();
    // The server stores the project verbatim — reuse the same builder so the
    // pulled copy is content-identical (a clean, converged cycle).
    installFakeFetch(buildPayloadForProject(local, STUB_SCHEMA));

    const { result } = await sync(
      SERVER_URL,
      null,
      [local],
      STUB_SCHEMA,
      passValidator,
      makeMemoryStore(),
      idleLiveState,
    );

    assert.equal(result.halted, false, 'a clean cycle should not halt');
    assert.ok(calls.length >= 3, 'expected at least push + manifest + per-project pull');

    // The ONLY allowed shapes: exactly `${SERVER_URL}/projects` or a single
    // `/projects/<segment>` (no extra path, no query string carrying state).
    const allowed = new RegExp(
      `^${SERVER_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/projects(/[^/?#]+)?$`,
    );
    for (const { url, method } of calls) {
      assert.match(url, allowed, `off-contract endpoint requested: ${method} ${url}`);
      assert.ok(['GET', 'PUT'].includes(method), `off-contract method used: ${method} ${url}`);
    }

    // Both pull endpoints and the push endpoint must all have been exercised.
    assert.ok(
      calls.some((c) => c.method === 'GET' && c.url === `${SERVER_URL}/projects`),
      'manifest GET /projects should be requested',
    );
    assert.ok(
      calls.some((c) => c.method === 'GET' && c.url === `${SERVER_URL}/projects/${PROJECT_ID}`),
      'per-project GET /projects/:id should be requested',
    );
    assert.ok(
      calls.some((c) => c.method === 'PUT' && c.url === `${SERVER_URL}/projects/${PROJECT_ID}`),
      'push PUT /projects/:id should be requested',
    );
  });

  it('the pushed body is a Full_Project_Payload carrying no conflict/baseline/review fields', async () => {
    const local = makeLocalProject();
    installFakeFetch(buildPayloadForProject(local, STUB_SCHEMA));

    await sync(
      SERVER_URL,
      null,
      [local],
      STUB_SCHEMA,
      passValidator,
      makeMemoryStore(),
      idleLiveState,
    );

    const put = calls.find((c) => c.method === 'PUT');
    assert.ok(put, 'a PUT push should have been made');
    const body = JSON.parse(put.body);

    // Full_Project_Payload is EXACTLY these three keys (R16.3).
    assert.deepEqual(
      Object.keys(body).sort(),
      ['docent_format', 'project', 'recordings'],
      'PUT body must be the existing Full_Project_Payload shape',
    );

    // docent_format stamp + project identity + recordings array.
    assert.equal(typeof body.docent_format.platform, 'string');
    assert.equal(typeof body.docent_format.schema_version, 'string');
    assert.equal(body.project.project_id, PROJECT_ID);
    assert.equal(typeof body.project.name, 'string');
    assert.equal(typeof body.project.created_at, 'string');
    assert.ok(Array.isArray(body.recordings), 'recordings must be an array');

    // No server-side conflict state crosses the wire (R16.4): no conflict,
    // baseline, review, or snapshot field appears anywhere in the payload.
    const forbidden = [
      'conflict',
      'conflicts',
      'baseline',
      'baselines',
      'review',
      'reviews',
      'snapshot',
      'snapshots',
    ];
    const keys = collectKeys(body);
    for (const field of forbidden) {
      assert.ok(!keys.has(field), `Full_Project_Payload must not carry a "${field}" field`);
    }

    // Project and recording fields stay within the existing allowlist.
    const projectAllow = new Set(['project_id', 'name', 'created_at', 'metadata']);
    for (const key of Object.keys(body.project)) {
      assert.ok(projectAllow.has(key), `unexpected project field on the wire: "${key}"`);
    }
    const recordingAllow = new Set(['recording_id', 'name', 'created_at', 'metadata', 'steps']);
    for (const recording of body.recordings) {
      for (const key of Object.keys(recording)) {
        assert.ok(recordingAllow.has(key), `unexpected recording field on the wire: "${key}"`);
      }
    }
  });

  it('GET requests carry no body (the server stays read-through on pull)', async () => {
    const local = makeLocalProject();
    installFakeFetch(buildPayloadForProject(local, STUB_SCHEMA));

    await sync(
      SERVER_URL,
      null,
      [local],
      STUB_SCHEMA,
      passValidator,
      makeMemoryStore(),
      idleLiveState,
    );

    for (const call of calls.filter((c) => c.method === 'GET')) {
      assert.equal(call.body, null, `GET ${call.url} should not send a body`);
    }
  });
});

// ─── (4) CONNECTION_TEST CONTRACT — existing read endpoint only (R16.5) ───────

describe('Connection_Test contract: testConnection uses only GET /projects, no test-specific server support (R16.5)', () => {
  const originalFetch = globalThis.fetch;
  let calls;

  /**
   * Install a fake fetch that records every request and serves the configured
   * status for `GET /projects` only — anything else is off-contract and 404s,
   * so a Connection_Test that hit a test-specific endpoint would be caught.
   */
  function installProbeFetch(status, body = []) {
    calls = [];
    globalThis.fetch = async (url, options = {}) => {
      const method = options.method ?? 'GET';
      calls.push({ url, method, body: options.body });
      if (method === 'GET' && url === `${SERVER_URL}/projects`) {
        return jsonResponse(status, body);
      }
      return jsonResponse(404, null);
    };
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('issues exactly one bodiless GET to the existing /projects endpoint', async () => {
    installProbeFetch(200, []);

    const result = await testConnection(SERVER_URL, null);

    assert.deepEqual(result, { ok: true, reason: 'pass' });
    assert.equal(calls.length, 1, 'the Connection_Test is a single request — no extra round-trips');
    const [probe] = calls;
    assert.equal(probe.method, 'GET', 'the probe is a read (GET), never a write');
    assert.equal(
      probe.url,
      `${SERVER_URL}/projects`,
      'the probe targets the existing read endpoint',
    );
    assert.equal(probe.body, undefined, 'the probe carries no body (no test-specific payload)');
  });

  it('targets ONLY the contract-pinned /projects endpoint — never a test-specific one', async () => {
    installProbeFetch(200, []);
    await testConnection(SERVER_URL, 'token');

    // The exact same endpoint shape the pull path uses; no `/connection-test`,
    // `/ping`, `/health`, or query-string-carrying variant.
    const allowed = new RegExp(`^${SERVER_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/projects$`);
    for (const { url, method } of calls) {
      assert.match(url, allowed, `Connection_Test hit an off-contract endpoint: ${method} ${url}`);
      assert.equal(method, 'GET', 'the Connection_Test must only read');
    }
  });

  it('classifies success/auth/unreachable from ordinary responses, needing no server support', async () => {
    // A normal successful response is sufficient (R16.5) — no special body.
    installProbeFetch(200, []);
    assert.deepEqual(await testConnection(SERVER_URL, null), { ok: true, reason: 'pass' });

    // A 401/403 is distinguished as an auth failure without a custom endpoint.
    installProbeFetch(401);
    assert.deepEqual(await testConnection(SERVER_URL, 'bad'), { ok: false, reason: 'auth' });

    // Any other non-success is unreachable; still just the read endpoint.
    installProbeFetch(500);
    assert.deepEqual(await testConnection(SERVER_URL, null), { ok: false, reason: 'unreachable' });
    for (const { url } of calls) {
      assert.equal(url, `${SERVER_URL}/projects`);
    }
  });

  it('settingsFingerprint is a purely client-local value (never sent to the server)', async () => {
    // Computing a fingerprint makes no network request at all.
    calls = [];
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url, method: options.method ?? 'GET' });
      return jsonResponse(404, null);
    };

    const fp = settingsFingerprint(SERVER_URL, 'plaintext-key');
    assert.equal(typeof fp, 'string');
    assert.equal(
      calls.length,
      0,
      'deriving the fingerprint issues no request — it is client-local',
    );
  });
});

// ─── (5) SYNC_TRIGGER CONTRACT — adds no server state, makes no requests (R16.6)

describe('Sync_Trigger contract: the scheduler/trigger adds no server-side state and issues no requests of its own (R16.6)', () => {
  const originalFetch = globalThis.fetch;
  let calls;

  /** A fetch that records EVERY request, so any trigger-side traffic is caught. */
  function installRecordingFetch() {
    calls = [];
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url, method: options.method ?? 'GET' });
      return jsonResponse(404, null);
    };
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('triggering and coalescing the scheduler issues no network traffic on its own', async () => {
    installRecordingFetch();

    // The scheduler's cycle runner is a pure stub here: the point is that the
    // TRIGGER mechanism itself (notify/coalesce/backstop) touches no server.
    let cycleRuns = 0;
    let release;
    const inFlight = new Promise((resolve) => {
      release = resolve;
    });
    const sched = createSyncScheduler({ cooldownMs: 0, now: () => 1000 });
    sched.start(() => {
      cycleRuns += 1;
      return inFlight; // hold the cycle open so follow-ups coalesce
    });

    sched.notify(); // leading-edge dispatch
    sched.notify(); // coalesced behind the in-flight cycle
    sched.notify(); // still coalesced — at most one follow-up

    assert.equal(cycleRuns, 1, 'never overlaps cycles');
    assert.equal(sched.hasPending(), true, 'a single follow-up is queued, not extra cycles');
    // The trigger plumbing made NO requests — only an invoked sync() would.
    assert.equal(calls.length, 0, 'the Sync_Trigger issues no requests of its own (R16.6)');

    release();
  });

  it('starting and tearing down a Sync_Trigger registers/removes only client-side hooks', () => {
    installRecordingFetch();

    let wiredNotify = null;
    let torn = false;
    const trigger = createSyncTrigger({
      cooldownMs: 0,
      now: () => 1000,
      // The platform wiring is client-side only (chrome.alarms / a timer); it
      // registers a notify callback and returns a teardown. No server contact.
      wire: (notify) => {
        wiredNotify = notify;
        return () => {
          torn = true;
        };
      },
    });

    trigger.start(() => {}); // cycle runner is a no-op stub
    assert.equal(typeof wiredNotify, 'function', 'the trigger wires a client-side notify hook');

    wiredNotify(); // a platform event fires the trigger
    trigger.stop(); // disable / settings-change / auth-disable teardown
    assert.equal(torn, true, 'stop() tears the client-side hook down');

    // The entire Sync_Trigger lifecycle added no server state and made no calls.
    assert.equal(calls.length, 0, 'the Sync_Trigger adapter contacts no server (R16.6)');
  });

  it('only the invoked sync() talks to the server, over the contract-pinned endpoints', async () => {
    // Wire the trigger to the SAME contract-driving sync() the protocol section
    // uses, and confirm every request the triggered cycle made is on-contract —
    // i.e. the trigger introduces no endpoint of its own.
    const local = makeLocalProject();
    const serverPayload = buildPayloadForProject(local, STUB_SCHEMA);

    calls = [];
    globalThis.fetch = async (url, options = {}) => {
      const method = options.method ?? 'GET';
      calls.push({ url, method });
      if (method === 'GET' && url === `${SERVER_URL}/projects`) {
        return jsonResponse(200, [{ project_id: PROJECT_ID, name: 'Checkout Flow' }]);
      }
      if (method === 'GET' && url.startsWith(`${SERVER_URL}/projects/`)) {
        return jsonResponse(200, serverPayload);
      }
      if (method === 'PUT' && url.startsWith(`${SERVER_URL}/projects/`)) {
        return jsonResponse(200, { ok: true });
      }
      return jsonResponse(404, null);
    };

    const runCycle = () =>
      sync(SERVER_URL, null, [local], STUB_SCHEMA, passValidator, makeMemoryStore(), idleLiveState);

    let notify;
    const trigger = createSyncTrigger({
      cooldownMs: 0,
      now: () => 1000,
      wire: (n) => {
        notify = n;
      },
    });
    trigger.start(runCycle);
    notify(); // fire one triggered cycle
    // Let the triggered cycle settle.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    trigger.stop();

    assert.ok(calls.length >= 3, 'the triggered cycle ran the full pull+push');
    const allowed = new RegExp(
      `^${SERVER_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/projects(/[^/?#]+)?$`,
    );
    for (const { url, method } of calls) {
      assert.match(url, allowed, `triggered cycle hit an off-contract endpoint: ${method} ${url}`);
      assert.ok(['GET', 'PUT'].includes(method), `off-contract method from trigger: ${method}`);
    }
  });
});
