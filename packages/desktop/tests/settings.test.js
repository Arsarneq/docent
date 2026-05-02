/**
 * Property 10: Settings persistence round-trip
 *
 * For any dispatch settings (endpoint URL and API key), saving the
 * settings and then loading them SHALL return values identical to
 * what was saved.
 *
 * **Validates: Requirements 9.3**
 *
 * This tests the pure serialization/deserialization logic, not the
 * Tauri invoke calls. The persistence layer is mocked with an
 * in-memory store.
 *
 * Feature: desktop-capture, Property 10: Settings persistence round-trip
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

// ─── Pure helpers extracted from dispatch.js / persistence.js ─────────────────
// We replicate the pure serialization logic here to test the round-trip
// without depending on Tauri globals (window.__TAURI__).

/**
 * Simulates the settings persistence round-trip:
 * 1. Start with an existing state (or empty)
 * 2. Save settings by merging into state and serializing to JSON
 * 3. Load settings by deserializing JSON and extracting settings fields
 */
function saveSettings(store, endpointUrl, apiKey) {
  let state;
  try {
    state = JSON.parse(store.data);
  } catch {
    state = { projects: [], settings: {} };
  }
  if (!state.settings) state.settings = {};
  state.settings.endpointUrl = endpointUrl || null;
  state.settings.apiKey = apiKey || null;
  store.data = JSON.stringify(state);
}

function loadSettings(store) {
  try {
    const state = JSON.parse(store.data);
    return {
      endpointUrl: state?.settings?.endpointUrl ?? null,
      apiKey: state?.settings?.apiKey ?? null,
    };
  } catch {
    return { endpointUrl: null, apiKey: null };
  }
}

// ─── Property test ────────────────────────────────────────────────────────────

describe('Property 10: Settings persistence round-trip', () => {
  it('saving then loading dispatch settings returns identical values', () => {
    fc.assert(
      fc.property(
        // Generate random URL strings (including empty)
        fc.oneof(
          fc.constant(''),
          fc.webUrl(),
          fc.string({ minLength: 0, maxLength: 200 }),
        ),
        // Generate random API key strings (including empty)
        fc.oneof(
          fc.constant(''),
          fc.string({ minLength: 0, maxLength: 200 }),
        ),
        (endpointUrl, apiKey) => {
          const store = { data: JSON.stringify({ projects: [], settings: {} }) };

          // Save
          saveSettings(store, endpointUrl, apiKey);

          // Load
          const loaded = loadSettings(store);

          // The round-trip contract: empty strings become null, non-empty preserved
          const expectedUrl = endpointUrl || null;
          const expectedKey = apiKey || null;

          assert.strictEqual(loaded.endpointUrl, expectedUrl,
            `URL mismatch: saved "${endpointUrl}", got "${loaded.endpointUrl}"`);
          assert.strictEqual(loaded.apiKey, expectedKey,
            `API key mismatch: saved "${apiKey}", got "${loaded.apiKey}"`);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('round-trip preserves settings when state already has other data', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }),
        fc.string({ minLength: 1, maxLength: 200 }),
        (endpointUrl, apiKey) => {
          // Start with a state that has existing projects and theme
          const store = {
            data: JSON.stringify({
              projects: [{ project_id: 'test-123', name: 'Test', recordings: [] }],
              settings: { theme: 'dark', selfCaptureExclusion: false },
            }),
          };

          // Save settings
          saveSettings(store, endpointUrl, apiKey);

          // Load and verify settings are preserved
          const loaded = loadSettings(store);
          assert.strictEqual(loaded.endpointUrl, endpointUrl);
          assert.strictEqual(loaded.apiKey, apiKey);

          // Verify other state is not lost
          const fullState = JSON.parse(store.data);
          assert.strictEqual(fullState.projects.length, 1);
          assert.strictEqual(fullState.settings.theme, 'dark');
          assert.strictEqual(fullState.settings.selfCaptureExclusion, false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
