/**
 * recorder-logic.test.js — Unit tests for extracted content script logic.
 *
 * Tests selector derivation, locator measurement, and element description
 * with mock DOM elements. No browser required: the measurement root is a
 * fake `ownerDocument` whose querySelectorAll is backed by a Map from
 * selector string → element array (or the 'throw' sentinel).
 *
 * Covers issue #31; extended for #132 (measured locators[]) and #172
 * (uniqueness-aware selector derivation).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectorFor,
  describeElement,
  buildLocators,
  matchStats,
  cssEscape,
  cssString,
  tagSelectorFor,
  normalizeText,
  shouldCaptureScroll,
  TEST_ID_ATTRS,
  TEXT_MEASURE_MAX,
} from '../../content/recorder-logic.js';

// ─── Mock DOM helpers ─────────────────────────────────────────────────────────

function createElement(
  tag,
  { id, type, name, role, text, value, autocomplete, parent, siblings, attrs, namespaceURI } = {},
) {
  const bag = { ...(attrs ?? {}) };
  if (name != null) bag.name = name;
  if (role != null) bag.role = role;
  if (type != null) bag.type = type;
  if (autocomplete != null) bag.autocomplete = autocomplete;
  const el = {
    tagName: namespaceURI ? tag : tag.toUpperCase(),
    id: id || '',
    type: type || null,
    innerText: text,
    value: value,
    parentElement: parent || null,
    children: [],
    namespaceURI,
    getAttribute(attr) {
      return bag[attr] ?? null;
    },
  };
  if (parent) {
    if (!parent.children.includes(el)) {
      parent.children.push(el);
    }
  }
  if (siblings) {
    // Add siblings to parent's children
    for (const sib of siblings) {
      if (!el.parentElement.children.includes(sib)) {
        el.parentElement.children.push(sib);
      }
    }
  }
  return el;
}

/**
 * A fake measurement root: querySelectorAll resolves from `map`
 * (selector → element array, or 'throw' to simulate an invalid selector).
 * Unknown selectors resolve to an empty list.
 */
function makeDoc(map = {}, { body } = {}) {
  const doc = {
    body: body ?? null,
    querySelectorAll(sel) {
      const hit = map[sel];
      if (hit === 'throw') throw new SyntaxError(`invalid selector: ${sel}`);
      return hit ?? [];
    },
  };
  return doc;
}

/** Attach a fake ownerDocument to an element chain (el and all ancestors). */
function withDoc(el, doc) {
  let node = el;
  while (node) {
    node.ownerDocument = doc;
    node = node.parentElement;
  }
  return el;
}

// ─── cssEscape ────────────────────────────────────────────────────────────────

describe('cssEscape (CSSOM serialize-an-identifier)', () => {
  it('escapes special characters', () => {
    assert.equal(cssEscape('my.class'), 'my\\.class');
    assert.equal(cssEscape('has:colon'), 'has\\:colon');
    assert.equal(cssEscape('with space'), 'with\\ space');
  });

  it('does not escape alphanumeric and hyphens', () => {
    assert.equal(cssEscape('normal-id'), 'normal-id');
    assert.equal(cssEscape('btn_submit'), 'btn_submit');
    assert.equal(cssEscape('item123'), 'item123');
  });

  // The old regex escape left leading digits untouched, producing the INVALID
  // selector "#123abc" — querySelectorAll throws on it, which would have made
  // every measurement of such an element fail once the mirror became the
  // measurement path. https://github.com/Arsarneq/docent/issues/172
  it('regression_172_digit_leading_id_produces_valid_selector', () => {
    assert.equal(cssEscape('123abc'), '\\31 23abc');
    assert.equal(cssEscape('1'), '\\31 ');
  });

  it('escapes a digit after a leading hyphen as a code point', () => {
    assert.equal(cssEscape('-5x'), '-\\35 x');
  });

  it('escapes a lone hyphen', () => {
    assert.equal(cssEscape('-'), '\\-');
  });

  it('replaces NUL with U+FFFD and hex-escapes control characters', () => {
    assert.equal(cssEscape('a\u0000b'), 'a\uFFFDb');
    assert.equal(cssEscape('a\u0001b'), 'a\\1 b');
  });
});

