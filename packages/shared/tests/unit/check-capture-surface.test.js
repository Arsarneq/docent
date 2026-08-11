/**
 * check-capture-surface.test.js — Unit tests for the capture-surface admission
 * test (scripts/check-capture-surface.js). Both platforms' surfaces are
 * committed closed enumerations (system capture-principles §CP-14, extension
 * §ECP-6/§ECP-7, desktop §DCP-4/§DCP-7), so every red path must fail loud:
 * these tests prove the pairwise set inequalities in each direction on every
 * leg, the receiver and multiplicity legs (an enumerated event moved to
 * `window`, a capture proxy registered twice), the admission list's
 * unadmitted / miscounted / stale legs, WinEvent range coverage (a widened
 * pair reds on the ids it spans, not on its endpoints, and a repeated pair
 * reds on its own) and the refusal of an endpoint the value table cannot resolve,
 * the extractors' unreadable-entry and unmodelled-shape refusals, duplicates,
 * empty parses, and — as a real-tree lock — that the shipped tree satisfies
 * every contract.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  RECORDER_PATH,
  WORKER_PATH,
  EXTENSION_DOC_PATH,
  DESKTOP_DOC_PATH,
  WINDOWS_CAPTURE_PATH,
  DOM_CLAUSE_ID,
  PROXY_CLAUSE_ID,
  DESKTOP_CLAUSE_ID,
  CORRELATION_CLAUSE_ID,
  EMPTY_SURFACES,
  DUPLICATE_SURFACES,
  ADMITTED_REGISTRATIONS,
  WIN_EVENT_VALUES,
  extractDomEnumeration,
  extractProxySources,
  extractRegistrations,
  extractDesktopRegistrations,
  extractClauseNames,
  extractCorrelationClasses,
  expandRange,
  evaluateCaptureSurface,
  auditTree,
} from '../../../../scripts/check-capture-surface.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');

/** A consistent synthetic surface every contract accepts. */
function makeSurface(overrides = {}) {
  return {
    docDomEvents: ['click', 'change'],
    docProxyWorkerEvents: ['chrome.tabs.onCreated'],
    docProxyDomEvents: ['change'],
    extensionUnreadable: [],
    recorderDomEvents: ['click', 'change'],
    recorderWindowEvents: [],
    recorderChromeApis: ['chrome.storage.onChanged'],
    workerDomEvents: [],
    workerChromeApis: ['chrome.tabs.onCreated', 'chrome.alarms.onAlarm'],
    docHooks: ['WH_MOUSE_LL'],
    docCorrelationClasses: ['EVENT_OBJECT_CREATE', 'EVENT_OBJECT_DESTROY'],
    desktopUnreadable: [],
    installedHooks: ['WH_MOUSE_LL'],
    installedRanges: [['EVENT_OBJECT_CREATE', 'EVENT_OBJECT_DESTROY']],
    admitted: [
      { file: RECORDER_PATH, api: 'chrome.storage.onChanged', occurrences: 1, why: 'x' },
      { file: WORKER_PATH, api: 'chrome.alarms.onAlarm', occurrences: 1, why: 'x' },
    ],
    ...overrides,
  };
}

describe('evaluateCaptureSurface — compliant baseline', () => {
  it('returns no problems when every contract holds', () => {
    assert.deepEqual(evaluateCaptureSurface(makeSurface()), []);
  });
});

