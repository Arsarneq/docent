/**
 * check-capture-surface.js — admission test for the two platforms' capture
 * surfaces, the closed positive enumerations core CP-14 requires each platform
 * to keep:
 *
 *   - the extension's DOM surface
 *     (docs/architecture/application/extension/capture-principles.md §ECP-6):
 *     the recorder's `document` listener registrations must equal, in both
 *     directions, the DOM events that clause enumerates — the receiver is part
 *     of the enumeration, so the same listener moved to `window` reds;
 *   - the extension's browser-chrome proxy surface (§ECP-7): the service
 *     worker's capture-proxy registrations must equal, in both directions, the
 *     worker events the proxy table's Event source column names — each
 *     registered exactly once, since a second registration of one proxy emits
 *     a second proxy for one user action (core CP-9) — and every other
 *     `chrome.*` listener either extension file registers must appear on this
 *     check's admission list with the role it plays;
 *   - the desktop capture surface
 *     (docs/architecture/application/desktop/windows/capture-principles.md
 *     §DCP-4): the installed low-level hooks must equal the hooks that clause
 *     names, and every event id a registered WinEvent range CONTAINS must be a
 *     class the Input Correlation table (§DCP-7) names — held by the ids a range
 *     spans, not by its endpoints, so a silently widened pair reds.
 *
 * The recorder's registrations all sit OUTSIDE the mirrored capture block, so
 * this check reads the one production copy in `content/recorder.js`; the two
 * copies of the block itself are held identical by the extension unit suite's
 * parity test, not here.
 *
 * Expanding a WinEvent range needs the numeric value of each registered
 * endpoint. Those values are the frozen Win32 ABI constants the desktop crate
 * imports from the `windows` crate; they are restated in WIN_EVENT_VALUES
 * below so a range can be expanded id by id. A constant the table does not
 * carry fails the check rather than passing it.
 *
 * Every parsed surface must be non-empty, every enumeration entry must be
 * readable (fence-aware, refusing unreadable list items and table cells rather
 * than skipping them), and a registration shape outside the scan's model — a
 * computed event name, a listener on a receiver the scan does not model, a
 * hook-installation site the extractor cannot anchor — is refused loudly
 * instead of passing vacuously.
 *
 * Honest limits. A registration shape outside the scan's model is REFUSED,
 * never skipped: an event name that is not a lone string literal (so a
 * concatenated name is refused, not read as its leading fragment), a receiver
 * outside `document`/`window` — which is what a helper taking its target as a
 * parameter looks like, wherever that helper is defined — and an
 * `addListener` chain not rooted at `chrome`. What is genuinely invisible is a
 * registration SITE that lands in neither scanned file: a helper defined
 * elsewhere and merely called here registers nothing these two files show.
 * Beyond that: §ECP-6 also states the phase the recorder listens in (capture),
 * which this check does not read — the listener options are not parsed, so the
 * phase claim stays review-held; and the scan reads registration sites, never
 * handler bodies, so whether a listener still captures what its doc row says
 * stays review-held, as does whether a dispatched WinEvent is later filtered
 * (the correlation, scope, and foreground gates have their own verification);
 * the admission list is keyed by
 * file and API path with an exact occurrence count, so where one file registers
 * the same API more than once the entry's justification names each role and
 * which site plays which is review-held; the desktop leg reads the hook
 * installation site only, and the doc prose around every enumeration — the
 * proxies' rationale, the correlation sources and additional filters — is
 * review-held, never parsed.
 *
 * Usage:
 *   node scripts/check-capture-surface.js  # or: npm run lint:capture-surface
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  backtickedName,
  duplicatesIn,
  extractClauseSection,
  missingFrom,
  parseTables,
  stripFences,
  tokenizeJs,
} from './check-test-inventory.js';
import { stripRustComments } from './check-command-surface.js';

/** Repo-relative path of the content-script recorder. */
export const RECORDER_PATH = 'packages/extension/content/recorder.js';
/** Repo-relative path of the extension service worker. */
export const WORKER_PATH = 'packages/extension/background/service-worker.js';
/** Repo-relative path of the extension capture doc stating ECP-6 and ECP-7. */
export const EXTENSION_DOC_PATH = 'docs/architecture/application/extension/capture-principles.md';
/** Repo-relative path of the desktop capture doc stating DCP-4 and DCP-7. */
export const DESKTOP_DOC_PATH =
  'docs/architecture/application/desktop/windows/capture-principles.md';
/** Repo-relative path of the Windows capture backend installing the hooks. */
export const WINDOWS_CAPTURE_PATH = 'packages/desktop/src-tauri/src/capture/windows.rs';

/** The clause enumerating the recorder's DOM surface. */
export const DOM_CLAUSE_ID = 'ECP-6';
/** The clause whose table enumerates the browser-chrome proxies. */
export const PROXY_CLAUSE_ID = 'ECP-7';
/** The clause enumerating the desktop capture surface. */
export const DESKTOP_CLAUSE_ID = 'DCP-4';
/** The clause whose table enumerates the correlated WinEvent classes. */
export const CORRELATION_CLAUSE_ID = 'DCP-7';

