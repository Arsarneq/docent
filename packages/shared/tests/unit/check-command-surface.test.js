/**
 * check-command-surface.test.js — Unit tests for the desktop command-surface
 * admission test (scripts/check-command-surface.js). The command surface is a
 * committed contract (application-shell.md §DSH-1), so every way it can rot
 * must fail loud: these tests prove each red-path family fires on synthetic
 * input — the pairwise set inequalities across every surface the check
 * compares, the emit-family and channel arms, the caller-side invoke arms,
 * the derived event channel's emit / listen / clause-prose sides, the
 * capability-source and fixture-shape refusals, unreadable rows and cells,
 * duplicate structures, and empty parses — that the Rust comment stripper, the
 * shared JavaScript tokenizer the caller scans read through, and the fence
 * stripper keep comments, literals, and fenced examples out of the scans, and
 * — as a real-tree lock — that the shipped tree satisfies the whole contract.
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
  FRONTEND_DIR,
  EMPTY_SURFACES,
  DUPLICATE_SURFACES,
  stripRustComments,
  extractCommandFns,
  extractHandlerCommands,
  extractDsh1Section,
  extractDocRows,
  extractDocGrants,
  extractSectionProse,
  extractEmitSites,
  extractCallSites,
  extractMockCommands,
  extractMockServicedCases,
  evaluateCommandSurface,
  auditTree,
} from '../../../../scripts/check-command-surface.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');

/**
 * The channel the synthetic surfaces agree on. Spelled out here rather than
 * imported: the check derives the channel from the doc's event row, so the
 * fixtures state it the same way a document does.
 */
const CHANNEL = 'capture:action';
/** A frontend path inside the scanned surface. */
const CALLER_PATH = `${FRONTEND_DIR}/panel.js`;
/**
 * The bridge module — inside the scanned surface like any other file. It is
 * named here only because its `function invoke(…)` declarations are the live
 * instance of the shape the scan skips; the check itself knows no paths.
 */
const BRIDGE_PATH = `${FRONTEND_DIR}/tauri-bridge.js`;