// ─── cssString / tagSelectorFor / normalizeText ───────────────────────────────

describe('cssString', () => {
  it('escapes backslashes, quotes, and newlines for attribute values', () => {
    assert.equal(cssString('plain'), 'plain');
    assert.equal(cssString('say "hi"'), 'say \\"hi\\"');
    assert.equal(cssString('back\\slash'), 'back\\\\slash');
    assert.equal(cssString('line\nbreak'), 'line\\a break');
  });
});

describe('tagSelectorFor', () => {
  it('lower-cases HTML-namespace tags', () => {
    const el = createElement('BUTTON');
    assert.equal(tagSelectorFor(el), 'button');
  });

  // CSS type selectors match foreign elements case-sensitively: a lowercased
  // "clippath" selector can never match an SVG <clipPath> element.
  it('regression_172_svg_camelcase_type_selector_preserved', () => {
    const el = createElement('clipPath', {
      namespaceURI: 'http://www.w3.org/2000/svg',
    });
    assert.equal(tagSelectorFor(el), 'clipPath');
  });
});

describe('normalizeText', () => {
  it('trims and collapses internal whitespace runs', () => {
    assert.equal(normalizeText('  Add   to\n cart '), 'Add to cart');
    assert.equal(normalizeText(''), '');
  });
});

// ─── matchStats ───────────────────────────────────────────────────────────────

describe('matchStats', () => {
  it('reports count and 0-based index in document order', () => {
    const el = createElement('button');
    const other = createElement('button');
    const doc = makeDoc({ button: [other, el] });
    assert.deepEqual(matchStats(doc, 'button', el), { match_count: 2, match_index: 1 });
  });

  it('reports match_index null when the element is not in the match list', () => {
    const el = createElement('button');
    const other = createElement('button');
    const doc = makeDoc({ button: [other] });
    assert.deepEqual(matchStats(doc, 'button', el), { match_count: 1, match_index: null });
  });

  it('returns null (not measured) for zero-count results', () => {
    const el = createElement('button');
    assert.equal(matchStats(makeDoc({}), 'button', el), null);
  });

  it('returns null for an invalid selector instead of throwing', () => {
    const el = createElement('button');
    assert.equal(matchStats(makeDoc({ bad: 'throw' }), 'bad', el), null);
  });

  it('returns null without a queryable document', () => {
    const el = createElement('button');
    assert.equal(matchStats(null, 'button', el), null);
    assert.equal(matchStats({}, 'button', el), null);
  });
});

// ─── selectorFor ──────────────────────────────────────────────────────────────

