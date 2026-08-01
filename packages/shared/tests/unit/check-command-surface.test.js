/**
 * check-command-surface.test.js — Unit tests for the desktop command-surface
 * admission test (scripts/check-command-surface.js). The command surface is a
 * committed contract (application-shell.md §DSH-1), so every way it can rot
 * must fail loud: these tests prove each red path fires on synthetic input
 * (a command missing from or extra in each of the registration, the doc
 * table, and the mock list; a second or mis-channelled emit site; a grant
 * missing from either side; duplicate rows; empty parses), that the Rust
 * comment stripper keeps doc-comment channel mentions out of the emit scan,
 * and — as a real-tree lock — that the shipped tree satisfies the contract.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  DOC_PATH,
  LIB_PATH,
  SRC_DIR,
  CAPABILITIES_PATH,
  MOCK_PATH,
  EVENT_CHANNEL,
  stripRustComments,
  extractCommandFns,
  extractHandlerCommands,
  extractDsh1Section,
  extractDocRows,
  extractDocGrants,
  extractEmitSites,
  extractMockCommands,
  evaluateCommandSurface,
  auditTree,
} from '../../../../scripts/check-command-surface.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');

/** A consistent synthetic surface every invariant accepts. */
function makeSurface(overrides = {}) {
  return {
    commandFns: ['start_capture', 'stop_capture'],
    handlerCommands: ['start_capture', 'stop_capture'],
    handlerOccurrences: 1,
    docCommands: ['start_capture', 'stop_capture'],
    docEvents: [EVENT_CHANNEL],
    emitSites: [{ path: 'src/lib.rs', channel: EVENT_CHANNEL, line: 90 }],
    fileGrants: ['core:default', 'dialog:allow-open'],
    docGrants: ['core:default', 'dialog:allow-open'],
    mockCommands: ['start_capture', 'stop_capture'],
    ...overrides,
  };
}

describe('evaluateCommandSurface — compliant baseline', () => {
  it('returns no problems when every surface agrees', () => {
    assert.deepEqual(evaluateCommandSurface(makeSurface()), []);
  });
});

describe('evaluateCommandSurface — command-set equality (both ways, each pair)', () => {
  it('fires when a command function is not registered in generate_handler!', () => {
    const problems = evaluateCommandSurface(
      makeSurface({ handlerCommands: ['start_capture'], docCommands: ['start_capture', 'stop_capture'] }), // prettier-ignore
    );
    assert.ok(problems.some((p) => p.includes('stop_capture') && p.includes('not registered')));
  });

  it('fires when generate_handler! registers a function that does not exist', () => {
    const problems = evaluateCommandSurface(
      makeSurface({ handlerCommands: ['start_capture', 'stop_capture', 'ghost_command'] }),
    );
    assert.ok(
      problems.some((p) => p.includes('ghost_command') && p.includes('no #[tauri::command]')),
    );
  });

  it('fires when a command function has no doc-table row', () => {
    const problems = evaluateCommandSurface(makeSurface({ docCommands: ['start_capture'] }));
    assert.ok(
      problems.some((p) => p.includes('stop_capture') && p.includes('no row in the DSH-1 table')),
    );
  });

  it('fires when the doc table carries a row for a command the crate lost', () => {
    const problems = evaluateCommandSurface(
      makeSurface({ docCommands: ['start_capture', 'stop_capture', 'get_self_pid'] }),
    );
    assert.ok(
      problems.some((p) => p.includes('get_self_pid') && p.includes('no #[tauri::command]')),
    );
  });

  it('fires when the mock services fewer commands than the crate defines', () => {
    const problems = evaluateCommandSurface(makeSurface({ mockCommands: ['start_capture'] }));
    assert.ok(
      problems.some((p) => p.includes('stop_capture') && p.includes('integration mock services no such command')), // prettier-ignore
    );
  });

  it('fires when the mock services a command the crate does not define', () => {
    const problems = evaluateCommandSurface(
      makeSurface({ mockCommands: ['start_capture', 'stop_capture', 'check_permissions'] }),
    );
    assert.ok(
      problems.some((p) => p.includes('check_permissions') && p.includes('serviced by the integration mock')), // prettier-ignore
    );
  });

  it('fires on a duplicate doc-table row', () => {
    const problems = evaluateCommandSurface(
      makeSurface({ docCommands: ['start_capture', 'stop_capture', 'start_capture'] }),
    );
    assert.ok(problems.some((p) => p.includes('start_capture') && p.includes('more than once')));
  });
});

