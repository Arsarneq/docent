/**
 * tauri-mock-fixture.js — the desktop integration suite's one `window.__TAURI__`
 * mock, and the dist server that injects it.
 *
 * Every spec in this directory drives the real desktop frontend against this
 * single mock, so the suite is one drift-visible consumer of the Tauri command
 * surface (`docs/architecture/application/desktop/windows/application-shell.md`
 * §DSH-1 defines that surface; the canonical table below services the crate's
 * registered command surface, and the shipped frontend's command invokes
 * draw from that set — its event listener rides the granted plugin surface
 * instead). The served page keeps the panel's shipped
 * Content-Security-Policy, and the mock is injected past the policy element, so
 * the suite exercises the frontend — and the mock itself — under the policy the
 * application ships; `serveDistFile` carries the mechanics.
 *
 * ── Composition with `coverage-fixture.js` ───────────────────────────────────
 * Coverage stays where it is: a spec keeps importing `test`/`expect` from
 * `./coverage-fixture.js`, so its pages contribute V8 coverage. This module
 * imports that same `test` object and registers its hooks on it, which
 * Playwright scopes to whichever spec file is being loaded when
 * `installTauriMockServer()` runs — so a spec gets the server lifecycle and the
 * fail-loud assertions below from one top-of-file call:
 *
 *   import { test, expect } from './coverage-fixture.js';
 *   import { installTauriMockServer, openPanel } from './tauri-mock-fixture.js';
 *
 *   const server = installTauriMockServer();
 *   // ... await openPanel(page, server);
 *
 * ── What the mock services ───────────────────────────────────────────────────
 * The canonical table answers every command the crate registers, and every
 * invoke — serviced or not — is recorded, so a spec reads the panel's command
 * traffic through the fixture's readers below (`invokedCommands`, `invokesOf`,
 * `clearInvokes`), the invokes no command services through
 * `_getUnknownInvokes()`, and the persisted blob itself through
 * `_getSavedState()` — what `load_state` would answer, read without adding an
 * invoke to the record. The page-side getters over the record and over the
 * unknown-invoke list each hand out a copy of what they hold (the reset hands
 * out nothing), so the one spec-side read of the record — the settle probe in
 * the panel spec, which needs the invoke count and the saved blob from one page
 * turn and which the integration-suite locks name as the allowance — can sort,
 * reverse, or splice what it was given without reaching the record the mock
 * keeps.
 *
 * Spec-controlled behaviour rides named hooks on `window.__TAURI__`:
 * `_setWindows()` supplies the `list_windows` result, `_setImportResult()` the
 * `import_file` payload, and `_getLastExport()` returns what `export_file` was
 * last handed. The canonical `sync_http_request` — the native HTTP transport —
 * is adapted onto the page's `window.fetch`, so a spec's fetch stub (or a route
 * this server serves) answers the real transport path. `event.listen` records
 * each handler under `_listeners`, so a spec can fire `capture:action` payloads
 * directly.
 *
 * `load_state`/`save_state` persist to this tab's web storage, so the blob
 * outlives the document: opening the panel again in the same tab reads back what
 * was saved — the restart shape a persistence assertion needs — while a fresh
 * test page starts from the empty state (the generated script below states the
 * mechanics).
 *
 * ── The helpers specs share ──────────────────────────────────────────────────
 * `openPanel(page, server)` is the panel-open preamble: navigate to the served
 * frontend, then wait for the panel to have loaded — its startup `load_state`
 * invoke recorded, and the projects view visible. Both halves are needed: that
 * view is the one the markup ships un-hidden, so it matches the moment the
 * document parses, while the invoke on its own says a call was made and not
 * that the panel got as far as showing what it loaded. An exception thrown
 * during startup surfaces as its own message, distinct from the one naming a
 * bundle that never ran; the watch itself stays armed for the test's whole
 * run, so an error after the gate fails the test in the shared afterEach.
 *
 * `createProject(page, name)` walks the new-project form and lands on the
 * project's detail view, holding that view to the name it typed — so a spec
 * whose subject is what happens once a project exists fails at the walk rather
 * than downstream, against a view that never took the name. Its precondition is
 * the projects view as the panel RENDERED it, a state the shipped markup cannot
 * produce and one no invoke-record reset erases, so the failure names each
 * state it can mean: a page that never ran the panel, and one left standing
 * inside a project. It opens no panel: the server handle belongs to the spec,
 * and the mock's invoke record is per document, so a re-open would drop the
 * invokes the spec goes on to read.
 *
 * `fireCaptureActions(page, payloads)` delivers captured actions through the
 * registered `capture:action` listener, and throws naming the absent listener
 * when the page has none — so a spec whose assertion would hold anyway with
 * nothing delivered fails at the delivery instead of passing for the wrong
 * reason. Its `delayMs` option holds the delivery in the page for that long
 * first, for a spec placing an action after a gap; the listener is checked
 * before the wait begins, and the call resolves once the actions have been
 * delivered.
 *
 * `seedRecordedStep(page, { project, recording, actions, narration })` is the
 * run-up to a committed step: the project — through `createProject`, so that
 * walk keeps its one home — a recording inside it, the captured actions
 * delivered, then the narration and the commit. Every key is stated by the
 * caller as a value or `null`, a missing one throwing naming it, and `null`
 * skips its leg, so a caller stops where its own subject begins. The commit
 * is held to the step the panel rendered, so a commit that produced no step
 * fails here rather than in whatever the caller asserts next.
 *
 * `invokedCommands(page)`, `invokesOf(page, command)` and `clearInvokes(page)`
 * read the mock's invoke record, the read itself being what a spec must not
 * re-implement: the command names in order; one command's records, arguments
 * included — the records themselves, never the arguments alone, so whether a
 * command was invoked and what it was passed stay separate questions; and the
 * reset that drops the record while the unknown-invoke list stands.
 *
 * ── Unknown invokes fail loudly ──────────────────────────────────────────────
 * An invoke of a command the mock does not service is recorded AND rejects (an
 * override restates a serviced command; it never adds one to the set the mock
 * answers). Recording is what makes it bite: the panel catches some invoke
 * failures by design, so `installTauriMockServer()` also installs an
 * `afterEach` that asserts the page recorded no unknown invoke — a panel-side
 * catch can hide the rejection, not the record. The same hook asserts
 * that a document this server injected the mock into really carries it, so a
 * mock that never installed reads as the drift it is rather than as an empty
 * record. `_clearInvokeCalls()` deliberately leaves the unknown list alone: a
 * spec resetting its own assertion window never resets the drift signal. The
 * reach of the assertions in that hook is the document the page holds when the
 * test ends, so a test that navigates away leaves the earlier document's record
 * behind.
 *
 * ── The canonical `stop_capture` reports a stopped, idle capture layer ───────
 * It answers the zero barrier report the backend returns when no capture was
 * active, which the adapter reads as "nothing was flushed" — so a commit
 * collects what is already pending rather than waiting for a sentinel. That is
 * the path the flow specs commit through. A spec that exercises the fused
 * stop-path flush barrier states that contract itself, through an override
 * returning an engaged barrier whose `barrier_complete` sentinel it delivers.
 *
 * ── The override seam ────────────────────────────────────────────────────────
 * `installTauriMockServer({ overrides })` replaces one command's behaviour with
 * a spec-supplied function, given as source text (the mock is served to the page
 * as a script, so an override travels as source):
 *
 *   installTauriMockServer({
 *     overrides: {
 *       stop_capture: `() => ({ barrier_id: 42, wedged_workers: 0, completion: 'marker_ordered' })`,
 *     },
 *   });
 *
 * Install time rejects an override naming a command the canonical table does not
 * service — an override is a restatement of a serviced command, never a way to
 * widen the surface behind the fail-loud contract's back — and one whose value
 * does not resolve to a function, which it establishes by resolving the source in
 * the test process. Because the source resolves in this Node process as well as
 * in the page, an override reaches page globals from inside the function it
 * resolves to, never while constructing itself — construction-time `window`
 * access is refused here though the page would have run it.
 * The case that check alone catches is source that resolves but
 * is not a function: unrefused, the mock would install and the failure would land
 * at invoke time on a command the mock does service, where the unknown-invoke
 * guard has nothing to say. Source that resolves there but throws in the page
 * gets past that check and aborts the served mock script, which the
 * mock-presence assertion reports.
 *
 * ── Extra routes ─────────────────────────────────────────────────────────────
 * `installTauriMockServer({ routeRequest })` lets a spec answer requests ahead
 * of the dist files — how the sync-samples spec reverse-proxies the sync
 * protocol paths to a real reference server on this same origin.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { test, expect } from './coverage-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The built desktop frontend the server serves (`npm run build:desktop-dist`). */
