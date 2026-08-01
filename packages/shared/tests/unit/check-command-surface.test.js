/**
 * check-command-surface.test.js — Unit tests for the desktop command-surface
 * admission test (scripts/check-command-surface.js). The command surface is a
 * committed contract (application-shell.md §DSH-1), so every way it can rot
 * must fail loud: these tests prove each red-path family fires on synthetic
 * input — the pairwise set inequalities across every surface the check
 * compares, the emit-family and channel arms, the capability-source and
 * fixture-shape refusals, unreadable rows and cells, duplicate structures,
 * and empty parses — that the Rust comment stripper and the fence stripper
 * keep comments, literals, and fenced examples out of the scans, and — as a
 * real-tree lock — that the shipped tree satisfies the whole contract.
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
  CAPABILITIES_DIR,
  TAURI_CONF_PATH,
  MOCK_PATH,
  EVENT_CHANNEL,
  EMPTY_SURFACES,
  DUPLICATE_SURFACES,
  stripRustComments,
  extractCommandFns,
  extractHandlerCommands,
  extractDsh1Section,
  extractDocRows,
  extractDocGrants,
  extractEmitSites,
  extractMockCommands,
  extractMockServicedCases,
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
    emitSites: [{ path: 'src/lib.rs', method: 'emit', channel: EVENT_CHANNEL, line: 90 }],
    fileGrants: ['core:default', 'dialog:allow-open'],
    docGrants: ['core:default', 'dialog:allow-open'],
    mockCommands: ['start_capture', 'stop_capture'],
    mockCases: ['start_capture', 'stop_capture'],
    docUnreadableRows: [],
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

  it('fires when the mock list carries fewer commands than the crate defines', () => {
    const problems = evaluateCommandSurface(makeSurface({ mockCommands: ['start_capture'] }));
    assert.ok(
      problems.some((p) => p.includes('stop_capture') && p.includes("CANONICAL_COMMANDS list does not carry it")), // prettier-ignore
    );
  });

  it('fires when the mock list carries a command the crate does not define', () => {
    const problems = evaluateCommandSurface(
      makeSurface({ mockCommands: ['start_capture', 'stop_capture', 'check_permissions'] }),
    );
    assert.ok(
      problems.some((p) => p.includes('check_permissions') && p.includes("CANONICAL_COMMANDS list but no #[tauri::command]")), // prettier-ignore
    );
  });

  it('fires when the mock invoke switch has no case for a crate command', () => {
    const problems = evaluateCommandSurface(makeSurface({ mockCases: ['start_capture'] }));
    assert.ok(
      problems.some((p) => p.includes('stop_capture') && p.includes('no case servicing it')),
    );
  });

  it('fires when the mock invoke switch services a command the crate does not define', () => {
    const problems = evaluateCommandSurface(
      makeSurface({ mockCases: ['start_capture', 'stop_capture', 'get_self_pid'] }),
    );
    assert.ok(
      problems.some((p) => p.includes('get_self_pid') && p.includes("serviced by the mock's invoke switch")), // prettier-ignore
    );
  });
});

// Fixture rows for the duplicates family, keyed to the check's own exported
// DUPLICATE_SURFACES list. The lock below holds the two key sets equal, so a
// surface added to the check's loop without a fixture row reds here — the
// addition direction the per-leg tests alone cannot see.
const DUPLICATE_FIXTURES = {
  commandFns: ['start_capture', 'stop_capture', 'start_capture'],
  handlerCommands: ['start_capture', 'stop_capture', 'start_capture'],
  docCommands: ['start_capture', 'stop_capture', 'start_capture'],
  mockCommands: ['start_capture', 'stop_capture', 'start_capture'],
  mockCases: ['start_capture', 'stop_capture', 'start_capture'],
};

describe('evaluateCommandSurface — duplicates, every leg of the duplicates loop', () => {
  it('the fixture table covers exactly the check’s duplicates legs (addition lock)', () => {
    assert.deepEqual(
      Object.keys(DUPLICATE_FIXTURES).sort(),
      DUPLICATE_SURFACES.map(([key]) => key).sort(),
    );
  });

  for (const [key, what] of DUPLICATE_SURFACES) {
    it(`fires on a duplicated name in ${what} — a leg the set diffs cannot see`, () => {
      const problems = evaluateCommandSurface(makeSurface({ [key]: DUPLICATE_FIXTURES[key] }));
      assert.ok(
        problems.some((p) => p.includes('more than once') && p.includes(what)),
        problems.join('\n') || `no duplicates diagnostic for ${what}`,
      );
    });
  }
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
          { path: 'src/lib.rs', method: 'emit', channel: EVENT_CHANNEL, line: 90 },
          { path: 'src/commands.rs', method: 'emit_to', channel: EVENT_CHANNEL, line: 12 },
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
          { path: 'src/lib.rs', method: 'emit', channel: EVENT_CHANNEL, line: 90 },
          { path: 'src/lib.rs', method: 'emit_filter', channel: 'other:channel', line: 120 },
        ],
      }),
    );
    assert.ok(problems.some((p) => p.includes('other:channel') && p.includes('src/lib.rs:120')));
  });

  it('fires when an emit-family call carries a channel the scan cannot read', () => {
    const problems = evaluateCommandSurface(
      makeSurface({
        emitSites: [
          { path: 'src/lib.rs', method: 'emit', channel: EVENT_CHANNEL, line: 90 },
          { path: 'src/lib.rs', method: 'emit_to', channel: null, line: 130 },
        ],
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('src/lib.rs:130') && p.includes('target/channel argument pair the scan cannot read')), // prettier-ignore
    );
  });

  it('fires when the crate carries two generate_handler! lists', () => {
    const problems = evaluateCommandSurface(makeSurface({ handlerOccurrences: 2 }));
    assert.ok(problems.some((p) => p.includes('2 generate_handler! lists')));
  });
});

describe('evaluateCommandSurface — capability grants', () => {
  it('fires when the capability file grants something the doc does not name', () => {
    const problems = evaluateCommandSurface(
      makeSurface({ fileGrants: ['core:default', 'dialog:allow-open', 'fs:allow-write'] }),
    );
    assert.ok(problems.some((p) => p.includes('fs:allow-write') && p.includes('does not name it')));
  });

  it('fires when the doc names a grant no capability file carries', () => {
    const problems = evaluateCommandSurface(
      makeSurface({ docGrants: ['core:default', 'dialog:allow-open', 'dialog:allow-save'] }),
    );
    assert.ok(
      problems.some((p) => p.includes('dialog:allow-save') && p.includes('no tracked capability file grants it')), // prettier-ignore
    );
  });
});

describe('evaluateCommandSurface — empty parses are structural failures', () => {
  it('every leg of the check’s non-empty guard fires (addition lock: driven by its export)', () => {
    assert.ok(EMPTY_SURFACES.length > 0);
  });

  for (const [key, message] of EMPTY_SURFACES) {
    it(`fires when ${key} parses empty`, () => {
      const problems = evaluateCommandSurface(makeSurface({ [key]: [] }));
      assert.ok(
        problems.some((p) => p.includes(message)),
        problems.join('\n') || `no vacuous diagnostic for ${key}`,
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
    assert.deepEqual(sites[0], {
      path: 'src/lib.rs',
      method: 'emit',
      channel: 'capture:action',
      line: 4,
    });
  });

  it('a raw identifier (r#type) does not desynchronize the scan', () => {
    const src = 'let r#type = 1; // gone\nlet _ = h.emit("capture:action", &e);';
    const stripped = stripRustComments(src);
    assert.ok(!stripped.includes('gone'));
    assert.equal(extractEmitSites(new Map([['a.rs', stripped]])).length, 1);
  });
});

describe('extractEmitSites — the emit family', () => {
  it('reads the channel from the right argument for every Emitter emit method', () => {
    const src = [
      'h.emit("capture:action", &e);',
      'h.emit_str("capture:action", s);',
      'h.emit_to("main", "capture:action", &e);',
      'h.emit_str_to("main", "capture:action", s);',
      'h.emit_filter("capture:action", &e, |t| true);',
      'h.emit_str_filter("capture:action", s, |t| true);',
    ].join('\n');
    const sites = extractEmitSites(new Map([['a.rs', src]]));
    assert.deepEqual(
      sites.map((s) => [s.method, s.channel]),
      [
        ['emit', 'capture:action'],
        ['emit_str', 'capture:action'],
        ['emit_to', 'capture:action'],
        ['emit_str_to', 'capture:action'],
        ['emit_filter', 'capture:action'],
        ['emit_str_filter', 'capture:action'],
      ],
    );
  });

  it('records a null channel when the argument is not a string literal', () => {
    const sites = extractEmitSites(new Map([['a.rs', 'h.emit(channel_name, &e);']]));
    assert.deepEqual(
      sites.map((s) => [s.method, s.channel]),
      [['emit', null]],
    );
  });

  it('a char literal cannot open a phantom string that hides or invents a site', () => {
    const src = [
      "fn q() -> char { '\"' }",
      '/// doc: handle.emit("capture:action", &e)',
      'fn forward(h: H, e: E) { let _ = h.emit("capture:action", &e); }',
    ].join('\n');
    const sites = extractEmitSites(new Map([['a.rs', stripRustComments(src)]]));
    assert.equal(sites.length, 1);
    assert.equal(sites[0].line, 3);
  });

  it('a lifetime tick is not read as a char literal', () => {
    const src = "fn f<'a>(x: &'a str) {} // gone";
    const stripped = stripRustComments(src);
    assert.ok(stripped.includes("&'a str"));
    assert.ok(!stripped.includes('gone'));
  });
});

describe('extractCommandFns / extractHandlerCommands', () => {
  it('reads pub, pub(crate), async, and attribute-argument command forms', () => {
    const src = [
      '#[tauri::command]',
      'pub fn plain_cmd() {}',
      '#[tauri::command]',
      'pub(crate) fn crate_cmd() {}',
      '#[tauri::command]',
      'pub async fn async_cmd() {}',
      '#[tauri::command(rename_all = "snake_case")]',
      'pub fn renamed_cmd() {}',
      '#[tauri::command]',
      'fn private_cmd() {}',
      'fn not_a_command() {}',
    ].join('\n');
    assert.deepEqual(extractCommandFns(stripRustComments(src)), [
      'plain_cmd',
      'crate_cmd',
      'async_cmd',
      'renamed_cmd',
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
      unreadable: [],
    });
  });

  it('an annotated, un-backticked, or empty first cell is unreadable, never silently skipped', () => {
    const table = [
      '| Name | D |',
      '| ---- | - |',
      '| `start_capture` | a |',
      '| `capture:status` (event, internal) | a |',
      '| check_permissions | a |',
      '|  | a |',
    ].join('\n');
    const rows = extractDocRows(table);
    assert.deepEqual(rows.commands, ['start_capture']);
    assert.deepEqual(rows.unreadable, [
      '`capture:status` (event, internal)',
      'check_permissions',
      '(empty first cell)',
    ]);
    const problems = evaluateCommandSurface(makeSurface({ docUnreadableRows: rows.unreadable }));
    assert.ok(problems.some((p) => p.includes('cannot read') && p.includes('capture:status')));
    // Pins the delimiters too: the cell is set off by em dashes, so the
    // stand-in renders as its own parentheses, never doubled ones.
    assert.ok(problems.some((p) => p.includes('read — (empty first cell) — rows')));
  });

  it('a tilde fence hides its content like a backtick fence', () => {
    const doc = [
      '**DSH-1.** The contract with `core:default`.',
      '~~~',
      'fenced `fs:allow-write`',
      '~~~',
      'after the fence',
    ].join('\n');
    const section = extractDsh1Section(doc);
    assert.ok(section.includes('after the fence'), 'the tilde fence must not truncate');
    assert.deepEqual(extractDocGrants(section), ['core:default']);
  });

  it('reads only grant-shaped backticked tokens — the event channel is not a grant', () => {
    assert.deepEqual(extractDocGrants(extractDsh1Section(doc)), [
      'core:default',
      'dialog:allow-open',
    ]);
  });

  it('accepts namespaced grant identifiers', () => {
    const section = 'section with `core:event:allow-listen` and `capture:action` in it';
    assert.deepEqual(extractDocGrants(section), ['core:event:allow-listen']);
  });

  it('fenced examples are neither table rows nor grants nor scope boundaries', () => {
    const fenced = [
      '**DSH-1.** The contract.',
      '',
      '| Name | D | W | C |',
      '| ---- | - | - | - |',
      '| `start_capture` | a | b | c |',
      '',
      'Grants: `core:default`. An illustrative example:',
      '',
      '```markdown',
      '| `example_cmd` | a | b | c |',
      'a fenced grant `fs:allow-write` and a fenced marker **DSH-9.**',
      '## a fenced heading',
      '```',
      '',
      'More prose after the fence.',
      '',
      '## Next Section',
    ].join('\n');
    const section = extractDsh1Section(fenced);
    assert.ok(section.includes('More prose after the fence'), 'the fence must not truncate');
    assert.deepEqual(extractDocRows(section).commands, ['start_capture']);
    assert.deepEqual(extractDocGrants(section), ['core:default']);
  });

  it('the clause scope ends at the next clause marker, not only at a heading', () => {
    const twoClauses = [
      '**DSH-1.** The contract.',
      '',
      '| Name | D | W | C |',
      '| ---- | - | - | - |',
      '| `start_capture` | a | b | c |',
      '',
      'Grants: `core:default`.',
      '',
      '**DSH-9.** Another clause naming `fs:allow-write` and a table:',
      '',
      '| `ghost_cmd` | a | b | c |',
    ].join('\n');
    const section = extractDsh1Section(twoClauses);
    assert.deepEqual(extractDocRows(section).commands, ['start_capture']);
    assert.deepEqual(extractDocGrants(section), ['core:default']);
  });

  it('returns an empty section when the marker is absent', () => {
    assert.equal(extractDsh1Section('# No clause here'), '');
  });
});

describe('auditTree — synthetic tree', () => {
  const DOC = [
    '## The Command Surface',
    '',
    '**DSH-1.** The contract.',
    '',
    '| Name | D | W | C |',
    '| ---- | - | - | - |',
    '| `start_capture` | a | b | c |',
    '| `capture:action` (event) | a | b | c |',
    '',
    'Grants: `core:default` and `fs:allow-read`.',
    '',
    '## Next',
  ].join('\n');
  const LIB = [
    '#[tauri::command]',
    'pub fn start_capture() {}',
    'fn run() { h.emit("capture:action", &e); }',
    'generate_handler![start_capture]',
  ].join('\n');
  const MOCK = [
    "const CANONICAL_COMMANDS = ['start_capture'];",
    'switch (cmd) {',
    "  case 'start_capture': return;",
    '  default:',
    '    throw new Error("nope");',
    '}',
  ].join('\n');

  /** A readFile over a synthetic file map, with the crate source at LIB_PATH. */
  function treeReader(capabilities) {
    return (f) => {
      if (f === DOC_PATH) return DOC;
      if (f === LIB_PATH) return LIB;
      if (f === MOCK_PATH) return MOCK;
      if (f === TAURI_CONF_PATH) return '{}';
      return capabilities[f] ?? '';
    };
  }

  it('unions grants across capability files and accepts the object entry form', () => {
    const caps = {
      'caps/default.json': JSON.stringify({ permissions: ['core:default'] }),
      'caps/extra.json': JSON.stringify({ permissions: [{ identifier: 'fs:allow-read' }] }),
    };
    const { problems, grantCount } = auditTree(treeReader(caps), [LIB_PATH], Object.keys(caps));
    assert.deepEqual(problems, [], problems.join('\n'));
    assert.equal(grantCount, 2);
  });

  it('reports an unparseable capability file as a problem, not a thrown stack', () => {
    const caps = { 'caps/default.json': 'not json' };
    const { problems } = auditTree(treeReader(caps), [LIB_PATH], Object.keys(caps));
    assert.ok(
      problems.some((p) => p.includes('caps/default.json') && p.includes('does not parse as JSON')), // prettier-ignore
    );
  });

  it('reports a permissions entry of an unknown shape', () => {
    const caps = { 'caps/default.json': JSON.stringify({ permissions: ['core:default', 42] }) };
    const { problems } = auditTree(treeReader(caps), [LIB_PATH], Object.keys(caps));
    assert.ok(problems.some((p) => p.includes('cannot read') && p.includes('42')));
  });

  it('refuses a capability file in a format the scan does not read', () => {
    const caps = {
      'caps/default.json': JSON.stringify({ permissions: ['core:default', 'fs:allow-read'] }),
      'caps/extra.toml': 'permissions = ["fs:allow-write"]',
    };
    const { problems } = auditTree(treeReader(caps), [LIB_PATH], Object.keys(caps));
    assert.ok(
      problems.some((p) => p.includes('caps/extra.toml') && p.includes('format the scan does not read')), // prettier-ignore
    );
  });

  it('refuses capabilities inlined in tauri.conf.json', () => {
    const caps = {
      'caps/default.json': JSON.stringify({ permissions: ['core:default', 'fs:allow-read'] }),
    };
    const readFile = (f) => {
      if (f === TAURI_CONF_PATH) {
        return JSON.stringify({ app: { security: { capabilities: [{ permissions: ['x:default'] }] } } }); // prettier-ignore
      }
      return treeReader(caps)(f);
    };
    const { problems } = auditTree(readFile, [LIB_PATH], Object.keys(caps));
    assert.ok(problems.some((p) => p.includes('inlines capabilities')));
  });

  it('refuses a fixture carrying a second switch (cmd) block', () => {
    const caps = {
      'caps/default.json': JSON.stringify({ permissions: ['core:default', 'fs:allow-read'] }),
    };
    const twoSwitches = `${MOCK}\nswitch (cmd) { default: break; }`;
    const readFile = (f) => (f === MOCK_PATH ? twoSwitches : treeReader(caps)(f));
    const { problems } = auditTree(readFile, [LIB_PATH], Object.keys(caps));
    assert.ok(problems.some((p) => p.includes('2 `switch (cmd)` blocks')));
  });
});

