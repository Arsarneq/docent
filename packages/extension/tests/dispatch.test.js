/**
 * dispatch.test.js — Property-based tests for dispatch.js
 *
 * Uses Node's built-in test runner (node:test) and fast-check.
 * Chrome APIs and fetch are mocked globally before importing dispatch.js.
 */

// ── Mock chrome.storage.local ──────────────────────────────────────────────
let storageData = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        if (Array.isArray(keys)) {
          return Object.fromEntries(keys.map(k => [k, storageData[k]]));
        }
        return { [keys]: storageData[keys] };
      },
      set: async (items) => { Object.assign(storageData, items); },
      remove: async (keys) => {
        const ks = Array.isArray(keys) ? keys : [keys];
        ks.forEach(k => delete storageData[k]);
      },
    },
  },
  runtime: {
    getURL: (path) => `chrome-extension://test-id/${path}`,
  },
};

// ── Imports ────────────────────────────────────────────────────────────────
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import {
  validateEndpointUrl,
  buildPayload,
  sendPayload,
  DispatchError,
} from '../sidepanel/dispatch.js';

import chromeAdapter from '../sidepanel/adapter-chrome.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Arbitrary valid HTTP/HTTPS URL */
const validUrlArb = fc.oneof(
  fc.constant('http://localhost:3000'),
  fc.webUrl({ validSchemes: ['http', 'https'] }),
);

// ── Task 2.2: Settings round-trip ──────────────────────────────────────────
describe('settings round-trip preserves both fields', () => {
  beforeEach(() => { storageData = {}; });

  test('saving and loading returns the same url and apiKey', async () => {
    await fc.assert(
      fc.asyncProperty(
        validUrlArb,
        fc.string(),
        async (url, apiKey) => {
          storageData = {};
          await chromeAdapter.saveSettings(url, apiKey);
          const loaded = await chromeAdapter.loadSettings();
          assert.strictEqual(loaded.endpointUrl, url || null);
          assert.strictEqual(loaded.apiKey, apiKey === '' ? null : apiKey);
        },
      ),
    );
  });
});

// ── Task 2.3: URL validation rejects non-HTTP(S) inputs ───────────────────
describe('URL validation rejects non-HTTP(S) inputs', () => {
  beforeEach(() => { storageData = {}; });

  test('validateEndpointUrl returns non-null for strings not starting with http:// or https://', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }).filter(s => !s.startsWith('http://') && !s.startsWith('https://')),
        async (s) => {
          const result = validateEndpointUrl(s);
          assert.ok(result !== null, `Expected non-null error for: ${s}`);
          assert.ok(typeof result === 'string');
        },
      ),
    );
  });

  test('saveDispatchSettings throws for invalid non-HTTP(S) URLs', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }).filter(s => !s.startsWith('http://') && !s.startsWith('https://')),
        async (s) => {
          storageData = {};
          await assert.rejects(
            () => chromeAdapter.saveSettings(s, ''),
            (err) => err instanceof Error,
          );
        },
      ),
    );
  });
});

// ── Task 2.4: Local addresses pass validation ──────────────────────────────
describe('local addresses pass validation', () => {
  test('http://localhost variants are valid', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.nat(65535), { nil: undefined }),
        fc.string(),
        (port, path) => {
          const portPart = port !== undefined ? `:${port}` : '';
          const url = `http://localhost${portPart}${path ? '/' + path : ''}`;
          const result = validateEndpointUrl(url);
          assert.strictEqual(result, null, `Expected null for: ${url}`);
        },
      ),
    );
  });

  test('http://127.0.0.1 variants are valid', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.nat(65535), { nil: undefined }),
        fc.string(),
        (port, path) => {
          const portPart = port !== undefined ? `:${port}` : '';
          const url = `http://127.0.0.1${portPart}${path ? '/' + path : ''}`;
          const result = validateEndpointUrl(url);
          assert.strictEqual(result, null, `Expected null for: ${url}`);
        },
      ),
    );
  });

  test('http://[::1] variants are valid', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.nat(65535), { nil: undefined }),
        fc.string(),
        (port, path) => {
          const portPart = port !== undefined ? `:${port}` : '';
          const url = `http://[::1]${portPart}${path ? '/' + path : ''}`;
          const result = validateEndpointUrl(url);
          assert.strictEqual(result, null, `Expected null for: ${url}`);
        },
      ),
    );
  });
});

