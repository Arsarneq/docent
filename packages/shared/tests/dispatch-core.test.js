/**
 * dispatch-core.test.js — Unit tests for dispatch-core.js coverage gaps.
 *
 * Tests validateEndpointUrl edge cases, sendPayload error paths (timeout,
 * large payload, large response, non-JSON response), and DispatchError.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { validateEndpointUrl, sendPayload, DispatchError, buildPayload } from '../dispatch-core.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─── validateEndpointUrl ──────────────────────────────────────────────────────

describe('validateEndpointUrl — edge cases', () => {
  it('returns null for empty string', () => {
    assert.equal(validateEndpointUrl(''), null);
  });

  it('rejects URL without http/https prefix', () => {
    const result = validateEndpointUrl('ftp://example.com');
    assert.ok(result !== null);
    assert.ok(result.includes('http://'));
  });

  it('rejects malformed URL that starts with https://', () => {
    const result = validateEndpointUrl('https://');
    assert.ok(result !== null);
  });

  it('rejects URL with embedded username', () => {
    const result = validateEndpointUrl('https://user@example.com/api');
    assert.ok(result !== null);
    assert.ok(result.includes('credentials'));
  });

  it('rejects URL with embedded username and password', () => {
    const result = validateEndpointUrl('https://user:pass@example.com/api');
    assert.ok(result !== null);
    assert.ok(result.includes('credentials'));
  });

  it('accepts valid https URL', () => {
    assert.equal(validateEndpointUrl('https://api.example.com/v1/dispatch'), null);
  });

  it('accepts valid http URL', () => {
    assert.equal(validateEndpointUrl('http://localhost:3000/api'), null);
  });
});

// ─── sendPayload — error paths ────────────────────────────────────────────────

describe('sendPayload — error handling', () => {
  it('throws DispatchError with null status for payload > 50MB', async () => {
    // Create a payload that serializes to > 50MB
    const largePayload = { data: 'x'.repeat(51 * 1024 * 1024) };

    let thrown = null;
    try {
      await sendPayload('https://example.com/api', null, largePayload);
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown instanceof DispatchError);
    assert.equal(thrown.status, null);
    assert.ok(thrown.message.includes('50MB'));
  });

  it('throws DispatchError for network errors', async () => {
    globalThis.fetch = async () => {
      throw new Error('Connection refused');
    };

    let thrown = null;
    try {
      await sendPayload('https://example.com/api', null, { test: true });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown instanceof DispatchError);
    assert.equal(thrown.status, null);
    assert.ok(thrown.message.includes('Connection refused'));
  });

  it('throws DispatchError for non-2xx response', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 503,
      headers: { get: () => null },
    });

    let thrown = null;
    try {
      await sendPayload('https://example.com/api', null, { test: true });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown instanceof DispatchError);
    assert.equal(thrown.status, 503);
    assert.ok(thrown.message.includes('503'));
  });

  it('throws DispatchError for response > 10MB', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: (h) => (h === 'content-length' ? '11000000' : null) },
      json: async () => ({}),
    });

    let thrown = null;
    try {
      await sendPayload('https://example.com/api', null, { test: true });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown instanceof DispatchError);
    assert.equal(thrown.status, null);
    assert.ok(thrown.message.includes('10MB'));
  });

  it('returns empty object when response is not valid JSON', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    });

    const result = await sendPayload('https://example.com/api', null, { test: true });
    assert.deepEqual(result, {});
  });

  it('returns parsed JSON on success', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ success: true, id: 'abc' }),
    });

    const result = await sendPayload('https://example.com/api', null, { test: true });
    assert.deepEqual(result, { success: true, id: 'abc' });
  });

  it('includes Authorization header when apiKey provided', async () => {
    let capturedHeaders = null;
    globalThis.fetch = async (_url, opts) => {
      capturedHeaders = opts.headers;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({}),
      };
    };

    await sendPayload('https://example.com/api', 'my-key', { test: true });
    assert.equal(capturedHeaders['Authorization'], 'Bearer my-key');
  });

  it('omits Authorization header when apiKey is null', async () => {
    let capturedHeaders = null;
    globalThis.fetch = async (_url, opts) => {
      capturedHeaders = opts.headers;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({}),
      };
    };

    await sendPayload('https://example.com/api', null, { test: true });
    assert.equal(capturedHeaders['Authorization'], undefined);
  });

  it('throws DispatchError with AbortError message on timeout', async () => {
    globalThis.fetch = async (_url, opts) => {
      // Simulate AbortError
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };

    let thrown = null;
    try {
      await sendPayload('https://example.com/api', null, { test: true });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown instanceof DispatchError);
    assert.equal(thrown.status, null);
    assert.ok(thrown.message.includes('timed out'));
  });
});

// ─── DispatchError ────────────────────────────────────────────────────────────

describe('DispatchError', () => {
  it('has correct name and properties', () => {
    const err = new DispatchError('test error', 404);
    assert.equal(err.name, 'DispatchError');
    assert.equal(err.message, 'test error');
    assert.equal(err.status, 404);
    assert.ok(err instanceof Error);
  });

  it('supports null status for network errors', () => {
    const err = new DispatchError('network failure', null);
    assert.equal(err.status, null);
  });
});

// ─── buildPayload — additional coverage ───────────────────────────────────────

describe('buildPayload — edge cases', () => {
  it('handles recording with null steps array', () => {
    const project = { project_id: 'p1', name: 'P', created_at: '2026-01-01T00:00:00.000Z' };
    const recordings = [
      {
        recording_id: 'r1',
        name: 'R',
        created_at: '2026-01-01T00:00:00.000Z',
        steps: null,
      },
    ];
    const payload = buildPayload(project, recordings, 'guidance', {});
    assert.deepEqual(payload.recordings[0].steps, []);
  });

  it('handles recording with undefined steps', () => {
    const project = { project_id: 'p1', name: 'P', created_at: '2026-01-01T00:00:00.000Z' };
    const recordings = [
      {
        recording_id: 'r1',
        name: 'R',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    const payload = buildPayload(project, recordings, 'guidance', {});
    assert.deepEqual(payload.recordings[0].steps, []);
  });

  it('includes reading_guidance and schema in payload', () => {
    const project = { project_id: 'p1', name: 'P', created_at: '2026-01-01T00:00:00.000Z' };
    const schema = { type: 'object', properties: {} };
    const payload = buildPayload(project, [], 'Read this first', schema);
    assert.equal(payload.reading_guidance, 'Read this first');
    assert.deepEqual(payload.schema, schema);
  });

  it('preserves deleted flag on steps', () => {
    const project = { project_id: 'p1', name: 'P', created_at: '2026-01-01T00:00:00.000Z' };
    const recordings = [
      {
        recording_id: 'r1',
        name: 'R',
        created_at: '2026-01-01T00:00:00.000Z',
        steps: [
          {
            uuid: 'u1',
            logical_id: 'l1',
            step_number: 1,
            created_at: '2026-01-01T00:00:00.000Z',
            actions: [],
            deleted: true,
          },
        ],
      },
    ];
    const payload = buildPayload(project, recordings, '', {});
    assert.equal(payload.recordings[0].steps[0].deleted, true);
  });
});

describe('buildPayload — metadata handling', () => {
  it('includes project metadata when present', () => {
    const project = {
      project_id: 'p1',
      name: 'P',
      created_at: '2026-01-01T00:00:00.000Z',
      metadata: { ticket: 'PROJ-42', env: 'staging' },
    };
    const payload = buildPayload(project, [], '', {});
    assert.deepEqual(payload.project.metadata, { ticket: 'PROJ-42', env: 'staging' });
  });

  it('omits project metadata when not present', () => {
    const project = { project_id: 'p1', name: 'P', created_at: '2026-01-01T00:00:00.000Z' };
    const payload = buildPayload(project, [], '', {});
    assert.equal(payload.project.metadata, undefined);
  });

  it('includes recording metadata when present', () => {
    const project = { project_id: 'p1', name: 'P', created_at: '2026-01-01T00:00:00.000Z' };
    const recordings = [
      {
        recording_id: 'r1',
        name: 'R',
        created_at: '2026-01-01T00:00:00.000Z',
        metadata: { browser: 'chrome', version: '120' },
        steps: [],
      },
    ];
    const payload = buildPayload(project, recordings, '', {});
    assert.deepEqual(payload.recordings[0].metadata, { browser: 'chrome', version: '120' });
  });

  it('omits recording metadata when not present', () => {
    const project = { project_id: 'p1', name: 'P', created_at: '2026-01-01T00:00:00.000Z' };
    const recordings = [
      { recording_id: 'r1', name: 'R', created_at: '2026-01-01T00:00:00.000Z', steps: [] },
    ];
    const payload = buildPayload(project, recordings, '', {});
    assert.equal(payload.recordings[0].metadata, undefined);
  });

  it('includes step narration and narration_source when present', () => {
    const project = { project_id: 'p1', name: 'P', created_at: '2026-01-01T00:00:00.000Z' };
    const recordings = [
      {
        recording_id: 'r1',
        name: 'R',
        created_at: '2026-01-01T00:00:00.000Z',
        steps: [
          {
            uuid: 'u1',
            logical_id: 'l1',
            step_number: 1,
            created_at: '2026-01-01T00:00:00.000Z',
            narration: 'Click login',
            narration_source: 'typed',
            actions: [],
            deleted: false,
          },
        ],
      },
    ];
    const payload = buildPayload(project, recordings, '', {});
    assert.equal(payload.recordings[0].steps[0].narration, 'Click login');
    assert.equal(payload.recordings[0].steps[0].narration_source, 'typed');
  });

  it('includes step_type and expect for simple mode steps', () => {
    const project = { project_id: 'p1', name: 'P', created_at: '2026-01-01T00:00:00.000Z' };
    const recordings = [
      {
        recording_id: 'r1',
        name: 'R',
        created_at: '2026-01-01T00:00:00.000Z',
        steps: [
          {
            uuid: 'u1',
            logical_id: 'l1',
            step_number: 1,
            created_at: '2026-01-01T00:00:00.000Z',
            step_type: 'validation',
            expect: 'present',
            actions: [],
            deleted: false,
          },
        ],
      },
    ];
    const payload = buildPayload(project, recordings, '', {});
    assert.equal(payload.recordings[0].steps[0].step_type, 'validation');
    assert.equal(payload.recordings[0].steps[0].expect, 'present');
  });

  it('omits narration fields when not present on step', () => {
    const project = { project_id: 'p1', name: 'P', created_at: '2026-01-01T00:00:00.000Z' };
    const recordings = [
      {
        recording_id: 'r1',
        name: 'R',
        created_at: '2026-01-01T00:00:00.000Z',
        steps: [
          {
            uuid: 'u1',
            logical_id: 'l1',
            step_number: 1,
            created_at: '2026-01-01T00:00:00.000Z',
            step_type: 'action',
            actions: [],
            deleted: false,
          },
        ],
      },
    ];
    const payload = buildPayload(project, recordings, '', {});
    assert.equal(payload.recordings[0].steps[0].narration, undefined);
    assert.equal(payload.recordings[0].steps[0].narration_source, undefined);
  });
});