describe('evaluateCaptureSurface — the DOM leg (both ways)', () => {
  it('fires when the recorder registers an event the clause does not enumerate', () => {
    const problems = evaluateCaptureSurface(
      makeSurface({ recorderDomEvents: ['click', 'change', 'pointerdown'] }),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /`pointerdown` is registered/);
    assert.match(problems[0], new RegExp(DOM_CLAUSE_ID));
  });

  it('fires when the clause enumerates an event the recorder does not register', () => {
    const problems = evaluateCaptureSurface(
      makeSurface({ docDomEvents: ['click', 'change', 'wheel'] }),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /`wheel` is enumerated .* registers no listener/);
  });

  it('fires when a proxy names a DOM source the clause does not enumerate', () => {
    const problems = evaluateCaptureSurface(makeSurface({ docProxyDomEvents: ['paste'] }));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /`paste` is named as a proxy's Event source/);
  });

  it('fires on a DOM listener registered in the service worker', () => {
    const problems = evaluateCaptureSurface(makeSurface({ workerDomEvents: ['click'] }));
    assert.ok(problems.some((p) => /registers a DOM listener for `click`/.test(p)));
  });

  it('fires on an enumerated event the recorder registers on window instead', () => {
    // The receiver is part of the enumeration: the same listener moved off
    // `document` reds on both sides — wrong receiver, and an enumerated event
    // with no listener left on the stated one.
    const problems = evaluateCaptureSurface(
      makeSurface({ recorderDomEvents: ['change'], recorderWindowEvents: ['click'] }),
    );
    assert.equal(problems.length, 2);
    assert.ok(problems.some((p) => /registers `click` on `window`/.test(p)));
    assert.ok(problems.some((p) => /`click` is enumerated .* registers no listener/.test(p)));
  });
});

describe('evaluateCaptureSurface — the proxy and admission legs', () => {
  it('fires on a registration that is neither a stated proxy nor admitted', () => {
    const problems = evaluateCaptureSurface(
      makeSurface({
        workerChromeApis: ['chrome.tabs.onCreated', 'chrome.alarms.onAlarm', 'chrome.idle.onStateChanged'], // prettier-ignore
      }),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /`chrome\.idle\.onStateChanged`, which is neither a capture proxy/);
  });

  it('fires when an admitted API is registered more times than admitted', () => {
    const problems = evaluateCaptureSurface(
      makeSurface({
        workerChromeApis: ['chrome.tabs.onCreated', 'chrome.alarms.onAlarm', 'chrome.alarms.onAlarm'], // prettier-ignore
      }),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /registers `chrome\.alarms\.onAlarm` 2 time\(s\); the admission list admits 1/); // prettier-ignore
  });

  it('fires when a capture proxy is registered more than once', () => {
    // Ungated multiplicity here would emit two proxies for one user action —
    // a second `chrome.tabs.onCreated` listener means a doubled context_open.
    const problems = evaluateCaptureSurface(
      makeSurface({
        workerChromeApis: ['chrome.tabs.onCreated', 'chrome.tabs.onCreated', 'chrome.alarms.onAlarm'], // prettier-ignore
      }),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /registers the capture proxy `chrome\.tabs\.onCreated` 2 time\(s\)/);
    assert.match(problems[0], /CP-9/);
  });

  it('fires on a stale admission entry', () => {
    const problems = evaluateCaptureSurface(
      makeSurface({ workerChromeApis: ['chrome.tabs.onCreated'] }),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /the admission list admits `chrome\.alarms\.onAlarm`.*is stale/);
  });

  it('fires when the doc names a worker event the worker does not register', () => {
    const problems = evaluateCaptureSurface(
      makeSurface({ docProxyWorkerEvents: ['chrome.tabs.onCreated', 'chrome.tabs.onZoomChange'] }),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /`chrome\.tabs\.onZoomChange` is named as a proxy's Event source/);
  });

  it('fires when one registration is claimed as both a proxy and an admitted role', () => {
    const problems = evaluateCaptureSurface(
      makeSurface({
        docProxyWorkerEvents: ['chrome.tabs.onCreated', 'chrome.alarms.onAlarm'],
      }),
    );
    assert.equal(problems.length, 1);
    assert.match(
      problems[0],
      /is both a capture proxy .* and an admitted non-capture registration/,
    );
  });

  it("admits the recorder's own chrome registrations through the same one list", () => {
    const problems = evaluateCaptureSurface(
      makeSurface({ recorderChromeApis: ['chrome.storage.onChanged', 'chrome.tabs.onCreated'] }),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], new RegExp(`${RECORDER_PATH} registers \`chrome\\.tabs\\.onCreated\``)); // prettier-ignore
  });
});

