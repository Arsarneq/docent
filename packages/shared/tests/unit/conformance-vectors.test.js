/**
 * conformance-vectors.test.js — hygiene locks over the committed conformance
 * vectors (corpus/sessions/<id>/vectors/*.vector.json), mirroring
 * corpus-compare.test.js.
 *
 * A vector is inert data under docs/technical/locator-resolution.md (Conformance and
 * Vector Scope): a recorded element's locator candidates + its non-locator
 * facts, a serialized snapshot of the bound scope, the ground-truth node, and
 * the node_ids each candidate's stated query selects over that snapshot. The
 * locks are structural: each is a per-candidate match COUNT (measured over the
 * committed snapshot by the platform's measurement evaluator) or a
 * committed-field EQUALITY. There is no function that turns a vector into an
 * outcome; the expected_outcome "resolved" guarantee EMERGES from the counts
 * and equalities the locks check — it is never computed here.
 *
 * The locks are platform-dispatched. Extension vectors are session-sourced
 * (from manifest corpus sessions) and use the DOM snapshot walker + extension
 * strategy evaluator. Desktop vectors may be session-sourced OR fixture-sourced
 * (from a dedicated vector-only fixture window listed in vector-fixtures.json —
 * no truth.docent.json, no baseline key); they use the desktop UIA snapshot +
 * desktop strategy evaluator.
 *
 * Locks:
 *  (1) the vector names an active manifest session of its platform, OR an
 *      enumerated dedicated vector fixture of its platform;
 *  (2) session-sourced: element_facts + locators equal a captured element of
 *      that session; fixture-sourced: the self-describing element_facts +
 *      locators are internally consistent and well-formed;
 *  (3) an eligible candidate is measured-unique (match_count 1, match_index 0);
 *  (4) ground_truth.node_id exists in tree_snapshot;
 *  (5) over the snapshot, every eligible candidate selects exactly the ground
 *      truth or is non-selecting (0 or >1), no eligible candidate selects a
 *      single other node, the measured-unique candidate selects exactly the
 *      ground truth, and the recorded matched_node_ids re-derive;
 *  (6) the ground-truth node's committed tag/text fields equal element_facts.
 *
 * Plus: the walker reproduces the committed snapshot, and the measurement is
 * faithful to the spec's strategy tables (extension + desktop).
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
import { measureDesktopStrategyMatches } from './vector-measurement-desktop.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CORPUS_DIR = resolve(__dirname, '../../../../corpus');
const MANIFEST_PATH = join(CORPUS_DIR, 'manifest.json');

const metaSchema = JSON.parse(readFileSync(join(CORPUS_DIR, 'vector.schema.json'), 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validateVector = ajv.compile(metaSchema);

const fixtures = JSON.parse(
  readFileSync(join(CORPUS_DIR, 'vector-fixtures.json'), 'utf8'),
).fixtures;

/** Dispatch the per-candidate measurement to the platform's evaluator. */
function measureFor(platform, snapshot, locator) {
  return platform === 'desktop-windows'
    ? measureDesktopStrategyMatches(snapshot, locator)
    : measureStrategyMatches(snapshot, locator);
}

/** The node's own control-type field, by platform (extension tag / desktop control_type). */
function nodeTagOf(platform, node) {
  return platform === 'desktop-windows' ? node.control_type : node.tag;
}

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

/** Pre-order list of every node in a snapshot subtree (both platforms). */
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

/** The allowed key set for a desktop locator entry of each strategy. */
const DESKTOP_LOCATOR_KEYS = {
  automation_id: new Set(['strategy', 'value', 'match_count', 'match_index', 'masked']),
  role_name: new Set(['strategy', 'role', 'name', 'match_count', 'match_index', 'masked']),
  class_name: new Set(['strategy', 'value', 'match_count', 'match_index', 'masked']),
  // labeled_by / tree_path carry {strategy, value}; the harness MAY additionally
  // augment them with a measured match_count/match_index pair (the declared,
  // bounded augmentation — STC-17). No other strategy is augmented.
  labeled_by: new Set(['strategy', 'value', 'match_count', 'match_index', 'masked']),
  tree_path: new Set(['strategy', 'value', 'match_count', 'match_index', 'masked']),
};