/** The `##` section carrying the browser-chrome proxy table. */
export const PROXY_SECTION = 'Browser Chrome Proxies';
/** That table's first header cell. */
export const PROXY_HEADER = 'User action';
/** That table's event-source header cell — the column this check holds. */
export const SOURCE_HEADER = 'Event source';
/** The `##` section carrying the WinEvent correlation table. */
export const CORRELATION_SECTION = 'Input Correlation';
/** That table's first header cell. */
export const CORRELATION_HEADER = 'WinEvent';

/**
 * The admission list is keyed by file AND API path, joined by a character
 * neither can carry, so a key can be split back into its two parts.
 */
const KEY_SEPARATOR = String.fromCharCode(0);

/**
 * The admission list's key for one file's registrations of one API.
 * @param {string} file repo-relative file path
 * @param {string} api the `chrome.<api>.<event>` path
 * @returns {string}
 */
function admissionKey(file, api) {
  return `${file}${KEY_SEPARATOR}${api}`;
}

/** A `chrome.<api>.<event>` listener path, the shape both extension files use. */
const CHROME_API_RE = /^chrome(?:\.[A-Za-z][A-Za-z0-9]*)+$/;
/** A DOM event name as the enumerations state it. */
const DOM_EVENT_RE = /^[a-z]+$/;
/** A low-level hook constant as the desktop clause names it. */
const HOOK_NAME_RE = /^WH_[A-Z0-9_]+$/;
/** A WinEvent constant as the desktop sources and doc name it. */
const WIN_EVENT_RE = /^EVENT_[A-Z0-9_]+$/;
/**
 * The receivers a DOM listener registration is modelled on. `document` is the
 * receiver §ECP-6 states; `window` is modelled so a listener moved there is
 * read and reported, rather than becoming invisible to the scan.
 */
const DOM_RECEIVERS = new Set(['document', 'window']);
/** The receiver §ECP-6 states the recorder listens on. */
export const ENUMERATED_RECEIVER = 'document';
/** The loop the WinEvent registrations are installed from. */
const WIN_EVENT_LOOP_ANCHOR = 'for (event_min, event_max) in [';
/** The WinEvent hook installation call. */
const WIN_EVENT_INSTALL = 'SetWinEventHook';
/** The low-level hook installation call. */
const LOW_LEVEL_INSTALL = 'SetWindowsHookExW';

/**
 * The Win32 WinEvent constants, restated from the `windows` crate the desktop
 * capture backend imports them from (crate `windows` 0.62, `Win32::UI::
 * WindowsAndMessaging`). They are frozen ABI values; they exist here only so a
 * registered `(min, max)` range can be expanded id by id, which endpoint
 * comparison cannot do. An endpoint this table does not carry is a refusal, not
 * a pass.
 */
export const WIN_EVENT_VALUES = {
  EVENT_SYSTEM_SOUND: 1,
  EVENT_SYSTEM_ALERT: 2,
  EVENT_SYSTEM_FOREGROUND: 3,
  EVENT_SYSTEM_MENUSTART: 4,
  EVENT_SYSTEM_MENUEND: 5,
  EVENT_SYSTEM_MENUPOPUPSTART: 6,
  EVENT_SYSTEM_MENUPOPUPEND: 7,
  EVENT_SYSTEM_CAPTURESTART: 8,
  EVENT_SYSTEM_CAPTUREEND: 9,
  EVENT_SYSTEM_MOVESIZESTART: 10,
  EVENT_SYSTEM_MOVESIZEEND: 11,
  EVENT_SYSTEM_CONTEXTHELPSTART: 12,
  EVENT_SYSTEM_CONTEXTHELPEND: 13,
  EVENT_SYSTEM_DRAGDROPSTART: 14,
  EVENT_SYSTEM_DRAGDROPEND: 15,
  EVENT_SYSTEM_DIALOGSTART: 16,
  EVENT_SYSTEM_DIALOGEND: 17,
  EVENT_SYSTEM_SCROLLINGSTART: 18,
  EVENT_SYSTEM_SCROLLINGEND: 19,
  EVENT_SYSTEM_SWITCHSTART: 20,
  EVENT_SYSTEM_SWITCHEND: 21,
  EVENT_SYSTEM_MINIMIZESTART: 22,
  EVENT_SYSTEM_MINIMIZEEND: 23,
  EVENT_SYSTEM_DESKTOPSWITCH: 32,
  EVENT_SYSTEM_END: 255,
  EVENT_OBJECT_CREATE: 32768,
  EVENT_OBJECT_DESTROY: 32769,
  EVENT_OBJECT_SHOW: 32770,
  EVENT_OBJECT_HIDE: 32771,
  EVENT_OBJECT_REORDER: 32772,
  EVENT_OBJECT_FOCUS: 32773,
  EVENT_OBJECT_SELECTION: 32774,
  EVENT_OBJECT_SELECTIONADD: 32775,
  EVENT_OBJECT_SELECTIONREMOVE: 32776,
  EVENT_OBJECT_SELECTIONWITHIN: 32777,
  EVENT_OBJECT_STATECHANGE: 32778,
  EVENT_OBJECT_LOCATIONCHANGE: 32779,
  EVENT_OBJECT_NAMECHANGE: 32780,
  EVENT_OBJECT_DESCRIPTIONCHANGE: 32781,
  EVENT_OBJECT_VALUECHANGE: 32782,
  EVENT_OBJECT_PARENTCHANGE: 32783,
  EVENT_OBJECT_HELPCHANGE: 32784,
  EVENT_OBJECT_DEFACTIONCHANGE: 32785,
  EVENT_OBJECT_ACCELERATORCHANGE: 32786,
  EVENT_OBJECT_INVOKED: 32787,
  EVENT_OBJECT_TEXTSELECTIONCHANGED: 32788,
  EVENT_OBJECT_CONTENTSCROLLED: 32789,
  EVENT_SYSTEM_ARRANGMENTPREVIEW: 32790,
  EVENT_OBJECT_CLOAKED: 32791,
  EVENT_OBJECT_UNCLOAKED: 32792,
  EVENT_OBJECT_LIVEREGIONCHANGED: 32793,
  EVENT_OBJECT_HOSTEDOBJECTSINVALIDATED: 32800,
  EVENT_OBJECT_DRAGSTART: 32801,
  EVENT_OBJECT_DRAGCANCEL: 32802,
  EVENT_OBJECT_DRAGCOMPLETE: 32803,
  EVENT_OBJECT_DRAGENTER: 32804,
  EVENT_OBJECT_DRAGLEAVE: 32805,
  EVENT_OBJECT_DRAGDROPPED: 32806,
  EVENT_OBJECT_END: 33023,
};