describe('evaluateCaptureSurface — the desktop leg', () => {
  it('fires in both directions on the low-level hook set', () => {
    const added = evaluateCaptureSurface(
      makeSurface({ installedHooks: ['WH_MOUSE_LL', 'WH_JOURNALRECORD'] }),
    );
    assert.equal(added.length, 1);
    assert.match(
      added[0],
      new RegExp(`\`WH_JOURNALRECORD\` is installed .* §${DESKTOP_CLAUSE_ID}`),
    );

    const dropped = evaluateCaptureSurface(
      makeSurface({ docHooks: ['WH_MOUSE_LL', 'WH_KEYBOARD_LL'] }),
    );
    assert.equal(dropped.length, 1);
    assert.match(dropped[0], /`WH_KEYBOARD_LL` is named .* installs no such hook/);
  });

  it('reds on what a widened range CONTAINS, not on its endpoints', () => {
    const problems = evaluateCaptureSurface(
      makeSurface({
        docCorrelationClasses: ['EVENT_OBJECT_CREATE', 'EVENT_OBJECT_DESTROY', 'EVENT_OBJECT_FOCUS'], // prettier-ignore
        installedRanges: [['EVENT_OBJECT_CREATE', 'EVENT_OBJECT_FOCUS']],
      }),
    );
    // Both endpoints are named classes; the ids between them are not.
    assert.deepEqual(
      problems.map((p) => /contains `(EVENT_[A-Z_]+)`/.exec(p)?.[1]).filter(Boolean),
      ['EVENT_OBJECT_SHOW', 'EVENT_OBJECT_HIDE', 'EVENT_OBJECT_REORDER'],
    );
  });

  it('fires when the correlation table names a class no registered range contains', () => {
    const problems = evaluateCaptureSurface(
      makeSurface({
        docCorrelationClasses: ['EVENT_OBJECT_CREATE', 'EVENT_OBJECT_DESTROY', 'EVENT_OBJECT_FOCUS'], // prettier-ignore
      }),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /`EVENT_OBJECT_FOCUS` is named .* no registered WinEvent range contains it/); // prettier-ignore
  });

  it('refuses a range endpoint the value table cannot resolve', () => {
    const problems = evaluateCaptureSurface(
      makeSurface({ installedRanges: [['EVENT_OBJECT_CREATE', 'EVENT_OBJECT_UNHEARD_OF']] }),
    );
    assert.ok(
      problems.some((p) =>
        new RegExp(`\`EVENT_OBJECT_UNHEARD_OF\`.*no value for it.*${CORRELATION_CLAUSE_ID}`).test(
          p,
        ),
      ),
    );
  });

  it('names an unnamed contained id by its raw value', () => {
    const problems = evaluateCaptureSurface(
      makeSurface({
        docCorrelationClasses: ['EVENT_OBJECT_LIVEREGIONCHANGED', 'EVENT_OBJECT_HOSTEDOBJECTSINVALIDATED'], // prettier-ignore
        installedRanges: [
          ['EVENT_OBJECT_LIVEREGIONCHANGED', 'EVENT_OBJECT_HOSTEDOBJECTSINVALIDATED'],
        ],
      }),
    );
    assert.deepEqual(problems.map((p) => /contains event id (\d+)/.exec(p)?.[1]).filter(Boolean), [
      '32794',
      '32795',
      '32796',
      '32797',
      '32798',
      '32799',
    ]);
  });
});

describe('expandRange', () => {
  it('expands an inclusive range id by id', () => {
    assert.deepEqual(
      expandRange(['EVENT_OBJECT_CREATE', 'EVENT_OBJECT_SHOW']).ids,
      [32768, 32769, 32770],
    );
  });

  it('refuses a backwards range rather than expanding to nothing', () => {
    const { ids, problems } = expandRange(['EVENT_OBJECT_SHOW', 'EVENT_OBJECT_CREATE']);
    assert.deepEqual(ids, []);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /runs backwards/);
  });

  it('carries the registered endpoints of the shipped tree', () => {
    for (const name of [
      'EVENT_SYSTEM_FOREGROUND',
      'EVENT_OBJECT_CREATE',
      'EVENT_OBJECT_DESTROY',
      'EVENT_OBJECT_FOCUS',
      'EVENT_OBJECT_VALUECHANGE',
      'EVENT_OBJECT_SELECTION',
    ]) {
      assert.equal(typeof WIN_EVENT_VALUES[name], 'number', `${name} has a value`);
    }
    // The object-event block is contiguous from CREATE, which is what makes
    // containment meaningful rather than a lookup of isolated points.
    assert.equal(WIN_EVENT_VALUES.EVENT_OBJECT_DESTROY, WIN_EVENT_VALUES.EVENT_OBJECT_CREATE + 1);
  });

  it('carries pairwise distinct values — the reverse lookup has one answer', () => {
    // The containment leg names each contained id through a reverse lookup of
    // this table. Two constants sharing a value would make that lookup return
    // whichever came first, so a contained id could be reported as — or
    // silently accepted as — a class it is not.
    const values = Object.values(WIN_EVENT_VALUES);
    const collisions = values.filter((v, i) => values.indexOf(v) !== i);
    assert.deepEqual(collisions, []);
  });
});

