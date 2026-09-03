/**
 * check-extension-surface.test.js — Unit tests for the extension-surface
 * admission test (scripts/check-extension-surface.js). Its surface contracts
 * are committed (permissions.md §EPM-1, runtime.md §ERT-4 and §ERT-5), so every
 * red-path
 * family must fail loud: these tests prove the pairwise set inequalities in
 * each direction on every leg, the sender side's readable shape and its
 * refusal, the unreadable-cell and unknown-shape refusals, the dispatcher
 * anchor guards over the scanned population (one switch, standing in the
 * service worker, with a default arm and no nesting), the population
 * machinery guards beside them (an empty file list, one that has lost the
 * worker), the asymmetry of the capture-path pair (forward from the table to
 * the worker's own guards, back to it from every guard the population makes),
 * the presence of the
 * clause's own sender statement in the clause's scope — the doctrine the send
 * leg holds, read for its words and for the single occurrence of them,
 * wherever in the clause a second copy would sit, with the fail-closed form
 * pinned — the disjointness
 * rule, duplicates, and empty parses — that the comment-safe tokenizer keeps
 * commented labels out of the scans — the introspection handle's own legs: the
 * anchored freeze its members are read from and every refusal around it, the
 * member diff in both directions, the reach test against the worker's own
 * module-scope bindings, and the mention count that keeps the handle out of
 * every production module but the one that assigns it — and, as real-tree locks
 * over the shipped
 * tree, that the contracts hold on it, that the derived population carries
 * the properties the dispatcher legs stand on and is the one the CLI scans,
 * that the shipped handle's members, reaches, and identifiers are the ones the
 * clause states, and that an unreadable worker fails loudly rather than passing
 * vacuously.
 * One case is a demonstration rather
 * than a guard: the reverse send direction's documented limit, exercised so
 * the misleading red it produces is observed behaviour, never an assertion in
 * prose alone.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tokenizeJs, trackedFilesUnder } from '../../../../scripts/check-test-inventory.js';
import {
  POPULATION_EXTENSIONS,
  POPULATION_TEST_TREE,
  derivePopulation as deriveProductionPopulation,
} from '../../../../scripts/check-capture-surface.js';
import {
  MANIFEST_PATH,
  PERMISSIONS_DOC_PATH,
  RUNTIME_DOC_PATH,
  WORKER_PATH,
  PANEL_DIR,
  BACKGROUND_ROOT,
  EMPTY_SURFACES,
  DUPLICATE_SURFACES,
  SENDER_STATEMENT_ANCHOR,
  HANDLE_CLAUSE_ID,
  HANDLE_NAME,
  HANDLE_REACH_SET,
  HANDLE_TABLE_HEADER,
  derivePopulation,
  countSenderStatements,
  collectModuleBindings,
  countHandleMentions,
  extractManifestSurface,
  extractSectionTableNames,
  extractProtocolTables,
  extractDispatcherSurface,
  extractHandleSurface,
  extractHandleTable,
  extractSendSites,
  evaluateExtensionSurface,
  auditTree,
} from '../../../../scripts/check-extension-surface.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
/** A panel path inside the scanned surface. */
const PANEL_PATH = `${PANEL_DIR}/panel.js`;
/** A second background module, inside the derived population beside the worker. */
const SECOND_BACKGROUND_PATH = `${BACKGROUND_ROOT}/router.js`;
/** A production module outside the background tree — the widened population's own. */
const LIB_PATH = 'packages/extension/lib/frame-trust.js';
/**
 * A handle literal as the worker writes one, `body` standing where its members
 * do — the anchored shape every handle case is a variation on.
 */
const handleSource = (body, head = `globalThis.${HANDLE_NAME} = Object.freeze({`) =>
  ['const activeFrames = new Map();', 'const programmaticTabs = new Set();', head, body, '});'].join('\n'); // prettier-ignore

/**
 * The tracked background JavaScript the shipped closure runs over — the
 * check's own derivation, not a copy of it, so the real-tree locks cannot stay
 * green over a population the check has stopped scanning.
 */
const shippedPopulation = () => derivePopulation(ROOT);

/**
 * The dispatcher extractor over ONE file, keyed as the service worker. The key
 * is what makes these fixtures the worker's own: the location leg holds the
 * dispatcher to {@link WORKER_PATH}, so a one-file fixture keyed anywhere else
 * would draw that refusal on every case below that supplies a dispatcher,
 * rather than only on the one that case is about.
 * @param {string} source the module source to read
 */
const workerOnly = (source) => extractDispatcherSurface(new Map([[WORKER_PATH, source]]));

/** A consistent synthetic surface every contract accepts. */
function makeSurface(overrides = {}) {
  return {
    manifestPermissions: ['storage', 'tabs'],
    manifestHostPermissions: ['<all_urls>'],
    docPermissions: ['storage', 'tabs'],
    docHostPermissions: ['<all_urls>'],
    permissionsUnreadable: [],
    docCaptureTypes: ['FRAME_READY'],
    docPanelTypes: ['PROJECTS_LIST', 'STEP_COMMIT'],
    protocolUnreadable: [],
    backgroundFiles: [WORKER_PATH],
    caseLabels: ['PROJECTS_LIST', 'STEP_COMMIT'],
    equalityTypes: ['FRAME_READY'],
    workerEqualityTypes: ['FRAME_READY'],
    sendTypes: ['PROJECTS_LIST', 'STEP_COMMIT'],
    sendSites: [
      { path: PANEL_PATH, ordinal: 1, type: 'PROJECTS_LIST', found: null },
      { path: PANEL_PATH, ordinal: 2, type: 'STEP_COMMIT', found: null },
    ],
    // The clause states its sender statement once. The key is stated here
    // because the guard is fail-closed: a fixture omitting it reds rather than
    // no-opping, which is what keeps a later scalar leg from being added to
    // this evaluator and silently passing on every hand-written surface.
    senderStatements: 1,
    handleMembers: ['frameRegistry', 'wipeFrameRegistry'],
    docHandleMembers: ['frameRegistry', 'wipeFrameRegistry'],
    handleUnreadable: [],
    // The same fail-closed reason as the sender count: a scalar the fixture
    // omits reds rather than no-opping.
    handleTableMatches: 1,
    handleReaches: [
      { member: 'frameRegistry', name: 'activeFrames' },
      { member: 'wipeFrameRegistry', name: 'activeFrames' },
    ],
    productionFiles: [WORKER_PATH, LIB_PATH],
    handleMentions: [{ path: WORKER_PATH, count: 1 }],
    ...overrides,
  };
}

describe('evaluateExtensionSurface — compliant baseline', () => {
  it('returns no problems when every contract holds', () => {
    assert.deepEqual(evaluateExtensionSurface(makeSurface()), []);
  });
});

describe('evaluateExtensionSurface — permission legs (both ways)', () => {
  it('fires when the manifest requests a permission the doc does not document', () => {
    const problems = evaluateExtensionSurface(
      makeSurface({ manifestPermissions: ['storage', 'tabs', 'alarms'] }),
    );
    assert.ok(problems.some((p) => p.includes('alarms') && p.includes('does not document it')));
  });

  it('fires when the doc documents a permission the manifest does not request', () => {
    const problems = evaluateExtensionSurface(
      makeSurface({ docPermissions: ['storage', 'tabs', 'scripting'] }),
    );
    assert.ok(problems.some((p) => p.includes('scripting') && p.includes('does not request it')));
  });

  it('fires on a host-permission mismatch in either direction', () => {
    const extra = evaluateExtensionSurface(
      makeSurface({ manifestHostPermissions: ['<all_urls>', 'https://x.test/*'] }),
    );
    assert.ok(
      extra.some((p) => p.includes('https://x.test/*') && p.includes('Host permissions table does not document it')), // prettier-ignore
    );
    const missing = evaluateExtensionSurface(
      makeSurface({ docHostPermissions: ['<all_urls>', 'https://y.test/*'] }),
    );
    assert.ok(
      missing.some((p) => p.includes('https://y.test/*') && p.includes('does not request it')),
    );
  });

  it('fires on an unreadable permission-table cell', () => {
    const problems = evaluateExtensionSurface(
      makeSurface({ permissionsUnreadable: ['storage (optional)'] }),
    );
    assert.ok(problems.some((p) => p.includes('storage (optional)') && p.includes('cannot read')));
  });
});

describe('evaluateExtensionSurface — message legs (both ways)', () => {
  it('fires when the panel enumeration states a type the switch does not service', () => {
    const problems = evaluateExtensionSurface(
      makeSurface({ docPanelTypes: ['PROJECTS_LIST', 'STEP_COMMIT', 'STEP_UNDO'] }),
    );
    assert.ok(problems.some((p) => p.includes('STEP_UNDO') && p.includes('no case servicing it')));
  });

  it('fires when the switch services a type the enumeration does not state', () => {
    const problems = evaluateExtensionSurface(
      makeSurface({ caseLabels: ['PROJECTS_LIST', 'STEP_COMMIT', 'GHOST_TYPE'] }),
    );
    assert.ok(
      problems.some((p) => p.includes('GHOST_TYPE') && p.includes('enumeration does not state it')),
    );
  });

  it('fires when the capture-path table states a type no equality guard services', () => {
    const problems = evaluateExtensionSurface(
      makeSurface({ docCaptureTypes: ['FRAME_READY', 'GET_TAB_ID'] }),
    );
    assert.ok(
      problems.some((p) => p.includes('GET_TAB_ID') && p.includes('no equality guard in the worker module services it')), // prettier-ignore
    );
  });

  it('fires when an equality guard services a type the table does not state', () => {
    const problems = evaluateExtensionSurface(
      makeSurface({ equalityTypes: ['FRAME_READY', 'SIDE_CHANNEL'] }),
    );
    assert.ok(
      problems.some((p) => p.includes('SIDE_CHANNEL') && p.includes('capture-path table does not state it')), // prettier-ignore
    );
  });

  it('fires when a type appears in both doc enumerations', () => {
    const problems = evaluateExtensionSurface(
      makeSurface({
        docCaptureTypes: ['FRAME_READY', 'STEP_COMMIT'],
        equalityTypes: ['FRAME_READY', 'STEP_COMMIT'],
        workerEqualityTypes: ['FRAME_READY', 'STEP_COMMIT'],
      }),
    );
    assert.ok(problems.some((p) => p.includes('STEP_COMMIT') && p.includes('disjoint')));
  });

  it('fires on an unreadable protocol cell', () => {
    const problems = evaluateExtensionSurface(
      makeSurface({ protocolUnreadable: ['PROJECTS_LIST and friends'] }),
    );
    assert.ok(
      problems.some((p) => p.includes('PROJECTS_LIST and friends') && p.includes('cannot read')),
    );
  });
});

