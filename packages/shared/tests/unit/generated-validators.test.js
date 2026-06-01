/**
 * generated-validators.test.js — Verifies the GENERATED Ajv-standalone
 * validators (SECURITY_BACKLOG S12) accept valid payloads and reject the cases
 * that matter, including the now-required `docent_format` stamp.
 *
 * These import the build-only artifacts in packages/shared/generated/, so they
 * require `npm run sync-shared` (or `node scripts/build-validators.js`) to have
 * run first — the same precondition the build-size tests already rely on. The
 * test self-skips with a clear message if the artifacts are absent, so a fresh
 * checkout that hasn't built yet fails loudly on the missing build step rather
 * than mysteriously.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const GENERATED_DIR = resolve(__dirname, '../../generated');
const FIXTURES_DIR = resolve(__dirname, '../fixtures');

const PLATFORMS = [
  { key: 'extension', fixture: 'extension/v2.0.0.docent.json' },
  { key: 'desktop-windows', fixture: 'desktop-windows/v1.0.0.docent.json' },
];

for (const { key, fixture } of PLATFORMS) {
  describe(`generated validator: ${key}`, () => {
    let validate;
    let validFixture;

    before(async () => {
      const file = join(GENERATED_DIR, `validate-${key}.js`);
      assert.ok(
        existsSync(file),
        `Missing ${file} — run \`npm run sync-shared\` (or node scripts/build-validators.js) before this test.`,
      );
      validate = (await import(pathToFileURL(file).href)).default;
      validFixture = JSON.parse(readFileSync(join(FIXTURES_DIR, fixture), 'utf8'));
    });

    it('accepts the frozen valid fixture', () => {
      assert.equal(validate(validFixture), true, JSON.stringify(validate.errors));
    });

    it('rejects a payload missing the docent_format stamp', () => {
      const { docent_format: _omit, ...stampLess } = validFixture;
      assert.equal(validate(stampLess), false);
      assert.ok(Array.isArray(validate.errors) && validate.errors.length > 0);
    });

    it('rejects a payload missing project', () => {
      const { project: _omit, ...noProject } = validFixture;
      assert.equal(validate(noProject), false);
    });

    it('rejects a payload missing recordings', () => {
      const { recordings: _omit, ...noRecordings } = validFixture;
      assert.equal(validate(noRecordings), false);
    });

    it('rejects an unknown top-level key (additionalProperties false)', () => {
      assert.equal(validate({ ...validFixture, sneaky: true }), false);
    });
  });
}