const DIST_PATH = path.resolve(__dirname, '../../dist');

/** The page event an uncaught frontend error arrives on. */
const PAGE_ERROR_EVENT = 'pageerror';

/**
 * The uncaught page errors each page has reported — exceptions and unhandled
 * rejections alike — from the moment the watch was armed on it. Armed once per
 * page: the installer's per-test hook arms the test's page, and openPanel arms
 * whatever page it is handed, so a page opened outside those hooks keeps its
 * startup verdict.
 */
const pageErrors = new WeakMap();
/** Arm the watch on a page once and hand back its live record. */
function armPageErrorWatch(page) {
  let errors = pageErrors.get(page);
  if (!errors) {
    errors = [];
    pageErrors.set(page, errors);
    page.on(PAGE_ERROR_EVENT, (error) => {
      errors.push(error);
    });
  }
  return errors;
}

/** Same-origin path the mock script is served from and injected by. */
const MOCK_SCRIPT_PATH = '/__tauri-mock.js';

/** Content types for the extensions the served frontend actually requests. */
const CONTENT_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.md': 'text/markdown',
};

/**
 * The desktop crate's registered command surface — every command this mock
 * services, and the only names an override may name. The command-surface
 * admission test (scripts/check-command-surface.js, npm run
 * lint:command-surface) holds this list AND the canonical switch's case
 * labels in the script below equal to the crate's #[tauri::command] surface
 * in both directions, so the mock can neither lag a command the crate gains
 * nor keep servicing one it loses; the shipped frontend invokes commands
 * from this set.
 */