/** One fixture per duplicates leg, keyed by the surface it duplicates. */
const DUPLICATE_FIXTURES = {
  docDomEvents: { docDomEvents: ['click', 'click', 'change'], recorderDomEvents: ['click', 'change'] }, // prettier-ignore
  recorderDomEvents: { recorderDomEvents: ['click', 'click', 'change'] },
  docHooks: { docHooks: ['WH_MOUSE_LL', 'WH_MOUSE_LL'] },
  docCorrelationClasses: {
    docCorrelationClasses: ['EVENT_OBJECT_CREATE', 'EVENT_OBJECT_CREATE', 'EVENT_OBJECT_DESTROY'],
  },
  installedHooks: { installedHooks: ['WH_MOUSE_LL', 'WH_MOUSE_LL'] },
  // Derived inside the evaluator from the registered pairs: a repeated pair
  // installs the hook twice, which the set-based containment diff cannot see.
  installedRangeLabels: {
    installedRanges: [
      ['EVENT_OBJECT_CREATE', 'EVENT_OBJECT_DESTROY'],
      ['EVENT_OBJECT_CREATE', 'EVENT_OBJECT_DESTROY'],
    ],
  },
};

describe('evaluateCaptureSurface — duplicates, every leg of the duplicates list', () => {
  it('the fixture table covers exactly the check’s duplicates legs (addition lock)', () => {
    assert.deepEqual(
      DUPLICATE_SURFACES.map(([key]) => key).sort(),
      Object.keys(DUPLICATE_FIXTURES).sort(),
    );
  });

  it('the surface labels are pairwise distinct — a copied leg cannot hide', () => {
    const labels = DUPLICATE_SURFACES.map(([, what]) => what);
    assert.equal(new Set(labels).size, labels.length);
  });

  for (const [key, what] of DUPLICATE_SURFACES) {
    it(`fires on a duplicate in ${what}`, () => {
      const problems = evaluateCaptureSurface(makeSurface(DUPLICATE_FIXTURES[key]));
      assert.ok(problems.some((p) => p.includes('appears more than once in') && p.includes(what)));
    });
  }
});

describe('evaluateCaptureSurface — empty parses are structural failures', () => {
  it('the export is non-empty and its diagnoses pairwise distinct', () => {
    assert.ok(EMPTY_SURFACES.length > 0);
    const messages = EMPTY_SURFACES.map(([, m]) => m);
    assert.equal(new Set(messages).size, messages.length);
  });

  for (const [key, message] of EMPTY_SURFACES) {
    it(`fires when ${key} parses empty`, () => {
      const problems = evaluateCaptureSurface(makeSurface({ [key]: [] }));
      assert.ok(problems.includes(message), `expected: ${message}`);
    });
  }

  it('an empty parse short-circuits the set diffs rather than reporting phantom gaps', () => {
    const problems = evaluateCaptureSurface(makeSurface({ docDomEvents: [] }));
    assert.ok(!problems.some((p) => p.includes('is registered in')));
  });
});

