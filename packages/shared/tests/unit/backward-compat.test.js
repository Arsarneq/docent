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

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
const SCHEMAS_DIR = join(REPO_ROOT, 'schemas');
const FIXTURES_DIR = resolve(__dirname, '../fixtures');

// ─── Discover platform schemas ────────────────────────────────────────────────

/**
 * Map of platform name → compiled Ajv validator, discovered from
 * `schemas/<platform>.schema.json`. `shared.schema.json` is excluded — it holds
 * shared $defs and is not a standalone export schema.
 */
function discoverValidators() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);

  const validators = new Map();
  const schemaFiles = readdirSync(SCHEMAS_DIR).filter(
    (f) => f.endsWith('.schema.json') && f !== 'shared.schema.json',
  );

  for (const file of schemaFiles) {
    const platform = basename(file, '.schema.json');
    const schema = JSON.parse(readFileSync(join(SCHEMAS_DIR, file), 'utf-8'));
    validators.set(platform, {
      validate: ajv.compile(schema),
      version: schema.version,
      file,
    });
  }
  return validators;
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
