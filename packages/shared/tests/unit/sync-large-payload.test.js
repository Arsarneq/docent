/**
 * sync-large-payload.test.js — Sync protocol large-payload handling (#94).
 *
 * Verifies that push/pull correctly handle large projects (hundreds of
 * recordings × many steps) without truncation, corruption, or shape loss.
 *
 * Deliberate scope note (#94 / PR #118 lesson): the issue's original
 * "sync of N projects in < 5s" criterion is intentionally NOT implemented as a
 * hard wall-clock assertion — absolute time thresholds flake on shared CI
 * runners. Instead these tests assert the *functional* contract (the full
 * payload round-trips intact at scale) and that serialization of a large
 * payload completes without error. Size/scale is the variable under test, not
 * elapsed time.
 *
 * Validates: #94 acceptance criteria (functional half).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { pushProjects, pullProjects, buildPayloadForProject } from '../../sync-client.js';
import { STUB_SCHEMA } from '../fixtures/stub-schema.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeStep(n) {
  return {
    uuid: `0190a1b2-c3d4-7e5f-8a9b-${String(n).padStart(12, '0')}`,
    logical_id: `0190a1b2-c3d4-7e5f-8a9b-1${String(n).padStart(11, '0')}`,
    step_number: n,
    created_at: '2026-01-01T00:00:00.000Z',
    narration: `Step ${n}: click the button and verify the result is shown correctly`,
    narration_source: 'typed',
    deleted: false,
    actions: [
      {
        type: 'click',
        timestamp: 1769860800000 + n,
        capture_mode: 'dom',
        context_id: 12345,
        element: {
          tag: 'Button',
          id: null,
          name: null,
          role: null,
          type: null,
          text: 'OK',
          selector: '#ok',
        },
        x: 100,
        y: 200,
      },
    ],
  };
}

function makeLargeProject(id, recordingCount, stepsPerRecording) {
  const recordings = [];
  for (let r = 0; r < recordingCount; r++) {
    const steps = [];
    for (let s = 1; s <= stepsPerRecording; s++) {
      steps.push(makeStep(r * stepsPerRecording + s));
    }
    recordings.push({
      recording_id: `0190a1b2-c3d4-7e5f-8a9b-2${String(r).padStart(11, '0')}`,
      name: `Recording ${r}`,
      created_at: '2026-01-01T00:00:00.000Z',
      steps,
    });
  }
  return {
    project_id: id,
    name: `Large project ${id}`,
    created_at: '2026-01-01T00:00:00.000Z',
    recordings,
  };
}

let fetchCalls = [];
function mockFetch(handler) {
  fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return handler(url, options);
  };
}
function makeResponse(status, body = null) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

/** Permissive stub validator — these tests exercise sync mechanics, not schema validation. */
function passValidator() {
  return true;
}
passValidator.errors = [];

const originalFetch = globalThis.fetch;
beforeEach(() => {
  fetchCalls = [];
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─── Push of a large payload ──────────────────────────────────────────────────

describe('#94 push of a large project payload', () => {
  it('serializes and pushes a 100-recording × 50-step project intact', async () => {
    const project = makeLargeProject('big', 100, 50);

    let receivedBodyLength = 0;
    let parsedBack;
    mockFetch((_url, opts) => {
      receivedBodyLength = opts.body.length;
      parsedBack = JSON.parse(opts.body); // server-side parse must succeed
      return makeResponse(200, { ok: true });
    });

    const result = await pushProjects('https://srv.test', null, [project], STUB_SCHEMA);

    assert.deepEqual(result.pushed, ['big']);
    assert.equal(result.errors.length, 0);

    // The payload is genuinely large (sanity: > 100KB) and round-trips intact.
    assert.ok(
      receivedBodyLength > 100_000,
      `expected a large body, got ${receivedBodyLength} bytes`,
    );
    assert.equal(parsedBack.recordings.length, 100, 'all recordings serialized');
    assert.equal(parsedBack.recordings[0].steps.length, 50, 'all steps per recording serialized');
    // Last step of the last recording survived (no truncation).
    const lastRec = parsedBack.recordings[99];
    assert.equal(
      lastRec.steps[49].step_number,
      100 * 50,
      'final step intact at the end of the payload',
    );
  });

  it('buildPayloadForProject preserves full step history without filtering', () => {
    const project = makeLargeProject('hist', 10, 100);
    const payload = buildPayloadForProject(project, STUB_SCHEMA);
    const totalSteps = payload.recordings.reduce((n, r) => n + r.steps.length, 0);
    assert.equal(totalSteps, 10 * 100, 'every step is included; nothing is dropped at scale');
  });
});

// ─── Pull of a large payload ──────────────────────────────────────────────────

describe('#94 pull of a large project payload', () => {
  it('parses a multi-MB project response without loss', async () => {
    const HUGE = '0190a1b2-0000-7000-8000-000000000099';
    const big = makeLargeProject(HUGE, 200, 50);
    const payload = buildPayloadForProject(big, STUB_SCHEMA);

    // Confirm the serialized response really is multi-hundred-KB / MB-scale.
    const serialized = JSON.stringify(payload);
    assert.ok(
      serialized.length > 1_000_000,
      `expected >1MB payload, got ${serialized.length} bytes`,
    );

    const manifest = [
      { project_id: HUGE, name: 'Huge', last_modified: '2026-01-01T00:00:00.000Z' },
    ];
    mockFetch((url) => {
      if (url.endsWith('/projects')) return makeResponse(200, manifest);
      if (url.endsWith(`/projects/${HUGE}`)) return makeResponse(200, payload);
      return makeResponse(404);
    });

    const result = await pullProjects('https://srv.test', null, passValidator);

    assert.equal(result.errors.length, 0);
    assert.equal(result.projects.length, 1);
    const pulled = result.projects[0];
    assert.equal(pulled.project_id, HUGE);
    assert.equal(pulled.recordings.length, 200, 'all recordings parsed back');
    assert.equal(pulled.recordings[199].steps.length, 50, 'final recording fully parsed');
  });
});

// ─── Edge cases ────────────────────────────────────────────────────────────────

describe('#94 payload edge cases', () => {
  it('project with an empty recordings array pushes cleanly', async () => {
    mockFetch(() => makeResponse(200, { ok: true }));
    const result = await pushProjects(
      'https://srv.test',
      null,
      [
        {
          project_id: 'empty',
          name: 'Empty',
          created_at: '2026-01-01T00:00:00.000Z',
          recordings: [],
        },
      ],
      STUB_SCHEMA,
    );
    assert.deepEqual(result.pushed, ['empty']);
    assert.equal(result.errors.length, 0);
  });

  it('recording with an empty steps array round-trips without issue', async () => {
    const project = {
      project_id: 'norec',
      name: 'No steps',
      created_at: '2026-01-01T00:00:00.000Z',
      recordings: [
        {
          recording_id: '0190a1b2-c3d4-7e5f-8a9b-2aaaaaaaaaaa',
          name: 'Empty rec',
          created_at: '2026-01-01T00:00:00.000Z',
          steps: [],
        },
      ],
    };
    let parsedBack;
    mockFetch((_url, opts) => {
      parsedBack = JSON.parse(opts.body);
      return makeResponse(200, { ok: true });
    });
    const result = await pushProjects('https://srv.test', null, [project], STUB_SCHEMA);
    assert.deepEqual(result.pushed, ['norec']);
    assert.equal(parsedBack.recordings[0].steps.length, 0, 'empty steps array preserved');
  });
});
