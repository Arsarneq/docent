/**
 * check-extension-surface.test.js — Unit tests for the extension-surface
 * admission test (scripts/check-extension-surface.js). Both surface contracts
 * are committed (permissions.md §EPM-1, runtime.md §ERT-4), so every red-path
 * family must fail loud: these tests prove the pairwise set inequalities in
 * each direction on every leg, the sender side's readable shape and its
 * refusal, the unreadable-cell and unknown-shape refusals, the dispatcher
 * anchor guards (one switch, a default arm, no nesting), the disjointness
 * rule, duplicates, and empty parses — that the comment-safe tokenizer keeps
 * commented labels out of the scans — and, as a real-tree lock, that the
 * shipped tree satisfies both contracts. One case is a demonstration rather
 * than a guard: the reverse send direction's documented limit, exercised so
 * the misleading red it produces is observed behaviour, never an assertion in
 * prose alone.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  MANIFEST_PATH,
  PERMISSIONS_DOC_PATH,
  RUNTIME_DOC_PATH,
  WORKER_PATH,
  PANEL_DIR,
  EMPTY_SURFACES,
  DUPLICATE_SURFACES,
  extractManifestSurface,
  extractSectionTableNames,
  extractProtocolTables,
  extractDispatcherSurface,
  extractSendSites,
  evaluateExtensionSurface,
  auditTree,
} from '../../../../scripts/check-extension-surface.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
/** A panel path inside the scanned surface. */
const PANEL_PATH = `${PANEL_DIR}/panel.js`;

/** A consistent synthetic surface both contracts accept. */
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
    caseLabels: ['PROJECTS_LIST', 'STEP_COMMIT'],
    equalityTypes: ['FRAME_READY'],
    sendTypes: ['PROJECTS_LIST', 'STEP_COMMIT'],
    sendSites: [
      { path: PANEL_PATH, ordinal: 1, type: 'PROJECTS_LIST', found: null },
      { path: PANEL_PATH, ordinal: 2, type: 'STEP_COMMIT', found: null },
    ],
    ...overrides,
  };
}