const CANONICAL_COMMANDS = [
  'load_state',
  'save_state',
  'start_capture',
  'stop_capture',
  'commit_barrier',
  'list_windows',
  'set_target_pid',
  'set_self_capture_exclusion',
  'set_auto_sync_keepalive',
  'import_file',
  'export_file',
  'sync_http_request',
];

/**
 * Build the mock script this server serves, with any spec overrides inlined.
 *
 * @param {Record<string, string>} overrides command name → function source text
 * @returns {string} the script body served at {@link MOCK_SCRIPT_PATH}
 */
function buildMockScript(overrides) {
  const overrideEntries = Object.entries(overrides)
    .map(([command, source]) => `    ${JSON.stringify(command)}: (${source}),`)
    .join('\n');

  return `
  // Generated by tauri-mock-fixture.js — the desktop integration suite's single
  // window.__TAURI__ mock. Change the fixture, never a copy of this script.

  // The saved blob is held in this tab's web storage, so it outlives the
  // document: opening the panel again in the same tab reads back exactly what
  // save_state last wrote — the restart a persistence assertion needs — while a
  // fresh test page, which is a fresh context, starts from the empty state
  // below. A storage write that
  // cannot be made surfaces as a rejected save_state rather than as a silently
  // forgotten save; the largest blob any spec saves here is the seed sample, of
  // a few kilobytes.
  const _STATE_KEY = '__docent_mock_saved_state';
  const _EMPTY_STATE = JSON.stringify({ projects: [], settings: {} });
  let _savedState = window.sessionStorage.getItem(_STATE_KEY) ?? _EMPTY_STATE;
  let _invokeCalls = [];
  const _unknownInvokes = [];
  const _listeners = {};
  let _windows = [];
  let _importResult = null;
  let _lastExport = null;

  // Spec-supplied command behaviours, checked ahead of the canonical table.
  const _overrides = {
${overrideEntries}
  };

  // The desktop routes sync, dispatch, and connection-test traffic through the
  // native sync_http_request command (application-shell.md § Native HTTP
  // transport). With no Rust backend here, the mock services it through the
  // page's window.fetch and adapts the reply into the command's
  // { status, headers, body } shape — so a spec's fetch stub answers the real
  // transport path.
  async function _syncHttpRequest(args) {
    const _r = await window.fetch(args.url, {
      method: args.method,
      headers: args.headers || {},
      body: args.body == null ? undefined : args.body,
    });
    const _status = typeof _r.status === 'number' ? _r.status : _r.ok ? 200 : 500;
    let _body = '';
    if (typeof _r.text === 'function') { try { _body = await _r.text(); } catch (_e) { _body = ''; } }
    if (!_body && typeof _r.json === 'function') { try { _body = JSON.stringify(await _r.json()); } catch (_e) { _body = ''; } }
    const _headers = {};
    if (_r.headers && typeof _r.headers.forEach === 'function') { _r.headers.forEach((v, k) => { _headers[String(k).toLowerCase()] = v; }); }
    return { status: _status, headers: _headers, body: _body };
  }

  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        _invokeCalls.push({ cmd, args });
        if (Object.prototype.hasOwnProperty.call(_overrides, cmd)) return _overrides[cmd](args);
        switch (cmd) {
          case 'load_state': return _savedState;
          case 'save_state':
            // Tab storage first: a write that cannot be made rejects the invoke
            // with the in-memory copy still matching what is stored, which is
            // what the note above promises. Assigning first would leave the two
            // disagreeing for the rest of the document's life.
            window.sessionStorage.setItem(_STATE_KEY, args.data);
            _savedState = args.data;
            return;
          case 'start_capture': return;
          // Both flush commands report the zero barrier the backend returns when
          // no capture was active, so no barrier engages and the adapter collects
          // what is already pending. A spec that drives the stop-path flush
          // barrier overrides stop_capture with an engaged report.
          case 'stop_capture': return { barrier_id: 0, wedged_workers: 0, completion: 'not_run' };
          case 'commit_barrier': return { barrier_id: 0, wedged_workers: 0, completion: 'not_run' };
          case 'list_windows': return _windows;
          case 'set_target_pid': return;
          case 'set_self_capture_exclusion': return;
          case 'set_auto_sync_keepalive': return;
          case 'import_file': return _importResult;
          case 'export_file':
            _lastExport = { data: args.data, defaultName: args.defaultName };
            return;
          case 'sync_http_request': return _syncHttpRequest(args);
          default:
            // Recorded first, so the afterEach guard sees it even though the
            // panel catches some invoke failures by design.
            _unknownInvokes.push(cmd);
            throw new Error('[tauri-mock] no command services invoke: ' + cmd);
        }
      },
    },
    event: {
      listen: (event, handler) => {
        _listeners[event] = handler;
        return Promise.resolve(() => {});
      },
    },
    _listeners,
    _getInvokeCalls: () => _invokeCalls.slice(),
    _getSavedState: () => _savedState,
    _clearInvokeCalls: () => { _invokeCalls = []; },
    _getUnknownInvokes: () => _unknownInvokes.slice(),
    _setWindows: (windows) => { _windows = windows; },
    _setImportResult: (json) => { _importResult = json; },
    _getLastExport: () => _lastExport,
  };
`;
}

