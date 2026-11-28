/**
 * passive-observer.test.js — the recorder observes a page and takes no part
 * in it (core capture principles, CP-20).
 *
 * Reads the extension's own source. The scripts the extension places in a
 * page are a closed list, and so are the calls in them that cancel or stop a
 * page's event or write to the page: the one that stands today is the
 * `dragover` cancellation the extension capture document lists as a defect
 * (ECP-12; docent#881). A new one fails here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const EXTENSION = resolve(__dirname, '../..');

/** The scripts the extension places in a page. */
const PLACED_IN_A_PAGE = ['content/recorder.js'];

/** Calls that cancel or stop a page's event, or act on the page. */
const CALLS = [
  'preventDefault',
  'stopPropagation',
  'stopImmediatePropagation',
  'dispatchEvent',
  'setAttribute',
  'removeAttribute',
  'toggleAttribute',
  'appendChild',
  'insertBefore',
  'removeChild',
  'replaceChild',
  'replaceWith',
  'insertAdjacentHTML',
  'insertAdjacentElement',
  'insertAdjacentText',
  'append',
  'prepend',
  'remove',
  'focus',
  'blur',
  'click',
  'submit',
  'requestSubmit',
  'scrollTo',
  'scrollBy',
  'scrollIntoView',
  'pushState',
  'replaceState',
  'write',
  'execCommand',
];

/** Properties whose assignment writes to the page. */
const ASSIGNED = [
  'innerHTML',
  'outerHTML',
  'innerText',
  'textContent',
  'value',
  'checked',
  'className',
  'returnValue',
  'href',
  'cssText',
];

const CALL = new RegExp(`\\.(${CALLS.join('|')})\\s*\\(`, 'g');
const ASSIGNMENT = new RegExp(`\\.(${ASSIGNED.join('|')})\\s*=(?!=)`, 'g');

/** Each call or assignment of the lists in `source`, as `{ line, name }`, comments left out. */
function actsOnThePage(source) {
  const found = [];
  source.split('\n').forEach((text, index) => {
    const code = text.trim();
    if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
    for (const pattern of [CALL, ASSIGNMENT]) {
      for (const match of code.matchAll(pattern)) {
        found.push({ line: index + 1, name: match[1] });
      }
    }
  });
  return found;
}

/** The lines of the listener `source` adds for the event `type`, as `[first, last]`. */
function listenerLines(source, type) {
  const lines = source.split('\n');
  const opening = lines.findIndex(
    (text, index) => text.trim() === `'${type}',` && lines[index - 1].includes('addEventListener('),
  );
  assert.notStrictEqual(opening, -1, `no listener for ${type}`);
  const closing = lines.findIndex((text, index) => index > opening && text.startsWith('  );'));
  return [opening + 1, closing + 1];
}

describe('the recorder takes no part in the page (core CP-20)', () => {
  it('the extension places only the recorder in a page, by file', () => {
    const placed = [];
    for (const file of readdirSync(resolve(EXTENSION, 'background'))) {
      const source = readFileSync(resolve(EXTENSION, 'background', file), 'utf8');
      for (const call of source.split('executeScript(').slice(1)) {
        const argument = call.slice(0, call.indexOf('});'));
        assert.doesNotMatch(
          argument,
          /\bfunc\s*:|\bworld\s*:/,
          `${file}: a script placed otherwise`,
        );
        placed.push(...[...argument.matchAll(/'([^']+\.js)'/g)].map((match) => match[1]));
      }
    }
    assert.deepEqual([...new Set(placed)], PLACED_IN_A_PAGE);
  });

  it('the recorder cancels, stops and writes nothing but the dragover of docent#881', () => {
    for (const file of PLACED_IN_A_PAGE) {
      const source = readFileSync(resolve(EXTENSION, file), 'utf8');
      const found = actsOnThePage(source);
      assert.deepEqual(
        found.map((act) => act.name),
        ['preventDefault'],
        `${file}: ${JSON.stringify(found)}`,
      );
      const [first, last] = listenerLines(source, 'dragover');
      assert.ok(
        found[0].line > first && found[0].line < last,
        `${file}:${found[0].line}: outside the dragover listener (${first}-${last})`,
      );
    }
  });

  it('the reader finds a breach written for it', () => {
    const breach = [
      'document.addEventListener(',
      "  'click',",
      '  (e) => {',
      '    // e.preventDefault() in a comment is no call',
      '    e.stopPropagation();',
      "    e.target.value = 'x';",
      '    if (e.target.value === 1) e.target.focus();',
      '  },',
      '  );',
    ].join('\n');
    assert.deepEqual(actsOnThePage(breach), [
      { line: 5, name: 'stopPropagation' },
      { line: 6, name: 'value' },
      { line: 7, name: 'focus' },
    ]);
  });
});
