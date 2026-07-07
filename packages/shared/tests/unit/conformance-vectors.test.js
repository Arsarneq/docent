/**
 * conformance-vectors.test.js — hygiene locks over the committed conformance
 * vectors (corpus/sessions/<id>/vectors/*.vector.json), mirroring
 * corpus-compare.test.js.
 *
 * A vector is inert data under docs/locator-resolution.md (Conformance and
 * Vector Scope): a recorded element's locator candidates + its non-locator
 * facts, a serialized snapshot of the bound scope, the ground-truth node, and
 * the node_ids each candidate's stated query selects over that snapshot. The
 * locks are structural: each is a per-candidate match COUNT (measured over the
 * committed snapshot by measureStrategyMatches) or a committed-field EQUALITY.
 * There is no function that turns a vector into an outcome; the expected_outcome
 * "resolved" guarantee EMERGES from the counts and equalities the locks check —
 * it is never computed here.
 *
 * Locks:
 *  (1) the vector names an active manifest session of its platform;
 *  (2) element_facts + locators equal a captured element of that session;
 *  (3) an eligible candidate is measured-unique (match_count 1, match_index 0);
 *  (4) ground_truth.node_id exists in tree_snapshot;
 *  (5) over the snapshot, every eligible candidate selects exactly the ground
 *      truth or is non-selecting (0 or >1), no eligible candidate selects a
 *      single other node, the measured-unique candidate selects exactly the
 *      ground truth, and the recorded matched_node_ids re-derive;
 *  (6) the ground-truth node's committed tag/text fields equal element_facts.
 *
 * Plus: the walker reproduces the committed snapshot, and the measurement is
 * faithful to the spec's extension strategy table.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { discoverSessions } from '../../../../scripts/corpus-compare.js';
import { serializeSnapshot } from '../../../../corpus/lib/snapshot-walker.js';
import { measureStrategyMatches } from './vector-measurement.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CORPUS_DIR = resolve(__dirname, '../../../../corpus');
const MANIFEST_PATH = join(CORPUS_DIR, 'manifest.json');

const metaSchema = JSON.parse(readFileSync(join(CORPUS_DIR, 'vector.schema.json'), 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validateVector = ajv.compile(metaSchema);

/** Every `.vector.json` committed under corpus/sessions/<id>/vectors/. */
function discoverVectors() {
  const sessionsDir = join(CORPUS_DIR, 'sessions');
  const found = [];
  for (const session of readdirSync(sessionsDir)) {
    const dir = join(sessionsDir, session, 'vectors');
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.vector.json')) continue;
      const vector = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      found.push({ session, name, vector });
    }
  }
  return found;
}

/** Pre-order list of every node in a snapshot subtree. */
function flattenNodes(root) {
  const acc = [];
  const visit = (n) => {
    acc.push(n);
    for (const c of n.children ?? []) visit(c);
  };
  visit(root);
  return acc;
}

/** An element object with its nested locators removed. */
function factsOf(el) {
  const { locators: _locators, ...rest } = el;
  return rest;
}

/** Every captured element (and drag source) across a truth file's active steps. */
function collectElements(truth) {
  const els = [];
  for (const rec of truth.recordings ?? []) {
    for (const step of rec.steps ?? []) {
      if (step.deleted) continue;
      for (const a of step.actions ?? []) {
        if (a.element) els.push(a.element);
        if (a.source_element) els.push(a.source_element);
      }
    }
  }
  return els;
}

const vectors = discoverVectors();