/**
 * Serve one built frontend file, with the mock injected into the panel page.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {void}
 */
function serveDistFile(req, res) {
  const filePath = path.resolve(DIST_PATH, req.url === '/' ? 'index.html' : req.url.slice(1));

  // Prevent path traversal — the resolved path must stay within the dist tree.
  // Compared with the separator appended, so a sibling directory whose name
  // merely starts with the dist path is outside it too.
  if (!filePath.startsWith(DIST_PATH + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath);
  let content = fs.readFileSync(filePath, 'utf-8');

  if (ext === '.html') {
    // The page keeps its shipped Content-Security-Policy verbatim, so the suite
    // runs the panel under the same policy the application ships — the mock
    // included. A meta-delivered policy governs only what is parsed after it,
    // so the mock goes at the END of <head>: past the policy element, and still
    // ahead of panel.js, which loads at the end of <body>. There it is subject
    // to `script-src 'self'`, which admits this same-origin served file and
    // would refuse an inline script in the same position.
    content = content.replace('</head>', `<script src="${MOCK_SCRIPT_PATH}"></script></head>`);
  }

  res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] || 'text/plain' });
  res.end(content);
}

/**
 * Install the mocked-backend dist server for the calling spec file: starts the
 * server before the file's tests, closes it after, and after each test asserts
 * that the page recorded no unknown invoke — and, where this server injected
 * the mock into the page's document, that the mock really installed.
 *
 * @param {object} [options]
 * @param {Record<string, string>} [options.overrides] command name → function
 *   source text replacing that command's canonical behaviour. Throws here on a
 *   command the canonical table does not service, and on a value that does not
 *   resolve to a function; each rejection names the command and its own cause.
 * @param {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => boolean} [options.routeRequest]
 *   answers a request ahead of the dist files; returns `true` when it has
 *   handled the request.
 * @returns {{ origin: () => string, url: (pathname?: string) => string }} the
 *   running server's address accessors, usable once the tests start
 */
