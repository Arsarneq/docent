/**
 * tauri-mock-fixture.js — the desktop integration suite's one `window.__TAURI__`
 * mock, and the dist server that injects it.
 *
 * Every spec in this directory drives the real desktop frontend against this
 * single mock, so the suite is one drift-visible consumer of the Tauri command
 * surface (`docs/architecture/application/desktop/windows/application-shell.md`
 * §DSH-1 defines that surface; the canonical table below services the crate's
 * registered command surface, which the shipped frontend invokes commands
 * from). The served page keeps the panel's shipped
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
 *   import { installTauriMockServer } from './tauri-mock-fixture.js';
 *
 *   const server = installTauriMockServer();
 *   // ... await page.goto(server.url());
 *
 * ── What the mock services ───────────────────────────────────────────────────
 * The canonical table answers every command the crate registers, and every
 * invoke — serviced or not — is recorded, so a spec can assert on the panel's
 * command traffic through `_getInvokeCalls()` / `_clearInvokeCalls()`.
 * Spec-controlled behaviour rides named hooks on `window.__TAURI__`:
 * `_setWindows()` supplies the `list_windows` result, `_setImportResult()` the
 * `import_file` payload, and `_getLastExport()` returns what `export_file` was
 * last handed. The canonical `sync_http_request` — the native HTTP transport —
 * is adapted onto the page's `window.fetch`, so a spec's fetch stub (or a route
 * this server serves) answers the real transport path. `event.listen` records
 * each handler under `_listeners`, so a spec can fire `capture:action` payloads
 * directly.
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
  let _savedState = JSON.stringify({ projects: [], settings: {} });
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
          case 'save_state': _savedState = args.data; return;
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
    _getInvokeCalls: () => _invokeCalls,
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

  test.afterEach(async ({ page }) => {
    const probe = await page.evaluate((mockPath) => {
      const injected = !!document.querySelector(`script[src="${mockPath}"]`);
      return {
        injected,
        installed: typeof window.__TAURI__?._getUnknownInvokes === 'function',
        unknown: window.__TAURI__?._getUnknownInvokes?.() ?? [],
      };
    }, MOCK_SCRIPT_PATH);

    // Keyed on the injected tag, so this covers exactly the documents the server
    // injected into — and catches a mock that was injected but did not install,
    // the way an override resolving in the test process and then throwing in the
    // page leaves it. Without it the guard would read a missing mock as "no
    // unknown invokes" and pass in the case it exists to shout about: the mock
    // not being what the spec thinks it is.
    if (probe.injected) {
      expect(
        probe.installed,
        'this fixture injected its mock script into the page, but no window.__TAURI__ mock installed — the unknown-invoke guard cannot speak',
      ).toBe(true);
    }

    const named = [...new Set(probe.unknown)].join(', ');
    expect(
      probe.unknown,
      `the panel invoked ${named} — the shared Tauri mock services no such command. ` +
        `The command-surface admission test holds this mock's serviced set equal to the ` +
        `crate's registered commands, so either stop invoking it or add the command to ` +
        `the crate (the admission test then requires the canonical entries here); an ` +
        `override cannot introduce a command the table does not already service.`,
    ).toEqual([]);
  });

  return {
    /** @returns {string} the server's origin, without a trailing slash. */
    origin: () => `http://127.0.0.1:${serverPort}`,
    /** @returns {string} an absolute URL on this server (default: the panel root). */
    url: (pathname = '/') => `http://127.0.0.1:${serverPort}${pathname}`,
  };
}