describe('selectorFor (no measurement root — legacy-shaped degradation)', () => {
  it('returns #id when element has an id', () => {
    const el = createElement('button', { id: 'submit-btn' });
    assert.equal(selectorFor(el), '#submit-btn');
  });

  it('escapes special characters in id', () => {
    const el = createElement('div', { id: 'my.element' });
    assert.equal(selectorFor(el), '#my\\.element');
  });

  it('returns tag name when no id and no parent', () => {
    const el = createElement('button');
    assert.equal(selectorFor(el), 'button');
  });

  it('adds nth-of-type when siblings have same tag', () => {
    const parent = createElement('div');
    const sib1 = createElement('button', { parent });
    const sib2 = createElement('button', { parent });
    parent.children = [sib1, sib2];
    sib1.parentElement = parent;
    sib2.parentElement = parent;

    assert.equal(selectorFor(sib1), 'div > button:nth-of-type(1)');
    assert.equal(selectorFor(sib2), 'div > button:nth-of-type(2)');
  });

  it('does not add nth-of-type when only child of its type', () => {
    const parent = createElement('div');
    const child = createElement('button', { parent });
    const otherChild = createElement('span', { parent });
    parent.children = [child, otherChild];
    child.parentElement = parent;

    assert.equal(selectorFor(child), 'div > button');
  });

  it('stops walking at the document body', () => {
    const body = createElement('body');
    const parent = createElement('div', { parent: body });
    parent.parentElement = body;
    body.children = [parent];
    const child = createElement('button', { parent });
    child.parentElement = parent;
    parent.children = [child];
    withDoc(child, makeDoc({}, { body }));

    const selector = selectorFor(child);
    assert.ok(!selector.includes('body'));
    assert.equal(selector, 'div > button');
  });

  it('stops early when ancestor has id', () => {
    const parent = createElement('div', { id: 'container' });
    const child = createElement('button', { parent });
    child.parentElement = parent;
    parent.children = [child];

    const selector = selectorFor(child);
    assert.equal(selector, '#container > button');
  });

  it('regression_172_body_target_yields_body', () => {
    const body = createElement('body');
    withDoc(body, makeDoc({}, { body }));
    assert.equal(selectorFor(body), 'body');
  });
});

describe('selectorFor (uniqueness-aware, measured — #172)', () => {
  it('returns a unique #id after a single probe', () => {
    const el = createElement('button', { id: 'a' });
    withDoc(el, makeDoc({ '#a': [el] }));
    assert.equal(selectorFor(el), '#a');
  });

  it('walks past a DUPLICATED id and anchors on an ancestor test attribute', () => {
    const parent = createElement('div', { attrs: { 'data-testid': 'panel' } });
    const el = createElement('button', { id: 'dup', parent });
    el.parentElement = parent;
    parent.children = [el];
    const impostor = createElement('button', { id: 'dup' });
    withDoc(
      el,
      makeDoc({
        '#dup': [impostor, el], // duplicated id: not unique, walk continues
        'div[data-testid="panel"] > #dup': [el],
      }),
    );
    assert.equal(selectorFor(el), 'div[data-testid="panel"] > #dup');
  });

  it('prefers a test-attribute anchor over positional refinement', () => {
    const parent = createElement('div', { attrs: { 'data-testid': 'panel' } });
    const el = createElement('button', { parent });
    el.parentElement = parent;
    parent.children = [el];
    const stray = createElement('button');
    withDoc(
      el,
      makeDoc({
        button: [stray, el],
        'div[data-testid="panel"] > button': [el],
      }),
    );
    assert.equal(selectorFor(el), 'div[data-testid="panel"] > button');
  });

  it('adds nth-of-type only for the ambiguous level, deepest first', () => {
    const parent = createElement('div');
    const sib1 = createElement('button', { parent });
    const el = createElement('button', { parent });
    parent.children = [sib1, el];
    sib1.parentElement = parent;
    el.parentElement = parent;
    withDoc(
      el,
      makeDoc({
        button: [sib1, el],
        'div > button': [sib1, el],
        'div > button:nth-of-type(2)': [el],
      }),
    );
    const selector = selectorFor(el);
    assert.equal(selector, 'div > button:nth-of-type(2)');
    assert.ok(!selector.startsWith('div:nth-of-type'), 'unambiguous level must not carry position');
  });

  it('falls back to the fully positional path when nothing is unique', () => {
    const parent = createElement('div');
    const sib1 = createElement('button', { parent });
    const el = createElement('button', { parent });
    parent.children = [sib1, el];
    sib1.parentElement = parent;
    el.parentElement = parent;
    // Every probe returns 2 matches — pathological page, nothing unique.
    withDoc(
      el,
      makeDoc({
        button: [sib1, el],
        'div > button': [sib1, el],
        'div > button:nth-of-type(2)': [sib1, el],
      }),
    );
    assert.equal(selectorFor(el), 'div > button:nth-of-type(2)');
  });

  it('never returns a "unique" selector that selects a different element', () => {
    const el = createElement('button', { id: 'ghost' });
    const impostor = createElement('button');
    // The selector matches exactly one element — but not el (shadow-tree case).
    withDoc(el, makeDoc({ '#ghost': [impostor] }));
    // match_index !== 0 for el → not unique → degrade to the structural path.
    assert.equal(selectorFor(el), '#ghost');
  });

  it('tolerates a throwing (invalid) candidate selector', () => {
    const el = createElement('button');
    withDoc(el, makeDoc({ button: 'throw' }));
    assert.equal(selectorFor(el), 'button');
  });
});