export function installTauriMockServer(options = {}) {
  const { overrides = {}, routeRequest = null } = options;

  for (const [command, source] of Object.entries(overrides)) {
    if (!CANONICAL_COMMANDS.includes(command)) {
      throw new Error(
        `[tauri-mock] cannot override '${command}': the canonical mock does not service it. ` +
          `Serviced commands: ${CANONICAL_COMMANDS.join(', ')}.`,
      );
    }
    if (typeof source !== 'string' || source.trim() === '') {
      throw new Error(
        `[tauri-mock] the override for '${command}' must be function source text, given as a string.`,
      );
    }
    // Resolve the expression here, so an override's value is known to be a
    // function before it reaches the page. What resolving catches is source that
    // resolves to a non-function: unrefused, the mock would install and the
    // failure would land at invoke time on a command the mock does service,
    // where the unknown-invoke guard has nothing to say. Source that resolves
    // here but throws in the page gets past this step and aborts the served
    // script instead, and the afterEach below reports the mock as
    // injected-but-not-installed.
    //
    // Resolution happens HERE, in the test process — once per spec file, on top
    // of once per page load in the page itself. So the expression has to resolve
    // in both realms: reach page globals from inside the function the override
    // resolves to, never while constructing it, or this step refuses source the
    // page would have run happily.
    let makeHandler;
    try {
      makeHandler = new Function(`return (${source});`);
    } catch (err) {
      throw new Error(`[tauri-mock] the override for '${command}' does not parse: ${err.message}`);
    }
    let handler;
    try {
      handler = makeHandler();
    } catch (err) {
      throw new Error(
        `[tauri-mock] the override for '${command}' threw while being evaluated: ${err.message}`,
      );
    }
    if (typeof handler !== 'function') {
      throw new Error(
        `[tauri-mock] the override for '${command}' must be function source text; ` +
          `this one evaluates to ${typeof handler}.`,
      );
    }
  }

  const mockScript = buildMockScript(overrides);
  let server = null;
  let serverPort = 0;

  test.beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (routeRequest && routeRequest(req, res)) return;
      if (req.url === MOCK_SCRIPT_PATH) {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(mockScript);
        return;
      }
      serveDistFile(req, res);
    });

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        serverPort = server.address().port;
        resolve();
      });
    });
  });

  test.afterAll(async () => {
    server?.close();
    server = null;
  });

  // The page-error watch lives as long as the test, not as long as the
  // readiness gate: every uncaught exception the panel throws — during
  // startup, during a click, inside a listener the test fired — and every
  // unhandled rejection lands on the page's record, and the afterEach below
  // fails the test on any of them. openPanel reads the same record for its
  // startup verdict.
  test.beforeEach(({ page }) => {
    armPageErrorWatch(page);
  });

  test.afterEach(async ({ page }) => {
    const probe = await page.evaluate((mockPath) => {
      const injected = !!document.querySelector(`script[src="${mockPath}"]`);
      return {
        injected,
        installed: typeof window.__TAURI__?._getUnknownInvokes === 'function',
        unknown: window.__TAURI__?._getUnknownInvokes?.() ?? [],
      };
    }, MOCK_SCRIPT_PATH);

    const pageErrorMessages = armPageErrorWatch(page).map(
      (error) => error?.message ?? String(error),
    );
    const reported = pageErrorMessages.length
      ? ` Page errors reported meanwhile: ${JSON.stringify(pageErrorMessages)}`
      : '';

    // Keyed on the injected tag, so this covers exactly the documents the server
    // injected into — and catches a mock that was injected but did not install,
    // the way an override resolving in the test process and then throwing in the
    // page leaves it. Without it the guard would read a missing mock as "no
    // unknown invokes" and pass in the case it exists to shout about: the mock
    // not being what the spec thinks it is.
    if (probe.injected) {
      expect(
        probe.installed,
        'this fixture injected its mock script into the page, but no window.__TAURI__ mock installed — the unknown-invoke guard cannot speak' +
          reported,
      ).toBe(true);
    }

    const named = [...new Set(probe.unknown)].join(', ');
    expect(
      probe.unknown,
      `the panel invoked ${named} — the shared Tauri mock services no such command. ` +
        `The command-surface admission test holds this mock's serviced set equal to the ` +
        `crate's registered commands, so either stop invoking it or add the command to ` +
        `the crate (the admission test then requires the canonical entries here); an ` +
        `override cannot introduce a command the table does not already service.` +
        reported,
    ).toEqual([]);

    expect(
      pageErrorMessages,
      'the panel threw uncaught while this test ran — an exception or unhandled rejection the page reported on `pageerror`; the messages are listed',
    ).toEqual([]);
  });

  return {
    /** @returns {string} the server's origin, without a trailing slash. */
    origin: () => `http://127.0.0.1:${serverPort}`,
    /** @returns {string} an absolute URL on this server (default: the panel root). */
    url: (pathname = '/') => `http://127.0.0.1:${serverPort}${pathname}`,
  };
}