describe('evaluateCommandSurface — the one event channel', () => {
  it('fires when the doc states a second event row', () => {
    const problems = evaluateCommandSurface(
      makeSurface({ docEvents: [EVENT_CHANNEL, 'capture:status'] }),
    );
    assert.ok(problems.some((p) => p.includes('capture:status')));
    assert.ok(problems.some((p) => p.includes('exactly one event channel')));
  });

  it('fires when the crate has two emit sites for the channel', () => {
    const problems = evaluateCommandSurface(
      makeSurface({
        emitSites: [
          { path: 'src/lib.rs', channel: EVENT_CHANNEL, line: 90 },
          { path: 'src/commands.rs', channel: EVENT_CHANNEL, line: 12 },
        ],
      }),
    );
    assert.ok(problems.some((p) => p.includes('found 2') && p.includes('src/commands.rs:12')));
  });

  it('fires when the crate has no emit site at all', () => {
    const problems = evaluateCommandSurface(makeSurface({ emitSites: [] }));
    assert.ok(problems.some((p) => p.includes('found 0')));
  });

  it('fires when something emits on another channel', () => {
    const problems = evaluateCommandSurface(
      makeSurface({
        emitSites: [
          { path: 'src/lib.rs', channel: EVENT_CHANNEL, line: 90 },
          { path: 'src/lib.rs', channel: 'other:channel', line: 120 },
        ],
      }),
    );
    assert.ok(problems.some((p) => p.includes('other:channel') && p.includes('src/lib.rs:120')));
  });
});

describe('evaluateCommandSurface — capability grants', () => {
  it('fires when the capability file grants something the doc does not name', () => {
    const problems = evaluateCommandSurface(
      makeSurface({ fileGrants: ['core:default', 'dialog:allow-open', 'fs:allow-write'] }),
    );
    assert.ok(problems.some((p) => p.includes('fs:allow-write') && p.includes('does not name it')));
  });

  it('fires when the doc names a grant the capability file does not carry', () => {
    const problems = evaluateCommandSurface(
      makeSurface({ docGrants: ['core:default', 'dialog:allow-open', 'dialog:allow-save'] }),
    );
    assert.ok(
      problems.some((p) => p.includes('dialog:allow-save') && p.includes('does not grant it')),
    );
  });
});

describe('evaluateCommandSurface — empty parses are structural failures', () => {
  for (const [key, needle] of [
    ['commandFns', 'no #[tauri::command] functions'],
    ['handlerCommands', 'no generate_handler! registrations'],
    ['docCommands', 'no command rows'],
    ['docEvents', 'no event row'],
    ['fileGrants', 'no permissions'],
    ['docGrants', 'no grant identifiers'],
    ['mockCommands', 'no CANONICAL_COMMANDS entries'],
  ]) {
    it(`fires when ${key} parses empty`, () => {
      const problems = evaluateCommandSurface(makeSurface({ [key]: [] }));
      assert.ok(
        problems.some((p) => p.includes(needle)),
        problems.join('\n'),
      );
    });
  }
});

describe('stripRustComments — the emit scan cannot count comment mentions', () => {
  it('blanks line and doc comments but keeps code, offsets, and newlines', () => {
    const src =
      '/// emits via app.emit("capture:action", e)\nlet x = 1; // .emit("capture:action")\n';
    const stripped = stripRustComments(src);
    assert.ok(!stripped.includes('emit'), 'comment text must be blanked');
    assert.ok(stripped.includes('let x = 1;'), 'code must survive');
    assert.equal(stripped.length, src.length, 'offsets must be preserved');
    assert.equal(stripped.split('\n').length, src.split('\n').length);
  });

  it('blanks nested block comments', () => {
    const stripped = stripRustComments('/* outer /* inner */ still comment */ fn live() {}');
    assert.ok(!stripped.includes('inner'));
    assert.ok(stripped.includes('fn live()'));
  });

  it('keeps comment markers inside string and raw-string literals', () => {
    const src = 'let a = "https://example.test"; let b = r#"// not a comment"#; let c = 1; // gone';
    const stripped = stripRustComments(src);
    assert.ok(stripped.includes('"https://example.test"'));
    assert.ok(stripped.includes('// not a comment'));
    assert.ok(!stripped.includes('gone'));
  });

  it('emit sites in doc comments are not counted; the real one is', () => {
    const src = [
      '/// Streams via `app.emit("capture:action", event)`.',
      'fn forward(handle: H, event: E) {',
      '    // handle.emit("capture:action", &event) is called below.',
      '    let _ = handle.emit("capture:action", &event);',
      '}',
    ].join('\n');
    const sites = extractEmitSites(new Map([['src/lib.rs', stripRustComments(src)]]));
    assert.equal(sites.length, 1);
    assert.deepEqual(sites[0], { path: 'src/lib.rs', channel: 'capture:action', line: 4 });
  });
});