describe('conformance vectors: committed tree', () => {
  it('at least one vector is committed', () => {
    assert.ok(vectors.length >= 1, 'no committed vectors found');
  });

  for (const { session, vector } of vectors) {
    describe(`${session} / ${vector.vector_id}`, () => {
      it('validates against the vector meta-schema', () => {
        const ok = validateVector(vector);
        assert.ok(ok, JSON.stringify(validateVector.errors, null, 2));
      });

      it('lock (1): names an active manifest session of its platform', () => {
        const sessions = discoverSessions(MANIFEST_PATH, vector.platform);
        const s = sessions.find((x) => x.id === session);
        assert.ok(s, `${session} is not a manifest ${vector.platform} session`);
        assert.equal(s.status, 'active', `${session} is not active`);
      });

      it('lock (2): element_facts + locators equal a captured session element', () => {
        const s = discoverSessions(MANIFEST_PATH, vector.platform).find((x) => x.id === session);
        const truth = JSON.parse(readFileSync(s.truthPath, 'utf8'));
        const match = collectElements(truth).find(
          (el) =>
            el.locators &&
            isDeepStrictEqual(factsOf(el), vector.element_facts) &&
            isDeepStrictEqual(el.locators, vector.locators),
        );
        assert.ok(match, 'no captured element matches element_facts + locators exactly');
      });

      it('lock (3): carries an eligible measured-unique candidate', () => {
        const measuredUnique = vector.locators.filter(
          (l) => l.masked !== true && l.match_index === 0 && l.match_count === 1,
        );
        assert.ok(measuredUnique.length >= 1, 'no measured-unique eligible candidate');
      });

      it('lock (4): ground_truth.node_id exists in tree_snapshot', () => {
        const ids = new Set(flattenNodes(vector.tree_snapshot).map((n) => n.node_id));
        assert.ok(ids.has(vector.ground_truth.node_id), 'ground truth node_id absent from snapshot');
      });

      it('lock (5): eligible candidates select exactly the ground truth or nothing; recorded matches re-derive', () => {
        const gt = vector.ground_truth.node_id;
        assert.equal(
          vector.matched_node_ids.length,
          vector.locators.length,
          'matched_node_ids parallels locators',
        );
        let coveredProven = false;
        vector.locators.forEach((l, i) => {
          const eligible = l.masked !== true && l.match_index !== null;
          if (!eligible) {
            assert.equal(vector.matched_node_ids[i], null, `ineligible candidate ${i} records null`);
            return;
          }
          const measured = measureStrategyMatches(vector.tree_snapshot, l);
          assert.ok(
            isDeepStrictEqual(measured, vector.matched_node_ids[i]),
            `recorded matches for candidate ${i} re-derive from the snapshot`,
          );
          if (measured.length === 1) {
            assert.equal(measured[0], gt, `a single-match candidate names the ground truth (${i})`);
          }
          if (l.match_count === 1 && l.match_index === 0) {
            assert.ok(
              isDeepStrictEqual(measured, [gt]),
              `measured-unique candidate ${i} selects exactly the ground truth`,
            );
            coveredProven = true;
          }
        });
        assert.ok(coveredProven, 'no measured-unique candidate selects exactly the ground truth');
      });

      it('lock (6): the ground-truth node committed tag/text equal element_facts', () => {
        const gtNode = flattenNodes(vector.tree_snapshot).find(
          (n) => n.node_id === vector.ground_truth.node_id,
        );
        assert.equal(gtNode.tag, vector.element_facts.tag, 'tag exact-equality');
        const factText = vector.element_facts.text;
        if (factText != null) {
          const nodeText = (gtNode.text ?? '').trim();
          assert.ok(nodeText.includes(factText.trim()), 'element_facts.text is contained in node text');
        }
      });
    });
  }
});

describe('snapshot walker: canonical serialization', () => {
  // DOM-like doubles exercise the walker's transformation logic deterministically
  // in Node. Fidelity to a live browser DOM (exact innerText) is proven by the
  // producer re-emitting the committed snapshot in the extension corpus run.
  const el = (tag, { attrs = {}, text, type, children = [] } = {}) => ({
    tagName: tag,
    innerText: text,
    type,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    children,
  });

  it('assigns pre-order ids, marks the ground truth by identity, sorts and filters attrs', () => {
    const target = el('BUTTON', {
      attrs: { id: 'b', 'data-testid': 'x', title: 'T', onclick: 'noop' },
      text: 'Hi',
    });
    const img = el('IMG', { attrs: { id: 'i', alt: 'A', width: '48', src: 'data:x' } });
    const body = el('BODY', { children: [target, img] });
    const html = el('HTML', { attrs: { lang: 'en' }, children: [body] });

    const { snapshot, groundTruthNodeId } = serializeSnapshot(html, (e) => e === target);

    assert.equal(snapshot.node_id, 'n0'); // HTML
    assert.equal(snapshot.children[0].node_id, 'n1'); // BODY
    const [btn, image] = snapshot.children[0].children;
    assert.equal(btn.node_id, 'n2');
    assert.equal(image.node_id, 'n3');
    assert.equal(groundTruthNodeId, 'n2', 'ground truth marked by element identity');
    // Only whitelist attrs, keys sorted; onclick/width/src/lang dropped.
    assert.deepEqual(Object.keys(btn.attrs), ['data-testid', 'id', 'title']);
    assert.deepEqual(Object.keys(image.attrs), ['alt', 'id']);
    assert.deepEqual(snapshot.attrs, {}, 'lang is outside the whitelist');
    assert.equal(btn.tag, 'BUTTON');
  });

  it('records text trim-only (internal whitespace preserved), 100-capped, password nulled', () => {
    const spaced = el('P', { text: '  a   b  ' });
    const long = el('P', { text: 'x'.repeat(150) });
    const pass = el('INPUT', { type: 'password', text: 'secret' });
    const root = el('DIV', { children: [spaced, long, pass] });
    const { snapshot } = serializeSnapshot(root);
    const [s, l, p] = snapshot.children;
    assert.equal(s.text, 'a   b', 'trim-only keeps internal runs');
    assert.equal(l.text.length, 100, '100-capped');
    assert.equal(p.text, null, 'password text nulled');
  });

  it('reads value when innerText is absent (form controls)', () => {
    const input = el('INPUT', { children: [] });
    input.value = 'typed';
    const { snapshot } = serializeSnapshot(el('DIV', { children: [input] }));
    assert.equal(snapshot.children[0].text, 'typed');
  });
});