describe('extractDomEnumeration', () => {
  const doc = [
    '## Capture Surface',
    '',
    `**${DOM_CLAUSE_ID}.** The recorder listens for exactly these DOM events:`,
    '',
    '- `click` — activation',
    '- `change` — a committed value',
    '  continued on a wrapped line',
    '',
    '## Browser Chrome Proxies',
    '',
    `**${PROXY_CLAUSE_ID}.** Captured by proxy:`,
    '',
    '- `notanevent` — outside the clause scope',
    '',
  ].join('\n');

  it('reads the leading backticked token of each item inside the clause scope only', () => {
    assert.deepEqual(extractDomEnumeration(doc).events, ['click', 'change']);
  });

  it('returns an item whose lead is not a lone backticked name as unreadable', () => {
    const broken = doc.replace('- `click` — activation', '- click — activation');
    const { events, unreadable } = extractDomEnumeration(broken);
    assert.deepEqual(events, ['change']);
    assert.deepEqual(unreadable, ['- click — activation']);
  });

  it('ignores a fenced example rather than reading it as an enumeration item', () => {
    const fenced = doc.replace(
      '- `change` — a committed value',
      '- `change` — a committed value\n\n```text\n- `fenced` — not an entry\n```\n',
    );
    assert.deepEqual(extractDomEnumeration(fenced).events, ['click', 'change']);
  });
});

describe('extractProxySources', () => {
  const doc = [
    '## Browser Chrome Proxies',
    '',
    '| User action | Captured as | Event source |',
    '| --- | --- | --- |',
    '| Click a tab | `context_switch` | `chrome.tabs.onActivated` |',
    '| Pick a file | `file_upload` | `change` (the recorder) |',
    '| Reopen a tab | `context_open` + `navigate` | `chrome.tabs.onCreated` + `chrome.webNavigation.onCommitted` |', // prettier-ignore
    '',
  ].join('\n');

  it('splits the column into worker events and DOM events', () => {
    const { workerEvents, domEvents, unreadable } = extractProxySources(doc);
    assert.deepEqual(workerEvents, [
      'chrome.tabs.onActivated',
      'chrome.tabs.onCreated',
      'chrome.webNavigation.onCommitted',
    ]);
    assert.deepEqual(domEvents, ['change']);
    assert.deepEqual(unreadable, []);
  });

  it('returns a cell with no backticked token as unreadable', () => {
    const broken = doc.replace('| `chrome.tabs.onActivated` |', '| the tabs API |');
    assert.deepEqual(extractProxySources(broken).unreadable, ['the tabs API']);
  });

  it('returns a token in neither shape as unreadable', () => {
    const broken = doc.replace('`chrome.tabs.onActivated`', '`Tabs::onActivated`');
    assert.deepEqual(extractProxySources(broken).unreadable, ['Tabs::onActivated']);
  });

  it('refuses a proxy table that states no Event source column', () => {
    const narrowed = [
      '## Browser Chrome Proxies',
      '',
      '| User action | Captured as |',
      '| --- | --- |',
      '| Click a tab | `context_switch` |',
      '',
    ].join('\n');
    assert.deepEqual(extractProxySources(narrowed).unreadable, [
      '(the proxy table states no Event source column)',
    ]);
  });
});

