/**
 * samples-conformance.test.js — Guards the bundled seed samples against silent
 * staleness as the platform schemas evolve.
 *
 * The reference server serves two hand-authored sample payloads via
 * `POST /__debug/seed { samples: true }` — one stamped `extension`, one stamped
 * `desktop-windows`. The server is deliberately OPAQUE: it never validates a
 * seeded payload, so nothing on the server side notices when a sample drifts out
 * of conformance with the current schema (a new required field, a changed action
 * shape) or when its `docent_format.schema_version` no longer matches the schema
 * the repo currently composes. A stale sample then silently fails the pulling
 * client's stamp/schema validation — exactly the "green tests, dead in reality"
 * trap.
 *
 * This suite closes that gap at the source. For each bundled sample it:
 *
 *   1. **Shape** — validates the sample against its platform's schema, COMPOSED
 *      FROM THE SOURCE LAYERS in-memory (`composePlatform`), not from
 *      `schemas/dist/` (which lags a PR's schema changes). So a schema shape
 *      change that a sample does not reflect fails HERE, on the feature PR that
 *      makes it — before any release.
 *   2. **Stamp** — asserts the sample's `docent_format.platform` and
 *      `schema_version` equal the consts the composed schema pins. On a feature
 *      PR the schema_version const is frozen at the last release and so is the
 *      sample, so this passes; at release `update-version-table.js` bumps BOTH in
 *      lockstep, so it keeps passing. It only fails if one side is hand-edited
 *      out of step — which is the drift we want caught.
 *
 * Together with the client-pull E2E (extension + desktop), this gives complete
 * guarding: this test pins schema conformance + stamp at the unit layer; the
 * E2E proves a real client actually reconciles the seeded sample end-to-end.
 *
 * The schema is composed via the repo's `scripts/build-schemas.js`
 * (`composePlatform`) — the same single source of truth the apps, sync-shared,
 * and the other schema tests use — and validated with the repo's root `ajv` +
 * `ajv-formats` devDependencies.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 *
 * @module tests/samples-conformance
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { composePlatform } from '../../../../scripts/build-schemas.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = path.join(TEST_DIR, '..', '..', 'samples');

/**
 * The bundled samples, mapped to the platform whose schema each must satisfy.
 * Adding a platform sample (e.g. a future desktop-linux) is a one-line addition
 * here — the assertions below are platform-agnostic.
 */
const SAMPLES = [
  { file: 'extension-sample.json', platform: 'extension' },
  { file: 'desktop-windows-sample.json', platform: 'desktop-windows' },
];

/** Parse a bundled sample payload by filename. */
function loadSample(file) {
  return JSON.parse(readFileSync(path.join(SAMPLES_DIR, file), 'utf8'));
}

/** Compile a platform schema (composed from source layers) into an Ajv validator. */
function compileValidator(platform) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(composePlatform(platform));
}

describe('Reference-server seed samples stay conformant with the current schemas', () => {
  for (const { file, platform } of SAMPLES) {
    describe(`${file} (platform: ${platform})`, () => {
      it('validates against its platform schema composed from the current source layers (shape guard)', () => {
        const sample = loadSample(file);
        const validate = compileValidator(platform);
        const valid = validate(sample);

        assert.ok(
          valid,
          `${file} no longer conforms to the ${platform} schema. A schema shape change ` +
            `landed without updating this sample. Refresh the sample to match the current ` +
            `schema (do NOT loosen the schema to fit a stale sample). Ajv errors:\n` +
            JSON.stringify(validate.errors, null, 2),
        );
      });

      it('carries a docent_format stamp that matches the schema platform + version consts (stamp guard)', () => {
        const sample = loadSample(file);
        const schema = composePlatform(platform);
        const stampDefs = schema.$defs.docent_format.properties;
        const expectedPlatform = stampDefs.platform.const;
        const expectedVersion = stampDefs.schema_version.const;

        assert.equal(
          sample.docent_format?.platform,
          expectedPlatform,
          `${file} docent_format.platform must equal the schema const "${expectedPlatform}"`,
        );
        assert.equal(
          sample.docent_format?.schema_version,
          expectedVersion,
          `${file} docent_format.schema_version ("${sample.docent_format?.schema_version}") is ` +
            `out of step with the current ${platform} schema version ("${expectedVersion}"). ` +
            `At release this is auto-stamped by update-version-table.js; if you see this on a ` +
            `feature branch, a version was hand-edited out of lockstep.`,
        );
      });
    });
  }
});