/**
 * Open the panel: navigate to the served frontend, then wait for the panel to
 * have loaded — its startup `load_state` invoke recorded, and the projects view
 * visible. The view alone would not do: it is the one the markup ships
 * un-hidden, so it matches the moment the document parses. An exception thrown
 * during startup surfaces as its own message, distinct from the one naming a
 * bundle that never ran; the watch itself stays armed for the test's whole run,
 * so an error after the gate fails the test in the shared afterEach.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ url: (pathname?: string) => string }} server the value
 *   {@link installTauriMockServer} returned
 * @param {{ timeout?: number }} [options] how long to give the panel to load and
 *   reach that view; a spec whose open is slower than the default says so here
 * @returns {Promise<void>}
 */
export async function openPanel(page, server, options = {}) {
  const { timeout = 10000 } = options;
  // A panel that throws part-way through startup can still satisfy the gate
  // below — its first invoke is already recorded and the projects view is
  // already up — so read the page's error record across the whole open and
  // report that as its own failure, distinct from a bundle that never ran.
  // Only what the page reported since THIS open counts, so an error an earlier
  // part of the test already reported is never re-read as a startup failure;
  // and the one this reports comes out of the record, so the shared afterEach
  // never names it a second time while anything else the open provoked stays
  // for that hook to list.
  const errors = armPageErrorWatch(page);
  const seen = errors.length;
  const startupThrew = () => {
    const startupError = errors[seen];
    errors.splice(seen, 1);
    return new Error(`[tauri-mock] the panel threw while starting up: ${startupError.message}`, {
      cause: startupError,
    });
  };
  try {
    await page.goto(server.url());
    // Readiness has to be something the panel did, not something the markup
    // already says: `#view-projects` is the one view shipped un-hidden, so it
    // matches the moment the document parses — before any script has run, and
    // just as well when none can. The panel's startup `load_state` is its first
    // word to the backend, so waiting for that invoke beside a visible projects
    // view is a wait that a panel which never ran cannot satisfy.
    await page.waitForFunction(
      () => {
        const calls = window.__TAURI__?._getInvokeCalls?.() ?? [];
        if (!calls.some((call) => call.cmd === 'load_state')) return false;
        const view = document.querySelector('#view-projects');
        return !!view && !view.classList.contains('hidden');
      },
      undefined,
      { timeout },
    );
  } catch (cause) {
    if (errors[seen]) throw startupThrew();
    throw new Error(
      `[tauri-mock] the panel did not load and reach the projects view within ${timeout}ms. ` +
        'This server serves packages/desktop/dist, the built frontend bundle, and a missing or ' +
        'stale bundle is what usually stops the panel here — rebuild it from the repository root ' +
        'with `npm run sync-shared && npm run build:desktop-dist`.',
      { cause },
    );
  }
  if (errors[seen]) throw startupThrew();
}