describe('extractCommandFns / extractHandlerCommands', () => {
  it('reads pub, pub(crate), and async command forms', () => {
    const src = [
      '#[tauri::command]',
      'pub fn plain_cmd() {}',
      '#[tauri::command]',
      'pub(crate) fn crate_cmd() {}',
      '#[tauri::command]',
      'pub async fn async_cmd() {}',
      '#[tauri::command]',
      'fn private_cmd() {}',
      'fn not_a_command() {}',
    ].join('\n');
    assert.deepEqual(extractCommandFns(stripRustComments(src)), [
      'plain_cmd',
      'crate_cmd',
      'async_cmd',
      'private_cmd',
    ]);
  });

  it('takes the last path segment of each registration and reports the list count', () => {
    const src = 'generate_handler![commands::start_capture, sync_http::sync_http_request,]';
    assert.deepEqual(extractHandlerCommands(src), {
      commands: ['start_capture', 'sync_http_request'],
      occurrences: 1,
    });
  });

  it('reports zero occurrences on a source with no registration', () => {
    assert.deepEqual(extractHandlerCommands('fn run() {}'), { commands: [], occurrences: 0 });
  });
});

describe('extractDsh1Section / extractDocRows / extractDocGrants', () => {
  const doc = [
    '## The Command Surface',
    '',
    '**DSH-1.** The table below is the complete contract.',
    '',
    '| Name | Direction | What it does | Who calls it |',
    '| ---- | --------- | ------------ | ------------ |',
    '| `start_capture` | JS → Rust | Starts. | `panel.js`. |',
    '| `capture:action` (event) | Rust → JS | Streams. | The adapter. |',
    '',
    'The webview can also invoke the `core:default` set and `dialog:allow-open`;',
    'the `capture:action` channel itself is no grant.',
    '',
    '## Session Persistence',
    '',
    'Text naming `dialog:allow-save` outside the clause scope.',
  ].join('\n');

  it('scopes to the clause: marker to the next heading', () => {
    const section = extractDsh1Section(doc);
    assert.ok(section.includes('start_capture'));
    assert.ok(!section.includes('Session Persistence'));
  });

  it('splits command rows from the event row and skips header rows', () => {
    assert.deepEqual(extractDocRows(extractDsh1Section(doc)), {
      commands: ['start_capture'],
      events: ['capture:action'],
    });
  });

  it('reads only grant-shaped backticked tokens — the event channel is not a grant', () => {
    assert.deepEqual(extractDocGrants(extractDsh1Section(doc)), [
      'core:default',
      'dialog:allow-open',
    ]);
  });

  it('returns an empty section when the marker is absent', () => {
    assert.equal(extractDsh1Section('# No clause here'), '');
  });
});

describe('extractMockCommands', () => {
  it('parses the CANONICAL_COMMANDS array literal', () => {
    const src = "const CANONICAL_COMMANDS = [\n  'load_state',\n  'save_state',\n];";
    assert.deepEqual(extractMockCommands(src), ['load_state', 'save_state']);
  });

  it('returns empty when the list is absent', () => {
    assert.deepEqual(extractMockCommands('const OTHER = 1;'), []);
  });
});

describe('real-tree lock', () => {
  it('the shipped tree satisfies the whole contract', () => {
    const rustFiles = execFileSync('git', ['ls-files', SRC_DIR], { encoding: 'utf8', cwd: ROOT })
      .split('\n')
      .map((s) => s.trim())
      .filter((f) => f.endsWith('.rs'));
    assert.ok(rustFiles.includes(LIB_PATH), 'the crate entry point must be among the sources');
    const { problems, commandCount } = auditTree(
      (f) => readFileSync(resolve(ROOT, f), 'utf8'),
      rustFiles,
    );
    assert.deepEqual(problems, [], problems.join('\n'));
    assert.ok(commandCount > 0);
    // The lock also proves the check reads the real surfaces it names.
    for (const p of [DOC_PATH, CAPABILITIES_PATH, MOCK_PATH]) {
      assert.doesNotThrow(() => readFileSync(resolve(ROOT, p)));
    }
  });
});