/**
 * The extension listener registrations that are admitted as something other
 * than a capture surface, keyed by file and API path. Every `chrome.*`
 * registration either extension file makes is either a capture proxy the
 * ECP-7 table's Event source column names, or an entry here — nothing else
 * passes. `occurrences` is the exact number of registrations of that API in
 * that file, so an added one reds until it is admitted with its own role.
 */
export const ADMITTED_REGISTRATIONS = [
  {
    file: RECORDER_PATH,
    api: 'chrome.storage.onChanged',
    occurrences: 1,
    why: "The recorder's own `recording` watch: it arms capture when a recording starts and disarms it in place when one stops, which is what leaves a recorder a prior recording left in a still-open document inert (ECP-2).",
  },
  {
    file: WORKER_PATH,
    api: 'chrome.runtime.onInstalled',
    occurrences: 1,
    why: 'First-install state seeding — it writes the empty project and pending-action keys the rest of the extension reads. It observes no user interaction.',
  },
  {
    file: WORKER_PATH,
    api: 'chrome.action.onClicked',
    occurrences: 1,
    why: 'Extension UI: the toolbar icon opens the side panel. The panel is the recording UI, never a recorded application.',
  },
  {
    file: WORKER_PATH,
    api: 'chrome.storage.onChanged',
    occurrences: 2,
    why: 'Two watches on the same storage surface: the `recording` key drives the record-start injection sweep, the active-frame registry clear, and the in-memory capture mirror (ECP-2, ECP-3); the sync-state key reconciles the background Auto-Sync trigger with the persisted setting.',
  },
  {
    file: WORKER_PATH,
    api: 'chrome.webNavigation.onCompleted',
    occurrences: 1,
    why: 'The per-frame injection path: each frame that finishes loading during a recording is injected into and registered as a trusted frame (ECP-2, ECP-3). It records no action of its own.',
  },
  {
    file: WORKER_PATH,
    api: 'chrome.webNavigation.onBeforeNavigate',
    occurrences: 1,
    why: "The active-frame registry's subframe departure route: a subframe navigating away loses its registry entry so its frame id cannot be reused (ECP-3).",
  },
  {
    file: WORKER_PATH,
    api: 'chrome.alarms.onAlarm',
    occurrences: 1,
    why: "Auto-Sync's periodic backstop trigger, which survives a service-worker suspension. It observes no user interaction.",
  },
  {
    file: WORKER_PATH,
    api: 'chrome.runtime.onMessage',
    occurrences: 1,
    why: "The extension's own message port: the recorder's tab-id request and its FRAME_READY registration, the APPEND_ACTION trust gate and sender stamping (ECP-3, ECP-4), and the panel command dispatcher. Actions arrive through it; none originates there.",
  },
];

/**
 * Read the DOM events ECP-6 enumerates: the leading backticked token of each
 * list item inside that clause's scope. An item whose leading token is not a
 * lone backticked lowercase event name is returned as unreadable, never
 * skipped.
 * @param {string} docText the extension capture doc's text
 * @returns {{ events: string[], unreadable: string[] }}
 */
