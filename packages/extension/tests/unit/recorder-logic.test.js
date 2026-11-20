/**
 * recorder-logic.test.js — Unit tests for extracted content script logic.
 *
 * Tests selector derivation, locator measurement, element description, the
 * scroll decision, and the
 * content script's inline scroll literals against their declared constants
 * with mock DOM elements. No browser required: the measurement root is a
 * fake `ownerDocument` whose querySelectorAll is backed by a Map from
 * selector string → element array (or the 'throw' sentinel).
 *
 * Covers issue #31; extended for #132 (measured locators[]) and #172
 * (uniqueness-aware selector derivation).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SCROLL_DEBOUNCE, SCROLL_MIN_DISTANCE_PX } from '../../lib/capture-timing.js';
import {
  selectorFor,
  describeElement,
  declaredLanguage,
  buildLocators,
  matchStats,
  cssEscape,
  cssString,
  tagSelectorFor,
  normalizeText,
  shouldCaptureScroll,
  mayTakeText,
  takesTextByParts,
  PART_ENTRY_INPUT_TYPES,
  keyPressKind,
  isShortcut,
  isSensitiveElement,
  takesNoTypedText,
  NON_TEXT_TAGS,
  NON_TEXT_ROLES,
  SENSITIVE_AUTOCOMPLETE,
  SENSITIVE_NAME_RE,
  keyActionName,
  MODIFIER_KEYS,
  NON_ENTRY_INPUT_TYPES,
  TEST_ID_ATTRS,
  TEXT_MEASURE_MAX,
} from '../../content/recorder-logic.js';
import {
  isSensitiveField,
  SENSITIVE_AUTOCOMPLETE as SHARED_AUTOCOMPLETE,
  SENSITIVE_NAME_RE as SHARED_NAME_RE,
} from '../../../shared/lib/field-sensitivity.js';
import {
  keyEntersText,
  takesNoTypedText as workerTakesNoTypedText,
  NON_TEXT_INPUT_TYPES as WORKER_NON_TEXT_INPUT_TYPES,
  NON_TEXT_TAGS as WORKER_NON_TEXT_TAGS,
  NON_TEXT_ROLES as WORKER_NON_TEXT_ROLES,
} from '../../lib/redaction-logic.js';

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

// ─── declaredLanguage (docent#142) ────────────────────────────────────────────

describe('declaredLanguage', () => {
  it("returns the element's own lang attribute", () => {
    const el = createElement('button', { attrs: { lang: 'da' } });
    assert.equal(declaredLanguage(el), 'da');
  });

  it('takes the nearest declaring ancestor, not the outermost', () => {
    const html = createElement('html', { attrs: { lang: 'da' } });
    const section = createElement('section', { parent: html, attrs: { lang: 'en-GB' } });
    const div = createElement('div', { parent: section });
    const el = createElement('button', { parent: div });
    assert.equal(declaredLanguage(el), 'en-GB');
  });

  it('returns null when nothing at or above the element declares one', () => {
    const html = createElement('html');
    const el = createElement('button', { parent: html });
    assert.equal(declaredLanguage(el), null);
  });

  it('writes an empty declaration as written and does not look past it', () => {
    const html = createElement('html', { attrs: { lang: 'da' } });
    const el = createElement('p', { parent: html, attrs: { lang: '' } });
    assert.equal(declaredLanguage(el), '');
  });

  it('writes the attribute as the application wrote it, unvalidated', () => {
    const el = createElement('p', { attrs: { lang: 'Dansk ' } });
    assert.equal(declaredLanguage(el), 'Dansk ');
  });

  it('crosses from a shadow tree to its host', () => {
    const html = createElement('html', { attrs: { lang: 'da' } });
    const host = createElement('x-card', { parent: html });
    const inner = createElement('button');
    inner.parentNode = { host };
    assert.equal(declaredLanguage(inner), 'da');
  });

  it('stops at the top of its own document', () => {
    const html = createElement('html');
    html.parentNode = {};
    assert.equal(declaredLanguage(html), null);
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

  it('states the declared language of the element', () => {
    const html = createElement('html', { attrs: { lang: 'da' } });
    const el = createElement('button', { parent: html, text: 'Gem' });
    assert.equal(describeElement(el).language, 'da');
  });

  it('writes a null language when none is declared', () => {
    const desc = describeElement(createElement('button', { text: 'Save' }));
    assert.ok('language' in desc);
    assert.equal(desc.language, null);
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

  it('discards exactly SCROLL_MIN_DISTANCE_PX and captures just above it', () => {
    assert.equal(shouldCaptureScroll(0, 0, SCROLL_MIN_DISTANCE_PX, 0).capture, false);
    assert.equal(shouldCaptureScroll(0, 0, 0, SCROLL_MIN_DISTANCE_PX).capture, false);
    assert.equal(shouldCaptureScroll(0, 0, SCROLL_MIN_DISTANCE_PX + 1, 0).capture, true);
  });

  it('the content script applies the declared scroll floor and settle debounce inline', () => {
    const source = readFileSync(new URL('../../content/recorder.js', import.meta.url), 'utf8');
    const occurrences = (text) => source.split(text).length - 1;
    const floor = `if (deltaY > ${SCROLL_MIN_DISTANCE_PX} || deltaX > ${SCROLL_MIN_DISTANCE_PX}) {`;
    const settle = `}, ${SCROLL_DEBOUNCE});`;
    assert.equal(occurrences(floor), 1, `recorder.js applies the floor once as: ${floor}`);
    assert.equal(occurrences(settle), 1, `recorder.js applies the settle once as: ${settle}`);
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

// ─── Key presses (#695, #702) ────────────────────────────────────────────────

describe('takesTextByParts', () => {
  it('regression_702_is_true_for_the_date_and_time_inputs_and_for_nothing_else', () => {
    assert.deepEqual(PART_ENTRY_INPUT_TYPES, ['date', 'datetime-local', 'month', 'time', 'week']);
    for (const type of PART_ENTRY_INPUT_TYPES) {
      assert.equal(takesTextByParts({ tagName: 'INPUT', type }), true, type);
    }
    for (const type of ['text', 'number', 'password', 'range', 'checkbox']) {
      assert.equal(takesTextByParts({ tagName: 'INPUT', type }), false, type);
    }
    assert.equal(takesTextByParts({ tagName: 'TEXTAREA' }), false);
    assert.equal(takesTextByParts({ tagName: 'DIV', isContentEditable: true }), false);
    assert.equal(takesTextByParts(null), false);
  });
});

describe('mayTakeText', () => {
  it('is true for a textarea, an input that holds an entry and editable content', () => {
    assert.equal(mayTakeText({ tagName: 'TEXTAREA' }), true);
    for (const type of ['text', 'password', 'search', 'email', 'url', 'tel', 'number', 'date']) {
      assert.equal(mayTakeText({ tagName: 'INPUT', type }), true, type);
    }
    assert.equal(mayTakeText({ tagName: 'DIV', isContentEditable: true }), true);
  });

  it('is false for every input type that holds no entry', () => {
    assert.deepEqual(NON_ENTRY_INPUT_TYPES, [
      'button',
      'checkbox',
      'file',
      'image',
      'radio',
      'reset',
      'submit',
    ]);
    for (const type of NON_ENTRY_INPUT_TYPES) {
      assert.equal(mayTakeText({ tagName: 'INPUT', type }), false, type);
    }
  });

  it('is false for a control that is no text field, and for no element', () => {
    for (const tagName of ['BUTTON', 'A', 'SELECT', 'SUMMARY', 'DIV', 'BODY']) {
      assert.equal(mayTakeText({ tagName, isContentEditable: false }), false, tagName);
    }
    assert.equal(mayTakeText(null), false);
  });
});

describe('keyPressKind', () => {
  // Regression: #702 — only a fixed set of keys was written, so a shortcut, an
  // editing key or a letter a page acts on left no record.
  // https://github.com/Arsarneq/docent/issues/702
  it('regression_702_a_key_that_enters_no_character_is_a_named_key', () => {
    for (const key of [
      'Enter',
      'Escape',
      'Tab',
      'ArrowUp',
      'Backspace',
      'Delete',
      'Home',
      'End',
      'PageUp',
      'PageDown',
      'Insert',
      'F1',
      'F12',
      'CapsLock',
      'ContextMenu',
      'Unidentified',
    ]) {
      assert.equal(keyPressKind(key, false), 'named', key);
    }
  });

  it('regression_702_a_key_whose_value_is_one_character_or_a_dead_key_is_a_character_key', () => {
    for (const key of ['a', 'A', '1', ' ', '.', 'å', '€', '😀', 'Dead']) {
      assert.equal(keyPressKind(key, false), 'character', key);
    }
  });

  it('regression_702_the_meta_key_is_a_named_key_as_the_desktop_writes_it', () => {
    // The system acts on this key by itself (it opens the Start menu), and the
    // desktop writes its press.
    assert.equal(keyPressKind('Meta', false), 'named');
  });

  it('regression_702_shift_ctrl_alt_and_altgr_alone_are_modifiers', () => {
    assert.deepEqual(MODIFIER_KEYS, ['Shift', 'Control', 'Alt', 'AltGraph']);
    for (const key of MODIFIER_KEYS) assert.equal(keyPressKind(key, false), 'modifier', key);
  });

  it('regression_702_a_key_the_input_method_takes_is_composed', () => {
    for (const key of ['Process', '']) assert.equal(keyPressKind(key, false), 'composed', key);
    // Any key pressed while a composition is open belongs to it.
    for (const key of ['a', 'Enter', 'Backspace', ' ']) {
      assert.equal(keyPressKind(key, true), 'composed', key);
    }
    // A modifier stays a modifier.
    assert.equal(keyPressKind('Shift', true), 'modifier');
  });
});

describe('isShortcut', () => {
  const held = (ctrl, alt, meta) => ({ ctrl, alt, meta, shift: false });

  it('regression_702_ctrl_or_meta_held_is_a_shortcut', () => {
    for (const altEntersCharacters of [false, true]) {
      assert.equal(isShortcut(held(true, false, false), altEntersCharacters), true);
      assert.equal(isShortcut(held(false, false, true), altEntersCharacters), true);
      assert.equal(isShortcut(held(true, true, true), altEntersCharacters), true);
      assert.equal(isShortcut(held(false, true, true), altEntersCharacters), true);
    }
  });

  it('regression_702_no_modifier_and_ctrl_with_alt_can_enter_a_character', () => {
    // Ctrl and Alt together is AltGr.
    for (const altEntersCharacters of [false, true]) {
      assert.equal(isShortcut(held(false, false, false), altEntersCharacters), false);
      assert.equal(isShortcut(held(true, true, false), altEntersCharacters), false);
    }
  });

  it('regression_702_alt_alone_is_a_shortcut_except_where_it_enters_characters', () => {
    // Alt with a character key reaches for a menu; on a Mac it is the Option
    // key, which enters characters of the layout.
    assert.equal(isShortcut(held(false, true, false), false), true);
    assert.equal(isShortcut(held(false, true, false), true), false);
  });
});

describe('isSensitiveElement', () => {
  const elements = [
    createElement('input', { type: 'password' }),
    createElement('input', { type: 'PASSWORD' }),
    createElement('input', { type: 'text', autocomplete: 'cc-number' }),
    createElement('input', { type: 'text', autocomplete: ' CC-CSC ' }),
    createElement('input', { type: 'text', autocomplete: 'cc-exp' }),
    createElement('input', { type: 'text', autocomplete: 'cc-exp-month' }),
    createElement('input', { type: 'text', autocomplete: 'cc-exp-year' }),
    createElement('input', { type: 'text', autocomplete: 'email' }),
    createElement('input', { type: 'text', name: 'card_number' }),
    createElement('input', { type: 'text', name: 'city' }),
    createElement('input', { type: 'text', id: 'cvv' }),
    createElement('input', { type: 'text', id: 'postcode' }),
    createElement('div', { id: 'otp' }),
    createElement('div', { id: 'footer' }),
    createElement('div', { role: 'textbox', name: 'api-key' }),
    createElement('textarea', { name: 'notes' }),
    createElement('button', { name: 'show-password' }),
  ];

  it('regression_702_the_recorder_and_the_worker_find_the_same_elements_sensitive', () => {
    // The worker tests the description the recorder sends; the recorder tests
    // the element, before it writes anything about a key pressed on it.
    for (const el of elements) {
      const described = describeElement(el);
      assert.equal(isSensitiveElement(el), isSensitiveField(described), JSON.stringify(described));
    }
    assert.equal(isSensitiveElement(elements[0]), true);
    assert.equal(isSensitiveElement(elements[9]), false);
    assert.equal(isSensitiveElement(elements[12]), true);
  });

  it('regression_702_the_recorder_holds_the_shared_rule_s_own_patterns', () => {
    assert.deepEqual([...SENSITIVE_AUTOCOMPLETE].sort(), [...SHARED_AUTOCOMPLETE].sort());
    assert.equal(String(SENSITIVE_NAME_RE), String(SHARED_NAME_RE));
  });

  it('regression_702_no_element_is_not_sensitive', () => {
    assert.equal(isSensitiveElement(null), false);
  });
});

describe('takesNoTypedText', () => {
  const elements = [
    createElement('button'),
    createElement('a'),
    createElement('summary'),
    createElement('div'),
    createElement('select'),
    createElement('textarea'),
    createElement('input', { type: 'text' }),
    createElement('input', { type: 'password' }),
    ...NON_ENTRY_INPUT_TYPES.map((type) => createElement('input', { type })),
    ...[
      'button',
      'checkbox',
      'link',
      'menuitem',
      'menuitemcheckbox',
      'menuitemradio',
      'radio',
      'switch',
      'tab',
      'TAB',
      'option',
      'textbox',
      'listbox',
    ].map((role) => createElement('div', { role })),
  ];

  it('regression_702_the_recorder_and_the_worker_agree_on_the_controls_that_take_no_typed_text', () => {
    for (const el of elements) {
      const described = describeElement(el);
      assert.equal(
        takesNoTypedText(el),
        workerTakesNoTypedText(described),
        JSON.stringify(described),
      );
    }
    assert.equal(takesNoTypedText(elements[0]), true);
    assert.equal(takesNoTypedText(elements[3]), false);
    assert.equal(takesNoTypedText(elements[4]), false);
  });

  it('regression_702_the_recorder_and_the_worker_hold_the_same_lists', () => {
    // A tag, role or input type added to one copy only fails here.
    assert.deepEqual([...NON_ENTRY_INPUT_TYPES].sort(), [...WORKER_NON_TEXT_INPUT_TYPES].sort());
    assert.deepEqual([...NON_TEXT_TAGS].sort(), [...WORKER_NON_TEXT_TAGS].sort());
    assert.deepEqual([...NON_TEXT_ROLES].sort(), [...WORKER_NON_TEXT_ROLES].sort());
  });

  it('regression_702_the_worker_s_shortcut_test_is_the_recorder_s', () => {
    const either = [false, true];
    for (const ctrl of either) {
      for (const alt of either) {
        for (const meta of either) {
          for (const altEntersCharacters of either) {
            const modifiers = { ctrl, alt, meta, shift: false };
            assert.equal(
              keyEntersText({ type: 'key', key: 'a', modifiers }, altEntersCharacters),
              !isShortcut(modifiers, altEntersCharacters),
              JSON.stringify({ modifiers, altEntersCharacters }),
            );
          }
        }
      }
    }
  });

  it('regression_702_no_element_takes_typed_text_for_all_the_rule_knows', () => {
    assert.equal(takesNoTypedText(null), false);
  });
});

describe('keyActionName', () => {
  // Regression: #695 — https://github.com/Arsarneq/docent/issues/695
  it('regression_695_a_space_is_named_Space_and_every_other_key_as_the_browser_names_it', () => {
    assert.equal(keyActionName(' '), 'Space');
    for (const key of ['Enter', 'a', 'A', 'F5', 'Backspace', 'Dead']) {
      assert.equal(keyActionName(key), key);
    }
  });
});
