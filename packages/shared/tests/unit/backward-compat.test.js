/**
 * backward-compat.test.js — Schema backward-compatibility regression lock (#87).
 *
 * Validates every frozen `.docent.json` fixture under tests/fixtures/ against
 * the CURRENT published platform schema. A fixture is a real export captured at
 * a known schema version; if a later schema change breaks backward
 * compatibility (adds a required field, renames a property, tightens a type),
 * the matching fixture stops validating and this test fails with a clear diff.
 *
 * The harness is schema-agnostic and auto-discovering:
 *   - validators come from globbing `schemas/*.schema.json`
 *   - fixtures come from globbing `tests/fixtures/<platform>/v*.docent.json`
 *   - a fixture under `<platform>/` is validated against `schemas/<platform>.schema.json`
 *
 * Adding a new platform (e.g. desktop-linux, #84) or a new historical version
 * is purely additive: drop a schema and/or a fixture file in. No code changes.
 *
 * Closes #87.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { PLATFORMS, composePlatform } from '../../../../scripts/build-schemas.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES_DIR = resolve(__dirname, '../fixtures');

// ─── Discover platform schemas ────────────────────────────────────────────────

/**
 * Map of platform name → compiled Ajv validator. Each platform schema is
 * COMPOSED FROM SOURCE LAYERS (composePlatform), not read from schemas/dist/.
 * dist/ is the released artifact and can lag the current PR's schema changes;
 * backward-compat must check fixtures against the schema this commit defines.
 * The set of platforms comes from build-schemas' PLATFORMS map — adding a new
 * platform (e.g. desktop-linux, #84) there makes it covered here automatically.
 */
function discoverValidators() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);

  const validators = new Map();
  for (const platform of Object.keys(PLATFORMS)) {
    const schema = composePlatform(platform);
    validators.set(platform, {
      validate: ajv.compile(shapeOnly(schema)),
      version: schema.version,
      file: `${platform}.schema.json (composed from source, shape-only)`,
    });
  }
  return validators;
}

/**
 * Return a clone of a composed schema with the `docent_format.schema_version`
 * `const` relaxed to a plain string — so frozen fixtures validate by SHAPE,
 * regardless of which version stamp they carry.
 *
 * Why: backward compatibility means "an old export still fits today's shape". But
 * the composed schema pins `schema_version` as a `const` (= the current release),
 * so an older-version fixture would fail on the stamp ALONE — the stamp mismatches
 * even when the data shape is fully compatible. Relaxing only that one const lets
 * a v2 fixture validate against a v3 schema if (and only if) the shape still fits,
 * which is exactly what this corpus is meant to catch. It also means a schema
 * major bump needs ZERO fixture re-stamping — the firefight that bit the 3.0.0 /
 * 2.0.0 release.
 *
 * GUARDRAIL: this relaxation is LOCAL TO THIS TEST HARNESS — a throwaway in-memory
 * clone. The published schemas (schemas/dist/), the source layers, and the
 * generated import/sync validators keep the `const` intact; strict import-time
 * version-gating is intentional and untouched. The `platform` const is kept here
 * too (a desktop fixture must not validate against the extension schema).
 */
function shapeOnly(schema) {
  const clone = structuredClone(schema);
  const sv = clone.$defs?.docent_format?.properties?.schema_version;
  if (sv) {
    delete sv.const;
    sv.type = 'string';
  }
  return clone;
}

/**
 * Discover fixtures as { platform, version, path } from
 * `tests/fixtures/<platform>/v<version>.docent.json`.
 */
function discoverFixtures() {
  const fixtures = [];
  if (!existsSync(FIXTURES_DIR)) return fixtures;

  for (const platform of readdirSync(FIXTURES_DIR, { withFileTypes: true })) {
    if (!platform.isDirectory()) continue;
    const platformDir = join(FIXTURES_DIR, platform.name);
    for (const file of readdirSync(platformDir)) {
      if (!file.endsWith('.docent.json')) continue;
      const version = basename(file, '.docent.json').replace(/^v/, '');
      fixtures.push({
        platform: platform.name,
        version,
        path: join(platformDir, file),
      });
    }
  }
  return fixtures;
}

function formatErrors(validate) {
  return (validate.errors || [])
    .map((e) => `  ${e.instancePath || '(root)'} ${e.message} (${JSON.stringify(e.params)})`)
    .join('\n');
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Schema backward compatibility: frozen fixtures validate against current schema', () => {
  let validators;
  let fixtures;

  before(() => {
    validators = discoverValidators();
    fixtures = discoverFixtures();
  });

  it('discovers at least one platform schema and one fixture', () => {
    // Guards against the harness silently passing because globbing found
    // nothing (e.g. moved directories). If this fails, the corpus or schema
    // discovery is misconfigured — not a backward-compat break.
    assert.ok(validators.size >= 1, 'expected to discover at least one platform schema');
    assert.ok(fixtures.length >= 1, 'expected to discover at least one fixture');
  });

  it('every fixture maps to a known platform schema', () => {
    for (const { platform, path } of fixtures) {
      assert.ok(
        validators.has(platform),
        `fixture ${path} is under platform "${platform}" but no schemas/${platform}.schema.json exists`,
      );
    }
  });

  // One assertion per fixture, generated dynamically so a failure names the
  // exact fixture and schema involved.
  it('all frozen fixtures validate against their current platform schema', () => {
    assert.ok(fixtures.length >= 1, 'no fixtures discovered');

    const failures = [];
    for (const { platform, version, path } of fixtures) {
      const entry = validators.get(platform);
      if (!entry) continue; // covered by the mapping test above
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      const valid = entry.validate(data);
      if (!valid) {
        failures.push(
          `Fixture ${platform}/v${version}.docent.json no longer validates against ` +
            `schemas/${entry.file} (current v${entry.version}):\n${formatErrors(entry.validate)}`,
        );
      }
    }

    assert.equal(
      failures.length,
      0,
      `Backward compatibility broken — ${failures.length} fixture(s) failed:\n\n${failures.join('\n\n')}\n\n` +
        `A fixture is a real export frozen at a known schema version. If a schema change ` +
        `intentionally breaks backward compatibility, that is a MAJOR version bump — decide ` +
        `that deliberately before regenerating the fixture.`,
    );
  });
});
