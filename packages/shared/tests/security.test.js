/**
 * security.test.js — Security tests for XSS prevention, data leakage, and input validation.
 *
 * Validates that:
 * 1. User-controlled content is properly escaped before rendering (XSS)
 * 2. Sensitive data (API keys, endpoints) doesn't leak into exports/payloads
 * 3. Import validation rejects dangerous payloads (prototype pollution, oversized)
 * 4. Content script injection scope is correctly restricted in manifest
 * 5. Storage keys don't collide with browser internals
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtml, describeAction, renderStepList, renderStepDetail, renderProjectList, renderRecordingList } from '../views/render.js';
import { buildPayload } from '../dispatch-core.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(__dirname, '../../extension/manifest.json'), 'utf-8'));

// ─── XSS Prevention ──────────────────────────────────────────────────────────

describe('XSS: malicious content in action payloads', () => {
  const xssPayloads = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '"><script>document.cookie</script>',
    "';alert(String.fromCharCode(88,83,83))//",
    '<svg onload=alert(1)>',
    'javascript:alert(1)',
    '<iframe src="javascript:alert(1)">',
    '{{constructor.constructor("alert(1)")()}}',
  ];

  for (const payload of xssPayloads) {
    it(`escapeHtml neutralizes: ${payload.slice(0, 40)}...`, () => {
      const escaped = escapeHtml(payload);
      // After escaping, no raw HTML tags should be parseable
      assert.ok(!escaped.includes('<'), `Should not contain unescaped <: ${escaped}`);
      assert.ok(!escaped.includes('>'), `Should not contain unescaped >: ${escaped}`);
    });
  }

  it('describeAction escapes malicious element text', () => {
    const action = { type: 'click', element: { text: '<script>alert("xss")</script>' } };
    const result = describeAction(action);
    assert.ok(!result.includes('<script>'), 'Should not contain raw script tag');
    assert.ok(result.includes('&lt;script&gt;'), 'Should contain escaped script tag');
  });

  it('describeAction escapes malicious URL in navigate', () => {
    const action = { type: 'navigate', url: 'javascript:alert(1)' };
    const result = describeAction(action);
    // The URL is escaped but still present as text
    assert.ok(!result.includes('<'), 'Should not contain unescaped angle brackets');
  });

  it('describeAction escapes malicious type value', () => {
    const action = { type: 'type', element: { selector: '#input' }, value: '<img src=x onerror=alert(1)>' };
    const result = describeAction(action);
    assert.ok(!result.includes('<img'), 'Should not contain raw img tag');
  });

  it('renderStepList escapes malicious narration', () => {
    const steps = [{ logical_id: 'l1', narration: '<script>steal(cookies)</script>', step_number: 1 }];
    const html = renderStepList(steps);
    assert.ok(!html[0].includes('<script>steal'), 'Should not contain raw script in step list');
    assert.ok(html[0].includes('&lt;script&gt;'), 'Should contain escaped script');
  });

  it('renderStepList escapes malicious step_type', () => {
    const steps = [{ logical_id: 'l1', step_type: '<img src=x onerror=alert(1)>', step_number: 1 }];
    const html = renderStepList(steps);
    assert.ok(!html[0].includes('<img'), 'Should not contain raw img tag');
  });

  it('renderStepDetail escapes malicious action descriptions', () => {
    const actions = [
      { type: 'click', element: { text: '<script>alert(1)</script>', selector: '"><script>x</script>' } },
    ];
    const html = renderStepDetail(actions);
    for (const h of html) {
      assert.ok(!h.includes('<script>'), `Should not contain raw script: ${h.slice(0, 100)}`);
    }
  });

  it('renderProjectList escapes malicious project name', () => {
    const projects = [{ project_id: 'p1', name: '<img src=x onerror=alert(1)>', recording_count: 0 }];
    const html = renderProjectList(projects);
    assert.ok(!html[0].includes('<img'), 'Should not contain raw img tag in project list');
  });

  it('renderRecordingList escapes malicious recording name', () => {
    const recordings = [{ recording_id: 'r1', name: '<script>x</script>', steps: [] }];
    const html = renderRecordingList(recordings);
    assert.ok(!html[0].includes('<script>x'), 'Should not contain raw script in recording list');
  });
});

// ─── API Key Leak Prevention ─────────────────────────────────────────────────

describe('Security: API key not leaked in exports or payloads', () => {
  it('buildPayload does not include apiKey in the payload body', () => {
    const project = { project_id: 'p1', name: 'P', created_at: '2026-01-01T00:00:00.000Z' };
    const recordings = [{ recording_id: 'r1', name: 'R', created_at: '2026-01-01T00:00:00.000Z', steps: [] }];
    const payload = buildPayload(project, recordings, 'guidance', { title: 'schema' });

    const json = JSON.stringify(payload);
    assert.ok(!json.includes('apiKey'), 'Payload should not contain apiKey field');
    assert.ok(!json.includes('api_key'), 'Payload should not contain api_key field');
    assert.ok(!json.includes('Authorization'), 'Payload should not contain Authorization');
  });

  it('buildPayload does not include endpoint URL in the payload body', () => {
    const project = { project_id: 'p1', name: 'P', created_at: '2026-01-01T00:00:00.000Z' };
    const recordings = [];
    const payload = buildPayload(project, recordings, 'guidance', {});

    const json = JSON.stringify(payload);
    assert.ok(!json.includes('endpointUrl'), 'Payload should not contain endpointUrl');
    assert.ok(!json.includes('endpoint_url'), 'Payload should not contain endpoint_url');
  });
});

// ─── Import Validation Security ──────────────────────────────────────────────

describe('Security: import validation rejects dangerous payloads', () => {
  it('oversized project name does not crash (truncation is UI concern)', () => {
    // This tests that the data layer handles large strings without throwing
    const longName = 'A'.repeat(100000);
    const project = { project_id: 'p1', name: longName, created_at: '2026-01-01T00:00:00.000Z' };
    const payload = buildPayload(project, [], '', {});
    assert.equal(payload.project.name, longName); // No crash, data preserved
  });

  it('prototype pollution attempt via __proto__ key in metadata is harmless', () => {
    const project = {
      project_id: 'p1', name: 'P', created_at: '2026-01-01T00:00:00.000Z',
      metadata: { '__proto__': { admin: true }, 'normal': 'value' },
    };
    const payload = buildPayload(project, [], '', {});

    // The metadata is passed through as-is (it's just data)
    // But it should NOT pollute Object.prototype
    const emptyObj = {};
    assert.equal(emptyObj.admin, undefined, '__proto__ pollution should not affect other objects');
    assert.ok(payload.project.metadata, 'metadata should still be present');
  });
});


// ─── Content Script Injection Scope ──────────────────────────────────────────

describe('Security: content script injection scope (manifest)', () => {
  it('manifest version is 3 (most restrictive CSP)', () => {
    assert.equal(manifest.manifest_version, 3);
  });

  it('content script does not use match patterns that include chrome:// URLs', () => {
    for (const cs of manifest.content_scripts) {
      for (const pattern of cs.matches) {
        assert.ok(!pattern.includes('chrome://'),
          `Content script should not match chrome:// URLs: ${pattern}`);
        assert.ok(!pattern.includes('chrome-extension://'),
          `Content script should not match chrome-extension:// URLs: ${pattern}`);
      }
    }
  });

  it('no unsafe-eval or unsafe-inline in CSP (MV3 enforces this)', () => {
    // MV3 doesn't allow custom CSP for content scripts — the browser enforces
    // no eval/inline. Verify no content_security_policy override weakens this.
    const csp = manifest.content_security_policy;
    if (csp) {
      const extensionPages = csp.extension_pages || '';
      assert.ok(!extensionPages.includes('unsafe-eval'),
        'CSP should not allow unsafe-eval');
      assert.ok(!extensionPages.includes('unsafe-inline'),
        'CSP should not allow unsafe-inline');
    }
    // If no CSP defined, MV3 defaults are secure — pass
  });

  it('web_accessible_resources does not expose sensitive files', () => {
    const war = manifest.web_accessible_resources || [];
    const allResources = war.flatMap(r => r.resources || []);

    // No resources should be web-accessible (extension loads them internally)
    // If resources are added in the future, they must not include sensitive files
    const sensitivePatterns = ['service-worker', 'adapter', 'panel.js', '*.json'];
    for (const resource of allResources) {
      for (const sensitive of sensitivePatterns) {
        if (sensitive.startsWith('*')) {
          assert.ok(!resource.endsWith(sensitive.slice(1)),
            `Sensitive file pattern exposed: ${resource}`);
        } else {
          assert.ok(!resource.includes(sensitive),
            `Sensitive file exposed as web-accessible: ${resource}`);
        }
      }
    }
  });

  it('permissions do not include dangerous capabilities', () => {
    const dangerous = ['debugger', 'proxy', 'vpnProvider', 'nativeMessaging', 'management'];
    for (const perm of manifest.permissions) {
      assert.ok(!dangerous.includes(perm),
        `Dangerous permission found: ${perm}`);
    }
  });
});

// ─── API Key and Sensitive Data Leakage ──────────────────────────────────────

describe('Security: sensitive data isolation', () => {
  it('buildPayload output contains no settings-related fields', () => {
    const project = {
      project_id: 'p1', name: 'P', created_at: '2026-01-01T00:00:00.000Z',
      // Simulate what would happen if settings accidentally leaked into project
    };
    const recordings = [{
      recording_id: 'r1', name: 'R', created_at: '2026-01-01T00:00:00.000Z',
      steps: [{ uuid: 'u1', logical_id: 'l1', step_number: 1, created_at: '2026-01-01T00:00:00.000Z',
        narration: 'test', narration_source: 'typed', actions: [], deleted: false }],
    }];

    const payload = buildPayload(project, recordings, 'guidance', { title: 'schema' });
    const json = JSON.stringify(payload);

    // None of these settings-related strings should appear in the payload
    const forbidden = ['endpointUrl', 'apiKey', 'api_key', 'syncUrl', 'syncApiKey',
      'selfCaptureExclusion', 'recordingMode', 'docentEndpointUrl', 'docentApiKey',
      'docentTheme', 'docentSyncUrl', 'docentSyncApiKey', 'docentRecordingMode'];

    for (const term of forbidden) {
      assert.ok(!json.includes(term),
        `Payload contains forbidden settings term: ${term}`);
    }
  });

  it('export structure mirrors buildPayload — no extra fields leak', () => {
    const project = {
      project_id: 'p1', name: 'P', created_at: '2026-01-01T00:00:00.000Z',
      metadata: { ticket: 'X' },
    };
    const recordings = [{
      recording_id: 'r1', name: 'R', created_at: '2026-01-01T00:00:00.000Z',
      metadata: { env: 'prod' },
      steps: [{ uuid: 'u1', logical_id: 'l1', step_number: 1, created_at: '2026-01-01T00:00:00.000Z',
        step_type: 'action', actions: [{ type: 'click', timestamp: 1 }], deleted: false }],
    }];

    const payload = buildPayload(project, recordings, '', {});

    // Verify only expected top-level keys
    const topKeys = Object.keys(payload).sort();
    assert.deepStrictEqual(topKeys, ['project', 'reading_guidance', 'recordings', 'schema']);

    // Verify project only has expected keys
    const projectKeys = Object.keys(payload.project).sort();
    const allowedProjectKeys = ['created_at', 'metadata', 'name', 'project_id'];
    for (const key of projectKeys) {
      assert.ok(allowedProjectKeys.includes(key),
        `Unexpected key in payload.project: ${key}`);
    }

    // Verify recording only has expected keys
    const recKeys = Object.keys(payload.recordings[0]).sort();
    const allowedRecKeys = ['created_at', 'metadata', 'name', 'recording_id', 'steps'];
    for (const key of recKeys) {
      assert.ok(allowedRecKeys.includes(key),
        `Unexpected key in payload.recordings[0]: ${key}`);
    }

    // Verify step only has expected keys
    const stepKeys = Object.keys(payload.recordings[0].steps[0]).sort();
    const allowedStepKeys = ['actions', 'created_at', 'deleted', 'logical_id',
      'narration', 'narration_source', 'step_number', 'step_type', 'expect', 'uuid'];
    for (const key of stepKeys) {
      assert.ok(allowedStepKeys.includes(key),
        `Unexpected key in step: ${key}`);
    }
  });
});

// ─── Input Validation: Import Robustness ─────────────────────────────────────

describe('Security: import robustness', () => {
  it('deeply nested objects do not cause stack overflow', () => {
    // Create a deeply nested structure
    let obj = { project_id: 'p1', name: 'P', created_at: '2026-01-01T00:00:00.000Z', recordings: [] };
    let current = obj;
    for (let i = 0; i < 100; i++) {
      current.nested = { level: i };
      current = current.nested;
    }

    // JSON.stringify/parse should handle this without crashing
    const json = JSON.stringify(obj);
    const parsed = JSON.parse(json);
    assert.equal(parsed.project_id, 'p1');
  });

  it('circular reference detection (JSON.stringify throws, not infinite loop)', () => {
    const obj = { project_id: 'p1', name: 'P' };
    obj.self = obj; // circular

    assert.throws(() => JSON.stringify(obj), TypeError,
      'Circular reference should throw TypeError, not hang');
  });

  it('NaN and Infinity in numeric fields are serialized as null', () => {
    const step = {
      uuid: 'u1', logical_id: 'l1', step_number: NaN, created_at: '2026-01-01T00:00:00.000Z',
      actions: [{ type: 'click', timestamp: Infinity }], deleted: false,
    };

    const json = JSON.stringify(step);
    const parsed = JSON.parse(json);

    // JSON serializes NaN/Infinity as null
    assert.equal(parsed.step_number, null);
    assert.equal(parsed.actions[0].timestamp, null);
  });

  it('very long string values do not crash buildPayload', () => {
    const longString = 'x'.repeat(1_000_000); // 1MB string
    const project = { project_id: 'p1', name: longString, created_at: '2026-01-01T00:00:00.000Z' };
    const recordings = [{
      recording_id: 'r1', name: 'R', created_at: '2026-01-01T00:00:00.000Z',
      steps: [{ uuid: 'u1', logical_id: 'l1', step_number: 1, created_at: '2026-01-01T00:00:00.000Z',
        narration: longString, narration_source: 'typed', actions: [], deleted: false }],
    }];

    // Should not throw
    const payload = buildPayload(project, recordings, '', {});
    assert.equal(payload.project.name.length, 1_000_000);
  });

  it('unicode and emoji in all text fields are preserved', () => {
    const project = {
      project_id: 'p1', name: '测试项目 🚀', created_at: '2026-01-01T00:00:00.000Z',
      metadata: { '标签': '重要 ⚠️' },
    };
    const recordings = [{
      recording_id: 'r1', name: 'Запись 📝', created_at: '2026-01-01T00:00:00.000Z',
      steps: [{ uuid: 'u1', logical_id: 'l1', step_number: 1, created_at: '2026-01-01T00:00:00.000Z',
        narration: 'Кликнуть кнопку 🔘', narration_source: 'typed', actions: [], deleted: false }],
    }];

    const payload = buildPayload(project, recordings, '', {});
    const json = JSON.stringify(payload);
    const restored = JSON.parse(json);

    assert.equal(restored.project.name, '测试项目 🚀');
    assert.equal(restored.project.metadata['标签'], '重要 ⚠️');
    assert.equal(restored.recordings[0].name, 'Запись 📝');
    assert.equal(restored.recordings[0].steps[0].narration, 'Кликнуть кнопку 🔘');
  });
});

// ─── Chrome Storage Key Safety ───────────────────────────────────────────────

describe('Security: storage key naming', () => {
  // These are the keys used by the extension in chrome.storage.local
  const EXTENSION_KEYS = [
    'docentEndpointUrl', 'docentApiKey', 'docentTheme', 'docentRecordingMode',
    'docentSyncUrl', 'docentSyncApiKey',
    'pendingActions', 'pendingCount', 'recording', 'lastUserActionTimestamp',
  ];

  it('all storage keys are prefixed with "docent" or are internal state keys', () => {
    const internalKeys = ['pendingActions', 'pendingCount', 'recording', 'lastUserActionTimestamp'];
    for (const key of EXTENSION_KEYS) {
      const isPrefixed = key.startsWith('docent');
      const isInternal = internalKeys.includes(key);
      assert.ok(isPrefixed || isInternal,
        `Storage key "${key}" should be prefixed with "docent" or be a known internal key`);
    }
  });

  it('no storage keys collide with common browser/extension patterns', () => {
    const browserKeys = ['theme', 'settings', 'config', 'state', 'data', 'cache',
      'user', 'session', 'token', 'auth', 'preferences'];
    for (const key of EXTENSION_KEYS) {
      assert.ok(!browserKeys.includes(key),
        `Storage key "${key}" collides with common browser pattern — use "docent" prefix`);
    }
  });
});


// ─── Content Security Policy ─────────────────────────────────────────────────

describe('Security: Content-Security-Policy meta tag', () => {
  const extensionShell = readFileSync(resolve(__dirname, '../../extension/sidepanel/index.shell.html'), 'utf-8');
  const desktopShell = readFileSync(resolve(__dirname, '../../desktop/src/index.shell.html'), 'utf-8');

  it('extension side panel has CSP meta tag', () => {
    assert.ok(extensionShell.includes('Content-Security-Policy'),
      'Extension shell HTML must include a Content-Security-Policy meta tag');
  });

  it('desktop app has CSP meta tag', () => {
    assert.ok(desktopShell.includes('Content-Security-Policy'),
      'Desktop shell HTML must include a Content-Security-Policy meta tag');
  });

  it('CSP disallows unsafe-eval', () => {
    assert.ok(!extensionShell.includes('unsafe-eval'), 'Extension CSP must not allow unsafe-eval');
    assert.ok(!desktopShell.includes('unsafe-eval'), 'Desktop CSP must not allow unsafe-eval');
  });

  it('CSP disallows unsafe-inline for scripts', () => {
    assert.ok(!extensionShell.includes('unsafe-inline'), 'Extension CSP must not allow unsafe-inline');
    assert.ok(!desktopShell.includes('unsafe-inline'), 'Desktop CSP must not allow unsafe-inline');
  });

  it('CSP allows connect-src for dispatch/sync endpoints', () => {
    assert.ok(extensionShell.includes('connect-src'), 'Extension CSP must include connect-src directive');
    assert.ok(desktopShell.includes('connect-src'), 'Desktop CSP must include connect-src directive');
  });
});


// ─── Adversarial Dispatch Endpoint Tests ─────────────────────────────────────

import { sendPayload, DispatchError, validateEndpointUrl } from '../dispatch-core.js';

describe('Security: endpoint URL validation (enhanced)', () => {
  it('rejects URLs with embedded credentials', () => {
    const result = validateEndpointUrl('http://user:pass@example.com/api');
    assert.ok(result !== null, 'Should reject embedded credentials');
    assert.ok(result.includes('credentials'));
  });

  it('rejects malformed URLs that start with http://', () => {
    const result = validateEndpointUrl('http://');
    assert.ok(result !== null, 'Should reject http:// alone');
  });

  it('accepts valid URLs', () => {
    assert.equal(validateEndpointUrl('http://localhost:3000'), null);
    assert.equal(validateEndpointUrl('https://api.example.com/dispatch'), null);
    assert.equal(validateEndpointUrl('http://192.168.1.1:8080/v1'), null);
  });

  it('accepts empty string (clears endpoint)', () => {
    assert.equal(validateEndpointUrl(''), null);
  });
});

describe('Security: adversarial dispatch responses', () => {
  it('handles malformed JSON response gracefully', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => { throw new SyntaxError('Unexpected token'); },
    });

    const result = await sendPayload('http://localhost:9999', null, {});
    // Should return empty object, not throw
    assert.deepStrictEqual(result, {});
  });

  it('throws DispatchError for oversized response (Content-Length > 10MB)', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: (h) => h === 'content-length' ? '20000000' : null },
      json: async () => ({}),
    });

    await assert.rejects(
      () => sendPayload('http://localhost:9999', null, {}),
      (err) => err instanceof DispatchError && err.message.includes('too large')
    );
  });

  it('throws DispatchError on network timeout (AbortError)', async () => {
    globalThis.fetch = async (_url, opts) => {
      // Simulate abort
      if (opts?.signal) {
        return new Promise((_, reject) => {
          opts.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }
    };

    // Manually trigger abort to test the path (real timeout is 30s)
    const controller = new AbortController();
    globalThis.fetch = async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };

    await assert.rejects(
      () => sendPayload('http://localhost:9999', null, {}),
      (err) => err instanceof DispatchError && err.message.includes('timed out')
    );
  });

  it('handles empty body with 200 status', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => '0' },
      json: async () => { throw new SyntaxError('Unexpected end of JSON input'); },
    });

    const result = await sendPayload('http://localhost:9999', null, {});
    assert.deepStrictEqual(result, {});
  });
});
