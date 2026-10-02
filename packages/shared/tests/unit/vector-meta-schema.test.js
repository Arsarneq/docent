/**
 * vector-meta-schema.test.js — pins corpus/lib/vector-meta-schema.js, the one
 * home of the shipped conformance-vector outcome and of the meta-schema
 * validator every vector producer and the hygiene suite share.
 *
 * Pinned here:
 *  - the module's SHIPPED_OUTCOME equals the meta-schema's expected_outcome
 *    const (read from the committed file, not through the module);
 *  - the error reporter names each seeded violation — a wrong outcome, a
 *    missing required field, and a snapshot whose node shape is the other
 *    platform's;
 *  - the vector emitters, fed the inputs a committed vector was produced from,
 *    stamp the shipped outcome and reproduce that vector exactly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SHIPPED_OUTCOME,
  VECTOR_META_SCHEMA_PATH,
  metaSchemaErrors,
  formatMetaSchemaErrors,
} from '../../../../corpus/lib/vector-meta-schema.js';
import { buildDesktopVector } from '../../../../scripts/corpus-assemble-desktop-vectors.js';
import { buildVectors } from '../../../extension/tests/e2e/helpers/vector-snapshot.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CORPUS_DIR = resolve(__dirname, '../../../../corpus');
const SCHEMA_FILE = join(CORPUS_DIR, 'vector.schema.json');

/** Every committed vector, with the session dir and file key it sits under. */
function committedVectors() {
  const sessionsDir = join(CORPUS_DIR, 'sessions');
  const found = [];
  for (const session of readdirSync(sessionsDir)) {
    const dir = join(sessionsDir, session, 'vectors');
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.vector.json')) continue;
      const vector = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      found.push({ session, key: name.slice(0, -'.vector.json'.length), vector });
    }
  }
  return found;
}

const vectors = committedVectors();
const byPlatform = (platform) => vectors.find((v) => v.vector.platform === platform);

describe('vector meta-schema module: the shipped outcome', () => {
  it('SHIPPED_OUTCOME equals the meta-schema expected_outcome const', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_FILE, 'utf8'));
    assert.equal(SHIPPED_OUTCOME, schema.properties.expected_outcome.const);
  });

  it('the module loads the committed meta-schema file', () => {
    assert.equal(resolve(VECTOR_META_SCHEMA_PATH), resolve(SCHEMA_FILE));
  });
});

describe('vector meta-schema module: the validator', () => {
  it('rejects a vector stating any other outcome', () => {
    const vector = {
      ...structuredClone(byPlatform('extension').vector),
      expected_outcome: 'bogus',
    };
    const errors = metaSchemaErrors(vector);
    assert.ok(
      errors.some((e) => e.instancePath === '/expected_outcome' && e.keyword === 'const'),
      formatMetaSchemaErrors(errors),
    );
  });

  it('rejects a vector missing a required field', () => {
    const vector = structuredClone(byPlatform('desktop-windows').vector);
    delete vector.ground_truth;
    const errors = metaSchemaErrors(vector);
    assert.ok(
      errors.some((e) => e.keyword === 'required' && e.params.missingProperty === 'ground_truth'),
      formatMetaSchemaErrors(errors),
    );
  });

  it('rejects a snapshot whose node shape is the other platform’s', () => {
    const ext = structuredClone(byPlatform('extension').vector);
    const desk = structuredClone(byPlatform('desktop-windows').vector);
    [ext.tree_snapshot, desk.tree_snapshot] = [desk.tree_snapshot, ext.tree_snapshot];

    // Ajv reports an error inside a $ref'd definition against that definition's
    // own root (`#/required`), so the platform branch is identified by the
    // failing `allOf` conditional and the node shape by its missing key.
    const branchFailed = (errors, n, missing) =>
      errors.some((e) => e.keyword === 'if' && e.schemaPath === `#/allOf/${n}/if`) &&
      errors.some((e) => e.instancePath === '/tree_snapshot' && e.params.missingProperty === missing); // prettier-ignore

    const extErrors = metaSchemaErrors(ext);
    assert.ok(branchFailed(extErrors, 0, 'tag'), formatMetaSchemaErrors(extErrors));
    const deskErrors = metaSchemaErrors(desk);
    assert.ok(branchFailed(deskErrors, 1, 'control_type'), formatMetaSchemaErrors(deskErrors));
  });

  it('formats every error on its own line, naming its instance path', () => {
    const vector = structuredClone(byPlatform('extension').vector);
    vector.expected_outcome = 'bogus';
    delete vector.vector_id;
    const errors = metaSchemaErrors(vector);
    const lines = formatMetaSchemaErrors(errors).split('\n');
    assert.equal(lines.length, errors.length);
    assert.ok(lines.some((l) => l.startsWith('/expected_outcome ')));
    assert.ok(lines.some((l) => l.startsWith('/ ') && l.includes('vector_id')));
  });
});

describe('vector emitters: the shipped outcome, reproduced from committed inputs', () => {
  it('the desktop assembler rebuilds every committed desktop vector exactly', () => {
    const desktop = vectors.filter((v) => v.vector.platform === 'desktop-windows');
    assert.ok(desktop.length >= 1);
    for (const { session, key, vector: committed } of desktop) {
      const built = buildDesktopVector({
        fixture: session,
        window_title: committed.scope.window,
        element: { ...committed.element_facts, locators: committed.locators },
        tree_snapshot: committed.tree_snapshot,
        ground_truth_node_id: committed.ground_truth.node_id,
      });
      assert.equal(built.key, key);
      assert.equal(built.vector.expected_outcome, SHIPPED_OUTCOME);
      assert.deepEqual(metaSchemaErrors(built.vector), []);
      assert.deepEqual(built.vector, committed);
    }
  });

  it('the extension emitter rebuilds every committed extension vector exactly', () => {
    const extension = vectors.filter((v) => v.vector.platform === 'extension');
    assert.ok(extension.length >= 1);
    for (const { session, key, vector: committed } of extension) {
      const [built] = buildVectors(
        session,
        [
          {
            key,
            snapshot: committed.tree_snapshot,
            groundTruthNodeId: committed.ground_truth.node_id,
          },
        ],
        [
          {
            element: { ...committed.element_facts, locators: committed.locators },
            frame_src: committed.scope.frame_src,
          },
        ],
      );
      assert.equal(built.expected_outcome, SHIPPED_OUTCOME);
      assert.deepEqual(metaSchemaErrors(built), []);
      assert.deepEqual(built, committed);
    }
  });
});