describe('snapshot measurement: faithful per-strategy queries', () => {
  const committed = JSON.parse(
    readFileSync(join(CORPUS_DIR, 'sessions/ext-click-basic/vectors/save.vector.json'), 'utf8'),
  );
  const snap = committed.tree_snapshot;
  const m = (loc) => measureStrategyMatches(snap, loc);

  it('id / test_id / title / css select the button uniquely', () => {
    assert.deepEqual(m({ strategy: 'id', value: 'save' }), ['n5']);
    assert.deepEqual(m({ strategy: 'test_id', attribute: 'data-testid', value: 'save' }), ['n5']);
    assert.deepEqual(m({ strategy: 'title', value: 'Save the form' }), ['n5']);
    assert.deepEqual(m({ strategy: 'css', value: '#save' }), ['n5']);
  });

  it('tag_name selects every same-tag element (all-tag, per the spec table)', () => {
    assert.deepEqual(m({ strategy: 'tag_name', value: 'button' }), ['n5', 'n7']);
  });

  it('text uses the all-tag normalized-equality predicate', () => {
    assert.deepEqual(m({ strategy: 'text', value: 'Save' }), ['n5']);
    assert.deepEqual(m({ strategy: 'text', value: 'Plain' }), ['n7']);
  });

  it('alt_text selects the image', () => {
    assert.deepEqual(m({ strategy: 'alt_text', value: 'Docent logo' }), ['n6']);
  });

  it('css :nth-of-type resolves positional structure', () => {
    assert.deepEqual(m({ strategy: 'css', value: 'button:nth-of-type(1)' }), ['n5']);
    assert.deepEqual(m({ strategy: 'css', value: 'button:nth-of-type(2)' }), ['n7']);
  });

  it('an unmatched value selects nothing', () => {
    assert.deepEqual(m({ strategy: 'id', value: 'nope' }), []);
    assert.deepEqual(m({ strategy: 'text', value: 'Save the form' }), []);
  });
});

describe('conformance vectors: per-strategy coverage ledger', () => {
  // The emitted extension strategies; role_name and label are schema-reserved
  // and not captured, so they are outside vector scope.
  const EMITTED = ['id', 'test_id', 'name', 'tag_name', 'text', 'placeholder', 'title', 'alt_text', 'css']; // prettier-ignore
  const ledger = JSON.parse(
    readFileSync(join(CORPUS_DIR, 'vectors-coverage.json'), 'utf8'),
  ).extension;

  it('covers exactly the emitted extension strategies', () => {
    assert.deepEqual(Object.keys(ledger).sort(), [...EMITTED].sort());
  });

  for (const strategy of EMITTED) {
    it(`${strategy}: its ledgered vector is committed and measured-unique for it`, () => {
      const row = ledger[strategy];
      assert.ok(row, `no ledger row for ${strategy}`);
      const file = join(CORPUS_DIR, 'sessions', row.session, 'vectors', `${row.vector}.vector.json`);
      assert.ok(existsSync(file), `ledger vector ${row.session}/${row.vector} is not committed`);
      const vector = JSON.parse(readFileSync(file, 'utf8'));
      const unique = vector.locators.some(
        (l) =>
          l.strategy === strategy &&
          l.masked !== true &&
          l.match_count === 1 &&
          l.match_index === 0,
      );
      assert.ok(unique, `${strategy} is not measured-unique in ${row.session}/${row.vector}`);
    });
  }
});