describe('extractMockCommands / extractMockServicedCases', () => {
  it('parses the CANONICAL_COMMANDS array literal', () => {
    const src = "const CANONICAL_COMMANDS = [\n  'load_state',\n  'save_state',\n];";
    assert.deepEqual(extractMockCommands(src), {
      commands: ['load_state', 'save_state'],
      error: null,
    });
  });

  it('errors when the list is absent', () => {
    const read = extractMockCommands('const OTHER = 1;');
    assert.deepEqual(read.commands, []);
    assert.match(read.error, /no `CANONICAL_COMMANDS/);
  });

  it('errors loudly on an element form it does not model — never a silent partial read', () => {
    const src = "const CANONICAL_COMMANDS = [\n  'a',\n  ...EXTRA,\n];\nconst EXTRA = ['b'];";
    const read = extractMockCommands(src);
    assert.deepEqual(read.commands, []);
    assert.match(read.error, /does not model/);
  });

  it('reads the serviced case labels out of the injected script template', () => {
    const src = [
      'switch (cmd) {',
      "          case 'load_state': return _savedState;",
      "          case 'save_state': _savedState = args.data; return;",
      '          default:',
      '            throw new Error("nope");',
      '        }',
    ].join('\n');
    assert.deepEqual(extractMockServicedCases(src), ['load_state', 'save_state']);
  });
});

describe('real-tree lock', () => {
  it('the shipped tree satisfies the whole contract', () => {
    const lsFiles = (dir) =>
      execFileSync('git', ['ls-files', dir], { encoding: 'utf8', cwd: ROOT })
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    const rustFiles = lsFiles(SRC_DIR).filter((f) => f.endsWith('.rs'));
    // The same unfiltered input set the CLI wrapper passes, so the
    // format-refusal branch stays locked against the real tree.
    const capabilityFiles = lsFiles(CAPABILITIES_DIR);
    assert.ok(rustFiles.includes(LIB_PATH), 'the crate entry point must be among the sources');
    assert.ok(
      capabilityFiles.length >= 1,
      'at least one file must be tracked under the capability directory',
    );
    const { problems, commandCount } = auditTree(
      (f) => readFileSync(resolve(ROOT, f), 'utf8'),
      rustFiles,
      capabilityFiles,
    );
    assert.deepEqual(problems, [], problems.join('\n'));
    assert.ok(commandCount > 0);
    // The lock also proves the check reads the real surfaces it names.
    for (const p of [DOC_PATH, MOCK_PATH]) {
      assert.doesNotThrow(() => readFileSync(resolve(ROOT, p)));
    }
  });
});