export function extractDomEnumeration(docText) {
  const events = [];
  const unreadable = [];
  const scope = extractClauseSection(docText, DOM_CLAUSE_ID);
  for (const line of scope.split('\n')) {
    if (!/^\s*-\s/.test(line)) continue;
    const match = /^\s*-\s+`([^`]+)`(?:\s|$)/.exec(line);
    if (match && DOM_EVENT_RE.test(match[1])) events.push(match[1]);
    else unreadable.push(line.trim());
  }
  return { events, unreadable };
}

/**
 * Read the ECP-7 proxy table's Event source column: the backticked tokens of
 * each body row's source cell, split into the worker events (`chrome.a.onB`)
 * and the DOM events (bare lowercase names) it names. A row with no readable
 * token, or a token in neither shape, is returned as unreadable.
 * @param {string} docText the extension capture doc's text
 * @returns {{ workerEvents: string[], domEvents: string[], unreadable: string[] }}
 */
export function extractProxySources(docText) {
  const workerEvents = [];
  const domEvents = [];
  const unreadable = [];
  for (const table of parseTables(docText)) {
    if (table.section !== PROXY_SECTION) continue;
    if ((table.header[0] ?? '').trim() !== PROXY_HEADER) continue;
    const column = table.header.findIndex((cell) => cell.trim() === SOURCE_HEADER);
    if (column === -1) {
      unreadable.push(`(the proxy table states no ${SOURCE_HEADER} column)`);
      continue;
    }
    for (const row of table.rows) {
      const cell = (row[column] ?? '').trim();
      const tokens = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
      if (tokens.length === 0) {
        unreadable.push(cell === '' ? '(empty Event source cell)' : cell);
        continue;
      }
      for (const token of tokens) {
        if (CHROME_API_RE.test(token)) workerEvents.push(token);
        else if (DOM_EVENT_RE.test(token)) domEvents.push(token);
        else unreadable.push(token);
      }
    }
  }
  return { workerEvents, domEvents, unreadable };
}

/**
 * Read one extension file's listener registrations through the shared
 * comment-safe tokenizer: `<receiver>.addEventListener('<event>'` and
 * `chrome.<path>.addListener(`. A registration whose event name is not a
 * string literal, whose receiver is outside the modelled set, or whose
 * `addListener` chain does not start at `chrome` is a problem of this
 * extractor, so it reds rather than vanishing. DOM registrations are returned
 * split by receiver: `domEvents` are the ones on the receiver §ECP-6 states,
 * `windowEvents` the ones on `window`, which the evaluator holds separately.
 * @param {string} source the file's source
 * @param {string} path the file's repo-relative path (for diagnostics)
 * @returns {{ domEvents: string[], windowEvents: string[], chromeApis: string[], problems: string[] }}
 */
export function extractRegistrations(source, path) {
  const tokens = tokenizeJs(source);
  const domEvents = [];
  const windowEvents = [];
  const chromeApis = [];
  const problems = [];
  const at = (i, type, value) => tokens[i] && tokens[i].type === type && tokens[i].value === value;

  for (let i = 0; i < tokens.length; i++) {
    if (at(i, 'word', 'addEventListener') && at(i - 1, 'punct', '.')) {
      const receiver = tokens[i - 2];
      if (!receiver || receiver.type !== 'word' || !DOM_RECEIVERS.has(receiver.value)) {
        problems.push(`${path} registers a DOM listener on a receiver the scan does not model (${receiver?.value ?? '?'}) — the modelled receivers are document and window`); // prettier-ignore
        continue;
      }
      // The literal must be the WHOLE first argument, which the following
      // comma is what establishes: `'mouse' + 'down'` tokenizes as a string
      // first, so reading the string alone would silently record `mouse`.
      if (
        !at(i + 1, 'punct', '(') ||
        tokens[i + 2]?.type !== 'string' ||
        !at(i + 3, 'punct', ',')
      ) {
        problems.push(`${path} registers a DOM listener on ${receiver.value} whose event name is not a string literal standing alone as the first argument — a concatenated or computed name is refused, never read as its leading fragment`); // prettier-ignore
        continue;
      }
      const target = receiver.value === ENUMERATED_RECEIVER ? domEvents : windowEvents;
      target.push(tokens[i + 2].value);
      continue;
    }
    if (at(i, 'word', 'addListener') && at(i - 1, 'punct', '.')) {
      const chain = [];
      let j = i - 1;
      while (j > 0 && at(j, 'punct', '.') && tokens[j - 1]?.type === 'word') {
        chain.unshift(tokens[j - 1].value);
        j -= 2;
      }
      const api = chain.join('.');
      if (chain.length < 2 || chain[0] !== 'chrome' || !CHROME_API_RE.test(api)) {
        problems.push(`${path} registers a listener the scan does not model (${api || '?'}.addListener) — the modelled shape is chrome.<api>.<event>.addListener`); // prettier-ignore
        continue;
      }
      chromeApis.push(api);
    }
  }
  return { domEvents, windowEvents, chromeApis, problems };
}

/**
 * Read the desktop hook installations from the Windows capture backend: the
 * first argument of every `SetWindowsHookExW` call, and the `(min, max)` pairs
 * of the one loop the `SetWinEventHook` calls are installed from. Anchor
 * failures — no loop, more than one, a `SetWinEventHook` call outside it, a
 * pair the scan cannot read — are this extractor's own problems.
 * @param {string} rustSource the capture backend's source
 * @returns {{ hooks: string[], ranges: [string, string][], problems: string[] }}
 */
export function extractDesktopRegistrations(rustSource) {
  const stripped = stripRustComments(rustSource);
  const problems = [];
  const hooks = [];
  const named = new RegExp(`\\b${LOW_LEVEL_INSTALL}\\s*\\(\\s*([A-Za-z0-9_]+)`, 'g');
  for (const match of stripped.matchAll(named)) hooks.push(match[1]);
  const bareHookCalls = [...stripped.matchAll(new RegExp(`\\b${LOW_LEVEL_INSTALL}\\s*\\(`, 'g'))].length; // prettier-ignore
  if (bareHookCalls !== hooks.length) {
    problems.push(`${WINDOWS_CAPTURE_PATH} installs a low-level hook whose first argument the scan cannot read as a constant name`); // prettier-ignore
  }

  const ranges = [];
  const anchors = [];
  let from = 0;
  for (;;) {
    const found = stripped.indexOf(WIN_EVENT_LOOP_ANCHOR, from);
    if (found === -1) break;
    anchors.push(found);
    from = found + WIN_EVENT_LOOP_ANCHOR.length;
  }
  const installs = [...stripped.matchAll(new RegExp(`\\b${WIN_EVENT_INSTALL}\\s*\\(`, 'g'))].length;
  if (anchors.length !== 1) {
    problems.push(`${WINDOWS_CAPTURE_PATH} carries ${anchors.length} WinEvent registration loops — the scan models exactly one \`${WIN_EVENT_LOOP_ANCHOR}\``); // prettier-ignore
    return { hooks, ranges, problems };
  }
  if (installs !== 1) {
    problems.push(`${WINDOWS_CAPTURE_PATH} carries ${installs} ${WIN_EVENT_INSTALL} call sites — the scan models exactly one, inside the registration loop`); // prettier-ignore
    return { hooks, ranges, problems };
  }

  const open = anchors[0] + WIN_EVENT_LOOP_ANCHOR.length - 1;
  let depth = 0;
  let close = -1;
  for (let i = open; i < stripped.length; i++) {
    if (stripped[i] === '[') depth++;
    else if (stripped[i] === ']' && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close === -1) {
    problems.push(`${WINDOWS_CAPTURE_PATH}'s WinEvent registration list is not closed — the range scan cannot run`); // prettier-ignore
    return { hooks, ranges, problems };
  }
  const body = stripped.slice(open + 1, close);
  if (stripped.indexOf(`${WIN_EVENT_INSTALL}`, close) === -1) {
    problems.push(`${WINDOWS_CAPTURE_PATH} installs its WinEvent hook outside the registration loop the scan reads the ranges from`); // prettier-ignore
  }
  for (const piece of body.split(/\)\s*,/)) {
    const text = piece.trim();
    if (text === '' || text === ')') continue;
    const match = /^\(?\s*([A-Za-z0-9_]+)\s*,\s*([A-Za-z0-9_]+)\s*\)?$/.exec(text);
    if (!match) {
      problems.push(`${WINDOWS_CAPTURE_PATH} states a WinEvent registration the scan cannot read as an (event_min, event_max) pair — ${text}`); // prettier-ignore
      continue;
    }
    ranges.push([match[1], match[2]]);
  }
  return { hooks, ranges, problems };
}

/**
 * Read the backticked names inside a clause's scope that match a shape — the
 * DCP-4 hook names, read from the clause the desktop surface is stated in.
 * @param {string} docText the desktop capture doc's text
 * @param {string} clauseId the clause whose scope is read
 * @param {RegExp} shape the shape a name must match to count
 * @returns {string[]} the matching names, in document order
 */
export function extractClauseNames(docText, clauseId, shape) {
  const scope = extractClauseSection(docText, clauseId);
  return [...scope.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((name) => shape.test(name));
}

/**
 * Read the WinEvent classes the Input Correlation table names — the
 * first-column backticked name of each body row. A row whose first cell is not
 * a lone backticked name is returned as unreadable.
 * @param {string} docText the desktop capture doc's text
 * @returns {{ classes: string[], unreadable: string[] }}
 */
export function extractCorrelationClasses(docText) {
  const classes = [];
  const unreadable = [];
  for (const table of parseTables(stripFences(docText))) {
    if (table.section !== CORRELATION_SECTION) continue;
    if ((table.header[0] ?? '').trim() !== CORRELATION_HEADER) continue;
    for (const row of table.rows) {
      const cell = (row[0] ?? '').trim();
      const name = backtickedName(cell);
      if (name !== null && WIN_EVENT_RE.test(name)) classes.push(name);
      else unreadable.push(cell === '' ? '(empty WinEvent cell)' : cell);
    }
  }
  return { classes, unreadable };
}

/**
 * Expand a registered `(min, max)` range to the event ids it contains.
 * @param {[string, string]} range the endpoint constant names
 * @returns {{ ids: number[], problems: string[] }}
 */
export function expandRange([min, max]) {
  const problems = [];
  const lo = WIN_EVENT_VALUES[min];
  const hi = WIN_EVENT_VALUES[max];
  for (const [name, value] of [
    [min, lo],
    [max, hi],
  ]) {
    if (value === undefined) {
      problems.push(`\`${name}\` is registered as a WinEvent range endpoint but this check carries no value for it — the range cannot be expanded, so its contents cannot be held to ${CORRELATION_CLAUSE_ID}`); // prettier-ignore
    }
  }
  if (problems.length) return { ids: [], problems };
  if (hi < lo) {
    return { ids: [], problems: [`the WinEvent range \`${min}\`–\`${max}\` runs backwards — the scan cannot expand it`] }; // prettier-ignore
  }
  const ids = [];
  for (let id = lo; id <= hi; id++) ids.push(id);
  return { ids, problems };
}

/** Reverse lookup for diagnostics: the constant name a value carries, if any. */
function nameOf(value) {
  for (const [name, v] of Object.entries(WIN_EVENT_VALUES)) if (v === value) return name;
  return null;
}

/**
 * The non-empty guard's legs: every parsed surface, with its empty-parse
 * diagnosis. Exported so the unit suite's family is generated from this list.
 */
export const EMPTY_SURFACES = [
  ['docDomEvents', `no DOM events enumerated in ${EXTENSION_DOC_PATH} §${DOM_CLAUSE_ID}`],
  ['docProxyWorkerEvents', `no worker events named in the ${SOURCE_HEADER} column of ${EXTENSION_DOC_PATH} §${PROXY_CLAUSE_ID}`], // prettier-ignore
  ['recorderDomEvents', `no DOM listener registrations found in ${RECORDER_PATH}`],
  ['workerChromeApis', `no chrome listener registrations found in ${WORKER_PATH}`],
  ['docHooks', `no low-level hooks named in ${DESKTOP_DOC_PATH} §${DESKTOP_CLAUSE_ID}`],
  ['docCorrelationClasses', `no WinEvent classes found in the ${CORRELATION_SECTION} table of ${DESKTOP_DOC_PATH}`], // prettier-ignore
  ['installedHooks', `no low-level hook installations found in ${WINDOWS_CAPTURE_PATH}`],
  ['installedRanges', `no WinEvent registrations found in ${WINDOWS_CAPTURE_PATH}`],
];

/**
 * The duplicates guard's legs — a repeated entry in an enumeration is drift the
 * deduplicating set diffs cannot see, and on the registration side a repeated
 * entry installs the same surface twice. `installedRangeLabels` is derived
 * inside the evaluator from the registered `(min, max)` pairs, because a
 * repeated pair installs the WinEvent hook twice while the containment diff,
 * being set-based, stays green. The proxy table's source column is exempt:
 * several user actions legitimately share one worker event.
 */
export const DUPLICATE_SURFACES = [
  ['docDomEvents', `the ${DOM_CLAUSE_ID} DOM-event enumeration`],
  ['recorderDomEvents', `the recorder's DOM listener registrations`],
  ['docHooks', `the ${DESKTOP_CLAUSE_ID} hook enumeration`],
  ['docCorrelationClasses', `the ${CORRELATION_SECTION} table`],
  ['installedHooks', `the installed low-level hooks`],
  ['installedRangeLabels', `the registered WinEvent ranges`],
];

/**
 * Pure core: evaluate both platforms' capture-surface contracts.
 * @param {object} s the extracted surfaces
 * @param {string[]} s.docDomEvents ECP-6's enumerated DOM events
 * @param {string[]} s.docProxyWorkerEvents ECP-7's named worker events
 * @param {string[]} s.docProxyDomEvents ECP-7's named DOM events
 * @param {string[]} s.extensionUnreadable unreadable extension-doc entries
 * @param {string[]} s.recorderDomEvents the recorder's `document` registrations
 * @param {string[]} s.recorderWindowEvents the recorder's `window` registrations (none enumerated)
 * @param {string[]} s.recorderChromeApis the recorder's chrome registrations
 * @param {string[]} s.workerDomEvents DOM registrations in the worker (none modelled)
 * @param {string[]} s.workerChromeApis the worker's chrome registrations
 * @param {string[]} s.docHooks DCP-4's named low-level hooks
 * @param {string[]} s.docCorrelationClasses DCP-7's WinEvent classes
 * @param {string[]} s.desktopUnreadable unreadable desktop-doc entries
 * @param {string[]} s.installedHooks the installed low-level hooks
 * @param {[string, string][]} s.installedRanges the registered WinEvent ranges
 * @param {object[]} s.admitted the admission list
 * @returns {string[]} problems; empty when every contract holds
 */
export function evaluateCaptureSurface(s) {
  const problems = [];

  for (const entry of s.extensionUnreadable) {
    problems.push(`${EXTENSION_DOC_PATH} carries a capture-surface entry the scan cannot read — ${entry} — enumeration items lead with a lone backticked name`); // prettier-ignore
  }
  for (const entry of s.desktopUnreadable) {
    problems.push(`${DESKTOP_DOC_PATH} carries a capture-surface entry the scan cannot read — ${entry} — enumeration items lead with a lone backticked name`); // prettier-ignore
  }
  for (const event of s.workerDomEvents) {
    problems.push(`${WORKER_PATH} registers a DOM listener for \`${event}\` — the worker's surface is the chrome-event surface ${PROXY_CLAUSE_ID} states, and the scan models no DOM listener there`); // prettier-ignore
  }
  // The receiver is part of the enumeration, not an implementation detail:
  // §ECP-6 states the recorder listens on `document`, and a listener on
  // `window` sees a different event population (no per-element bubbling
  // origin, a different set of events that reach it at all).
  for (const event of s.recorderWindowEvents) {
    problems.push(`${RECORDER_PATH} registers \`${event}\` on \`window\` — §${DOM_CLAUSE_ID} states the recorder listens on \`${ENUMERATED_RECEIVER}\`, so the receiver is part of the enumerated surface`); // prettier-ignore
  }

  let vacuous = false;
  for (const [key, message] of EMPTY_SURFACES) {
    if (s[key].length === 0) {
      problems.push(message);
      vacuous = true;
    }
  }
  if (vacuous) return problems; // empty parses make set diffs meaningless

  const withDerived = {
    ...s,
    installedRangeLabels: s.installedRanges.map(([min, max]) => `${min}–${max}`),
  };
  for (const [key, what] of DUPLICATE_SURFACES) {
    problems.push(...duplicatesIn(withDerived[key], what));
  }

  // ── The extension's DOM surface (ECP-6) ────────────────────────────────────
  problems.push(
    ...missingFrom(s.recorderDomEvents, s.docDomEvents, `is registered in ${RECORDER_PATH} but §${DOM_CLAUSE_ID} does not enumerate it — the surface is closed, so a new event is stated or it is not captured`), // prettier-ignore
    ...missingFrom(s.docDomEvents, s.recorderDomEvents, `is enumerated by §${DOM_CLAUSE_ID} but ${RECORDER_PATH} registers no listener for it`), // prettier-ignore
    ...missingFrom(s.docProxyDomEvents, s.docDomEvents, `is named as a proxy's ${SOURCE_HEADER} but §${DOM_CLAUSE_ID} does not enumerate it`), // prettier-ignore
  );

  // ── The extension's browser-chrome proxy surface (ECP-7) ───────────────────
  const admittedKeys = new Set(s.admitted.map((entry) => admissionKey(entry.file, entry.api)));
  const proxyEvents = new Set(s.docProxyWorkerEvents);
  const registeredCounts = new Map();
  const record = (file, api) => {
    const key = admissionKey(file, api);
    registeredCounts.set(key, (registeredCounts.get(key) ?? 0) + 1);
  };
  for (const api of s.workerChromeApis) record(WORKER_PATH, api);
  for (const api of s.recorderChromeApis) record(RECORDER_PATH, api);

  for (const [key, count] of registeredCounts) {
    const [file, api] = key.split(KEY_SEPARATOR);
    const isProxy = file === WORKER_PATH && proxyEvents.has(api);
    if (isProxy && admittedKeys.has(key)) {
      problems.push(`\`${api}\` is both a capture proxy in the §${PROXY_CLAUSE_ID} table and an admitted non-capture registration — one registration, one role`); // prettier-ignore
      continue;
    }
    if (isProxy) {
      // A proxy's multiplicity is part of its contract: a second registration
      // of the same worker event emits a second proxy for one user action.
      if (count !== 1) {
        problems.push(`${file} registers the capture proxy \`${api}\` ${count} time(s) — one user action produces at most one proxy (core CP-9), so each proxy event is registered exactly once`); // prettier-ignore
      }
      continue;
    }
    if (!admittedKeys.has(key)) {
      problems.push(`${file} registers \`${api}\`, which is neither a capture proxy the §${PROXY_CLAUSE_ID} ${SOURCE_HEADER} column names nor an admitted non-capture registration — state it in the doc, or admit it here with the role it plays`); // prettier-ignore
      continue;
    }
    const entry = s.admitted.find((e) => e.file === file && e.api === api);
    if (entry.occurrences !== count) {
      problems.push(`${file} registers \`${api}\` ${count} time(s); the admission list admits ${entry.occurrences} — every registration is admitted with its own role`); // prettier-ignore
    }
  }
  for (const entry of s.admitted) {
    if (!registeredCounts.has(admissionKey(entry.file, entry.api))) {
      problems.push(`the admission list admits \`${entry.api}\` in ${entry.file}, which registers no such listener — the entry is stale`); // prettier-ignore
    }
  }
  problems.push(
    ...missingFrom(s.docProxyWorkerEvents, s.workerChromeApis, `is named as a proxy's ${SOURCE_HEADER} in §${PROXY_CLAUSE_ID} but ${WORKER_PATH} registers no listener for it`), // prettier-ignore
  );

  // ── The desktop capture surface (DCP-4, DCP-7) ─────────────────────────────
  problems.push(
    ...missingFrom(s.installedHooks, s.docHooks, `is installed by ${WINDOWS_CAPTURE_PATH} but §${DESKTOP_CLAUSE_ID} does not name it`), // prettier-ignore
    ...missingFrom(s.docHooks, s.installedHooks, `is named by §${DESKTOP_CLAUSE_ID} but ${WINDOWS_CAPTURE_PATH} installs no such hook`), // prettier-ignore
  );

  const named = new Set(s.docCorrelationClasses);
  const covered = new Set();
  for (const range of s.installedRanges) {
    const { ids, problems: expansion } = expandRange(range);
    problems.push(...expansion);
    for (const id of ids) {
      const name = nameOf(id);
      if (name !== null && named.has(name)) {
        covered.add(name);
        continue;
      }
      problems.push(`the registered WinEvent range \`${range[0]}\`–\`${range[1]}\` contains ${name === null ? `event id ${id}` : `\`${name}\``}, which the ${CORRELATION_SECTION} table does not name — a range is held by what it contains, not by its endpoints`); // prettier-ignore
    }
  }
  for (const name of s.docCorrelationClasses) {
    if (!covered.has(name)) {
      problems.push(`\`${name}\` is named in the ${CORRELATION_SECTION} table but no registered WinEvent range contains it`); // prettier-ignore
    }
  }

  return problems;
}

/**
 * Read every surface from the working tree and evaluate both contracts.
 * @param {(f: string) => string} readFile repo-relative content reader
 * @returns {{ problems: string[], domEventCount: number, proxyCount: number, winEventCount: number }}
 */
export function auditTree(readFile) {
  const extensionDoc = readFile(EXTENSION_DOC_PATH);
  const desktopDoc = readFile(DESKTOP_DOC_PATH);
  const dom = extractDomEnumeration(extensionDoc);
  const proxies = extractProxySources(extensionDoc);
  const recorder = extractRegistrations(readFile(RECORDER_PATH), RECORDER_PATH);
  const worker = extractRegistrations(readFile(WORKER_PATH), WORKER_PATH);
  const correlation = extractCorrelationClasses(desktopDoc);
  const desktop = extractDesktopRegistrations(readFile(WINDOWS_CAPTURE_PATH));

  const s = {
    docDomEvents: dom.events,
    docProxyWorkerEvents: proxies.workerEvents,
    docProxyDomEvents: proxies.domEvents,
    extensionUnreadable: [...dom.unreadable, ...proxies.unreadable],
    recorderDomEvents: recorder.domEvents,
    recorderWindowEvents: recorder.windowEvents,
    recorderChromeApis: recorder.chromeApis,
    // The worker's surface is the chrome-event one; a DOM listener there reds
    // whichever receiver it was registered on.
    workerDomEvents: [...worker.domEvents, ...worker.windowEvents],
    workerChromeApis: worker.chromeApis,
    docHooks: extractClauseNames(desktopDoc, DESKTOP_CLAUSE_ID, HOOK_NAME_RE),
    docCorrelationClasses: correlation.classes,
    desktopUnreadable: correlation.unreadable,
    installedHooks: desktop.hooks,
    installedRanges: desktop.ranges,
    admitted: ADMITTED_REGISTRATIONS,
  };
  return {
    problems: [
      ...recorder.problems,
      ...worker.problems,
      ...desktop.problems,
      ...evaluateCaptureSurface(s),
    ],
    domEventCount: new Set(s.docDomEvents).size,
    proxyCount: new Set(s.docProxyWorkerEvents).size,
    winEventCount: new Set(s.docCorrelationClasses).size,
  };
}

/* c8 ignore start — the CLI wrapper reads the tree and formats the pass/fail
   output; the pure extraction and evaluation core above is unit-tested. */
function run() {
  const readFile = (f) => {
    try {
      return readFileSync(f, 'utf8');
    } catch {
      return ''; // an unreadable surface fails the non-empty guards loudly
    }
  };
  const { problems, domEventCount, proxyCount, winEventCount } = auditTree(readFile);

  if (problems.length) {
    console.error(
      `✗ a capture surface drifted from its committed enumeration:\n` +
        problems.map((p) => `    ${p}`).join('\n') +
        `\n\n  Each platform's capture surface is enumerated positively and treated as closed\n` +
        `  (${'docs/architecture/system/capture-principles.md'} §CP-14). The recorder's\n` +
        `  \`${ENUMERATED_RECEIVER}\` listeners must equal §${DOM_CLAUSE_ID}'s enumeration; the worker's capture proxies\n` +
        `  must equal the worker events the §${PROXY_CLAUSE_ID} table's ${SOURCE_HEADER} column names, each\n` +
        `  registered once (a DOM event that column names is held to §${DOM_CLAUSE_ID}'s enumeration\n` +
        `  instead), with every other registration in ${RECORDER_PATH}\n` +
        `  or ${WORKER_PATH} admitted in\n` +
        `  ${'scripts/check-capture-surface.js'} with the role it plays; the installed low-level hooks\n` +
        `  must equal §${DESKTOP_CLAUSE_ID}'s enumeration and the ${CORRELATION_SECTION} classes must each be covered\n` +
        `  by a registered WinEvent range, both in both directions; and every id a registered\n` +
        `  range contains must be one of those classes — containment, so a widened pair reds.\n` +
        `  Update the drifted surfaces together in the same change.\n`,
    );
    process.exit(1);
  }
  console.log(
    `✓ capture surfaces consistent: ${domEventCount} DOM events match the recorder's listeners; ` +
      `${proxyCount} worker proxy events match the browser-chrome table; ` +
      `${winEventCount} WinEvent classes contain every registered desktop range.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
/* c8 ignore stop */