// ─── buildLocators ────────────────────────────────────────────────────────────

describe('buildLocators (#132)', () => {
  it('emits every applicable strategy in schema declaration order with measured pairs', () => {
    const el = createElement('button', {
      id: 'save',
      name: 'save-btn',
      text: 'Save',
      attrs: { 'data-testid': 'save-tid', title: 'Save the form' },
    });
    const doc = makeDoc({
      '[id="save"]': [el],
      '[data-testid="save-tid"]': [el],
      '[name="save-btn"]': [el],
      button: [el],
      '[title="Save the form"]': [el],
      '#save': [el],
    });
    withDoc(el, doc);
    const locators = buildLocators(el, '#save');
    assert.deepEqual(
      locators.map((l) => l.strategy),
      ['id', 'test_id', 'name', 'tag_name', 'text', 'title', 'css'],
    );
    for (const entry of locators) {
      assert.equal(entry.match_count, 1, `${entry.strategy} should be measured unique`);
      assert.equal(entry.match_index, 0);
    }
    assert.equal(locators.find((l) => l.strategy === 'test_id').attribute, 'data-testid');
    assert.equal(locators.find((l) => l.strategy === 'css').value, '#save');
  });

  it('test-attribute family precedence: data-testid beats data-cy; lone data-qa records itself', () => {
    const both = createElement('button', {
      attrs: { 'data-testid': 'a', 'data-cy': 'b' },
    });
    const loneQa = createElement('button', { attrs: { 'data-qa': 'q' } });
    const tidBoth = buildLocators(both, 'button').find((l) => l.strategy === 'test_id');
    assert.equal(tidBoth.attribute, 'data-testid');
    assert.equal(tidBoth.value, 'a');
    const tidQa = buildLocators(loneQa, 'button').find((l) => l.strategy === 'test_id');
    assert.equal(tidQa.attribute, 'data-qa');
    assert.equal(tidQa.value, 'q');
  });

  it('counts DUPLICATE ids via the attribute selector', () => {
    const impostor = createElement('div', { id: 'dup' });
    const el = createElement('div', { id: 'dup' });
    withDoc(el, makeDoc({ '[id="dup"]': [impostor, el] }));
    const idEntry = buildLocators(el, '#dup').find((l) => l.strategy === 'id');
    assert.equal(idEntry.match_count, 2);
    assert.equal(idEntry.match_index, 1);
  });

  it('reports match_index null when a candidate does not match the element', () => {
    const other = createElement('button', { attrs: { 'data-testid': 't' } });
    const el = createElement('button', { attrs: { 'data-testid': 't' } });
    withDoc(el, makeDoc({ '[data-testid="t"]': [other] }));
    const tid = buildLocators(el, 'button').find((l) => l.strategy === 'test_id');
    assert.equal(tid.match_count, 1);
    assert.equal(tid.match_index, null);
  });

  it('ships the pair ABSENT for zero-count results (shadow-tree target)', () => {
    const el = createElement('button', { id: 'in-shadow' });
    // Document-rooted matching cannot see the element: every list is empty.
    withDoc(el, makeDoc({}));
    for (const entry of buildLocators(el, '#in-shadow')) {
      assert.equal('match_count' in entry, false, `${entry.strategy} must not carry a pair`);
      assert.equal('match_index' in entry, false);
    }
  });

  it('normalizes text whitespace and reuses the tag list for its pair', () => {
    const twin = createElement('button', { text: 'Add   to cart' });
    const el = createElement('button', { text: '  Add to\ncart ' });
    const stranger = createElement('button', { text: 'Checkout' });
    withDoc(el, makeDoc({ button: [twin, el, stranger] }));
    const textEntry = buildLocators(el, 'button').find((l) => l.strategy === 'text');
    assert.equal(textEntry.value, 'Add to cart');
    assert.equal(textEntry.match_count, 2);
    assert.equal(textEntry.match_index, 1);
  });

  it('omits the text candidate when normalized text exceeds 100 chars', () => {
    const el = createElement('p', { text: 'A'.repeat(150) });
    withDoc(el, makeDoc({ p: [el] }));
    assert.equal(
      buildLocators(el, 'p').find((l) => l.strategy === 'text'),
      undefined,
    );
  });

  it('ships the text pair absent when the same-tag set exceeds the measurement cap', () => {
    const el = createElement('span', { text: 'hi' });
    const crowd = [el];
    for (let i = 0; i <= TEXT_MEASURE_MAX; i++) crowd.push(createElement('span', { text: 'x' }));
    withDoc(el, makeDoc({ span: crowd }));
    const textEntry = buildLocators(el, 'span').find((l) => l.strategy === 'text');
    assert.equal(textEntry.value, 'hi');
    assert.equal('match_count' in textEntry, false);
  });

  it('a password input emits no text candidate (values are not rendered text)', () => {
    const el = createElement('input', { type: 'password', value: 'secret123' });
    withDoc(el, makeDoc({ input: [el] }));
    const locators = buildLocators(el, 'input');
    assert.equal(
      locators.find((l) => l.strategy === 'text'),
      undefined,
    );
    assert.ok(locators.find((l) => l.strategy === 'tag_name'));
  });

  it('omits empty-valued candidates entirely', () => {
    const el = createElement('button');
    withDoc(el, makeDoc({ button: [el] }));
    const strategies = buildLocators(el, 'button').map((l) => l.strategy);
    assert.deepEqual(strategies, ['tag_name', 'css']);
  });
});