describe('evaluateExtensionSurface — compliant baseline', () => {
  it('returns no problems when both contracts hold', () => {
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

  it('reads names per section and header cell, fence-aware, refusing unreadable cells', () => {
    const perms = extractSectionTableNames(doc, 'Permissions', 'Permission');
    assert.deepEqual(perms.names, ['storage']);
    assert.deepEqual(perms.unreadable, ['un-backticked']);
    const hosts = extractSectionTableNames(doc, 'Host permissions', 'Host permission');
    assert.deepEqual(hosts.names, ['<all_urls>']);
    assert.deepEqual(hosts.unreadable, []);
  });

  it('a sibling table under the same heading with a different header is never conscripted', () => {
    const withSibling = doc.replace(
      '## Host permissions',
      ['| Optional permission | Why |', '| ------------------- | --- |', '| `downloads`         | e   |', '', '## Host permissions'].join('\n'), // prettier-ignore
    );
    const perms = extractSectionTableNames(withSibling, 'Permissions', 'Permission');
    assert.deepEqual(perms.names, ['storage']);
    assert.ok(!perms.names.includes('downloads'));
    assert.ok(!perms.unreadable.length || !perms.unreadable.includes('`downloads`'));
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
    const read = extractDispatcherSurface(worker);
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
    const read = extractDispatcherSurface(reordered);
    assert.deepEqual(read.caseLabels.sort(), ['PROJECTS_LIST', 'STEP_COMMIT']);
    assert.deepEqual(read.problems, []);
  });

  it('a sibling switch after the dispatcher is not misread as nesting', () => {
    const sibling = `${worker}\nswitch (mode) { default: break; }`;
    const read = extractDispatcherSurface(sibling);
    assert.deepEqual(read.caseLabels, ['PROJECTS_LIST', 'STEP_COMMIT']);
    assert.deepEqual(read.problems, []);
  });

  it('reports a nested switch instead of misreading its cases', () => {
    const nested = worker.replace("case 'STEP_COMMIT': {", "case 'STEP_COMMIT': { switch (x) {");
    const read = extractDispatcherSurface(nested);
    assert.ok(read.problems.some((p) => p.includes('nests a switch')));
  });

  it('reports a missing dispatcher as an extractor problem — reachable on the real path', () => {
    const read = extractDispatcherSurface('const x = 1;');
    assert.ok(read.problems.some((p) => p.includes('0 dispatcher switches')));
    assert.deepEqual(read.caseLabels, []);
  });

  it('reports a second dispatcher switch as an extractor problem — reachable on the real path', () => {
    const two = `${worker}\nfunction other(message) { switch (message.type) { default: break; } }`;
    const read = extractDispatcherSurface(two);
    assert.ok(read.problems.some((p) => p.includes('2 dispatcher switches')));
  });

  it('reports a missing default arm as an extractor problem', () => {
    const noDefault = worker.replace('    default:\n      return { ok: false };\n', '');
    const read = extractDispatcherSurface(noDefault);
    assert.ok(read.problems.some((p) => p.includes('no default: arm')));
  });

  it('collects equality guards module-wide and deduplicates a repeated guard', () => {
    const spread = `${worker}\nif (message.type === 'LATE_GUARD') { return; }\nif (message.type === 'FRAME_READY' && busy) { return; }`;
    const read = extractDispatcherSurface(spread);
    assert.deepEqual(read.equalityTypes.sort(), ['FRAME_READY', 'LATE_GUARD']);
    assert.deepEqual(read.problems, []);
  });

  it('reports an unreadable dispatcher head as an extractor problem', () => {
    const read = extractDispatcherSurface('switch (msg.type) nope;');
    assert.ok(read.problems.some((p) => p.includes('no readable body')));
  });

  it('refuses an equality guard whose literal leads an expression', () => {
    // Before the operand's own end was required, this credited the guard with
    // `CAPTURE_START` while the code tested `CAPTURE_STARTsuffix`: the doc and
    // the guard then agreed in both directions on a type nothing guards.
    const guarded = `${worker}\nif (message.type === 'CAPTURE_START' + suffix) { return start(); }`;
    const read = extractDispatcherSurface(guarded);
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
      const read = extractDispatcherSurface(`${worker}\nconst r = message.type === ${tail}`);
      assert.deepEqual(read.problems, [], tail);
    }
    for (const tail of ["'X' + suffix;", "'X'.length;"]) {
      const read = extractDispatcherSurface(`${worker}\nconst r = message.type === ${tail}`);
      assert.equal(read.problems.length, 1, tail);
      assert.match(read.problems[0], /guards a message type with `X` followed by/);
    }
  });

  it('refuses an equality guard written with a template literal', () => {
    const templated = `${worker}\nif (message.type === \`PONG_\${k}\`) { return; }`;
    const read = extractDispatcherSurface(templated);
    assert.deepEqual(read.equalityTypes, ['FRAME_READY']);
    assert.equal(read.problems.length, 1);
    assert.match(read.problems[0], /guards a message type with a template literal \(`PONG_`\)/);
  });

  it('refuses an equality guard written with a regular-expression literal', () => {
    // A pattern reaches the operand position wherever an expression may start,
    // and the kind travelling with the read is what names it as the literal the
    // source wrote rather than letting it fall through unremarked.
    const patterned = `${worker}\nif (message.type === /PONG_/) { return; }`;
    const read = extractDispatcherSurface(patterned);
    assert.deepEqual(read.equalityTypes, ['FRAME_READY']);
    assert.equal(read.problems.length, 1);
    assert.match(read.problems[0], /guards a message type with a regular-expression literal \(`\/PONG_\/`\)/); // prettier-ignore
  });

  it('refuses a case label whose literal leads an expression', () => {
    // Before the label's own colon was required, this label vanished with no
    // problem at all — the enumeration then redded as a type nothing services,
    // naming a cause the source does not have.
    const shaped = worker.replace("case 'STEP_COMMIT': {", "case 'STEP_COMMIT' + k: {");
    const read = extractDispatcherSurface(shaped);
    assert.deepEqual(read.caseLabels, ['PROJECTS_LIST']);
    assert.equal(read.problems.length, 1);
    assert.match(read.problems[0], /labels an arm `STEP_COMMIT` followed by `\+`/);
    assert.match(read.problems[0], /quoted string literal the label's own colon follows/);
  });

  it('refuses a case label written with a template literal', () => {
    const templated = worker.replace("case 'STEP_COMMIT':", 'case `STEP_COMMIT`:');
    const read = extractDispatcherSurface(templated);
    assert.deepEqual(read.caseLabels, ['PROJECTS_LIST']);
    assert.equal(read.problems.length, 1);
    assert.match(read.problems[0], /labels an arm with a template literal \(`STEP_COMMIT`\)/);
  });

  it('refuses a case label written with a regular-expression literal', () => {
    // `case` is a position an expression can start at, so a pattern stands
    // there legally as far as the scanner is concerned; it is named as one
    // instead of leaving the arm silently unlabelled.
    const patterned = worker.replace("case 'STEP_COMMIT':", 'case /STEP_COMMIT/:');
    const read = extractDispatcherSurface(patterned);
    assert.deepEqual(read.caseLabels, ['PROJECTS_LIST']);
    assert.equal(read.problems.length, 1);
    assert.match(read.problems[0], /labels an arm with a regular-expression literal \(`\/STEP_COMMIT\/`\)/); // prettier-ignore
  });

  it('leaves a case label the scan never modelled outside the closure', () => {
    // A constant label is not a shape this scan reads, and never was: the
    // refusals above are about a literal the scan reads part of, not about
    // every label form.
    const constant = worker.replace("case 'STEP_COMMIT':", 'case STEP_COMMIT:');
    const read = extractDispatcherSurface(constant);
    assert.deepEqual(read.caseLabels, ['PROJECTS_LIST']);
    assert.deepEqual(read.problems, []);
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

describe('real-tree lock', () => {
  it('the shipped tree satisfies both contracts', () => {
    // The recursive enumeration the CLI wrapper passes, filtered the same way.
    const panelFiles = execFileSync('git', ['ls-files', PANEL_DIR], { encoding: 'utf8', cwd: ROOT })
      .split('\n')
      .map((s) => s.trim())
      .filter((f) => f.endsWith('.js'));
    assert.ok(panelFiles.length >= 1, 'the panel tree must carry tracked JavaScript');
    const { problems, permissionCount, typeCount, panelTypeCount } = auditTree(
      (f) => readFileSync(resolve(ROOT, f), 'utf8'),
      panelFiles,
    );
    assert.deepEqual(problems, [], problems.join('\n'));
    assert.ok(permissionCount > 0);
    assert.ok(typeCount > 0);
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
});