/** A consistent synthetic surface every invariant accepts. */
function makeSurface(overrides = {}) {
  return {
    commandFns: ['start_capture', 'stop_capture'],
    handlerCommands: ['start_capture', 'stop_capture'],
    handlerOccurrences: 1,
    docCommands: ['start_capture', 'stop_capture'],
    docEvents: [CHANNEL],
    emitSites: [{ path: 'src/lib.rs', method: 'emit', channel: CHANNEL, line: 90 }],
    fileGrants: ['core:default', 'dialog:allow-open'],
    docGrants: ['core:default', 'dialog:allow-open'],
    mockCommands: ['start_capture', 'stop_capture'],
    mockCases: ['start_capture', 'stop_capture'],
    docUnreadableRows: [],
    sectionProse: `The \`${CHANNEL}\` channel is consumed by one listener.`,
    invokeLiterals: ['start_capture', 'stop_capture'],
    invokeSites: [
      { path: CALLER_PATH, ordinal: 1, name: 'start_capture', argToken: 'start_capture' },
      { path: CALLER_PATH, ordinal: 2, name: 'stop_capture', argToken: 'stop_capture' },
    ],
    listenSites: [{ path: CALLER_PATH, ordinal: 1, name: CHANNEL, argToken: CHANNEL }],
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

describe('evaluateCommandSurface — the caller side (both ways)', () => {
  it('fires when a crate command no invoke literal names — the caller closure', () => {
    const problems = evaluateCommandSurface(
      makeSurface({
        invokeLiterals: ['start_capture'],
        invokeSites: [
          { path: CALLER_PATH, ordinal: 1, name: 'start_capture', argToken: 'start_capture' },
        ],
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('stop_capture') && p.includes('no invoke( call site')),
      problems.join('\n') || 'no caller-closure diagnostic',
    );
  });

  it('fires when an invoke literal names no crate command — the direct-invoke closure', () => {
    const problems = evaluateCommandSurface(
      makeSurface({
        invokeLiterals: ['start_capture', 'stop_capture', 'plugin:dialog|open'],
        invokeSites: [
          ...makeSurface().invokeSites,
          { path: CALLER_PATH, ordinal: 3, name: 'plugin:dialog|open', argToken: 'plugin:dialog|open' }, // prettier-ignore
        ],
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('plugin:dialog|open') && p.includes('is invoked from the frontend')), // prettier-ignore
    );
    // The red says what to do about it rather than only that it fired: a
    // granted plugin command invoked directly is a contract change.
    assert.ok(problems.some((p) => p.includes('contract change that extends the DSH-1 clause')));
  });

  it('refuses an invoke call site whose command name is not a string literal, naming the site', () => {
    const problems = evaluateCommandSurface(
      makeSurface({
        invokeSites: [
          ...makeSurface().invokeSites,
          { path: CALLER_PATH, ordinal: 3, name: null, argToken: 'commandName' },
        ],
      }),
    );
    assert.ok(
      problems.some((p) => p.includes(`${CALLER_PATH} (invoke( call site 3)`) && p.includes('commandName')), // prettier-ignore
      problems.join('\n') || 'no invoke refusal',
    );
  });

  it('refuses a concatenated invoke argument — the literal is not credited with the command', () => {
    // The hole the follower guard closes: `invoke('load_state' + suffix)` was
    // read as a call of `load_state`, so a computed command name greened the
    // caller closure on a command it never invokes.
    const sites = extractCallSites(
      new Map([[CALLER_PATH, "await invoke('load_state' + suffix);"]]),
      'invoke',
    );
    assert.deepEqual(sites, [
      { path: CALLER_PATH, ordinal: 1, name: null, argToken: 'load_state +' },
    ]);
    const problems = evaluateCommandSurface(
      makeSurface({ invokeSites: [...makeSurface().invokeSites, { ...sites[0], ordinal: 3 }] }),
    );
    assert.ok(
      problems.some((p) => p.includes(`${CALLER_PATH} (invoke( call site 3)`) && p.includes('load_state +')), // prettier-ignore
      problems.join('\n') || 'no concatenated-invoke refusal',
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

  it('the surface labels are pairwise distinct — a copied leg cannot hide behind its neighbour', () => {
    assert.ok(DUPLICATE_SURFACES.length > 0);
    const labels = DUPLICATE_SURFACES.map(([, what]) => what);
    assert.equal(new Set(labels).size, labels.length);
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
      makeSurface({ docEvents: [CHANNEL, 'capture:status'] }),
    );
    assert.ok(problems.some((p) => p.includes('capture:status')));
    assert.ok(problems.some((p) => p.includes('exactly one event channel')));
  });

  it('fires when the crate has two emit sites for the channel', () => {
    const problems = evaluateCommandSurface(
      makeSurface({
        emitSites: [
          { path: 'src/lib.rs', method: 'emit', channel: CHANNEL, line: 90 },
          { path: 'src/commands.rs', method: 'emit_to', channel: CHANNEL, line: 12 },
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
          { path: 'src/lib.rs', method: 'emit', channel: CHANNEL, line: 90 },
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
          { path: 'src/lib.rs', method: 'emit', channel: CHANNEL, line: 90 },
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

describe('evaluateCommandSurface — the channel the doc row derives', () => {
  const RENAMED = 'capture:event';

  it('fires when the doc row is renamed alone', () => {
    const problems = evaluateCommandSurface(makeSurface({ docEvents: [RENAMED] }));
    assert.ok(problems.some((p) => p.includes(`expected exactly one \`${RENAMED}\` emit site`)));
    assert.ok(
      problems.some((p) => p.includes(`listen( call site on \`${RENAMED}\``) && p.includes(`on \`${CHANNEL}\``)), // prettier-ignore
    );
    assert.ok(problems.some((p) => p.includes(`never names \`${RENAMED}\` in backticks`)));
  });

  it('fires when the doc row and the emit site are renamed but the listener is left behind', () => {
    // The rename hole this leg exists to close: the document and the backend
    // agree on the new name while the adapter still listens on the old one.
    // The leg is scoped to the derived channel, so the stale site is not
    // redded on its own — the zero case names it, which is what makes the
    // single line actionable.
    const problems = evaluateCommandSurface(
      makeSurface({
        docEvents: [RENAMED],
        emitSites: [{ path: 'src/lib.rs', method: 'emit', channel: RENAMED, line: 90 }],
        sectionProse: `The \`${RENAMED}\` channel is consumed by one listener.`,
      }),
    );
    assert.deepEqual(problems, [
      `expected exactly one listen( call site on \`${RENAMED}\` in the tracked ${FRONTEND_DIR} JavaScript, found 0 — the listen sites found listen elsewhere: ${CALLER_PATH} (listen( call site 1) on \`${CHANNEL}\``,
    ]);
  });

  it('a listen site on another channel is outside the leg — the channel-carrying one greens', () => {
    assert.deepEqual(
      evaluateCommandSurface(
        makeSurface({
          listenSites: [
            { path: CALLER_PATH, ordinal: 1, name: CHANNEL, argToken: CHANNEL },
            { path: `${FRONTEND_DIR}/auto-sync-host.js`, ordinal: 1, name: 'sync:progress', argToken: 'sync:progress' }, // prettier-ignore
          ],
        }),
      ),
      [],
    );
  });

  it('fires when a second listen site on the channel appears', () => {
    const problems = evaluateCommandSurface(
      makeSurface({
        listenSites: [
          { path: CALLER_PATH, ordinal: 1, name: CHANNEL, argToken: CHANNEL },
          { path: `${FRONTEND_DIR}/auto-sync-host.js`, ordinal: 1, name: CHANNEL, argToken: CHANNEL }, // prettier-ignore
        ],
      }),
    );
    assert.ok(
      problems.some((p) => p.includes(`expected exactly one listen( call site on \`${CHANNEL}\``) && p.includes('found 2')), // prettier-ignore
      problems.join('\n') || 'no single-listener diagnostic',
    );
  });

  it('fires when the tree carries no listen site at all', () => {
    const problems = evaluateCommandSurface(makeSurface({ listenSites: [] }));
    assert.ok(problems.some((p) => p.includes('found 0')));
  });

  it('refuses a listen call site whose channel is not a string literal, naming the site', () => {
    const problems = evaluateCommandSurface(
      makeSurface({
        listenSites: [{ path: CALLER_PATH, ordinal: 1, name: null, argToken: 'CHANNEL_NAME' }],
      }),
    );
    assert.ok(
      problems.some((p) => p.includes(`${CALLER_PATH} (listen( call site 1)`) && p.includes('CHANNEL_NAME')), // prettier-ignore
      problems.join('\n') || 'no listen refusal',
    );
  });

  it('refuses a concatenated listen channel — the literal is not credited with the channel', () => {
    const sites = extractCallSites(
      new Map([[CALLER_PATH, "listen('capture:' + kind, (event) => handle(event));"]]),
      'listen',
    );
    assert.deepEqual(sites, [
      { path: CALLER_PATH, ordinal: 1, name: null, argToken: 'capture: +' },
    ]);
    const problems = evaluateCommandSurface(makeSurface({ listenSites: sites }));
    assert.ok(
      problems.some((p) => p.includes(`${CALLER_PATH} (listen( call site 1)`) && p.includes('capture: +')), // prettier-ignore
      problems.join('\n') || 'no concatenated-listen refusal',
    );
  });

  it('fires when the clause prose stops naming the channel while the table still does', () => {
    const problems = evaluateCommandSurface(
      makeSurface({ sectionProse: 'The event channel is consumed by one listener.' }),
    );
    assert.deepEqual(problems, [
      `the DSH-1 section's prose outside its table never names \`${CHANNEL}\` in backticks — the channel the table states is stated in the clause's own prose too`,
    ]);
  });

  it('greens when the row, the emit site, the listener, and the prose are renamed together', () => {
    assert.deepEqual(
      evaluateCommandSurface(
        makeSurface({
          docEvents: [RENAMED],
          emitSites: [{ path: 'src/lib.rs', method: 'emit', channel: RENAMED, line: 90 }],
          listenSites: [{ path: CALLER_PATH, ordinal: 1, name: RENAMED, argToken: RENAMED }],
          sectionProse: `The \`${RENAMED}\` channel is consumed by one listener.`,
        }),
      ),
      [],
    );
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
  it('the export is non-empty and its diagnoses pairwise distinct', () => {
    assert.ok(EMPTY_SURFACES.length > 0);
    const messages = EMPTY_SURFACES.map(([, message]) => message);
    assert.equal(new Set(messages).size, messages.length);
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

  it('reads a lone channel literal only — one the separator or the closing paren follows', () => {
    const src = [
      'h.emit("capture:action", &e);',
      'h.emit("capture:action");',
      'h.emit("capture:action".to_string(), &e);',
      'h.emit_to("main", "capture:action".to_owned(), &e);',
    ].join('\n');
    const sites = extractEmitSites(new Map([['a.rs', src]]));
    assert.deepEqual(
      sites.map((s) => [s.method, s.channel]),
      [
        ['emit', 'capture:action'],
        ['emit', 'capture:action'],
        ['emit', null],
        ['emit_to', null],
      ],
    );
    // The refusal the null channel drives names the site, so a channel built
    // around a literal fails loudly instead of being credited with it.
    const problems = evaluateCommandSurface(
      makeSurface({
        emitSites: [
          { path: 'src/lib.rs', method: 'emit', channel: CHANNEL, line: 90 },
          { path: 'src/lib.rs', method: 'emit', channel: null, line: 140 },
        ],
      }),
    );
    assert.ok(
      problems.some((p) => p.includes('src/lib.rs:140') && p.includes('channel the scan cannot read')), // prettier-ignore
      problems.join('\n') || 'no emit refusal',
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

describe('extractCallSites — the frontend caller scans', () => {
  const caller = [
    "// invoke('commented_out') is never counted",
    "/* listen('also:commented') */",
    "import { invoke, listen } from './tauri-bridge.js';",
    "await invoke('start_capture', { pid: null });",
    "const json = await invoke('load_state');",
    "listen('capture:action', (event) => handle(event));",
  ].join('\n');

  it('reads the literal first argument and skips comments and imports', () => {
    assert.deepEqual(
      extractCallSites(new Map([[CALLER_PATH, caller]]), 'invoke').map((s) => s.name),
      ['start_capture', 'load_state'],
    );
    assert.deepEqual(
      extractCallSites(new Map([[CALLER_PATH, caller]]), 'listen').map((s) => s.name),
      ['capture:action'],
    );
  });

  it('numbers the sites per file, in source order', () => {
    const sites = extractCallSites(new Map([[CALLER_PATH, caller]]), 'invoke');
    assert.deepEqual(
      sites.map((s) => [s.path, s.ordinal]),
      [
        [CALLER_PATH, 1],
        [CALLER_PATH, 2],
      ],
    );
  });

  it('records a null name and the token standing in its place when the argument is not literal', () => {
    const sites = extractCallSites(new Map([['a.js', 'await invoke(commandName, args);']]), 'invoke'); // prettier-ignore
    assert.deepEqual(sites, [{ path: 'a.js', ordinal: 1, name: null, argToken: 'commandName' }]);
  });

  it('reads a lone literal only — the comma and the closing parenthesis are the followers it accepts', () => {
    const sources = new Map([
      ['a.js', "invoke('load_state');\ninvoke('save_state', { data });\ninvoke('load_state' + suffix);\ninvoke('load_state'.concat(suffix));"], // prettier-ignore
    ]);
    assert.deepEqual(
      extractCallSites(sources, 'invoke').map((s) => [s.name, s.argToken]),
      [
        ['load_state', 'load_state'],
        ['save_state', 'save_state'],
        [null, 'load_state +'],
        [null, 'load_state .'],
      ],
    );
  });

  it('a source that ends mid-call records the end-of-source stand-in', () => {
    // Both truncations: the argument never arrives, and the follower that
    // would prove the literal lone never arrives.
    assert.deepEqual(
      extractCallSites(new Map([['a.js', 'await invoke(']]), 'invoke').map((s) => s.argToken),
      ['(end of source)'],
    );
    assert.deepEqual(extractCallSites(new Map([['a.js', "await invoke('load_state'"]]), 'invoke'), [
      { path: 'a.js', ordinal: 1, name: null, argToken: '(end of source)' },
    ]);
  });

  it('skips a declaration by shape — the shipped bridge contributes no call site', () => {
    // The bridge is scanned like every other module; what keeps it out of the
    // closures is the declaration shape, not its path. Its forwarding call
    // reaches the API through a parenthesized expression, which the
    // word-then-paren pair never matches.
    const bridge = [
      'export function invoke(...args) {',
      '  const globalInvoke = globalThis.window?.__TAURI__?.core?.invoke;',
      '  return (globalInvoke ?? esmInvoke)(...args);',
      '}',
      'export function listen(...args) {',
      '  return (globalListen ?? esmListen)(...args);',
      '}',
    ].join('\n');
    assert.deepEqual(extractCallSites(new Map([[BRIDGE_PATH, bridge]]), 'invoke'), []);
    assert.deepEqual(extractCallSites(new Map([[BRIDGE_PATH, bridge]]), 'listen'), []);
  });

  it('skips the declaration only — a real call in the same file is still site 1', () => {
    const source = [
      'export function invoke(...args) { return real(...args); }',
      "await invoke('load_state');",
    ].join('\n');
    assert.deepEqual(
      extractCallSites(new Map([[CALLER_PATH, source]]), 'invoke').map((s) => [s.ordinal, s.name]),
      [[1, 'load_state']],
    );
  });
});

describe('extractSectionProse — the weld reads the section without its table', () => {
  it('drops table lines and keeps the prose around them', () => {
    const section = [
      '**DSH-1.** The contract.',
      '',
      '| Name | D |',
      '| ---- | - |',
      '| `capture:action` (event) | a |',
      '',
      'The `capture:action` channel has one consumer.',
    ].join('\n');
    const prose = extractSectionProse(section);
    assert.ok(!prose.includes('(event)'), 'table rows must not reach the weld');
    assert.ok(prose.includes('The `capture:action` channel has one consumer.'));
  });

  it('a section whose only mention is the table cell leaves the prose without one', () => {
    const section = [
      '**DSH-1.** The contract.',
      '',
      '| Name | D |',
      '| ---- | - |',
      '| `capture:action` (event) | a |',
    ].join('\n');
    assert.ok(!extractSectionProse(section).includes('`capture:action`'));
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
    'Grants: `core:default` and `fs:allow-read`. The `capture:action` channel',
    'has one frontend consumer.',
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
  const CALLER = [
    "await invoke('start_capture', { pid: null });",
    "listen('capture:action', (event) => handle(event));",
  ].join('\n');
  // The bridge declares the two functions and calls neither by name, so the
  // declaration-shape rule leaves it contributing nothing — while the file
  // itself stays inside the scanned surface.
  const BRIDGE = 'export function invoke(...args) {}\nexport function listen(...args) {}';
  const JS_FILES = [CALLER_PATH, BRIDGE_PATH];

  /** A readFile over a synthetic file map, with the crate source at LIB_PATH. */
  function treeReader(capabilities) {
    return (f) => {
      if (f === DOC_PATH) return DOC;
      if (f === LIB_PATH) return LIB;
      if (f === MOCK_PATH) return MOCK;
      if (f === TAURI_CONF_PATH) return '{}';
      if (f === CALLER_PATH) return CALLER;
      if (f === BRIDGE_PATH) return BRIDGE;
      return capabilities[f] ?? '';
    };
  }

  it('unions grants across capability files and accepts the object entry form', () => {
    const caps = {
      'caps/default.json': JSON.stringify({ permissions: ['core:default'] }),
      'caps/extra.json': JSON.stringify({ permissions: [{ identifier: 'fs:allow-read' }] }),
    };
    const { problems, grantCount } = auditTree(
      treeReader(caps),
      [LIB_PATH],
      Object.keys(caps),
      JS_FILES,
    );
    assert.deepEqual(problems, [], problems.join('\n'));
    assert.equal(grantCount, 2);
  });

  it('reports an unparseable capability file as a problem, not a thrown stack', () => {
    const caps = { 'caps/default.json': 'not json' };
    const { problems } = auditTree(treeReader(caps), [LIB_PATH], Object.keys(caps), JS_FILES);
    assert.ok(
      problems.some((p) => p.includes('caps/default.json') && p.includes('does not parse as JSON')), // prettier-ignore
    );
  });

  it('reports a permissions entry of an unknown shape', () => {
    const caps = { 'caps/default.json': JSON.stringify({ permissions: ['core:default', 42] }) };
    const { problems } = auditTree(treeReader(caps), [LIB_PATH], Object.keys(caps), JS_FILES);
    assert.ok(problems.some((p) => p.includes('cannot read') && p.includes('42')));
  });

  it('refuses a capability file in a format the scan does not read', () => {
    const caps = {
      'caps/default.json': JSON.stringify({ permissions: ['core:default', 'fs:allow-read'] }),
      'caps/extra.toml': 'permissions = ["fs:allow-write"]',
    };
    const { problems } = auditTree(treeReader(caps), [LIB_PATH], Object.keys(caps), JS_FILES);
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
    const { problems } = auditTree(readFile, [LIB_PATH], Object.keys(caps), JS_FILES);
    assert.ok(problems.some((p) => p.includes('inlines capabilities')));
  });

  it('refuses a fixture carrying a second switch (cmd) block', () => {
    const caps = {
      'caps/default.json': JSON.stringify({ permissions: ['core:default', 'fs:allow-read'] }),
    };
    const twoSwitches = `${MOCK}\nswitch (cmd) { default: break; }`;
    const readFile = (f) => (f === MOCK_PATH ? twoSwitches : treeReader(caps)(f));
    const { problems } = auditTree(readFile, [LIB_PATH], Object.keys(caps), JS_FILES);
    assert.ok(problems.some((p) => p.includes('2 `switch (cmd)` blocks')));
  });

  it('deduplicates the invoke literals — one command invoked from several sites is one entry', () => {
    // Several call sites naming one command is ordinary code shape (the
    // shipped panel invokes `stop_capture` from many paths), so the caller
    // set the closure diffs run over carries each name once.
    const caps = {
      'caps/default.json': JSON.stringify({ permissions: ['core:default', 'fs:allow-read'] }),
    };
    const repeated = [
      "await invoke('start_capture', { pid: null });",
      "await invoke('start_capture', { pid: 7 });",
      "listen('capture:action', (event) => handle(event));",
    ].join('\n');
    const readFile = (f) => (f === CALLER_PATH ? repeated : treeReader(caps)(f));
    const { problems, invokeLiterals } = auditTree(
      readFile,
      [LIB_PATH],
      Object.keys(caps),
      JS_FILES,
    );
    assert.deepEqual(invokeLiterals, ['start_capture']);
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  it('scans the bridge like any other module — the declarations alone keep it green', () => {
    const caps = {
      'caps/default.json': JSON.stringify({ permissions: ['core:default', 'fs:allow-read'] }),
    };
    assert.deepEqual(
      auditTree(treeReader(caps), [LIB_PATH], Object.keys(caps), JS_FILES).problems,
      [],
    );
    // …and a call written inside the bridge is a call site like any other: a
    // plugin invoke and a second listener there reach all three closures,
    // which is exactly what a whole-file exclusion used to hide.
    const rogue = [
      BRIDGE,
      "await invoke('plugin:dialog|open', {});",
      "listen('capture:action', (event) => handle(event));",
    ].join('\n');
    const reader = (f) => (f === BRIDGE_PATH ? rogue : treeReader(caps)(f));
    const { problems } = auditTree(reader, [LIB_PATH], Object.keys(caps), JS_FILES);
    assert.ok(
      problems.some((p) => p.includes('plugin:dialog|open') && p.includes('is invoked from the frontend')), // prettier-ignore
      problems.join('\n') || 'no direct-invoke diagnostic for the in-bridge call',
    );
    assert.ok(
      problems.some((p) => p.includes(`expected exactly one listen( call site on \`${CHANNEL}\``) && p.includes('found 2')), // prettier-ignore
      problems.join('\n') || 'no single-listener diagnostic for the in-bridge listener',
    );
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
    // The recursive enumeration the CLI wrapper passes, filtered the same way.
    const jsFiles = lsFiles(FRONTEND_DIR).filter((f) => f.endsWith('.js'));
    assert.ok(rustFiles.includes(LIB_PATH), 'the crate entry point must be among the sources');
    assert.ok(
      capabilityFiles.length >= 1,
      'at least one file must be tracked under the capability directory',
    );
    assert.ok(
      jsFiles.includes(BRIDGE_PATH),
      'the bridge module must be among the scanned files — its declarations are what the shape rule skips',
    );
    const { problems, commandCount, channel } = auditTree(
      (f) => readFileSync(resolve(ROOT, f), 'utf8'),
      rustFiles,
      capabilityFiles,
      jsFiles,
    );
    assert.deepEqual(problems, [], problems.join('\n'));
    assert.ok(commandCount > 0);
    assert.equal(channel, CHANNEL, 'the shipped event row states the channel the fixtures use');
    // The lock also proves the check reads the real surfaces it names.
    for (const p of [DOC_PATH, MOCK_PATH, BRIDGE_PATH]) {
      assert.doesNotThrow(() => readFileSync(resolve(ROOT, p)));
    }
  });
});