/**
 * The projects view as the panel renders it, not as the markup ships it: the
 * view visible AND either its empty-state element un-hidden or its list filled
 * (`renderProjectsList` does one or the other; the markup ships the element
 * hidden and the list empty). A panel that never ran cannot satisfy it, and a
 * panel standing inside a project does not show it. Evaluated in the page.
 */
const PROJECTS_VIEW_RENDERED = () => {
  const view = document.querySelector('#view-projects');
  if (!view || view.classList.contains('hidden')) return false;
  const empty = document.querySelector('#projects-empty');
  const list = document.querySelector('#project-list');
  return (!!empty && !empty.classList.contains('hidden')) || (!!list && list.children.length > 0);
};

/**
 * Create a project from the panel's projects view and land on its detail view.
 *
 * The wait for `#view-project` says the view switched; the title assertion says
 * the panel got as far as showing the project it was asked for — a spec whose
 * real subject is what happens after a project exists would otherwise carry on
 * against a view that never took the name and fail downstream, naming the wrong
 * thing. A whitespace-only name is held to what the panel renders it as,
 * "Untitled Project".
 *
 * The panel has to be open on its projects view: `openPanel` is its own call,
 * named at the call site, because the server handle is the spec's and the mock's
 * invoke record is per document — a re-open would drop the invokes a spec then
 * reads. The precondition is that view as the panel rendered it, so a page that
 * was merely navigated, served a bundle that never ran, or left standing inside
 * a project fails here by name rather than on a later selector — and a spec that
 * cleared the invoke record first is unaffected.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} [name] the project name typed into the form
 * @param {{ timeout?: number }} [options] how long to give each step
 * @returns {Promise<void>} resolves once the project detail view shows the name
 */
export async function createProject(page, name = 'Test Project', options = {}) {
  const { timeout = 5000 } = options;
  await page.waitForFunction(PROJECTS_VIEW_RENDERED, undefined, { timeout }).catch((cause) => {
    throw new Error(
      'createProject needs the panel on its rendered projects view — ' +
        'call openPanel(page, server) first, or return to the projects view',
      { cause },
    );
  });
  await page.click('#btn-new-project');
  await page.waitForSelector('#view-new-project:not(.hidden)', { timeout });
  await page.fill('#new-project-name', name);
  await page.click('#btn-new-project-create');
  await page.waitForSelector('#view-project:not(.hidden)', { timeout });
  await expect(page.locator('#project-title')).toHaveText(name.trim() || 'Untitled Project', {
    timeout,
  });
}

/**
 * Deliver captured actions to the panel through the `capture:action` listener
 * the frontend registered on this mock.
 *
 * The listener has to be there for a delivery to reach the panel at all, so its
 * absence throws here, naming it: a spec whose assertion would hold with nothing
 * delivered — a control that stays disabled, a list that stays empty — then
 * fails at the delivery rather than passing for the opposite reason.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object[]} payloads each becomes one `capture:action` event payload, in
 *   the order given
 * @param {{ delayMs?: number }} [options] `delayMs` holds the delivery in the
 *   page for that many milliseconds first, so a spec can place an action after a
 *   gap; the listener is checked before the wait begins, and the call resolves
 *   once the actions have been delivered either way.
 * @returns {Promise<void>} resolves after the actions have reached the listener
 */