describe('extractRegistrations', () => {
  it('splits DOM listeners by receiver and reads chrome listener paths', () => {
    const source = [
      "document.addEventListener('click', handler, { capture: true });",
      "window.addEventListener('resize', handler);",
      'chrome.storage.onChanged.addListener(handler);',
      'chrome.webNavigation.onCompleted.addListener(handler);',
    ].join('\n');
    const { domEvents, windowEvents, chromeApis, problems } = extractRegistrations(source, 'f.js');
    assert.deepEqual(domEvents, ['click']);
    assert.deepEqual(windowEvents, ['resize']);
    assert.deepEqual(chromeApis, ['chrome.storage.onChanged', 'chrome.webNavigation.onCompleted']);
    assert.deepEqual(problems, []);
  });

  it('never reads a commented-out registration', () => {
    const source = [
      "// document.addEventListener('paste', handler);",
      "/* window.addEventListener('wheel', handler); */",
      "document.addEventListener('click', handler);",
    ].join('\n');
    const { domEvents, windowEvents } = extractRegistrations(source, 'f.js');
    assert.deepEqual(domEvents, ['click']);
    assert.deepEqual(windowEvents, []);
  });

  it('refuses a computed event name rather than skipping it', () => {
    const { problems } = extractRegistrations("document.addEventListener(NAME, h);", 'f.js'); // prettier-ignore
    assert.equal(problems.length, 1);
    assert.match(problems[0], /event name is not a string literal/);
  });

  it('refuses a concatenated event name rather than reading its leading fragment', () => {
    // Without the comma containment the string token alone is read, so this
    // registers `mousedown` while the scan records `mouse` — a real event
    // silently absent from the surface, and a phantom one silently in it.
    const { domEvents, windowEvents, problems } = extractRegistrations(
      "document.addEventListener('mouse' + 'down', h);",
      'f.js',
    );
    assert.deepEqual(domEvents, []);
    assert.deepEqual(windowEvents, []);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /not a string literal standing alone as the first argument/);
  });

  it('refuses a DOM listener on a receiver outside the model', () => {
    const { problems } = extractRegistrations("el.addEventListener('click', h);", 'f.js');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /receiver the scan does not model \(el\)/);
  });

  it('refuses an addListener chain that does not start at chrome', () => {
    const { problems } = extractRegistrations('port.onMessage.addListener(h);', 'f.js');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /port\.onMessage\.addListener/);
  });
});

describe('extractDesktopRegistrations', () => {
  const source = [
    'fn install() {',
    '    for (event_min, event_max) in [',
    '        (EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND),',
    '        (EVENT_OBJECT_CREATE, EVENT_OBJECT_DESTROY),',
    '    ] {',
    '        let hook = unsafe { SetWinEventHook(event_min, event_max, None) };',
    '    }',
    '    SetWindowsHookExW(WH_MOUSE_LL, Some(p), None, 0);',
    '    SetWindowsHookExW(WH_KEYBOARD_LL, Some(p), None, 0);',
    '}',
  ].join('\n');

  it('reads the hooks and the registered ranges', () => {
    const { hooks, ranges, problems } = extractDesktopRegistrations(source);
    assert.deepEqual(hooks, ['WH_MOUSE_LL', 'WH_KEYBOARD_LL']);
    assert.deepEqual(ranges, [
      ['EVENT_SYSTEM_FOREGROUND', 'EVENT_SYSTEM_FOREGROUND'],
      ['EVENT_OBJECT_CREATE', 'EVENT_OBJECT_DESTROY'],
    ]);
    assert.deepEqual(problems, []);
  });

  it('never reads a commented-out registration', () => {
    const commented = source.replace(
      '        (EVENT_OBJECT_CREATE, EVENT_OBJECT_DESTROY),',
      '        // (EVENT_OBJECT_CREATE, EVENT_OBJECT_DESTROY),',
    );
    assert.deepEqual(extractDesktopRegistrations(commented).ranges, [
      ['EVENT_SYSTEM_FOREGROUND', 'EVENT_SYSTEM_FOREGROUND'],
    ]);
  });

  it('refuses a tree with no registration loop the scan can anchor on', () => {
    const { problems } = extractDesktopRegistrations(source.replace('event_min, event_max', 'a, b')); // prettier-ignore
    assert.equal(problems.length, 1);
    assert.match(problems[0], /carries 0 WinEvent registration loops/);
  });

  it('refuses more than one WinEvent installation site', () => {
    const twice = source.replace(
      '    }\n    SetWindowsHookExW(WH_MOUSE_LL',
      '    }\n    unsafe { SetWinEventHook(1, 2, None) };\n    SetWindowsHookExW(WH_MOUSE_LL',
    );
    const { problems } = extractDesktopRegistrations(twice);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /carries 2 SetWinEventHook call sites/);
  });

  it('refuses a pair it cannot read as (event_min, event_max)', () => {
    const broken = source.replace(
      '(EVENT_OBJECT_CREATE, EVENT_OBJECT_DESTROY),',
      '(EVENT_OBJECT_CREATE, EVENT_OBJECT_DESTROY, 1),',
    );
    const { problems } = extractDesktopRegistrations(broken);
    assert.ok(problems.some((p) => /cannot read as an \(event_min, event_max\) pair/.test(p)));
  });

  it('refuses a hook installation whose first argument is not a constant name', () => {
    const broken = source.replace('SetWindowsHookExW(WH_MOUSE_LL', 'SetWindowsHookExW(*hook_id');
    const { problems } = extractDesktopRegistrations(broken);
    assert.ok(problems.some((p) => /first argument the scan cannot read/.test(p)));
  });
});

