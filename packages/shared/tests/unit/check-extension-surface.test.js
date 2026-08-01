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
    switchCount: 1,
    hasDefault: true,
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
      problems.some((p) => p.includes('GET_TAB_ID') && p.includes('no equality guard servicing it')), // prettier-ignore
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

  it('fires when the dispatcher switch count is not one, or the default arm is missing', () => {
    const two = evaluateExtensionSurface(makeSurface({ switchCount: 2 }));
    assert.ok(two.some((p) => p.includes('2 dispatcher switches')));
    const noDefault = evaluateExtensionSurface(makeSurface({ hasDefault: false }));
    assert.ok(noDefault.some((p) => p.includes('no default: arm')));
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

  it('reads names per section, fence-aware, refusing unreadable cells', () => {
    const perms = extractSectionTableNames(doc, 'Permissions');
    assert.deepEqual(perms.names, ['storage']);
    assert.deepEqual(perms.unreadable, ['un-backticked']);
    const hosts = extractSectionTableNames(doc, 'Host permissions');
    assert.deepEqual(hosts.names, ['<all_urls>']);
    assert.deepEqual(hosts.unreadable, []);
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

  it('reads case labels up to default and equality literals, skipping comments', () => {
    const read = extractDispatcherSurface(worker);
    assert.deepEqual(read.caseLabels, ['PROJECTS_LIST', 'STEP_COMMIT']);
    assert.deepEqual(read.equalityTypes, ['FRAME_READY']);
    assert.equal(read.switchCount, 1);
    assert.equal(read.hasDefault, true);
    assert.deepEqual(read.problems, []);
  });

  it('reports a nested switch instead of misreading its cases', () => {
    const nested = worker.replace("case 'STEP_COMMIT': {", "case 'STEP_COMMIT': { switch (x) {");
    const read = extractDispatcherSurface(nested);
    assert.ok(read.problems.some((p) => p.includes('nests a switch')));
  });

  it('counts zero switches and no default on a source without the dispatcher', () => {
    const read = extractDispatcherSurface('const x = 1;');
    assert.equal(read.switchCount, 0);
    assert.equal(read.hasDefault, false);
    assert.deepEqual(read.caseLabels, []);
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