/** Is one committed desktop locator entry well-formed for its strategy? */
function desktopLocatorWellFormed(l) {
  const allowed = DESKTOP_LOCATOR_KEYS[l.strategy];
  if (!allowed) return false;
  for (const k of Object.keys(l)) if (!allowed.has(k)) return false;
  if (l.strategy === 'role_name') {
    if (typeof l.role !== 'string' || typeof l.name !== 'string') return false;
  } else if (typeof l.value !== 'string') {
    return false;
  }
  if ('match_count' in l && !(Number.isInteger(l.match_count) && l.match_count >= 1)) return false;
  if ('match_index' in l && l.match_index !== null) {
    if (!(Number.isInteger(l.match_index) && l.match_index >= 0)) return false;
    if ('match_count' in l && l.match_index >= l.match_count) return false;
  }
  return true;
}

const vectors = discoverVectors();

describe('conformance vectors: committed tree', () => {
  it('at least one vector is committed', () => {
    assert.ok(vectors.length >= 1, 'no committed vectors found');
  });

  for (const { session, vector } of vectors) {
    const platform = vector.platform;
    describe(`${session} / ${vector.vector_id}`, () => {
      it('validates against the vector meta-schema', () => {
        const ok = validateVector(vector);
        assert.ok(ok, JSON.stringify(validateVector.errors, null, 2));
      });

      it('lock (1): names an active manifest session OR an enumerated fixture of its platform', () => {
        const manifestSession = discoverSessions(MANIFEST_PATH, platform).find((x) => x.id === session); // prettier-ignore
        if (manifestSession) {
          assert.equal(manifestSession.status, 'active', `${session} is not active`);
          return;
        }
        const fixture = fixtures.find((f) => f.id === session && f.platform === platform);
        assert.ok(
          fixture,
          `${session} is neither a manifest ${platform} session nor an enumerated ${platform} fixture`,
        );
      });

      it('lock (2): element_facts + locators are consistent with the captured element', () => {
        // element_facts never nests locators, either mode (the corroboration
        // fact source is the non-locator fields only).
        assert.ok(!('locators' in vector.element_facts), 'element_facts must not nest locators');

        const manifestSession = discoverSessions(MANIFEST_PATH, platform).find((x) => x.id === session); // prettier-ignore
        if (manifestSession) {
          // Session-sourced: match a real captured element of the session truth.
          const truth = JSON.parse(readFileSync(manifestSession.truthPath, 'utf8'));
          const match = collectElements(truth).find(
            (el) =>
              el.locators &&
              isDeepStrictEqual(factsOf(el), vector.element_facts) &&
              isDeepStrictEqual(el.locators, vector.locators),
          );
          assert.ok(match, 'no captured element matches element_facts + locators exactly');
          return;
        }
        // Fixture-sourced (desktop): the vector is self-describing — check the
        // authored locators are internally well-formed for their strategies,
        // with the labeled_by/tree_path additive-stats augmentation permitted
        // and no other keys.
        assert.equal(platform, 'desktop-windows', 'only desktop has fixture-sourced vectors');
        for (const l of vector.locators) {
          assert.ok(desktopLocatorWellFormed(l), `malformed desktop locator: ${JSON.stringify(l)}`);
        }
      });

      it('lock (3): carries an eligible measured-unique candidate', () => {
        const measuredUnique = vector.locators.filter(
          (l) => l.masked !== true && l.match_index === 0 && l.match_count === 1,
        );
        assert.ok(measuredUnique.length >= 1, 'no measured-unique eligible candidate');
      });

      it('lock (4): ground_truth.node_id exists in tree_snapshot', () => {
        const ids = new Set(flattenNodes(vector.tree_snapshot).map((n) => n.node_id));
        assert.ok(
          ids.has(vector.ground_truth.node_id),
          'ground truth node_id absent from snapshot',
        );
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
            assert.equal(
              vector.matched_node_ids[i],
              null,
              `ineligible candidate ${i} records null`,
            );
            return;
          }
          const measured = measureFor(platform, vector.tree_snapshot, l);
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
        assert.equal(nodeTagOf(platform, gtNode), vector.element_facts.tag, 'tag exact-equality');
        const factText = vector.element_facts.text;
        if (factText != null) {
          const nodeText = (gtNode.text ?? '').trim();
          assert.ok(
            nodeText.includes(factText.trim()),
            'element_facts.text is contained in node text',
          );
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

describe('snapshot measurement: faithful per-strategy queries (extension)', () => {
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

describe('snapshot measurement: faithful per-strategy queries (desktop)', () => {
  // A small hand-built desktop snapshot exercising each desktop strategy's
  // query over the desktop_node shape. (The committed live vector is proven by
  // its own locks above; this pins the evaluator against the spec table.)
  const snap = {
    node_id: 'w0',
    control_type: 'Window',
    name: 'Fixture',
    automation_id: null,
    class_name: 'Static',
    text: null,
    labeled_by: null,
    children: [
      {
        node_id: 'w1',
        control_type: 'Text',
        name: 'Amount',
        automation_id: '1001',
        class_name: 'Static',
        text: 'Amount',
        labeled_by: null,
        children: [],
      },
      {
        node_id: 'w2',
        control_type: 'Edit',
        name: 'Amount',
        automation_id: '1002',
        class_name: 'Edit',
        text: 'x',
        labeled_by: { target_node_id: 'w1', target_name: 'Amount' },
        children: [],
      },
    ],
  };
  const m = (loc) => measureDesktopStrategyMatches(snap, loc);

  it('automation_id / class_name field-walks select uniquely', () => {
    assert.deepEqual(m({ strategy: 'automation_id', value: '1002' }), ['w2']);
    assert.deepEqual(m({ strategy: 'class_name', value: 'Edit' }), ['w2']);
    assert.deepEqual(m({ strategy: 'class_name', value: 'Static' }), ['w0', 'w1']);
  });

  it('role_name binds the non-localized control type + name', () => {
    assert.deepEqual(m({ strategy: 'role_name', role: 'Edit', name: 'Amount' }), ['w2']);
    // same name, different control type — not selected
    assert.deepEqual(m({ strategy: 'role_name', role: 'Text', name: 'Amount' }), ['w1']);
  });

  it('labeled_by resolves the label relation edge', () => {
    assert.deepEqual(m({ strategy: 'labeled_by', value: 'Amount' }), ['w2']);
    assert.deepEqual(m({ strategy: 'labeled_by', value: 'Nope' }), []);
  });

  it('tree_path walks segments from the window root', () => {
    assert.deepEqual(m({ strategy: 'tree_path', value: 'Window:Fixture > Edit:Amount' }), ['w2']);
    assert.deepEqual(m({ strategy: 'tree_path', value: 'Window:Fixture > Text:Amount' }), ['w1']);
    assert.deepEqual(m({ strategy: 'tree_path', value: 'Window:Wrong > Edit:Amount' }), []);
  });

  it('an unmatched value selects nothing', () => {
    assert.deepEqual(m({ strategy: 'automation_id', value: '9999' }), []);
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
      const file = join(
        CORPUS_DIR,
        'sessions',
        row.session,
        'vectors',
        `${row.vector}.vector.json`,
      );
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

describe('conformance vectors: per-strategy coverage ledger (desktop)', () => {
  // The emitted desktop strategies. Every one is either COVERED by a committed
  // vector or an accounted-for GAP with a reason — the union equals this set, so
  // no emitted strategy is silently dropped.
  const EMITTED = ['automation_id', 'role_name', 'class_name', 'labeled_by', 'tree_path']; // prettier-ignore
  const coverage = JSON.parse(readFileSync(join(CORPUS_DIR, 'vectors-coverage.json'), 'utf8'));
  const covered = coverage['desktop-windows'];
  const gaps = coverage['desktop-windows-gaps'];

  it('every emitted desktop strategy is covered or an accounted-for gap (disjoint, exhaustive)', () => {
    const coveredKeys = Object.keys(covered);
    const gapKeys = Object.keys(gaps);
    const overlap = coveredKeys.filter((k) => gapKeys.includes(k));
    assert.deepEqual(overlap, [], 'a strategy is both covered and a gap');
    assert.deepEqual([...coveredKeys, ...gapKeys].sort(), [...EMITTED].sort());
  });

  for (const strategy of Object.keys(covered)) {
    it(`${strategy}: its ledgered vector is committed and measured-unique for it`, () => {
      const row = covered[strategy];
      const file = join(CORPUS_DIR, 'sessions', row.fixture, 'vectors', `${row.vector}.vector.json`); // prettier-ignore
      assert.ok(existsSync(file), `ledger vector ${row.fixture}/${row.vector} is not committed`);
      const vector = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(vector.platform, 'desktop-windows', 'a desktop ledger vector is desktop');
      const unique = vector.locators.some(
        (l) =>
          l.strategy === strategy &&
          l.masked !== true &&
          l.match_count === 1 &&
          l.match_index === 0,
      );
      assert.ok(unique, `${strategy} is not measured-unique in ${row.fixture}/${row.vector}`);
    });
  }

  for (const strategy of Object.keys(gaps)) {
    it(`${strategy}: the coverage gap states a reason`, () => {
      const reason = gaps[strategy]?.reason;
      assert.ok(typeof reason === 'string' && reason.length > 0, `${strategy} gap has no reason`);
    });
  }
});