// ─── describeElement ──────────────────────────────────────────────────────────

describe('describeElement', () => {
  it('returns all fields for a basic element', () => {
    const el = createElement('button', { id: 'btn', text: 'Click me', role: 'button' });
    const desc = describeElement(el);

    assert.equal(desc.tag, 'BUTTON');
    assert.equal(desc.id, 'btn');
    assert.equal(desc.role, 'button');
    assert.equal(desc.text, 'Click me');
    assert.equal(desc.selector, '#btn');
  });

  it('returns null for empty optional fields', () => {
    const el = createElement('div');
    const desc = describeElement(el);

    assert.equal(desc.id, null);
    assert.equal(desc.name, null);
    assert.equal(desc.role, null);
    assert.equal(desc.type, null);
  });

  it('attaches locators, with the css entry reusing the derived selector', () => {
    const el = createElement('button', { id: 'btn', text: 'Click me' });
    withDoc(el, makeDoc({ '#btn': [el], '[id="btn"]': [el], button: [el] }));
    const desc = describeElement(el);
    assert.ok(Array.isArray(desc.locators));
    const css = desc.locators.find((l) => l.strategy === 'css');
    assert.equal(css.value, desc.selector);
    assert.equal(css.match_count, 1);
  });

  it('masks password field text', () => {
    const el = createElement('input', { type: 'password', value: 'secret123' });
    const desc = describeElement(el);

    assert.equal(desc.text, null);
    assert.equal(desc.type, 'password');
  });

  it('truncates text to 100 characters', () => {
    const longText = 'A'.repeat(200);
    const el = createElement('p', { text: longText });
    const desc = describeElement(el);

    assert.equal(desc.text.length, 100);
  });

  it('uses value when innerText is undefined', () => {
    const el = createElement('input', { value: 'typed text' });
    el.innerText = undefined;
    const desc = describeElement(el);

    assert.equal(desc.text, 'typed text');
  });

  it('trims whitespace from text', () => {
    const el = createElement('span', { text: '  hello world  ' });
    const desc = describeElement(el);

    assert.equal(desc.text, 'hello world');
  });

  it('captures the autocomplete attribute (sensitivity signal)', () => {
    const el = createElement('input', { type: 'text', autocomplete: 'cc-number' });
    assert.equal(describeElement(el).autocomplete, 'cc-number');
  });

  it('flags a password element as redacted', () => {
    const el = createElement('input', { type: 'password', value: 'secret' });
    assert.equal(describeElement(el).redacted, true);
  });

  it('leaves a non-password element unredacted', () => {
    const el = createElement('input', { type: 'text', value: 'hello' });
    assert.equal(describeElement(el).redacted, undefined);
  });
});