describe('evaluateExtensionSurface — the sender side (both ways)', () => {
  it('fires when the panel sends a type outside the enumeration', () => {
    const problems = evaluateExtensionSurface(
      makeSurface({
        sendTypes: ['PROJECTS_LIST', 'STEP_COMMIT', 'STEP_UNDO'],
        sendSites: [
          ...makeSurface().sendSites,
          { path: PANEL_PATH, ordinal: 3, type: 'STEP_UNDO', found: null },
        ],
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('STEP_UNDO') && p.includes('is sent by the panel')),
      problems.join('\n') || 'no forward sender diagnostic',
    );
  });

  it('refuses an object-literal send that states no readable type, naming what it found', () => {
    const found = 'a `type` key set from `messageType`';
    const problems = evaluateExtensionSurface(
      makeSurface({
        sendSites: [...makeSurface().sendSites, { path: PANEL_PATH, ordinal: 3, type: null, found }], // prettier-ignore
      }),
    );
    const refusal = problems.find((p) => p.includes(`${PANEL_PATH} (object-literal send( call site 3)`)); // prettier-ignore
    assert.ok(refusal, problems.join('\n') || 'no send refusal');
    // The line names the actual offender rather than rendering the key it
    // wants as the thing that went wrong.
    assert.ok(refusal.includes(`the scan found ${found}`), refusal);
    assert.ok(refusal.includes('object-literal send( call site 3'), refusal);
  });

  it('fires when an enumerated type has no literal send site — and demonstrates the documented limit', () => {
    // The reverse direction holds over the literal-send subset only. The
    // fixture below DOES send STEP_COMMIT, through a payload assembled
    // beforehand — the shape the scan does not read — so the red that follows
    // is the misleading one the residue names, observed rather than asserted.
    const source = [
      "await send({ type: 'PROJECTS_LIST' });",
      "const payload = { type: 'STEP_COMMIT', step_type: stepType };",
      'const response = await send(payload);',
    ].join('\n');
    const sites = extractSendSites(new Map([[PANEL_PATH, source]]));
    assert.deepEqual(
      sites.map((s) => s.type),
      ['PROJECTS_LIST'],
      'the assembled-payload send is outside the shape the scan reads',
    );
    const problems = evaluateExtensionSurface(
      makeSurface({ sendTypes: sites.map((s) => s.type), sendSites: sites }),
    );
    assert.ok(
      problems.some((p) => p.includes('STEP_COMMIT') && p.includes('no object-literal send(')),
      problems.join('\n') || 'no reverse sender diagnostic',
    );
    assert.ok(
      problems.some((p) => p.includes('assembled beforehand is invisible to this leg and reds here too')), // prettier-ignore
      'the red states the limit that makes it misleading',
    );
    // …and names the remedy, the way the command side's contract-change line
    // does: the doctrine and the check move together.
    assert.ok(
      problems.some((p) => p.includes("updates the runtime doc's sender statement and this check together")), // prettier-ignore
      'the red names the change that closes it',
    );
  });
});

describe('evaluateExtensionSurface — the clause states the doctrine the send leg holds', () => {
  it('fires when the clause states no sender statement — the leg cannot hold an unstated rule', () => {
    assert.deepEqual(evaluateExtensionSurface(makeSurface({ senderStatements: 0 })), [
      `${RUNTIME_DOC_PATH} §ERT-4 states no sender statement — nothing in the clause's scope carries "${SENDER_STATEMENT_ANCHOR}" — the panel-side closure this check's send leg holds (every panel-protocol type carrying at least one object-literal send( that names it) is doctrine the clause states, and the leg cannot hold a rule the document no longer makes`,
    ]);
  });

  it('fires when the claim is made a second time — an update would land on one copy', () => {
    assert.deepEqual(evaluateExtensionSurface(makeSurface({ senderStatements: 2 })), [
      `${RUNTIME_DOC_PATH} §ERT-4 makes the "${SENDER_STATEMENT_ANCHOR}" claim 2 times — the clause states it once, so an update cannot land on one copy and leave another standing, wherever in the clause that copy was written`,
    ]);
  });

  it('is fail-closed: a surface stating no count reds rather than passing silently', () => {
    // The `!(n >= 1)` form, pinned. Written as `=== 0` this guard no-ops on
    // every surface that omits the key, which is how a scalar leg gets added
    // to this evaluator and proves nothing.
    const surface = makeSurface();
    delete surface.senderStatements;
    assert.ok(
      evaluateExtensionSurface(surface).some((p) => p.includes('states no sender statement')),
      'a surface without the key must red',
    );
  });

  it('is read ahead of the vacuous return — a doc edit that broke both says both', () => {
    const problems = evaluateExtensionSurface(
      makeSurface({ senderStatements: 0, docPanelTypes: [] }),
    );
    assert.ok(problems.some((p) => p.includes('states no sender statement')));
    assert.ok(problems.some((p) => p.includes(`no panel-protocol types found in ${RUNTIME_DOC_PATH}`))); // prettier-ignore
  });
});

describe('countSenderStatements — the clause scope the sender statement must sit in', () => {
  /** The clause, with `body` standing where its sender paragraph does. */
  const doc = (body) =>
    [
      '## Message protocol',
      '',
      '**ERT-4.** The dispatcher’s serviced surface is exactly the two enumerations.',
      '',
      body,
      '',
      '### Capture path',
      '',
      `A later section, outside the clause: ${SENDER_STATEMENT_ANCHOR} whose type it names.`,
    ].join('\n');
  /**
   * Where the live clause's line break falls inside the anchor — before
   * `an object literal`. Derived from the anchor rather than spelled, so the
   * fixture keeps wrapping mid-phrase if the anchor is ever reworded.
   */
  const WRAP_AT = SENDER_STATEMENT_ANCHOR.indexOf(' an object literal');
  /**
   * The clause's sender paragraph, wrapped where the live document wraps it:
   * the anchor is split ACROSS a line boundary, so no line of this fixture
   * carries it whole and a read over the raw text finds nothing.
   */
  const paragraph = [
    'The panel states its half of that surface literally: each type of the',
    `closed set ${SENDER_STATEMENT_ANCHOR.slice(0, WRAP_AT)}`,
    `${SENDER_STATEMENT_ANCHOR.slice(WRAP_AT + 1)} whose top-level \`type\` property`,
    'carries the type name as a string literal.',
  ].join('\n');

  it('counts the hand-wrapped statement — the anchor is found whatever line it wraps on', () => {
    // The guard is the point: the fixture's raw text carries the anchor
    // NOWHERE, because the line break falls inside it. A read that did not
    // flatten the scope first would count zero here.
    assert.ok(
      !paragraph.includes(SENDER_STATEMENT_ANCHOR),
      'the fixture must split the anchor across a line boundary',
    );
    assert.equal(countSenderStatements(doc(paragraph)), 1);
  });

  it('counts a duplicated paragraph twice — the drift a presence-only read cannot see', () => {
    assert.equal(countSenderStatements(doc(`${paragraph}\n\n${paragraph}`)), 2);
  });

  it('counts a copy pasted into the same paragraph — occurrences, not paragraphs', () => {
    // Where the second copy sits decides nothing: it is a second copy an
    // update can land beside either way, so a paragraph-granular read would
    // green on exactly the drift the one-statement rule exists to catch.
    assert.equal(countSenderStatements(doc(`${paragraph} ${paragraph}`)), 2);
  });

  it('does not count a paragraph moved out of the clause scope', () => {
    // The trailing sentence past `### Capture path` carries the anchor, so
    // this proves the scope bound, not the anchor's absence from the file.
    assert.ok(doc('The panel sends what it sends.').includes(SENDER_STATEMENT_ANCHOR));
    assert.equal(countSenderStatements(doc('The panel sends what it sends.')), 0);
  });

  it('does not count a fenced illustration — a code sample is not the doctrine', () => {
    assert.equal(countSenderStatements(doc(['```text', paragraph, '```'].join('\n'))), 0);
  });

  it('does not count the paragraph when the clause marker is renumbered away', () => {
    assert.equal(countSenderStatements(doc(paragraph).replace('**ERT-4.**', '**ERT-9.**')), 0);
  });

  it('the shipped runtime doc states it exactly once', () => {
    assert.equal(
      countSenderStatements(readFileSync(resolve(ROOT, RUNTIME_DOC_PATH), 'utf8')),
      1,
      'the clause must carry the sender statement the send leg holds',
    );
  });
});

// Fixture rows for the duplicates family, keyed to the check's own exported
// DUPLICATE_SURFACES list. The lock below holds the two key sets equal, so a
// surface added to the check's loop without a fixture row reds here — the
// addition direction the per-leg tests alone cannot see.
const DUPLICATE_FIXTURES = {
  manifestPermissions: ['storage', 'tabs', 'storage'],
  manifestHostPermissions: ['<all_urls>', '<all_urls>'],
  docPermissions: ['storage', 'tabs', 'storage'],
  docHostPermissions: ['<all_urls>', '<all_urls>'],
  docCaptureTypes: ['FRAME_READY', 'FRAME_READY'],
  docPanelTypes: ['PROJECTS_LIST', 'STEP_COMMIT', 'STEP_COMMIT'],
  caseLabels: ['PROJECTS_LIST', 'STEP_COMMIT', 'PROJECTS_LIST'],
  handleMembers: ['frameRegistry', 'wipeFrameRegistry', 'frameRegistry'],
  docHandleMembers: ['frameRegistry', 'wipeFrameRegistry', 'wipeFrameRegistry'],
};

describe('evaluateExtensionSurface — duplicates, every leg of the duplicates loop', () => {
  it('the fixture table covers exactly the check’s duplicates legs (addition lock)', () => {
    assert.deepEqual(
      Object.keys(DUPLICATE_FIXTURES).sort(),
      DUPLICATE_SURFACES.map(([key]) => key).sort(),
    );
  });

  it('the surface labels are pairwise distinct — a copied leg cannot hide behind its neighbour', () => {
    assert.ok(DUPLICATE_SURFACES.length > 0);
    const labels = DUPLICATE_SURFACES.map(([, what]) => what);
    assert.equal(new Set(labels).size, labels.length);
  });

  for (const [key, what] of DUPLICATE_SURFACES) {
    it(`fires on a duplicated name in ${what} — a leg the set diffs cannot see`, () => {
      const problems = evaluateExtensionSurface(makeSurface({ [key]: DUPLICATE_FIXTURES[key] }));
      assert.ok(
        problems.some((p) => p.includes('more than once') && p.includes(what)),
        problems.join('\n') || `no duplicates diagnostic for ${what}`,
      );
    });
  }
});

describe('evaluateExtensionSurface — empty parses are structural failures', () => {
  it('the export is non-empty and its diagnoses pairwise distinct', () => {
    assert.ok(EMPTY_SURFACES.length > 0);
    const messages = EMPTY_SURFACES.map(([, message]) => message);
    assert.equal(new Set(messages).size, messages.length);
  });

  for (const [key, message] of EMPTY_SURFACES) {
    it(`fires when ${key} parses empty`, () => {
      const problems = evaluateExtensionSurface(makeSurface({ [key]: [] }));
      assert.ok(
        problems.some((p) => p.includes(message)),
        problems.join('\n') || `no vacuous diagnostic for ${key}`,
      );
    });
  }
});

describe('extractManifestSurface', () => {
  it('reads both arrays and refuses non-string entries', () => {
    const read = extractManifestSurface(
      JSON.stringify({ permissions: ['storage', 42], host_permissions: ['<all_urls>'] }),
    );
    assert.deepEqual(read.permissions, ['storage']);
    assert.deepEqual(read.hostPermissions, ['<all_urls>']);
    assert.ok(read.problems.some((p) => p.includes('42') && p.includes('cannot read')));
  });

  it('refuses an unparseable manifest', () => {
    const read = extractManifestSurface('not json');
    assert.ok(read.problems.some((p) => p.includes('does not parse as JSON')));
  });

  it('refuses a permission field that is not an array without throwing — null included', () => {
    for (const shape of ['42', '{"a":1}', 'true', '"storage"', 'null']) {
      const read = extractManifestSurface(
        `{"permissions": ${shape}, "host_permissions": ["<all_urls>"]}`,
      );
      assert.deepEqual(read.permissions, []);
      assert.deepEqual(read.hostPermissions, ['<all_urls>']);
      assert.ok(
        read.problems.some((p) => p.includes('a permissions that is not an array')),
        `expected the non-array diagnosis for ${shape}, got: ${read.problems.join('\n')}`,
      );
    }
    const hostRead = extractManifestSurface(
      '{"permissions": ["storage"], "host_permissions": null}',
    );
    assert.deepEqual(hostRead.permissions, ['storage']);
    assert.deepEqual(hostRead.hostPermissions, []);
    assert.ok(
      hostRead.problems.some((p) => p.includes('a host_permissions that is not an array')),
      hostRead.problems.join('\n') || 'no non-array diagnostic for host_permissions',
    );
  });

  it('routes an absent permission key to the empty-parse guard, not the non-array refusal', () => {
    const read = extractManifestSurface('{"host_permissions": ["<all_urls>"]}');
    assert.deepEqual(read.permissions, []);
    assert.deepEqual(read.hostPermissions, ['<all_urls>']);
    assert.deepEqual(read.problems, []);
    const problems = evaluateExtensionSurface(makeSurface({ manifestPermissions: read.permissions })); // prettier-ignore
    assert.ok(problems.some((p) => p.includes('no permissions found')));
  });

  it('refuses a manifest that parses to a non-object without throwing', () => {
    for (const scalar of ['42', '"hello"', 'true', 'null', '["storage"]']) {
      const read = extractManifestSurface(scalar);
      assert.deepEqual(read.permissions, []);
      assert.ok(
        read.problems.some((p) => p.includes('not as an object')),
        `expected the non-object diagnosis for ${scalar}, got: ${read.problems.join('\n')}`,
      );
    }
  });

  it('refuses optional-permission keys the tables do not model — any present shape other than the empty array', () => {
    const read = extractManifestSurface(
      JSON.stringify({
        permissions: ['storage'],
        host_permissions: ['<all_urls>'],
        optional_permissions: ['downloads'],
        optional_host_permissions: 'not-even-an-array',
      }),
    );
    assert.ok(read.problems.some((p) => p.includes('optional_permissions')));
    assert.ok(read.problems.some((p) => p.includes('optional_host_permissions')));
    const emptyOk = extractManifestSurface(
      JSON.stringify({
        permissions: ['storage'],
        host_permissions: ['<all_urls>'],
        optional_permissions: [],
      }),
    );
    assert.deepEqual(emptyOk.problems, []);
  });
});

describe('extractSectionTableNames / extractProtocolTables', () => {
  const doc = [
    '# Doc',
    '',
    '## Permissions',
    '',
    '| Permission | Why |',
    '| ---------- | --- |',
    '| `storage`  | a   |',
    '| un-backticked | b |',
    '',
    '## Host permissions',
    '',
    '| Host permission | Why |',
    '| --------------- | --- |',
    '| `<all_urls>`    | c   |',
    '',
    '```markdown',
    '| `fenced` | d |',
    '```',
  ].join('\n');

  it('reads names per section and whole header, fence-aware, refusing unreadable cells', () => {
    const perms = extractSectionTableNames(doc, 'Permissions', ['Permission', 'Why']);
    assert.deepEqual(perms.names, ['storage']);
    assert.deepEqual(perms.unreadable, ['un-backticked']);
    const hosts = extractSectionTableNames(doc, 'Host permissions', ['Host permission', 'Why']);
    assert.deepEqual(hosts.names, ['<all_urls>']);
    assert.deepEqual(hosts.unreadable, []);
  });

  it('a sibling table under the same heading with a different header is never conscripted', () => {
    // The sibling leads with the SAME first cell, which is what makes this the
    // whole-header selector's own property rather than the first cell's.
    const withSibling = doc.replace(
      '## Host permissions',
      ['| Permission | Note |', '| ---------- | ---- |', '| `downloads` | e   |', '', '## Host permissions'].join('\n'), // prettier-ignore
    );
    const perms = extractSectionTableNames(withSibling, 'Permissions', ['Permission', 'Why']);
    assert.deepEqual(perms.names, ['storage']);
    assert.deepEqual(perms.unreadable, ['un-backticked']);
  });

  const runtime = [
    '## Message protocol',
    '',
    '### Capture path',
    '',
    '| Type          | Payload | Response |',
    '| ------------- | ------- | -------- |',
    '| `FRAME_READY` | a       | b        |',
    '',
    '### Panel protocol',
    '',
    '| Group    | Types                              |',
    '| -------- | ---------------------------------- |',
    '| Projects | `PROJECTS_LIST`, `PROJECT_CREATE`  |',
    '| Steps    | `STEP_COMMIT`, STEP_RAW            |',
  ].join('\n');

  it('splits the panel Types cells on commas and refuses non-backticked pieces', () => {
    const read = extractProtocolTables(runtime);
    assert.deepEqual(read.captureTypes, ['FRAME_READY']);
    assert.deepEqual(read.panelTypes, ['PROJECTS_LIST', 'PROJECT_CREATE', 'STEP_COMMIT']);
    assert.deepEqual(read.unreadable, ['STEP_RAW']);
  });

  it('refuses an unreadable capture-path first cell', () => {
    const bad = runtime.replace(
      '| `FRAME_READY` | a       | b        |',
      '| FRAME_READY | a | b |',
    );
    const read = extractProtocolTables(bad);
    assert.deepEqual(read.captureTypes, []);
    assert.ok(read.unreadable.includes('FRAME_READY'));
  });

  it('unreadable-cell context survives the vacuous early return', () => {
    const problems = evaluateExtensionSurface(
      makeSurface({ docCaptureTypes: [], protocolUnreadable: ['FRAME_READY'] }),
    );
    assert.ok(problems.some((p) => p.includes('FRAME_READY') && p.includes('cannot read')));
    assert.ok(problems.some((p) => p.includes('no capture-path types')));
  });
});

describe('extractDispatcherSurface — comment-safe tokenizer reads', () => {
  const worker = [
    "// case 'COMMENTED_OUT': never counted",
    "/* message.type === 'ALSO_COMMENTED' */",
    "if (message.type === 'FRAME_READY') { return; }",
    'async function handle(msg) {',
    '  switch (msg.type) {',
    "    case 'PROJECTS_LIST': {",
    '      return list();',
    '    }',
    "    case 'STEP_COMMIT': {",
    '      return commit();',
    '    }',
    '    default:',
    '      return { ok: false };',
    '  }',
    '}',
  ].join('\n');

  it('reads case labels and equality literals, skipping comments', () => {
    const read = workerOnly(worker);
    assert.deepEqual(read.caseLabels, ['PROJECTS_LIST', 'STEP_COMMIT']);
    assert.deepEqual(read.equalityTypes, ['FRAME_READY']);
    assert.deepEqual(read.problems, []);
  });

  it('collects a case that sits after the default arm — order cannot hide a label', () => {
    const reordered = worker
      .replace("    case 'STEP_COMMIT': {\n      return commit();\n    }\n", '')
      .replace(
        '    default:\n      return { ok: false };',
        "    default:\n      return { ok: false };\n    case 'STEP_COMMIT': {\n      return commit();\n    }",
      );
    const read = workerOnly(reordered);
    assert.deepEqual(read.caseLabels.sort(), ['PROJECTS_LIST', 'STEP_COMMIT']);
    assert.deepEqual(read.problems, []);
  });

  it('a sibling switch after the dispatcher is not misread as nesting', () => {
    const sibling = `${worker}\nswitch (mode) { default: break; }`;
    const read = workerOnly(sibling);
    assert.deepEqual(read.caseLabels, ['PROJECTS_LIST', 'STEP_COMMIT']);
    assert.deepEqual(read.problems, []);
  });

  it('reports a nested switch instead of misreading its cases', () => {
    const nested = worker.replace("case 'STEP_COMMIT': {", "case 'STEP_COMMIT': { switch (x) {");
    const read = workerOnly(nested);
    assert.ok(read.problems.some((p) => p.includes('nests a switch')));
  });

  it('reports a missing dispatcher as an extractor problem — reachable on the real path', () => {
    const read = workerOnly('const x = 1;');
    assert.ok(
      read.problems.some((p) => p.includes('no dispatcher switch over the message type')),
      read.problems.join('\n') || 'no missing-dispatcher diagnostic',
    );
    // The refusal is about the population that WAS read, so it names the
    // derived scope rather than any one file in it.
    assert.ok(read.problems.some((p) => p.includes(BACKGROUND_ROOT)));
    assert.deepEqual(read.caseLabels, []);
  });

  it('reports a second dispatcher switch as an extractor problem — reachable on the real path', () => {
    const two = `${worker}\nfunction other(message) { switch (message.type) { default: break; } }`;
    const read = workerOnly(two);
    assert.ok(
      read.problems.some((p) => p.includes('2 dispatcher switches over the message type')),
      read.problems.join('\n') || 'no second-dispatcher diagnostic',
    );
  });

  it('reports a missing default arm as an extractor problem, naming the file', () => {
    const noDefault = worker.replace('    default:\n      return { ok: false };\n', '');
    const read = workerOnly(noDefault);
    assert.ok(read.problems.some((p) => p.includes('no default: arm') && p.includes(WORKER_PATH)));
  });

  it('collects equality guards from anywhere in the population and deduplicates a repeated guard', () => {
    const spread = `${worker}\nif (message.type === 'LATE_GUARD') { return; }\nif (message.type === 'FRAME_READY' && busy) { return; }`;
    const read = workerOnly(spread);
    assert.deepEqual(read.equalityTypes.sort(), ['FRAME_READY', 'LATE_GUARD']);
    assert.deepEqual(read.workerEqualityTypes.sort(), ['FRAME_READY', 'LATE_GUARD']);
    assert.deepEqual(read.problems, []);
  });

  it('reports an unreadable dispatcher head as an extractor problem', () => {
    const read = workerOnly('switch (msg.type) nope;');
    assert.ok(read.problems.some((p) => p.includes('no readable body')));
  });

  it('refuses an equality guard whose literal leads an expression', () => {
    // Before the operand's own end was required, this credited the guard with
    // `CAPTURE_START` while the code tested `CAPTURE_STARTsuffix`: the doc and
    // the guard then agreed in both directions on a type nothing guards.
    const guarded = `${worker}\nif (message.type === 'CAPTURE_START' + suffix) { return start(); }`;
    const read = workerOnly(guarded);
    assert.ok(!read.equalityTypes.includes('CAPTURE_START'));
    assert.equal(read.problems.length, 1);
    assert.match(read.problems[0], /guards a message type with `CAPTURE_START` followed by `\+`/);
    assert.match(read.problems[0], /quoted string literal standing alone as the operand/);
  });

  it('accepts every punctuation that ends the operand, and refuses the rest', () => {
    for (const tail of [
      "'X') { return; }",
      "'X';",
      "'X' && busy) { return; }",
      "'X' || busy) { return; }",
      "'X' ? a : b;",
      "['X' === message.type];",
      "f(message.type === 'X', 1);",
    ]) {
      // prettier-ignore
      const read = workerOnly(`${worker}\nconst r = message.type === ${tail}`);
      assert.deepEqual(read.problems, [], tail);
    }
    for (const tail of ["'X' + suffix;", "'X'.length;"]) {
      const read = workerOnly(`${worker}\nconst r = message.type === ${tail}`);
      assert.equal(read.problems.length, 1, tail);
      assert.match(read.problems[0], /guards a message type with `X` followed by/);
    }
  });

  it('refuses an equality guard written with a template literal', () => {
    const templated = `${worker}\nif (message.type === \`PONG_\${k}\`) { return; }`;
    const read = workerOnly(templated);
    assert.deepEqual(read.equalityTypes, ['FRAME_READY']);
    assert.equal(read.problems.length, 1);
    assert.match(read.problems[0], /guards a message type with a template literal \(`PONG_`\)/);
  });

  it('refuses an equality guard written with a regular-expression literal', () => {
    // A pattern reaches the operand position wherever an expression may start,
    // and the kind travelling with the read is what names it as the literal the
    // source wrote rather than letting it fall through unremarked.
    const patterned = `${worker}\nif (message.type === /PONG_/) { return; }`;
    const read = workerOnly(patterned);
    assert.deepEqual(read.equalityTypes, ['FRAME_READY']);
    assert.equal(read.problems.length, 1);
    assert.match(read.problems[0], /guards a message type with a regular-expression literal \(`\/PONG_\/`\)/); // prettier-ignore
  });

  it('refuses a case label whose literal leads an expression', () => {
    // Before the label's own colon was required, this label vanished with no
    // problem at all — the enumeration then redded as a type nothing services,
    // naming a cause the source does not have.
    const shaped = worker.replace("case 'STEP_COMMIT': {", "case 'STEP_COMMIT' + k: {");
    const read = workerOnly(shaped);
    assert.deepEqual(read.caseLabels, ['PROJECTS_LIST']);
    assert.equal(read.problems.length, 1);
    assert.match(read.problems[0], /labels an arm `STEP_COMMIT` followed by `\+`/);
    assert.match(read.problems[0], /quoted string literal the label's own colon follows/);
  });

  it('refuses a case label written with a template literal', () => {
    const templated = worker.replace("case 'STEP_COMMIT':", 'case `STEP_COMMIT`:');
    const read = workerOnly(templated);
    assert.deepEqual(read.caseLabels, ['PROJECTS_LIST']);
    assert.equal(read.problems.length, 1);
    assert.match(read.problems[0], /labels an arm with a template literal \(`STEP_COMMIT`\)/);
  });

  it('refuses a case label written with a regular-expression literal', () => {
    // `case` is a position an expression can start at, so a pattern stands
    // there legally as far as the scanner is concerned; it is named as one
    // instead of leaving the arm silently unlabelled.
    const patterned = worker.replace("case 'STEP_COMMIT':", 'case /STEP_COMMIT/:');
    const read = workerOnly(patterned);
    assert.deepEqual(read.caseLabels, ['PROJECTS_LIST']);
    assert.equal(read.problems.length, 1);
    assert.match(read.problems[0], /labels an arm with a regular-expression literal \(`\/STEP_COMMIT\/`\)/); // prettier-ignore
  });

  it('leaves a case label the scan never modelled outside the closure', () => {
    // A constant label is not a shape this scan reads, and never was: the
    // refusals above are about a literal the scan reads part of, not about
    // every label form.
    const constant = worker.replace("case 'STEP_COMMIT':", 'case STEP_COMMIT:');
    const read = workerOnly(constant);
    assert.deepEqual(read.caseLabels, ['PROJECTS_LIST']);
    assert.deepEqual(read.problems, []);
  });
  it('is silent on a reversed-operand type test — the limit the header names, pinned', () => {
    // The file header states this limit ("a negated or reversed-operand type
    // test … is invisible to the scan"); this is the case that holds it, so
    // the disclosure cannot drift from the behaviour without one of them
    // reddening. A receiver-first guard beside it is read as usual.
    const yoda = [
      "if ('CAPTURE_START' === message.type) { return start(); }",
      "if (message.type === 'CAPTURE_STOP') { return stop(); }",
      'function handle(msg) {',
      '  switch (msg.type) {',
      "    case 'PING': return pong();",
      '    default: return null;',
      '  }',
      '}',
    ].join('\n');
    const read = workerOnly(yoda);
    assert.deepEqual(read.equalityTypes, ['CAPTURE_STOP'], 'the reversed operand is unread');
    assert.deepEqual(read.caseLabels, ['PING']);
    assert.deepEqual(read.problems, [], 'and it is silent, not refused');
  });
});

describe('extractDispatcherSurface — the derived population, read as one set', () => {
  /** The worker as the shipped shape has it: one guard, one dispatcher. */
  const worker = [
    "if (message.type === 'FRAME_READY') { return ready(); }",
    'function handle(msg) {',
    '  switch (msg.type) {',
    "    case 'PROJECTS_LIST': return list();",
    '    default: return { ok: false };',
    '  }',
    '}',
  ].join('\n');
  /** The dispatcher alone, for the case that moves it out of the worker. */
  const dispatcherOnly = worker.slice(worker.indexOf('function handle'));
  /** The population as the CLI hands it over: the worker plus one more module. */
  const population = (second) =>
    new Map([
      [WORKER_PATH, worker],
      [SECOND_BACKGROUND_PATH, second],
    ]);

  it('reads a second module that states nothing without changing the surface', () => {
    const read = extractDispatcherSurface(population('export const VERSION = 3;\n'));
    assert.deepEqual(read.caseLabels, ['PROJECTS_LIST']);
    assert.deepEqual(read.equalityTypes, ['FRAME_READY']);
    assert.deepEqual(read.workerEqualityTypes, ['FRAME_READY']);
    assert.deepEqual(read.problems, []);
  });

  it('reds on a dispatcher a second module carries, naming every file with its count', () => {
    // The blind spot the population closes: read over the worker alone, a
    // dispatcher delegated to the module beside it was a switch nothing saw.
    const read = extractDispatcherSurface(
      population("function route(message) { switch (message.type) { case 'X': return x(); default: return null; } }"), // prettier-ignore
    );
    const refusal = read.problems.find((p) => p.includes('dispatcher switches over the message type')); // prettier-ignore
    assert.ok(refusal, read.problems.join('\n') || 'no second-dispatcher diagnostic');
    assert.ok(refusal.includes(`${WORKER_PATH} (1)`), refusal);
    assert.ok(refusal.includes(`${SECOND_BACKGROUND_PATH} (1)`), refusal);
    // Fail-closed: labels from an ambiguous pair never reach the diffs.
    assert.deepEqual(read.caseLabels, []);
  });

  it("collects a second module's guards into the population set, outside the worker subset", () => {
    const read = extractDispatcherSurface(
      population("if (message.type === 'SIDE_CHANNEL') { return side(); }"),
    );
    assert.deepEqual(read.equalityTypes.sort(), ['FRAME_READY', 'SIDE_CHANNEL']);
    assert.deepEqual(read.workerEqualityTypes, ['FRAME_READY']);
    assert.deepEqual(read.problems, []);
  });

  it('names the file a per-file guard refusal is about', () => {
    const read = extractDispatcherSurface(
      population("if (message.type === 'CAPTURE_START' + suffix) { return start(); }"),
    );
    assert.equal(read.problems.length, 1, read.problems.join('\n'));
    assert.ok(read.problems[0].startsWith(SECOND_BACKGROUND_PATH), read.problems[0]);
    assert.match(read.problems[0], /guards a message type with `CAPTURE_START` followed by `\+`/);
  });

  it('holds the one dispatcher to the service worker, letting its labels through', () => {
    // The mechanical hold the single-file read gave the Components row: a
    // dispatcher moved out of the worker redded then as a zero count, and goes
    // on redding now as a refusal naming where it went. The labels are well
    // defined — the singleton holds — so they pass through; withholding them
    // could only hide drift the diffs would otherwise name.
    const read = extractDispatcherSurface(
      new Map([
        [WORKER_PATH, "if (message.type === 'FRAME_READY') { return ready(); }"],
        [SECOND_BACKGROUND_PATH, dispatcherOnly],
      ]),
    );
    const refusal = read.problems.find((p) => p.includes('carries the dispatcher switch'));
    assert.ok(refusal, read.problems.join('\n') || 'no location diagnostic');
    assert.ok(refusal.includes(SECOND_BACKGROUND_PATH) && refusal.includes(WORKER_PATH), refusal);
    assert.deepEqual(read.caseLabels, ['PROJECTS_LIST']);
  });

  it('states nothing about a dispatcher when nothing was scanned', () => {
    // An empty map is a population that was never read — the evaluator's own
    // machinery diagnosis. A singleton refusal here would report a missing
    // dispatcher over a set nobody handed over.
    assert.deepEqual(extractDispatcherSurface(new Map()), {
      caseLabels: [],
      equalityTypes: [],
      workerEqualityTypes: [],
      problems: [],
    });
  });
});

describe('evaluateExtensionSurface — the population machinery guards', () => {
  it('diagnoses an empty population itself, in place of the empty-parse lines', () => {
    const problems = evaluateExtensionSurface(
      makeSurface({
        backgroundFiles: [],
        caseLabels: [],
        equalityTypes: [],
        workerEqualityTypes: [],
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('has no population to hold')),
      problems.join('\n') || 'no empty-population diagnostic',
    );
    // Both machinery lines stand: a file list naming nothing has also lost the
    // worker, and the two state distinct facts — no population to scan, and no
    // file for the forward diff to stand on. Pinning only the first would let
    // the required-member line be dropped from this path unnoticed.
    assert.ok(
      problems.some((p) => p.includes(WORKER_PATH) && p.includes('outside the scanned population')),
      problems.join('\n') || 'no required-member diagnostic beside the empty-population one',
    );
    // The lines that would otherwise blame the dispatcher for a file list that
    // stopped naming anything.
    for (const [, message] of EMPTY_SURFACES) {
      assert.ok(!problems.some((p) => p.includes(message)), message);
    }
  });

  it('keeps the unreadable-cell and sender-statement reads ahead of the machinery return', () => {
    const problems = evaluateExtensionSurface(
      makeSurface({ backgroundFiles: [], protocolUnreadable: ['FRAME_READY'], senderStatements: 0 }), // prettier-ignore
    );
    assert.ok(problems.some((p) => p.includes('FRAME_READY') && p.includes('cannot read')));
    assert.ok(problems.some((p) => p.includes('states no sender statement')));
    assert.ok(problems.some((p) => p.includes('has no population to hold')));
  });

  it('reds when the population has lost the service worker', () => {
    const problems = evaluateExtensionSurface(
      makeSurface({ backgroundFiles: [SECOND_BACKGROUND_PATH] }),
    );
    assert.ok(
      problems.some((p) => p.includes(WORKER_PATH) && p.includes('outside the scanned population')),
      problems.join('\n') || 'no required-member diagnostic',
    );
  });
});

describe('the capture-path pair is asymmetric — read through the extractor', () => {
  /** The worker guarding both documented capture-path types. */
  const bothGuarded = [
    "if (message.type === 'FRAME_READY') { return ready(); }",
    "if (message.type === 'GET_TAB_ID') { return tab(); }",
    'function handle(msg) {',
    '  switch (msg.type) {',
    "    case 'PROJECTS_LIST': return list();",
    "    case 'STEP_COMMIT': return commit();",
    '    default: return { ok: false };',
    '  }',
    '}',
  ].join('\n');
  const DOC_CAPTURE_TYPES = ['FRAME_READY', 'GET_TAB_ID'];
  const read = (workerSource, secondSource) =>
    extractDispatcherSurface(
      new Map([
        [WORKER_PATH, workerSource],
        [SECOND_BACKGROUND_PATH, secondSource],
      ]),
    );
  /**
   * The two equality sets wired from a real extractor read, everything else
   * left at the compliant baseline — so what these cases observe is the
   * capture-path pair and nothing beside it.
   */
  const evaluate = (dispatcher) =>
    evaluateExtensionSurface(
      makeSurface({
        docCaptureTypes: DOC_CAPTURE_TYPES,
        equalityTypes: dispatcher.equalityTypes,
        workerEqualityTypes: dispatcher.workerEqualityTypes,
        backgroundFiles: [WORKER_PATH, SECOND_BACKGROUND_PATH],
      }),
    );

  it("takes the worker's own guards in both directions", () => {
    const dispatcher = read(bothGuarded, 'export const VERSION = 3;\n');
    assert.deepEqual(dispatcher.problems, []);
    assert.deepEqual(evaluate(dispatcher), []);
  });

  it('reds FORWARD on a worker guard deleted while a stale copy sits in a second module', () => {
    // ERT-4 states the capture-path types are serviced by the listener's own
    // guards, and the listener is the worker's: a copy elsewhere is not that
    // guard. The shape is deliberately two-type — the worker keeps FRAME_READY
    // — so its subset stays non-empty and the diff actually runs.
    const dispatcher = read(
      bothGuarded.replace("if (message.type === 'GET_TAB_ID') { return tab(); }\n", ''),
      "if (message.type === 'GET_TAB_ID') { return tab(); }",
    );
    assert.deepEqual(dispatcher.workerEqualityTypes, ['FRAME_READY']);
    assert.deepEqual(dispatcher.equalityTypes.sort(), ['FRAME_READY', 'GET_TAB_ID']);
    assert.ok(
      evaluate(dispatcher).some((p) => p.includes('GET_TAB_ID') && p.includes('no equality guard in the worker module services it')), // prettier-ignore
      evaluate(dispatcher).join('\n') || 'no forward capture-path diagnostic',
    );
  });

  it('reds in REVERSE on an undocumented type guarded in a second module', () => {
    // The direction the population buys: a guard on a type the table does not
    // state is drift wherever in the scanned set it was written.
    const dispatcher = read(bothGuarded, "if (message.type === 'SIDE_CHANNEL') { return side(); }"); // prettier-ignore
    assert.deepEqual(dispatcher.workerEqualityTypes.sort(), DOC_CAPTURE_TYPES);
    const problems = evaluate(dispatcher);
    assert.ok(
      problems.some((p) => p.includes('SIDE_CHANNEL') && p.includes(BACKGROUND_ROOT)),
      problems.join('\n') || 'no reverse capture-path diagnostic',
    );
  });
});

describe('extractSendSites — the one shape the sender scan reads', () => {
  const panel = [
    "// send({ type: 'COMMENTED_OUT' }) is never counted",
    'function send(message) {',
    '  return adapter.send(message);',
    '}',
    "await send({ type: 'RECORDING_STOP' });",
    'await send({',
    "  type: 'RECORDING_RENAME',",
    '  recording_id: activeRecording.recording_id,',
    '});',
  ].join('\n');

  it('reads object-literal sends, skipping comments, declarations, and forwards', () => {
    const sites = extractSendSites(new Map([[PANEL_PATH, panel]]));
    assert.deepEqual(
      sites.map((s) => [s.ordinal, s.type]),
      [
        [1, 'RECORDING_STOP'],
        [2, 'RECORDING_RENAME'],
      ],
    );
  });

  it('the residue shapes contribute no sites at all', () => {
    const residue = [
      'function send(message) { return adapter.send(message); }',
      'const adapter = { send(message) { return port.post(message); } };',
      'const payload = { type: assembled };',
      'await send(payload);',
    ].join('\n');
    assert.deepEqual(extractSendSites(new Map([['a.js', residue]])), []);
  });

  it('reads the type wherever the property sits — order is not meaning', () => {
    const sites = extractSendSites(
      new Map([['a.js', "await send({ recording_id: id, type: 'RECORDING_OPEN' });"]]),
    );
    assert.deepEqual(sites, [{ path: 'a.js', ordinal: 1, type: 'RECORDING_OPEN', found: null }]);
  });

  it('reads a quoted type key the same as a bare one', () => {
    const sites = extractSendSites(new Map([['a.js', "await send({ 'type': 'RECORDING_OPEN' });"]])); // prettier-ignore
    assert.deepEqual(sites, [{ path: 'a.js', ordinal: 1, type: 'RECORDING_OPEN', found: null }]);
  });

  it('refuses a send whose top-level properties carry no type key, naming the keys it read', () => {
    // Discriminates the key comparison: the property below holds a string
    // literal in the value position, so only the key name separates it from a
    // readable send.
    const sites = extractSendSites(new Map([['a.js', "await send({ label: 'x' });"]]));
    assert.deepEqual(sites, [
      { path: 'a.js', ordinal: 1, type: null, found: 'no `type` key among the top-level properties (`label`)' }, // prettier-ignore
    ]);
    const problems = evaluateExtensionSurface(makeSurface({ sendSites: sites }));
    assert.ok(
      problems.some((p) => p.includes('object-literal send( call site 1') && p.includes('`label`')),
      problems.join('\n') || 'no missing-type refusal',
    );
  });

  it('refuses a type property whose value is not a string literal', () => {
    const sites = extractSendSites(new Map([['a.js', 'await send({ type: messageType });']]));
    assert.deepEqual(
      sites.map((s) => [s.type, s.found]),
      [[null, 'a `type` key set from `messageType`']],
    );
  });

  it('refuses a concatenated type value — the literal is not credited with the type', () => {
    const sites = extractSendSites(
      new Map([['a.js', "await send({ type: 'RECORDING_' + which });"]]),
    );
    assert.deepEqual(
      sites.map((s) => [s.type, s.found]),
      [[null, 'a `type` key set from `RECORDING_` followed by `+`']],
    );
  });

  it('reads the message literal, never a nested payload’s own type key', () => {
    const sites = extractSendSites(
      new Map([['a.js', "await send({ payload: { type: 'INNER' }, label: 'x' });"]]),
    );
    assert.deepEqual(
      sites.map((s) => [s.type, s.found]),
      [[null, 'no `type` key among the top-level properties (`payload`, `label`)']],
    );
  });

  it('names a template type value as a template rather than as the text it leads with', () => {
    // A template's token value is a run of its literal text, so naming the
    // token alone would report a type the send never states — and an
    // interpolated one, a type no enumeration can ever carry.
    const found = [
      'await send({ type: `RECORDING_OPEN` });',
      'await send({ type: `RECORDING_${which}` });',
    ].map((source) => {
      const sites = extractSendSites(new Map([['a.js', source]]));
      assert.equal(sites.length, 1, source);
      assert.equal(sites[0].type, null, source);
      return sites[0].found;
    });
    assert.deepEqual(found, [
      'a `type` key set from a template literal (`RECORDING_OPEN`)',
      'a `type` key set from a template literal (`RECORDING_`)',
    ]);
  });

  it('names the shape standing where a key belongs, computed keys included', () => {
    // The computed form is the one way an expression reaches a key position in
    // valid JavaScript, and it is where a template can stand: the key scan
    // reads a bare or quoted name, so neither is credited with a key it never
    // wrote — and the diagnosis names the shape it found rather than reporting
    // a literal with no properties, which is a cause these sends do not have.
    const cases = [
      ["await send({ ['type']: 'RECORDING_OPEN' });", 'no `type` key among the top-level properties (a computed key)'], // prettier-ignore
      ['await send({ [`type`]: kind });', 'no `type` key among the top-level properties (a computed key)'], // prettier-ignore
      ['await send({ ...payload });', 'no `type` key among the top-level properties (a spread)'],
      ['await send({ type });', 'no `type` key among the top-level properties (`type`, which no colon follows)'], // prettier-ignore
    ];
    for (const [source, found] of cases) {
      const sites = extractSendSites(new Map([['a.js', source]]));
      assert.deepEqual(
        sites.map((s) => [s.type, s.found]),
        [[null, found]],
        source,
      );
    }
  });

  it('names a template literal standing where a key belongs', () => {
    // The literal's sibling arm, on the shared phrase: a template standing in
    // key position is named by its kind with its own run of text beside it,
    // rather than by the backtick it opens with.
    const sites = extractSendSites(new Map([['a.js', 'await send({ `type`: 1 });']]));
    assert.deepEqual(
      sites.map((s) => [s.type, s.found]),
      [[null, 'no `type` key among the top-level properties (a template literal (`type`))']],
    );
  });

  it('names a regular-expression literal standing where a key belongs', () => {
    // The kind travels with the token here too, so the diagnosis states the
    // literal the source wrote rather than the punctuation it opens with.
    const sites = extractSendSites(
      new Map([['a.js', "await send({ /type/: 'RECORDING_OPEN' });"]]),
    );
    assert.deepEqual(
      sites.map((s) => [s.type, s.found]),
      [[null, 'no `type` key among the top-level properties (a regular-expression literal (`/type/`))']], // prettier-ignore
    );
  });

  it('keeps the empty-literal diagnosis for a send that really states no property', () => {
    // The other cause, still its own: an object literal with nothing in it.
    const sites = extractSendSites(new Map([['a.js', 'await send({});']]));
    assert.deepEqual(
      sites.map((s) => [s.type, s.found]),
      [[null, 'no top-level properties at all']],
    );
  });

  it('reads a send written inside a template interpolation', () => {
    // The interpolation's contents are code, so the send is a send — it was
    // string text before templates were modelled, and the scan saw nothing.
    const sites = extractSendSites(
      new Map([['a.js', "const t = `x${send({ type: 'RECORDING_OPEN' })}y`;"]]),
    );
    assert.deepEqual(sites, [{ path: 'a.js', ordinal: 1, type: 'RECORDING_OPEN', found: null }]);
  });

  it('a source that ends mid-send records the end-of-source stand-in', () => {
    // Both truncations: the literal never closes, and the follower that would
    // prove the type value lone never arrives.
    assert.deepEqual(
      extractSendSites(new Map([['a.js', 'await send({ recording_id: id,']])).map((s) => s.found),
      ['(end of source)'],
    );
    assert.deepEqual(
      extractSendSites(new Map([['a.js', "await send({ type: 'RECORDING_OPEN'"]])).map((s) => s.found), // prettier-ignore
      ['(end of source)'],
    );
  });
});

describe('collectModuleBindings — the population the reach test runs against', () => {
  const bindingsOf = (source) => {
    const read = collectModuleBindings(tokenizeJs(source));
    return { names: [...read.bindings].sort(), problems: read.problems };
  };

  it('collects every module-scope declaration form, declarator lists included', () => {
    const read = bindingsOf(
      [
        'const activeFrames = new Map(), programmaticTabs = new Set();',
        'let liveRecording = false;',
        'var legacy = 1;',
        'function registerFrame(tabId, frameId) { const local = tabId; return local; }',
        'async function seedActiveFrames() {}',
        'function* ticks() {}',
        'class Router {}',
      ].join('\n'),
    );
    assert.deepEqual(read.names, [
      'Router',
      'activeFrames',
      'legacy',
      'liveRecording',
      'programmaticTabs',
      'registerFrame',
      'seedActiveFrames',
      'ticks',
    ]);
    assert.deepEqual(read.problems, []);
  });

  it('leaves locals and parameters out — they bind nothing at module scope', () => {
    // The false-red direction the reach leg stands on: an identifier a member
    // shares with a local is not a reach, and never reaches this set.
    const read = bindingsOf('function f(param) { const local = 1; let other = 2; return local + other + param; }'); // prettier-ignore
    assert.deepEqual(read.names, ['f']);
  });

  it("collects an import's bindings in each form it is written", () => {
    const read = bindingsOf(
      [
        "import validateExtensionPayload from '../shared/generated/validate-extension.js';",
        "import { registerFrame, sync as syncNow } from '../shared/sync-client.js';",
        "import chromeAdapter, { helper } from '../sidepanel/adapter-chrome.js';",
        "import * as timing from '../lib/capture-timing.js';",
        "import '../lib/side-effect.js';",
      ].join('\n'),
    );
    // `sync as syncNow` binds the local name, never the exported one.
    assert.deepEqual(read.names, [
      'chromeAdapter',
      'helper',
      'registerFrame',
      'syncNow',
      'timing',
      'validateExtensionPayload',
    ]);
    assert.ok(!read.names.includes('sync'), 'the renamed export binds nothing here');
    assert.deepEqual(read.problems, []);
  });

  it('binds the namespace alias in either position it can stand in', () => {
    // The combined form is the one this closes: read before the default arm,
    // the alias arm answers for the leading shape only, and `ns` below would
    // bind nothing at all — a name the reach test could then never see.
    const shapes = [
      ["import * as ns from './x.js';", ['ns']],
      ["import def, * as ns from './x.js';", ['def', 'ns']],
      ["import def, { a, b as c } from './x.js';", ['a', 'c', 'def']],
    ];
    for (const [source, names] of shapes) {
      const read = bindingsOf(source);
      assert.deepEqual(read.names, names, source);
      assert.deepEqual(read.problems, [], source);
    }
  });

  it('binds nothing for a dynamic import, which is an expression rather than a declaration', () => {
    assert.deepEqual(bindingsOf("const mod = import('./x.js');").names, ['mod']);
  });

  it('refuses a destructuring declarator instead of reading past it', () => {
    // Fail-closed: names the collector cannot see are reaches the leg cannot
    // test, so the shape is refused rather than silently shrinking the set.
    const read = bindingsOf('const { activeFrames } = state;');
    assert.deepEqual(read.names, []);
    assert.equal(read.problems.length, 1, read.problems.join('\n'));
    assert.match(read.problems[0], /declares a module-scope binding through `\{`/);
    assert.match(read.problems[0], /a name it cannot see is a reach it cannot test/);
  });
});

describe('extractHandleSurface — one anchor, read whole', () => {
  const compliant = [
    '  frameRegistry: () => Object.fromEntries([...activeFrames]),',
    '  wipeFrameRegistry: () => activeFrames.clear(),',
  ].join('\n');

  it('reads the members and what each of them reaches', () => {
    const read = extractHandleSurface(handleSource(compliant));
    assert.deepEqual(read.members, ['frameRegistry', 'wipeFrameRegistry']);
    assert.deepEqual(read.reaches, [
      { member: 'frameRegistry', name: 'activeFrames' },
      { member: 'wipeFrameRegistry', name: 'activeFrames' },
    ]);
    assert.deepEqual(read.problems, []);
    // The identifiers a body names are ALL of its words; what it reaches is
    // their intersection with the module scope, which is what leaves the
    // built-ins and property names out of the reach test rather than allowed
    // through it.
    assert.deepEqual(read.named[0].identifiers, ['Object', 'fromEntries', 'activeFrames']);
  });

  it('reads a quoted member name the same as a bare one', () => {
    const read = extractHandleSurface(handleSource("  'frameRegistry': () => [...activeFrames],"));
    assert.deepEqual(read.members, ['frameRegistry']);
    assert.deepEqual(read.problems, []);
  });

  it('reports a member reaching a worker structure the reach set does not name', () => {
    // The leg the member table alone cannot hold: the name and the row are
    // unchanged, and the body reaches a third structure.
    const source = `const pendingQueue = new Map();\n${handleSource('  frameRegistry: () => pendingQueue.size,')}`; // prettier-ignore
    const read = extractHandleSurface(source);
    assert.deepEqual(read.reaches, [{ member: 'frameRegistry', name: 'pendingQueue' }]);
    assert.deepEqual(read.problems, []);
    const problems = evaluateExtensionSurface(
      makeSurface({ handleMembers: read.members, docHandleMembers: read.members, handleReaches: read.reaches }), // prettier-ignore
    );
    assert.ok(
      problems.some((p) => p.includes('`pendingQueue`') && p.includes('outside the set')),
      problems.join('\n') || 'no reach diagnostic',
    );
  });

  it("reads no reach out of a body's own locals and parameters", () => {
    const read = extractHandleSurface(
      handleSource('  count: (tabId) => { const seen = tabId; return seen; },'),
    );
    assert.deepEqual(read.members, ['count']);
    assert.deepEqual(read.reaches, []);
    assert.deepEqual(read.problems, []);
  });

  it('refuses an absent assignment', () => {
    const read = extractHandleSurface('const activeFrames = new Map();');
    assert.deepEqual(read.members, []);
    assert.equal(read.problems.length, 1);
    assert.match(read.problems[0], /assigns no `globalThis\.__docentCaptureBookkeeping`/);
  });

  it('refuses a second assignment, counting them', () => {
    const twice = `${handleSource(compliant)}\nglobalThis.${HANDLE_NAME} = Object.freeze({});`;
    const read = extractHandleSurface(twice);
    assert.deepEqual(read.members, []);
    assert.equal(read.problems.length, 1);
    assert.match(
      read.problems[0],
      /carries 2 `globalThis\.__docentCaptureBookkeeping` assignments/,
    );
  });

  it('refuses an unfrozen literal, naming what stands where the freeze does', () => {
    // The pin the freeze leg exists for: dropping `Object.freeze` leaves a
    // surface that can be extended in place, and the shape must not pass as the
    // anchor with the members read out of it anyway.
    const read = extractHandleSurface(handleSource(compliant, `globalThis.${HANDLE_NAME} = {`));
    assert.deepEqual(read.members, []);
    assert.equal(read.problems.length, 1);
    assert.match(read.problems[0], /assigns `globalThis\.__docentCaptureBookkeeping` from `\{`/);
    assert.match(read.problems[0], /the scan reads `Object\.freeze\(\{`/);
  });

  it('refuses a literal that never closes rather than half-reading it', () => {
    const read = extractHandleSurface(
      `const activeFrames = new Map();\nglobalThis.${HANDLE_NAME} = Object.freeze({\n  frameRegistry: () => 1,`,
    );
    assert.deepEqual(read.members, []);
    assert.match(read.problems[0], /handle literal never closes/);
  });

  it('names the shape standing where a member name belongs', () => {
    const cases = [
      ["  ['frameRegistry']: () => 1,", 'a computed key'],
      ['  ...base,', 'a spread'],
      ['  frameRegistry,', '`frameRegistry`, which no colon follows'],
    ];
    for (const [body, found] of cases) {
      const read = extractHandleSurface(handleSource(body));
      assert.deepEqual(read.members, [], body);
      assert.equal(read.problems.length, 1, `${body}: ${read.problems.join('\n')}`);
      assert.ok(read.problems[0].includes(found), read.problems[0]);
    }
  });

  it('never reads a commented-out member — the tokenizer keeps comments out', () => {
    const read = extractHandleSurface(
      handleSource(['  // wipeProgrammaticTabs: () => programmaticTabs.clear(),', compliant].join('\n')), // prettier-ignore
    );
    assert.deepEqual(read.members, ['frameRegistry', 'wipeFrameRegistry']);
  });
});

describe("extractHandleTable — the enumeration read from the clause's own scope", () => {
  const doc = (rows, tail = '') =>
    [
      '## Lifecycle and the persisted-state model',
      '',
      `**${HANDLE_CLAUSE_ID}.** The handle's member surface is the table below.`,
      '',
      HANDLE_TABLE_HEADER.map((cell) => `| ${cell} `).join('') + '|',
      '| --- | --- | --- |',
      ...rows,
      '',
      '**ERT-6.** The handle ships in release builds.',
      tail,
    ].join('\n');

  it('reads the member column, refusing a cell that is not a lone backticked name', () => {
    const read = extractHandleTable(doc(['| `frameRegistry` | a | b |', '| plantFrame | a | b |']));
    assert.deepEqual(read.members, ['frameRegistry']);
    assert.deepEqual(read.unreadable, ['plantFrame']);
    assert.equal(read.matches, 1);
  });

  it('reads nothing from a table that has left the clause scope, and counts it', () => {
    // Two facts, kept apart: the document still carries a table with that
    // header (the count says so), and the clause's own scope no longer states
    // the enumeration (the empty read says so).
    const moved = doc([], ['', '| Member | Reaches | What it does |', '| --- | --- | --- |', '| `frameRegistry` | a | b |'].join('\n')); // prettier-ignore
    const read = extractHandleTable(moved);
    assert.deepEqual(read.members, []);
    assert.equal(read.matches, 2);
  });

  it('reads nothing when the clause marker is renumbered away', () => {
    const read = extractHandleTable(
      doc(['| `frameRegistry` | a | b |']).replace(`**${HANDLE_CLAUSE_ID}.**`, '**ERT-9.**'),
    );
    assert.deepEqual(read.members, []);
  });

  it('never reads a fenced illustration of the table, inside the clause scope or past it', () => {
    // Both positions, because the two reads are bounded differently: the member
    // read is the clause's own scope, the count is the whole document.
    const fenced = ['', '```markdown', '| Member | Reaches | What it does |', '| --- | --- | --- |', '| `fenced` | a | b |', '```', ''].join('\n'); // prettier-ignore
    const claim = `**${HANDLE_CLAUSE_ID}.** The handle's member surface is the table below.`;
    const read = extractHandleTable(
      doc(['| `frameRegistry` | a | b |'], fenced).replace(claim, `${claim}\n${fenced}`),
    );
    assert.deepEqual(read.members, ['frameRegistry']);
    assert.equal(read.matches, 1);
  });
});

describe('countHandleMentions — the handle names itself once, where it is assigned', () => {
  it('counts word and computed-string positions, and no comment at all', () => {
    const counts = countHandleMentions(
      new Map([
        [WORKER_PATH, `globalThis.${HANDLE_NAME} = Object.freeze({});`],
        [LIB_PATH, `// ${HANDLE_NAME} is the worker's own\nexport const x = 1;`],
        [SECOND_BACKGROUND_PATH, `const h = globalThis['${HANDLE_NAME}'];`],
      ]),
    );
    assert.deepEqual(counts, [
      { path: WORKER_PATH, count: 1 },
      { path: SECOND_BACKGROUND_PATH, count: 1 },
    ]);
  });

  it('counts every occurrence a file makes', () => {
    const counts = countHandleMentions(
      new Map([[WORKER_PATH, `globalThis.${HANDLE_NAME} = Object.freeze({});\nglobalThis.${HANDLE_NAME}.wipeFrameRegistry();`]]), // prettier-ignore
    );
    assert.deepEqual(counts, [{ path: WORKER_PATH, count: 2 }]);
  });
});

describe('evaluateExtensionSurface — the handle legs', () => {
  it('fires when the handle carries a member the table does not state', () => {
    const problems = evaluateExtensionSurface(
      makeSurface({ handleMembers: ['frameRegistry', 'wipeFrameRegistry', 'peekPending'] }),
    );
    assert.ok(
      problems.some((p) => p.includes('peekPending') && p.includes('member table does not state it')), // prettier-ignore
      problems.join('\n') || 'no forward member diagnostic',
    );
  });

  it('fires when the table states a member the handle does not carry', () => {
    const problems = evaluateExtensionSurface(
      makeSurface({ docHandleMembers: ['frameRegistry', 'wipeFrameRegistry', 'plantFrame'] }),
    );
    assert.ok(
      problems.some((p) => p.includes('plantFrame') && p.includes('does not carry it')),
      problems.join('\n') || 'no reverse member diagnostic',
    );
  });

  it('fires on a reach outside the stated set, naming the member and the name', () => {
    const problems = evaluateExtensionSurface(
      makeSurface({ handleReaches: [{ member: 'frameRegistry', name: 'pendingQueue' }] }),
    );
    const refusal = problems.find((p) => p.includes('pendingQueue'));
    assert.ok(refusal, problems.join('\n') || 'no reach diagnostic');
    assert.ok(refusal.includes('`frameRegistry` reaches'), refusal);
    for (const name of HANDLE_REACH_SET) assert.ok(refusal.includes(name), refusal);
  });

  it('accepts every name the reach set states', () => {
    assert.deepEqual(
      evaluateExtensionSurface(
        makeSurface({ handleReaches: HANDLE_REACH_SET.map((name) => ({ member: 'frameRegistry', name })) }), // prettier-ignore
      ),
      [],
    );
  });

  it('fires on a production module naming the handle, and names the tests tree as where its observers sit', () => {
    const problems = evaluateExtensionSurface(
      makeSurface({
        handleMentions: [
          { path: WORKER_PATH, count: 1 },
          { path: LIB_PATH, count: 1 },
        ],
      }),
    );
    const refusal = problems.find((p) => p.startsWith(LIB_PATH));
    assert.ok(refusal, problems.join('\n') || 'no production-caller diagnostic');
    assert.ok(refusal.includes(HANDLE_NAME) && refusal.includes(POPULATION_TEST_TREE), refusal);
  });

  it('fires on a second occurrence inside the worker itself', () => {
    const problems = evaluateExtensionSurface(
      makeSurface({ handleMentions: [{ path: WORKER_PATH, count: 2 }] }),
    );
    assert.ok(
      problems.some((p) => p.includes('names `__docentCaptureBookkeeping` 2 times')),
      problems.join('\n') || 'no second-occurrence diagnostic',
    );
  });

  it('reads the mention count ahead of the vacuous return', () => {
    // A production route into the plants and wipes is a fact about the shipped
    // extension whatever the doc's tables parse to.
    const problems = evaluateExtensionSurface(
      makeSurface({
        docPanelTypes: [],
        handleMentions: [
          { path: WORKER_PATH, count: 1 },
          { path: LIB_PATH, count: 3 },
        ],
      }),
    );
    assert.ok(problems.some((p) => p.startsWith(LIB_PATH)));
    assert.ok(problems.some((p) => p.includes('no panel-protocol types found')));
  });

  it('fires when the document does not state the member table exactly once', () => {
    for (const matches of [0, 2]) {
      const problems = evaluateExtensionSurface(makeSurface({ handleTableMatches: matches }));
      assert.ok(
        problems.some((p) => p.includes(`carries ${matches} tables headed`)),
        problems.join('\n') || `no table-posture diagnostic for ${matches}`,
      );
    }
  });

  it('is fail-closed on the table posture: a surface stating no count reds', () => {
    const surface = makeSurface();
    delete surface.handleTableMatches;
    assert.ok(
      evaluateExtensionSurface(surface).some((p) => p.includes('tables headed')),
      'a surface without the key must red',
    );
  });

  it('fires on an unreadable member cell, ahead of the vacuous return', () => {
    const problems = evaluateExtensionSurface(
      makeSurface({ docHandleMembers: [], handleUnreadable: ['plantFrame'] }),
    );
    assert.ok(problems.some((p) => p.includes('plantFrame') && p.includes('cannot read')));
    assert.ok(problems.some((p) => p.includes('no handle members found')));
  });

  it('diagnoses a production population that names no file, or has lost the worker', () => {
    const empty = evaluateExtensionSurface(makeSurface({ productionFiles: [] }));
    assert.ok(
      empty.some((p) => p.includes('no-production-caller leg has no population to hold')),
      empty.join('\n') || 'no empty-production diagnostic',
    );
    const lost = evaluateExtensionSurface(makeSurface({ productionFiles: [LIB_PATH] }));
    assert.ok(
      lost.some((p) => p.includes('outside the production population')),
      lost.join('\n') || 'no lost-worker diagnostic',
    );
  });
});

describe('real-tree lock', () => {
  const readFile = (f) => readFileSync(resolve(ROOT, f), 'utf8');

  it('the shipped tree satisfies its contracts', () => {
    // The recursive enumeration the CLI wrapper passes, filtered the same way,
    // beside the check's own background derivation and the production set it
    // imports — the three sets the CLI scans.
    const panelFiles = trackedFilesUnder(PANEL_DIR, { cwd: ROOT, extensions: ['.js'] });
    assert.ok(panelFiles.length >= 1, 'the panel tree must carry tracked JavaScript');
    const { problems, permissionCount, typeCount, panelTypeCount, memberCount } = auditTree(
      readFile,
      panelFiles,
      shippedPopulation(),
      deriveProductionPopulation(ROOT),
    );
    assert.deepEqual(problems, [], problems.join('\n'));
    assert.ok(permissionCount > 0);
    assert.ok(typeCount > 0);
    assert.ok(memberCount > 0, 'the handle states members');
    // The two counts the success line reports are different surfaces: the
    // whole message-type union, and the panel-protocol subset the sender leg
    // covers.
    assert.ok(panelTypeCount > 0);
    assert.ok(panelTypeCount < typeCount, 'the capture-path types sit outside the panel protocol');
    // The lock also proves the check reads the real surfaces it names.
    for (const p of [MANIFEST_PATH, PERMISSIONS_DOC_PATH, RUNTIME_DOC_PATH, WORKER_PATH]) {
      assert.doesNotThrow(() => readFileSync(resolve(ROOT, p)));
    }
  });

  it('derives a population with the properties the dispatcher legs stand on', () => {
    // The properties, not a second copy of the derivation: what the background
    // tree tracks IS the population, so a module the extension grows there is
    // scanned with nothing to update — and the service worker, whose own guards
    // the forward diff reads, is in it.
    const population = shippedPopulation();
    assert.ok(population.length > 0);
    assert.ok(population.includes(WORKER_PATH), `${WORKER_PATH} is in the scanned population`);
    for (const file of population) {
      assert.ok(file.startsWith(`${BACKGROUND_ROOT}/`), `${file} is inside the background tree`);
      assert.ok(
        POPULATION_EXTENSIONS.some((ext) => file.endsWith(ext)),
        `${file} carries a JavaScript module extension`,
      );
    }
    assert.equal(new Set(population).size, population.length, 'each file is stated once');
  });

  it('an unreadable worker fails loudly rather than passing vacuously', () => {
    const panelFiles = trackedFilesUnder(PANEL_DIR, { cwd: ROOT, extensions: ['.js'] });
    const { problems } = auditTree(
      (f) => (f === WORKER_PATH ? '' : readFile(f)),
      panelFiles,
      shippedPopulation(),
      deriveProductionPopulation(ROOT),
    );
    assert.ok(problems.length > 0);
    assert.ok(
      problems.some((p) => p.includes('no dispatcher switch over the message type')),
      problems.join('\n') || 'no missing-dispatcher diagnostic',
    );
    // The handle's own legs answer for the same unreadable file, on their own
    // diagnosis: the anchor the members are read from is gone with it.
    assert.ok(
      problems.some((p) => p.includes(`assigns no \`globalThis.${HANDLE_NAME}\``)),
      problems.join('\n') || 'no missing-anchor diagnostic',
    );
  });

  it('the shipped handle states the members its clause does, reaching only what the clause places it over', () => {
    // The three shipped facts, read from the tree rather than restated: the
    // members agree with the table, every reach is a name the set states, and
    // the identifiers a healthy tree leaves OUTSIDE the reach test are pinned —
    // the false-red direction, so a collector that started reading locals or
    // built-ins as bindings reds here instead of reddening the whole check.
    const handle = extractHandleSurface(readFile(WORKER_PATH));
    const table = extractHandleTable(readFile(RUNTIME_DOC_PATH));
    assert.deepEqual(handle.problems, [], handle.problems.join('\n'));
    assert.deepEqual(handle.members.slice().sort(), table.members.slice().sort());
    assert.equal(table.matches, 1);
    const reached = [...new Set(handle.reaches.map((r) => r.name))].sort();
    assert.deepEqual(reached, HANDLE_REACH_SET.slice().sort());
    const identifiers = [...new Set(handle.named.flatMap((n) => n.identifiers))];
    const outside = identifiers.filter((name) => !reached.includes(name)).sort();
    // Sorted on both sides, like the reach assertion above: what is held is the
    // SET the shipped members leave outside the reach test, so reordering the
    // members cannot red a lock that is not about their order.
    assert.deepEqual(
      outside,
      ['Object', 'add', 'async', 'await', 'clear', 'frameId', 'frames', 'fromEntries', 'id', 'map', 't', 'tabId'].sort(), // prettier-ignore
    );
  });

  it('the shipped production population names the handle once, where it is assigned', () => {
    const productionFiles = deriveProductionPopulation(ROOT);
    assert.ok(productionFiles.includes(WORKER_PATH), `${WORKER_PATH} is in the production set`);
    assert.ok(
      productionFiles.every((f) => !f.startsWith(`${POPULATION_TEST_TREE}/`)),
      'the tests tree is the one exclusion',
    );
    assert.deepEqual(countHandleMentions(new Map(productionFiles.map((f) => [f, readFile(f)]))), [
      { path: WORKER_PATH, count: 1 },
    ]);
  });

  it('the CLI scans those same derivations, never a second copy of one', () => {
    // The lock these real-tree cases stand on: they hold the shipped
    // derivations, so the CLI must consume them too — a private copy in the
    // wrapper could drift while every case here stayed green.
    const script = readFile('scripts/check-extension-surface.js');
    assert.match(
      script,
      /auditTree\(\s*readFile,\s*panelFiles,\s*derivePopulation\(\),\s*deriveProductionPopulation\(\),?\s*\)/,
    );
    // The enumeration itself is the shared population reader's, so this file
    // states no `ls-files` invocation of its own…
    assert.equal(script.split("'ls-files'").length - 1, 0, 'no private enumeration here');
    // …and reaches that reader from exactly the two places it is entitled to:
    // the panel derivation in the CLI wrapper, and the background derivation
    // these cases hold. The production population is a third set and no third
    // derivation: it arrives imported from the check that already derives it,
    // so a private copy of it cannot land green either.
    assert.equal(
      script.split('trackedFilesUnder(').length - 1,
      2,
      'the file reaches the shared population reader at the panel and background derivations, and nowhere else',
    );
    assert.match(
      script,
      /derivePopulation as deriveProductionPopulation,?\s*\n\}\s*from '\.\/check-capture-surface\.js'/,
    );
    // The module extensions are one fact about the package the extension
    // ships, and both closures filter on it. It arrives from the same sibling
    // import, so a module kind widened in one home cannot enter that closure
    // and miss this one.
    assert.match(script, /POPULATION_EXTENSIONS,[^}]*\}\s*from '\.\/check-capture-surface\.js'/);
    // The panel derivation states its own `['.js']` filter, which is a
    // narrower set on purpose, so what is held is the MODULE-KIND half: the
    // extensions the module system defines beyond `.js` appear in no literal
    // here.
    for (const ext of POPULATION_EXTENSIONS.filter((e) => e !== '.js')) {
      assert.equal(script.split(`'${ext}'`).length - 1, 0, `${ext} is imported, never restated here`); // prettier-ignore
    }
  });
});