describe('extractClauseNames and extractCorrelationClasses', () => {
  const doc = [
    '## Capture Surface',
    '',
    `**${DESKTOP_CLAUSE_ID}.** The two low-level input hooks (\`WH_MOUSE_LL\`, \`WH_KEYBOARD_LL\`) and the classes below.`, // prettier-ignore
    '',
    '## Input Correlation',
    '',
    `**${CORRELATION_CLAUSE_ID}.** Correlated classes:`,
    '',
    '| WinEvent | Correlation source |',
    '| --- | --- |',
    '| `EVENT_OBJECT_CREATE` | Any low-level input |',
    '| `EVENT_OBJECT_DESTROY` | Any low-level input |',
    '',
  ].join('\n');

  it('reads the hook names from the clause scope, ignoring names elsewhere', () => {
    assert.deepEqual(extractClauseNames(doc, DESKTOP_CLAUSE_ID, /^WH_[A-Z0-9_]+$/), [
      'WH_MOUSE_LL',
      'WH_KEYBOARD_LL',
    ]);
  });

  it('reads the correlation table and refuses an unreadable first cell', () => {
    assert.deepEqual(extractCorrelationClasses(doc).classes, [
      'EVENT_OBJECT_CREATE',
      'EVENT_OBJECT_DESTROY',
    ]);
    const broken = doc.replace('| `EVENT_OBJECT_CREATE` |', '| EVENT_OBJECT_CREATE |');
    const { classes, unreadable } = extractCorrelationClasses(broken);
    assert.deepEqual(classes, ['EVENT_OBJECT_DESTROY']);
    assert.deepEqual(unreadable, ['EVENT_OBJECT_CREATE']);
  });
});

describe('the admission list', () => {
  it('states a distinct file/api key, a positive occurrence count, and a reason per entry', () => {
    const keys = ADMITTED_REGISTRATIONS.map((e) => `${e.file} ${e.api}`);
    assert.equal(new Set(keys).size, keys.length);
    for (const entry of ADMITTED_REGISTRATIONS) {
      assert.ok([RECORDER_PATH, WORKER_PATH].includes(entry.file), `${entry.api} names a scanned file`); // prettier-ignore
      assert.ok(Number.isInteger(entry.occurrences) && entry.occurrences > 0);
      assert.ok(entry.why.length > 40, `${entry.api} states why it is admitted`);
    }
  });
});

describe('auditTree — the shipped tree', () => {
  const readFile = (f) => readFileSync(resolve(ROOT, f), 'utf8');

  it('holds every capture surface in the working tree', () => {
    const { problems } = auditTree(readFile);
    assert.deepEqual(problems, []);
  });

  it('reads a non-vacuous surface from each scanned file', () => {
    const { domEventCount, proxyCount, winEventCount } = auditTree(readFile);
    assert.ok(domEventCount > 0);
    assert.ok(proxyCount > 0);
    assert.ok(winEventCount > 0);
  });

  it('an unreadable input fails loudly rather than passing vacuously', () => {
    const { problems } = auditTree((f) => (f === WINDOWS_CAPTURE_PATH ? '' : readFile(f)));
    assert.ok(problems.length > 0);
    assert.ok(problems.some((p) => p.includes(WINDOWS_CAPTURE_PATH)));
  });

  it('names each scanned surface path exactly once in its own constant', () => {
    const paths = [
      RECORDER_PATH,
      WORKER_PATH,
      EXTENSION_DOC_PATH,
      DESKTOP_DOC_PATH,
      WINDOWS_CAPTURE_PATH,
    ];
    assert.equal(new Set(paths).size, paths.length);
    for (const p of paths) assert.doesNotThrow(() => readFile(p));
  });
});