// ─── Test-hook attribute family ───────────────────────────────────────────────

describe('TEST_ID_ATTRS', () => {
  it('is the fixed, documented precedence order', () => {
    assert.deepEqual(TEST_ID_ATTRS, [
      'data-testid',
      'data-test',
      'data-test-id',
      'data-qa',
      'data-cy',
    ]);
  });
});

// ─── Scroll capture logic ─────────────────────────────────────────────────────

describe('shouldCaptureScroll', () => {
  it('captures vertical scroll > 200px', () => {
    const result = shouldCaptureScroll(0, 0, 500, 0);
    assert.equal(result.capture, true);
    assert.equal(result.deltaY, 500);
    assert.equal(result.deltaX, 0);
  });

  it('captures horizontal scroll > 200px', () => {
    const result = shouldCaptureScroll(0, 0, 0, 300);
    assert.equal(result.capture, true);
    assert.equal(result.deltaY, 0);
    assert.equal(result.deltaX, 300);
  });

  it('does NOT capture small vertical scroll (< 200px)', () => {
    const result = shouldCaptureScroll(0, 0, 100, 0);
    assert.equal(result.capture, false);
  });

  it('does NOT capture small horizontal scroll (< 200px)', () => {
    const result = shouldCaptureScroll(0, 0, 0, 150);
    assert.equal(result.capture, false);
  });

  it('does NOT capture exactly 200px (threshold is >200, not >=200)', () => {
    const result = shouldCaptureScroll(0, 0, 200, 0);
    assert.equal(result.capture, false);
  });

  it('captures 201px scroll', () => {
    const result = shouldCaptureScroll(0, 0, 201, 0);
    assert.equal(result.capture, true);
  });

  it('captures scroll up (negative delta)', () => {
    const result = shouldCaptureScroll(500, 0, 0, 0);
    assert.equal(result.capture, true);
    assert.equal(result.deltaY, -500);
  });

  it('captures scroll left (negative delta)', () => {
    const result = shouldCaptureScroll(0, 400, 0, 0);
    assert.equal(result.capture, true);
    assert.equal(result.deltaX, -400);
  });

  it('captures when both axes exceed threshold', () => {
    const result = shouldCaptureScroll(0, 0, 300, 300);
    assert.equal(result.capture, true);
    assert.equal(result.deltaY, 300);
    assert.equal(result.deltaX, 300);
  });

  it('captures when only one axis exceeds threshold', () => {
    const result = shouldCaptureScroll(0, 0, 50, 250);
    assert.equal(result.capture, true);
    assert.equal(result.deltaY, 50);
    assert.equal(result.deltaX, 250);
  });

  it('does NOT capture when both axes are below threshold', () => {
    const result = shouldCaptureScroll(0, 0, 100, 100);
    assert.equal(result.capture, false);
  });
});