// ── Task 2.5: Payload fidelity ─────────────────────────────────────────────
describe('payload fidelity', () => {
  const narrationStepArb = fc.record({
    uuid: fc.uuid(),
    logical_id: fc.uuid(),
    step_number: fc.nat(),
    created_at: fc.string(),
    narration: fc.string({ minLength: 1 }),
    narration_source: fc.constant('typed'),
    actions: fc.array(fc.anything()),
    deleted: fc.boolean(),
  });

  const simpleStepArb = fc.record({
    uuid: fc.uuid(),
    logical_id: fc.uuid(),
    step_number: fc.nat(),
    created_at: fc.string(),
    step_type: fc.constantFrom('action', 'validation'),
    expect: fc.option(fc.constantFrom('present', 'absent'), { nil: undefined }),
    actions: fc.array(fc.anything()),
    deleted: fc.boolean(),
  });

  const stepArb = fc.oneof(narrationStepArb, simpleStepArb);

  const recordingArb = fc.record({
    recording_id: fc.uuid(),
    name: fc.string(),
    created_at: fc.string(),
    steps: fc.array(stepArb),
    metadata: fc.option(fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.oneof(fc.string(), fc.array(fc.string()))), { nil: undefined }),
  });

  const projectArb = fc.record({
    project_id: fc.uuid(),
    name: fc.string(),
    created_at: fc.string(),
    metadata: fc.option(fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.oneof(fc.string(), fc.array(fc.string()))), { nil: undefined }),
  });

  const schemaArb = fc.record({
    title: fc.string(),
    type: fc.constant('object'),
  });

  test('buildPayload preserves all project, recording, and step fields', async () => {
    await fc.assert(
      fc.asyncProperty(
        projectArb,
        fc.array(recordingArb),
        fc.string(),
        schemaArb,
        (project, recordings, readingGuidance, schema) => {
          const payload = buildPayload(project, recordings, readingGuidance, schema);

          assert.strictEqual(payload.reading_guidance, readingGuidance);
          assert.deepStrictEqual(payload.schema, schema);
          assert.strictEqual(payload.project.project_id, project.project_id);
          assert.strictEqual(payload.project.name, project.name);
          assert.strictEqual(payload.project.created_at, project.created_at);
          if (project.metadata) {
            assert.deepStrictEqual(payload.project.metadata, project.metadata);
          } else {
            assert.strictEqual(payload.project.metadata, undefined);
          }
          assert.strictEqual(payload.recordings.length, recordings.length);

          for (let i = 0; i < recordings.length; i++) {
            const src = recordings[i];
            const out = payload.recordings[i];
            assert.strictEqual(out.recording_id, src.recording_id);
            assert.strictEqual(out.name, src.name);
            assert.strictEqual(out.created_at, src.created_at);
            if (src.metadata) {
              assert.deepStrictEqual(out.metadata, src.metadata);
            } else {
              assert.strictEqual(out.metadata, undefined);
            }
            assert.strictEqual(out.steps.length, src.steps.length);

            for (let j = 0; j < src.steps.length; j++) {
              const srcStep = src.steps[j];
              const outStep = out.steps[j];
              assert.strictEqual(outStep.uuid, srcStep.uuid);
              assert.strictEqual(outStep.logical_id, srcStep.logical_id);
              assert.strictEqual(outStep.step_number, srcStep.step_number);
              assert.strictEqual(outStep.created_at, srcStep.created_at);
              assert.strictEqual(outStep.narration, srcStep.narration);
              assert.strictEqual(outStep.narration_source, srcStep.narration_source);
              assert.strictEqual(outStep.step_type, srcStep.step_type);
              assert.strictEqual(outStep.expect, srcStep.expect);
              assert.deepStrictEqual(outStep.actions, srcStep.actions);
              assert.strictEqual(outStep.deleted, srcStep.deleted);
            }
          }
        },
      ),
    );
  });

  test('buildPayload produces exactly four top-level keys: reading_guidance, schema, project, recordings', async () => {
    await fc.assert(
      fc.asyncProperty(
        projectArb,
        fc.array(recordingArb),
        fc.string(),
        schemaArb,
        (project, recordings, readingGuidance, schema) => {
          const payload = buildPayload(project, recordings, readingGuidance, schema);
          const keys = Object.keys(payload).sort();
          assert.deepStrictEqual(keys, ['project', 'reading_guidance', 'recordings', 'schema']);
        },
      ),
    );
  });
});

// ── Task 2.6: API key produces correct Authorization header ────────────────
describe('API key produces correct Authorization header', () => {
  beforeEach(() => {
    globalThis.fetch = undefined;
  });

  test('sendPayload sets Authorization: Bearer <apiKey> for non-empty keys', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }),
        async (apiKey) => {
          let capturedHeaders = null;
          globalThis.fetch = async (_url, init) => {
            capturedHeaders = init.headers;
            return { ok: true, json: async () => ({}) };
          };

          await sendPayload('http://localhost:9999', apiKey, {});
          assert.strictEqual(capturedHeaders['Authorization'], `Bearer ${apiKey}`);
        },
      ),
    );
  });
});

// ── Task 2.7: Error messages surface HTTP status codes and network errors ──
describe('error messages surface HTTP status codes and network errors', () => {
  beforeEach(() => {
    globalThis.fetch = undefined;
  });

  test('sendPayload throws DispatchError with correct status for non-2xx responses', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.integer({ min: 300, max: 399 }),
          fc.integer({ min: 400, max: 499 }),
          fc.integer({ min: 500, max: 599 }),
        ),
        async (code) => {
          globalThis.fetch = async () => ({ ok: false, status: code });

          let thrown = null;
          try {
            await sendPayload('http://localhost:9999', null, {});
          } catch (err) {
            thrown = err;
          }

          assert.ok(thrown instanceof DispatchError, 'Expected DispatchError to be thrown');
          assert.strictEqual(thrown.status, code);
        },
      ),
    );
  });

  test('sendPayload throws DispatchError with null status and original message for network errors', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }),
        async (message) => {
          globalThis.fetch = async () => { throw new Error(message); };

          let thrown = null;
          try {
            await sendPayload('http://localhost:9999', null, {});
          } catch (err) {
            thrown = err;
          }

          assert.ok(thrown instanceof DispatchError, 'Expected DispatchError to be thrown');
          assert.strictEqual(thrown.status, null);
          assert.ok(thrown.message.includes(message), `Expected message to contain: ${message}`);
        },
      ),
    );
  });
});
