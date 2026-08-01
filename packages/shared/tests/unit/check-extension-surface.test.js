/**
 * check-extension-surface.test.js — Unit tests for the extension-surface
 * admission test (scripts/check-extension-surface.js). Both surface contracts
 * are committed (permissions.md §EPM-1, runtime.md §ERT-4), so every red-path
 * family must fail loud: these tests prove the pairwise set inequalities in
 * each direction on every leg, the unreadable-cell and unknown-shape
 * refusals, the dispatcher anchor guards (one switch, a default arm, no
 * nesting), the disjointness rule, duplicates, and empty parses — that the
 * comment-safe tokenizer keeps commented labels out of the scans — and, as a
 * real-tree lock, that the shipped tree satisfies both contracts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MANIFEST_PATH,
  PERMISSIONS_DOC_PATH,
  RUNTIME_DOC_PATH,
  WORKER_PATH,
  extractManifestSurface,
  extractSectionTableNames,
  extractProtocolTables,
  extractDispatcherSurface,
  evaluateExtensionSurface,
  auditTree,
} from '../../../../scripts/check-extension-surface.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');

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

  it('fires on a duplicated name in the doc and case-label surfaces — the legs the set diffs cannot see', () => {
    const docDup = evaluateExtensionSurface(
      makeSurface({ docPermissions: ['storage', 'tabs', 'storage'] }),
    );
    assert.ok(docDup.some((p) => p.includes('storage') && p.includes('more than once')));
    const panelDup = evaluateExtensionSurface(
      makeSurface({ docPanelTypes: ['PROJECTS_LIST', 'STEP_COMMIT', 'STEP_COMMIT'] }),
    );
    assert.ok(panelDup.some((p) => p.includes('STEP_COMMIT') && p.includes('more than once')));
    const caseDup = evaluateExtensionSurface(
      makeSurface({ caseLabels: ['PROJECTS_LIST', 'STEP_COMMIT', 'PROJECTS_LIST'] }),
    );
    assert.ok(caseDup.some((p) => p.includes('PROJECTS_LIST') && p.includes('more than once')));
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

describe('evaluateExtensionSurface — empty parses are structural failures', () => {
  for (const [key, needle] of [
    ['manifestPermissions', 'no permissions found'],
    ['manifestHostPermissions', 'no host_permissions found'],
    ['docPermissions', 'no Permissions table names'],
    ['docHostPermissions', 'no Host permissions table names'],
    ['docCaptureTypes', 'no capture-path types'],
    ['docPanelTypes', 'no panel-protocol types'],
    ['caseLabels', 'no case labels'],
    ['equalityTypes', 'no message-type equality literals'],
  ]) {
    it(`fires when ${key} parses empty`, () => {
      const problems = evaluateExtensionSurface(makeSurface({ [key]: [] }));
      assert.ok(
        problems.some((p) => p.includes(needle)),
        problems.join('\n'),
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
});

describe('real-tree lock', () => {
  it('the shipped tree satisfies both contracts', () => {
    const { problems, permissionCount, typeCount } = auditTree((f) =>
      readFileSync(resolve(ROOT, f), 'utf8'),
    );
    assert.deepEqual(problems, [], problems.join('\n'));
    assert.ok(permissionCount > 0);
    assert.ok(typeCount > 0);
    // The lock also proves the check reads the real surfaces it names.
    for (const p of [MANIFEST_PATH, PERMISSIONS_DOC_PATH, RUNTIME_DOC_PATH, WORKER_PATH]) {
      assert.doesNotThrow(() => readFileSync(resolve(ROOT, p)));
    }
  });
});
