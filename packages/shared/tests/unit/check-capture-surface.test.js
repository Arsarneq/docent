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
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  RECORDER_PATH,
  WORKER_PATH,
  PANEL_ADAPTER_PATH,
  POPULATION_ROOT,
  POPULATION_TEST_TREE,
  POPULATION_EXTENSIONS,
  derivePopulation,
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
  REGISTRATION_LEGS,
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

/**
 * The tracked JavaScript the shipped closure runs over — the check's own
 * derivation, not a copy of it, so these locks cannot stay green over a
 * population the check has stopped scanning.
 */
const shippedPopulation = () => derivePopulation(ROOT);

/**
 * A consistent synthetic surface every contract accepts. The chrome-registration
 * surface is keyed by file, so the fixture states one list per scanned file:
 * the two capture files, and one population file beyond them — which is what
 * lets a test move a registration between files and see the closure answer
 * differently.
 */
function makeSurface(overrides = {}) {
  const {
    recorderChromeApis = ['chrome.storage.onChanged'],
    workerChromeApis = ['chrome.tabs.onCreated', 'chrome.alarms.onAlarm'],
    panelChromeApis = [],
    ...rest
  } = overrides;
  return {
    population: [RECORDER_PATH, WORKER_PATH, PANEL_ADAPTER_PATH],
    chromeApisByFile: [
      [RECORDER_PATH, recorderChromeApis],
      [WORKER_PATH, workerChromeApis],
      [PANEL_ADAPTER_PATH, panelChromeApis],
    ],
    beyondPairDomEvents: [],
    docDomEvents: ['click', 'change'],
    docProxyWorkerEvents: ['chrome.tabs.onCreated'],
    docProxyDomEvents: ['change'],
    extensionUnreadable: [],
    recorderDomEvents: ['click', 'change'],
    recorderWindowEvents: [],
    workerDomEvents: [],
    docHooks: ['WH_MOUSE_LL'],
    docCorrelationClasses: ['EVENT_OBJECT_CREATE', 'EVENT_OBJECT_DESTROY'],
    desktopUnreadable: [],
    installedHooks: ['WH_MOUSE_LL'],
    installedRanges: [['EVENT_OBJECT_CREATE', 'EVENT_OBJECT_DESTROY']],
    admitted: [
      { file: RECORDER_PATH, api: 'chrome.storage.onChanged', occurrences: 1, why: 'x' },
      { file: WORKER_PATH, api: 'chrome.alarms.onAlarm', occurrences: 1, why: 'x' },
    ],
    ...rest,
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

describe('evaluateCaptureSurface — the scanned population', () => {
  it('holds a registration in a population file beyond the two capture files', () => {
    // The escape this closure exists to close: the same registration passes in
    // one file and reds in another only while the file list is the difference.
    const problems = evaluateCaptureSurface(
      makeSurface({ panelChromeApis: ['chrome.tabs.onUpdated'] }),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], new RegExp(`^${PANEL_ADAPTER_PATH} registers \`chrome\\.tabs\\.onUpdated\``)); // prettier-ignore
    assert.match(problems[0], /the admission list does not admit/);
  });

  it('counts a population file’s registrations against that file’s own admission', () => {
    const admitted = [
      { file: RECORDER_PATH, api: 'chrome.storage.onChanged', occurrences: 1, why: 'x' },
      { file: WORKER_PATH, api: 'chrome.alarms.onAlarm', occurrences: 1, why: 'x' },
      { file: PANEL_ADAPTER_PATH, api: 'chrome.storage.onChanged', occurrences: 2, why: 'x' },
    ];
    assert.deepEqual(
      evaluateCaptureSurface(
        makeSurface({
          admitted,
          panelChromeApis: ['chrome.storage.onChanged', 'chrome.storage.onChanged'],
        }),
      ),
      [],
    );
    const problems = evaluateCaptureSurface(
      makeSurface({
        admitted,
        panelChromeApis: ['chrome.storage.onChanged', 'chrome.storage.onChanged', 'chrome.storage.onChanged'], // prettier-ignore
      }),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], new RegExp(`^${PANEL_ADAPTER_PATH} registers \`chrome\\.storage\\.onChanged\` 3 time\\(s\\); the admission list admits 2`)); // prettier-ignore
  });

  it('routes a beyond-pair file to the admission list, the one route it can take', () => {
    // The proxy route is the worker's: the same API registered elsewhere can
    // only be admitted here, so the refusal offers that route alone — and it
    // never denies the table names an event the table does name.
    const problems = evaluateCaptureSurface(
      makeSurface({ panelChromeApis: ['chrome.tabs.onCreated'] }),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], new RegExp(`^${PANEL_ADAPTER_PATH} registers \`chrome\\.tabs\\.onCreated\`, which the admission list does not admit`)); // prettier-ignore
    assert.match(problems[0], new RegExp(`are ${WORKER_PATH}'s`));
    assert.ok(!problems[0].includes('state it in the doc'), problems[0]);
    assert.ok(!problems[0].includes('is neither a capture proxy'), problems[0]);
  });

  it('lets a population file beyond the pair contribute nothing at all', () => {
    // Most of the extension's production JavaScript registers no chrome
    // listener; that is the ordinary case there, not an empty parse.
    assert.deepEqual(evaluateCaptureSurface(makeSurface({ panelChromeApis: [] })), []);
  });

  it('reds a document listener registered outside the recorder, with no admission route', () => {
    // §ECP-6 enumerates the recorder's DOM surface, so the recorder is the one
    // home a capture listener has: the same registration in a capture-layer
    // module beyond it is capture the enumeration does not describe, and the
    // admission list — which admits `chrome.*` roles — is not a route to it.
    const problems = evaluateCaptureSurface(
      makeSurface({
        beyondPairDomEvents: [
          { file: 'packages/extension/lib/frame-trust.js', receiver: 'document', event: 'paste' },
        ],
      }),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^packages\/extension\/lib\/frame-trust\.js registers a DOM listener for `paste` on `document`/); // prettier-ignore
    assert.match(problems[0], new RegExp(`${DOM_CLAUSE_ID} enumerates ${RECORDER_PATH}`));
    assert.ok(!problems[0].includes('admission list'), problems[0]);
  });

  it('reds a window listener beyond the pair the same way', () => {
    const problems = evaluateCaptureSurface(
      makeSurface({
        beyondPairDomEvents: [
          { file: 'packages/extension/lib/storage-quota.js', receiver: 'window', event: 'resize' },
        ],
      }),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /registers a DOM listener for `resize` on `window`/);
  });

  it('refuses registrations keyed to a file outside the population', () => {
    // The two are one statement of one set: registrations from a file the
    // population does not name describe a scan this closure never claimed.
    const surface = makeSurface();
    const problems = evaluateCaptureSurface({
      ...surface,
      chromeApisByFile: [...surface.chromeApisByFile, ['packages/extension/lib/stray.js', []]],
    });
    assert.ok(
      problems.some((p) => p.startsWith('packages/extension/lib/stray.js carries scanned registrations but is outside the scanned population')), // prettier-ignore
      problems.join('\n') || 'no agreement refusal',
    );
  });

  it('refuses a population file that carries no registration entry', () => {
    const surface = makeSurface();
    const problems = evaluateCaptureSurface({
      ...surface,
      population: [...surface.population, 'packages/extension/lib/unread.js'],
    });
    assert.ok(
      problems.some((p) => p.startsWith('packages/extension/lib/unread.js is in the scanned population but carries no registration entry')), // prettier-ignore
      problems.join('\n') || 'no agreement refusal',
    );
    // A machinery refusal is the whole verdict: the surface diffs below it
    // would describe a population that is not the one stated.
    assert.ok(!problems.some((p) => p.includes('is registered in')), problems.join('\n'));
  });

  it('refuses a population that carries neither capture file', () => {
    // The registrations state the same file set, so the one thing wrong here is
    // the missing capture pair.
    const problems = evaluateCaptureSurface(
      makeSurface({
        population: [PANEL_ADAPTER_PATH],
        chromeApisByFile: [[PANEL_ADAPTER_PATH, []]],
      }),
    );
    assert.equal(problems.length, 2);
    for (const path of [RECORDER_PATH, WORKER_PATH]) {
      assert.ok(problems.some((p) => p.startsWith(`${path} is outside the scanned population`)));
    }
  });

  it('refuses an empty population rather than passing with nothing to hold', () => {
    const problems = evaluateCaptureSurface(makeSurface({ population: [], chromeApisByFile: [] }));
    const empty = problems.find((p) => /no tracked JavaScript module found under/.test(p));
    assert.ok(empty, problems.join('\n') || 'no empty-population refusal');
    // The refusal names the scope it derived from, both halves of it.
    assert.ok(empty.includes(POPULATION_ROOT), empty);
    assert.ok(empty.includes(POPULATION_TEST_TREE), empty);
  });

  it('a broken population short-circuits the surface diffs', () => {
    // Every diff below the population guard reads a population that is not the
    // one claimed, so its answers would name the wrong cause.
    const problems = evaluateCaptureSurface(
      makeSurface({ population: [], chromeApisByFile: [], docDomEvents: ['click', 'change', 'wheel'] }), // prettier-ignore
    );
    assert.ok(!problems.some((p) => p.includes('registers no listener for it')));
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

  it('refuses a template event name rather than reading its text as the name', () => {
    // A template is not a string literal: reading its text would record an
    // event whose name the source never states, and an interpolated one would
    // record a name no listener is ever registered for.
    for (const source of [
      'document.addEventListener(`click`, h);',
      'document.addEventListener(`mouse${d}`, h);',
    ]) {
      const { domEvents, problems } = extractRegistrations(source, 'f.js');
      assert.deepEqual(domEvents, [], source);
      assert.equal(problems.length, 1, source);
      assert.match(problems[0], /not a string literal standing alone as the first argument/);
    }
  });

  it('reads a registration written inside a template interpolation', () => {
    // The interpolation's contents are code, so a registration written there is
    // a registration — before templates were modelled it was string text and
    // the scan saw nothing at all.
    const { domEvents, problems } = extractRegistrations(
      "const t = `x${document.addEventListener('click', h)}y`;",
      'f.js',
    );
    assert.deepEqual(domEvents, ['click']);
    assert.deepEqual(problems, []);
  });

  it('reads both registration kinds beyond the pair, drawing the boundary by receiver', () => {
    // The beyond-pair leg is not a chrome-only leg: a `document` listener there
    // is read and returned — most of those files are capture-layer modules, and
    // a capture listener moved into one would otherwise be invisible — while a
    // listener bound to an element is outside this closure's subject and is
    // passed over rather than refused.
    const source = [
      "btn.addEventListener('click', h);",
      "document.addEventListener('paste', h);",
      "window.addEventListener('resize', h);",
      'chrome.storage.onChanged.addListener(h);',
    ].join('\n');
    const beyond = extractRegistrations(source, 'lib/frame-trust.js', REGISTRATION_LEGS.beyondPair);
    assert.deepEqual(beyond.domEvents, ['paste']);
    assert.deepEqual(beyond.windowEvents, ['resize']);
    assert.deepEqual(beyond.chromeApis, ['chrome.storage.onChanged']);
    assert.deepEqual(beyond.problems, []);
    // The same source read for the capture pair reds on the element receiver,
    // which is the discipline the pair alone is held to.
    const capture = extractRegistrations(source, 'panel.js', REGISTRATION_LEGS.capture);
    assert.deepEqual(capture.domEvents, ['paste']);
    assert.deepEqual(capture.windowEvents, ['resize']);
    assert.equal(capture.problems.length, 1);
    assert.match(capture.problems[0], /receiver the scan does not model \(btn\)/);
  });

  it('passes over a non-chrome listener chain beyond the pair, and refuses it in the pair', () => {
    // A `chrome.runtime.connect` port is the live shape: `port.onMessage` is a
    // listener registration on nothing this closure holds, so beyond the pair
    // there is nothing to say about it — a red would have no route to green.
    const port = [
      'const port = chrome.runtime.connect({ name: "capture" });',
      'port.onMessage.addListener(h);',
    ].join('\n');
    const beyond = extractRegistrations(
      port,
      'lib/capture-timing.js',
      REGISTRATION_LEGS.beyondPair,
    );
    assert.deepEqual(beyond.chromeApis, []);
    assert.deepEqual(beyond.problems, []);
    const capture = extractRegistrations(port, RECORDER_PATH, REGISTRATION_LEGS.capture);
    assert.equal(capture.problems.length, 1);
    assert.match(capture.problems[0], /registers a listener the scan does not model \(port\.onMessage\.addListener\)/); // prettier-ignore
  });

  it('refuses an unreadable event name on a document listener beyond the pair too', () => {
    // The registration is in scope there — only its name is unread — so the
    // silence beyond the pair is about receivers and roots, never about a
    // listener the closure does hold.
    const { problems } = extractRegistrations(
      'document.addEventListener(`mouse${d}`, h);',
      'lib/navigation-logic.js',
      REGISTRATION_LEGS.beyondPair,
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /not a string literal standing alone as the first argument/);
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

  it('closes the range list on the blanked view, so a bracket inside a string cannot move it', () => {
    // The one anchor that was read with string contents intact: a `]` written
    // inside a literal in the registration loop closed the list where the
    // source does not, and every range past that point stopped existing —
    // surfacing as correlation classes no registered range covers, a cause the
    // source does not have. The entry carrying the literal is refused on its
    // own terms instead, and the ranges around it are read as written.
    const withLiteral = source.replace('    ] {', '        "[",\n    ] {');
    const { ranges, problems } = extractDesktopRegistrations(withLiteral);
    assert.deepEqual(ranges, [
      ['EVENT_SYSTEM_FOREGROUND', 'EVENT_SYSTEM_FOREGROUND'],
      ['EVENT_OBJECT_CREATE', 'EVENT_OBJECT_DESTROY'],
    ]);
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0], /cannot read as an \(event_min, event_max\) pair/);
    assert.ok(!problems.some((p) => /is not closed/.test(p)), problems.join('\n'));
  });

  it('reads the list contents on that same view — a literal states no range', () => {
    // The whole leg reads one view. A pair-shaped fragment inside a literal is
    // text about the registrations, never one of them, so it contributes no
    // range and is refused as the entry the scan cannot read.
    const withLiteral = source.replace(
      '    ] {',
      '        "(EVENT_OBJECT_FOCUS, EVENT_OBJECT_FOCUS)",\n    ] {',
    );
    const { ranges, problems } = extractDesktopRegistrations(withLiteral);
    assert.deepEqual(ranges, [
      ['EVENT_SYSTEM_FOREGROUND', 'EVENT_SYSTEM_FOREGROUND'],
      ['EVENT_OBJECT_CREATE', 'EVENT_OBJECT_DESTROY'],
    ]);
    assert.ok(
      !ranges.some(([min]) => min === 'EVENT_OBJECT_FOCUS'),
      'a literal contributes no registered range',
    );
    assert.ok(problems.length > 0, 'the unreadable entry is refused rather than skipped');
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
    const population = shippedPopulation();
    const keys = ADMITTED_REGISTRATIONS.map((e) => `${e.file} ${e.api}`);
    assert.equal(new Set(keys).size, keys.length);
    for (const entry of ADMITTED_REGISTRATIONS) {
      assert.ok(population.includes(entry.file), `${entry.api} names a scanned file`);
      assert.ok(Number.isInteger(entry.occurrences) && entry.occurrences > 0);
      assert.ok(entry.why.length > 40, `${entry.api} states why it is admitted`);
    }
  });

  it('states one entry per file and API, with its occurrence count carrying the rest', () => {
    // The key is the pin: several registrations of one API in one file are one
    // entry whose count states how many, and whose reason names each role — the
    // panel adapter's storage watches are the shape that proves it.
    const panelEntries = ADMITTED_REGISTRATIONS.filter((e) => e.file === PANEL_ADAPTER_PATH);
    assert.equal(panelEntries.length, 1);
    assert.equal(panelEntries[0].api, 'chrome.storage.onChanged');
    assert.ok(panelEntries[0].occurrences > 1);
  });
});

describe('auditTree — the shipped tree', () => {
  const readFile = (f) => readFileSync(resolve(ROOT, f), 'utf8');

  it('holds every capture surface in the working tree', () => {
    const { problems } = auditTree(readFile, shippedPopulation());
    assert.deepEqual(problems, []);
  });

  it('reads a non-vacuous surface from each scanned file', () => {
    const { domEventCount, proxyCount, winEventCount } = auditTree(readFile, shippedPopulation());
    assert.ok(domEventCount > 0);
    assert.ok(proxyCount > 0);
    assert.ok(winEventCount > 0);
  });

  it('an unreadable input fails loudly rather than passing vacuously', () => {
    const { problems } = auditTree(
      (f) => (f === WINDOWS_CAPTURE_PATH ? '' : readFile(f)),
      shippedPopulation(),
    );
    assert.ok(problems.length > 0);
    assert.ok(problems.some((p) => p.includes(WINDOWS_CAPTURE_PATH)));
  });

  it('derives a population with the properties the closure stands on', () => {
    // The properties, not a second copy of the derivation: what the package
    // tracks IS the population, so a production directory the extension grows
    // is scanned with nothing to update — and the two capture files, which
    // every leg reads by construction, are in it.
    const population = shippedPopulation();
    assert.ok(population.length > 0);
    for (const p of [RECORDER_PATH, WORKER_PATH, PANEL_ADAPTER_PATH]) {
      assert.ok(population.includes(p), `${p} is in the scanned population`);
    }
    for (const file of population) {
      assert.ok(file.startsWith(`${POPULATION_ROOT}/`), `${file} is inside the extension package`);
      assert.ok(
        POPULATION_EXTENSIONS.some((ext) => file.endsWith(ext)),
        `${file} carries a JavaScript module extension`,
      );
      assert.ok(!file.startsWith(`${POPULATION_TEST_TREE}/`), `${file} is outside the test tree`);
    }
    assert.equal(new Set(population).size, population.length, 'each file is stated once');
    // The exclusion bites: the tree it excludes is not empty.
    const excluded =
      execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', POPULATION_TEST_TREE], { encoding: 'utf8', cwd: ROOT }) // prettier-ignore
        .split('\n')
        .map((line) => line.trim())
        .filter((f) => POPULATION_EXTENSIONS.some((ext) => f.endsWith(ext)));
    assert.ok(excluded.length > 0, 'the extension test tree tracks JavaScript of its own');
    for (const file of excluded) assert.ok(!population.includes(file), `${file} stays excluded`);
  });

  it('states the module extensions as a set, so a module kind cannot escape by name', () => {
    // The escape this closes: a tracked production module written with an
    // explicit module extension was outside the closure entirely while the
    // filter named one extension.
    assert.deepEqual(POPULATION_EXTENSIONS, ['.js', '.mjs', '.cjs']);
    assert.equal(new Set(POPULATION_EXTENSIONS).size, POPULATION_EXTENSIONS.length);
    for (const ext of POPULATION_EXTENSIONS) assert.match(ext, /^\.[a-z]+$/);
  });

  it('the CLI scans that same derivation, never a second copy of it', () => {
    // The lock these real-tree cases stand on: they hold the shipped
    // derivation, so the CLI must consume it too — a private copy in the
    // wrapper could drift while every case here stayed green.
    const script = readFile('scripts/check-capture-surface.js');
    assert.match(script, /auditTree\(\s*readFile,\s*derivePopulation\(\),?\s*\)/);
    assert.equal(
      script.split("'ls-files'").length - 1,
      1,
      'the file enumerates the tracked tree in exactly one place',
    );
  });

  it('reds on a registration the population reaches only because it was widened', () => {
    // The escape the closure closes, over the real tree: a listener the panel
    // adapter would have registered unseen while the file list was the pair.
    const { problems } = auditTree(
      (f) =>
        f === PANEL_ADAPTER_PATH
          ? `${readFile(f)}\nchrome.tabs.onUpdated.addListener(() => {});\n`
          : readFile(f),
      shippedPopulation(),
    );
    assert.ok(
      problems.some((p) =>
        p.startsWith(`${PANEL_ADAPTER_PATH} registers \`chrome.tabs.onUpdated\``),
      ),
      problems.join('\n'),
    );
  });

  it('stays green on an element listener added to a population file', () => {
    // The boundary, observed on the real tree: a listener bound to an element
    // registers on nothing either enumeration describes, so it is passed over
    // wherever in the population it is written.
    const { problems } = auditTree(
      (f) =>
        f === PANEL_ADAPTER_PATH
          ? `${readFile(f)}\nconst el = document.body;\nel.addEventListener('click', () => {});\n`
          : readFile(f),
      shippedPopulation(),
    );
    assert.deepEqual(problems, []);
  });

  it('stays green on a message port opened in a population file', () => {
    // The other half of the boundary: `port.onMessage.addListener` is a
    // listener registration rooted outside `chrome`, and beyond the capture
    // pair there is no route that would make it green — so it is passed over
    // rather than redded.
    const port = [
      "const port = chrome.runtime.connect({ name: 'capture' });",
      'port.onMessage.addListener(() => {});',
    ].join('\n');
    const { problems } = auditTree(
      (f) => (f === PANEL_ADAPTER_PATH ? `${readFile(f)}\n${port}\n` : readFile(f)),
      shippedPopulation(),
    );
    assert.deepEqual(problems, []);
    // In the capture pair the same shape is refused, which is the discipline
    // those two files alone are held to.
    const inPair = auditTree(
      (f) => (f === WORKER_PATH ? `${readFile(f)}\n${port}\n` : readFile(f)),
      shippedPopulation(),
    );
    assert.ok(
      inPair.problems.some((p) => /registers a listener the scan does not model/.test(p)),
      inPair.problems.join('\n') || 'no unmodelled-chain refusal in the pair',
    );
  });

  it('reds a document listener added to a capture-layer module beyond the pair', () => {
    // The escape the leg model closes: those modules are capture-layer code,
    // and a capture listener moved into one was invisible while the leg read
    // `chrome.*` registrations alone.
    const module = 'packages/extension/lib/frame-trust.js';
    assert.ok(shippedPopulation().includes(module), `${module} is in the scanned population`);
    const { problems } = auditTree(
      (f) =>
        f === module ? `${readFile(f)}\ndocument.addEventListener('paste', () => {});\n` : readFile(f), // prettier-ignore
      shippedPopulation(),
    );
    assert.ok(
      problems.some((p) => p.startsWith(`${module} registers a DOM listener for \`paste\` on \`document\``)), // prettier-ignore
      problems.join('\n') || 'no beyond-pair DOM refusal',
    );
  });

  it('carries no document or window listener outside the recorder today', () => {
    // The day-one green the leg model rests on, stated rather than assumed:
    // every population file beyond the capture pair registers none.
    const population = shippedPopulation();
    for (const file of population) {
      if (file === RECORDER_PATH || file === WORKER_PATH) continue;
      const read = extractRegistrations(readFile(file), file, REGISTRATION_LEGS.beyondPair);
      assert.deepEqual(read.domEvents, [], `${file} registers a document listener`);
      assert.deepEqual(read.windowEvents, [], `${file} registers a window listener`);
    }
  });

  it('names each scanned surface path exactly once in its own constant', () => {
    const paths = [
      RECORDER_PATH,
      WORKER_PATH,
      PANEL_ADAPTER_PATH,
      EXTENSION_DOC_PATH,
      DESKTOP_DOC_PATH,
      WINDOWS_CAPTURE_PATH,
    ];
    assert.equal(new Set(paths).size, paths.length);
    for (const p of paths) assert.doesNotThrow(() => readFile(p));
  });
});