export async function fireCaptureActions(page, payloads, options = {}) {
  const { delayMs = 0 } = options;
  await page.evaluate(
    async ({ actions, delay }) => {
      const handler = window.__TAURI__?._listeners?.['capture:action'];
      if (typeof handler !== 'function') {
        throw new Error(
          '[tauri-mock] the page has no capture:action listener, so these actions reach nothing. ' +
            'The frontend registers it as the adapter module loads — a page that never got that far, ' +
            'or a mock that did not install, lands here.',
        );
      }
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      for (const payload of actions) handler({ payload });
    },
    { actions: payloads, delay: delayMs },
  );
}

/**
 * Walk the open panel to a committed step: create a project (through
 * `createProject`, so the walk and its postcondition have one home), create a
 * recording inside it, deliver captured actions, then narrate and commit. Every
 * key is stated by the caller as a value or `null` — a missing or undefined one
 * throws naming it — and `null` skips its leg: `project: null` when the panel
 * already stands inside the project, `recording: null` to stop after the
 * project, `actions: null` to deliver nothing, `narration: null` to leave the
 * delivered actions uncommitted. The commit leg holds the step list to one more
 * `.step-item` than before the click, so a commit the panel did not render
 * fails here rather than in whatever the caller asserts next. The waits are the
 * ones the panel's view transitions, delivery and commit take.
 *
 * @param {import('@playwright/test').Page} page an open panel (`openPanel` first)
 * @param {object} legs
 * @param {string | null} legs.project
 * @param {string | null} legs.recording
 * @param {object[] | null} legs.actions `capture:action` payloads; each is
 *   stamped with the current time unless it carries a `timestamp`
 * @param {string | null} legs.narration
 * @returns {Promise<void>}
 */
export async function seedRecordedStep(page, legs) {
  for (const key of ['project', 'recording', 'actions', 'narration']) {
    if (legs?.[key] === undefined)
      throw new Error(`seedRecordedStep: state "${key}" (a value, or null to skip that leg)`);
  }
  const { project, recording, actions, narration } = legs;
  const timeout = 5000;
  if (project !== null) await createProject(page, project, { timeout });
  if (recording !== null) {
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout });
    await page.fill('#new-recording-name', recording);
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout });
  }
  if (actions !== null) {
    await fireCaptureActions(
      page,
      actions.map((action) =>
        'timestamp' in action ? action : { ...action, timestamp: Date.now() },
      ),
    );
    await page.waitForTimeout(300);
  }
  if (narration !== null) {
    const steps = page.locator('.step-item');
    const before = await steps.count();
    await page.fill('#narration-input', narration);
    await page.click('#btn-commit-step');
    await expect(steps).toHaveCount(before + 1, { timeout });
    await page.waitForTimeout(500);
  }
}

/**
 * The command names the page has invoked, in the order the mock recorded them.
 *
 * The ordered names are what an assertion about the panel's command traffic
 * reads — that a commit ran through `stop_capture` and not a separate
 * `commit_barrier`, say. A site that needs one command's arguments reads
 * {@link invokesOf} instead.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string[]>} every recorded invoke's command name, in order
 */
export async function invokedCommands(page) {
  return page.evaluate(() => window.__TAURI__._getInvokeCalls().map((call) => call.cmd));
}

/**
 * The invokes of one command the page has recorded, in order.
 *
 * Each entry is the mock's own `{ cmd, args }` record, so a site reads
 * `entry.args` for what the panel passed and the entry itself answers whether
 * the command was invoked at all. Handing back the arguments alone would make
 * those two questions one: a command invoked with no arguments records
 * `undefined` there, which an existence check cannot tell from never having
 * been invoked.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} command the command name to select
 * @returns {Promise<{ cmd: string, args: unknown }[]>} the matching records, in
 *   the order the mock recorded them; empty where the page invoked no such
 *   command
 */
export async function invokesOf(page, command) {
  return page.evaluate(
    (cmd) => window.__TAURI__._getInvokeCalls().filter((call) => call.cmd === cmd),
    command,
  );
}

/**
 * Drop the recorded invokes, so what a spec reads afterwards is the traffic of
 * the step it is about to take and nothing before it.
 *
 * The unknown-invoke list is deliberately left standing — a spec resetting its
 * own assertion window never resets the suite's drift signal.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<void>}
 */
export async function clearInvokes(page) {
  await page.evaluate(() => window.__TAURI__._clearInvokeCalls());
}
