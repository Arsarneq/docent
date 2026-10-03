/**
 * check-pin-history.js — Probe that every SHA-pinned action sits on its
 * upstream's default-branch history.
 *
 * A pin is a commit SHA (check-action-pins.js holds every `uses:` to one); this
 * probe holds the policy docs/guides/ci.md states for which commit that is: one
 * reachable from the upstream's default branch, the history an upstream does
 * not rewrite. A commit that sits only on a branch the upstream re-points stops
 * being fetchable when that branch moves, and every job using it fails.
 *
 * It reads every `uses:` reference through check-action-pins.js's `readUses`,
 * over the same files that check scans, and groups the SHA-pinned ones by
 * `owner/repo@sha` (an action in a subdirectory of its repository, such as
 * `actions/cache/restore`, is its repository's pin). For each upstream it asks
 * GitHub's REST API for the repository, whose answer names the default branch,
 * and then compares that branch with each pin
 * (`GET /repos/{owner}/{repo}/compare/{default}...{sha}`). The verdicts:
 *
 *   - `identical` or `behind` — the pin is on the default branch's history.
 *   - `ahead` or `diverged` — the pin is off that history: one problem naming
 *     the pin, each file:line that states it, and the base it was compared
 *     with (exit 1).
 *   - a 404 on the repository lookup — the upstream is gone (deleted, or no
 *     longer public): one problem naming it, and one per pin to it, each as
 *     unfetchable (exit 1).
 *   - a 404 on the compare, made with the base the lookup itself returned —
 *     the pin is unfetchable: GitHub knows no such commit in that repository's
 *     network (exit 1). An upstream with no commits, or a default branch
 *     renamed between the two calls, answers the same way and reads as the
 *     same verdict.
 *   - any other HTTP status, a network failure, an answer missing the field
 *     this probe reads, a compare whose `status` is one this probe does not
 *     read, or a scan that read no pin at all — the machinery
 *     verdict, on this check's own exit code (exit 2), never a pass and never
 *     a pin off its history: the family grammar check-action-pins.js states.
 *   - the rate limit, read from any of three signals: a 403 or 429 whose
 *     `x-ratelimit-remaining` header reads `0`, a 403 or 429 that carries a
 *     `retry-after` header, or a 403 or 429 whose JSON body's `message` names
 *     a rate limit. It is that same machinery verdict and reads as such: the
 *     probe stops there and reports one line naming the upstream it met the
 *     limit at, how many further upstreams it did not probe, and when the
 *     limit resets. The reset is stated from a `retry-after` the probe can
 *     read (seconds, or an HTTP date), or from a non-empty, numeric
 *     `x-ratelimit-reset` when the signal was `x-ratelimit-remaining: 0`; in
 *     every other case the line says it resets at a time GitHub did not
 *     state. The remedy follows the signal and the run's own token: an
 *     anonymous run is told to set `GH_TOKEN`; an authenticated run that met
 *     `x-ratelimit-remaining: 0` is told it met the token's own limit; an
 *     authenticated run that met either other signal is given no remedy.
 *
 * Any other machinery verdict on one upstream is collected and reported beside
 * the pin problems the run found, and the probe goes on to the next upstream;
 * the rate limit is reported the same way, beside whatever the run found
 * before it. The exit code is 2 when any machinery verdict occurred, 1 when
 * only pin problems did, and 0 otherwise.
 *
 * The green line states how many pinned references were read, as how many
 * distinct pins, across how many upstreams, so a scan that stopped matching
 * cannot report a clean history while having probed nothing.
 *
 * A pin that must sit elsewhere than its upstream's default branch is outside
 * the policy as stated; this probe carries no allowlist for one, and gains one
 * when a case needs it. The reader is Node's `fetch`, whose default follows
 * redirects, so a renamed or transferred repository answers from its new
 * location. `GH_TOKEN` is sent as a bearer token when the environment carries
 * one, under that token's own rate limit; without it the probe reads
 * anonymously, under GitHub's unauthenticated rate limit, which is counted per
 * originating host per hour and shared by every anonymous reader on that host,
 * so a run can meet either. The HTTP reader is a seam, so the unit suite feeds
 * it answers and no test reaches the network.
 *
 * Runs weekly in .github/workflows/pin-history.yml (docs/guides/ci.md, "Weekly
 * pin-history probe"). It runs on that schedule because it depends on an
 * outside service — its availability and its limits — and a per-PR run is not
 * part of it: a pin bump is probed at the next weekly run, and a rate-limited
 * run is the machinery verdict and reads as such.
 *
 * Usage: node scripts/check-pin-history.js   # or: npm run check:pin-history
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { actionFiles, isPinned, readUses } from './check-action-pins.js';

const ROOT = resolve(import.meta.dirname, '..');
const API = 'https://api.github.com';

/** The compare statuses that put a pin on the base's history. */
const ON_HISTORY = new Set(['identical', 'behind']);
/** The compare statuses that put a pin off it. */
const OFF_HISTORY = new Set(['ahead', 'diverged']);

/**
 * An input this probe reads that answered with something other than what it
 * reads there — machinery breakage, reported on the probe's own exit code so it
 * is never read as a pin off its history.
 */
export class InputError extends Error {}

/** The rate limit an answer reported — the machinery verdict that stops the probe. */
export class RateLimitError extends InputError {
  /**
   * @param {object} limit what the answer stated
   * @param {number} limit.status the HTTP status
   * @param {string} limit.when when the limit resets, as text
   * @param {boolean} limit.authenticated whether the request carried a token
   * @param {boolean} limit.remainingZero whether `x-ratelimit-remaining` read `0`
   */
  constructor({ status, when, authenticated, remainingZero }) {
    super(`GitHub's API rate limit (HTTP ${status})`);
    this.status = status;
    this.when = when;
    this.authenticated = authenticated;
    this.remainingZero = remainingZero;
  }
}

/**
 * The SHA-pinned references the files state, grouped by upstream and pin.
 * A reference is admitted by check-action-pins.js's own `isPinned`, local
 * references then dropped: the first live in this repository, and a reference
 * not pinned to a SHA is that check's red. An admitted reference's text before
 * its last `@` names the upstream as `owner/repo`, any further path segment
 * being an action inside that repository.
 * @param {object} seams the reads this scan is taken through
 * @param {() => string[]} seams.listFiles the repo-relative files to scan
 * @param {(path: string) => string} seams.readFile repo-relative reader
 * @returns {{ refCount: number, upstreams: Map<string, Map<string, string[]>> }}
 *   the pinned references read, and per `owner/repo`, per SHA, the
 *   `file:line` sites stating it
 */
export function collectPins({ listFiles, readFile }) {
  const upstreams = new Map();
  let refCount = 0;
  for (const file of listFiles()) {
    for (const { line, ref } of readUses(readFile(file))) {
      if (ref.startsWith('./') || ref.startsWith('../') || !isPinned(ref)) continue;
      refCount++;
      const at = ref.lastIndexOf('@');
      const sha = ref.slice(at + 1);
      const [owner, repo] = ref.slice(0, at).split('/');
      const upstream = `${owner}/${repo}`;
      if (!upstreams.has(upstream)) upstreams.set(upstream, new Map());
      const pins = upstreams.get(upstream);
      if (!pins.has(sha)) pins.set(sha, []);
      pins.get(sha).push(`${file}:${line}`);
    }
  }
  return { refCount, upstreams };
}

/**
 * When a rate limit resets, as the answer's headers state it: after the
 * `retry-after` seconds, or at the HTTP date a non-numeric `retry-after`
 * states, when the probe can read that header; else at a non-empty, numeric
 * `x-ratelimit-reset` time when `x-ratelimit-remaining` reads `0`; else
 * unstated.
 * @param {{ remaining?: string | null, reset?: string | null, retryAfter?: string | null } | undefined} limit
 *   the headers, or undefined when the answer carried none
 * @returns {string} the reset, as text
 */
function resetText(limit) {
  const retryAfter = (limit?.retryAfter ?? '').trim();
  if (/^\d+$/.test(retryAfter)) return `after ${retryAfter} second(s)`;
  if (retryAfter !== '' && !Number.isNaN(new Date(retryAfter).getTime()))
    return `at ${new Date(retryAfter).toISOString()}`;
  const reset = (limit?.reset ?? '').trim();
  if (limit?.remaining === '0' && /^\d+$/.test(reset))
    return `at ${new Date(Number(reset) * 1000).toISOString()}`;
  return 'at a time GitHub did not state';
}

/**
 * One API answer, refused as machinery breakage unless its status is one of
 * those the caller reads; a rate-limited answer is refused as the rate limit.
 * @param {(path: string) => Promise<{ status: number, body: any,
 *   authenticated?: boolean, rateLimit?: { remaining: string | null, reset: string | null,
 *   retryAfter?: string | null } }>} request the reader
 * @param {string} path the API path
 * @param {number[]} statuses the statuses the caller reads
 * @returns {Promise<{ status: number, body: any }>} the answer
 */
async function answer(request, path, statuses) {
  let res;
  try {
    res = await request(path);
  } catch (error) {
    throw new InputError(`GET ${path} failed: ${error.message}`);
  }
  const limit = res.rateLimit;
  const bodyNamesLimit =
    (res.status === 403 || res.status === 429) &&
    typeof res.body?.message === 'string' &&
    /rate limit/i.test(res.body.message);
  if (
    bodyNamesLimit ||
    ((res.status === 403 || res.status === 429) &&
      (limit?.remaining === '0' || (limit?.retryAfter ?? null) !== null))
  ) {
    throw new RateLimitError({
      status: res.status,
      when: resetText(limit),
      authenticated: res.authenticated === true,
      remainingZero: limit?.remaining === '0',
    });
  }
  if (!statuses.includes(res.status)) {
    throw new InputError(`GET ${path} answered HTTP ${res.status}`);
  }
  return res;
}

/**
 * Pure core: every pin's verdict against its upstream's default branch.
 * @param {object} seams the reads this probe is taken through
 * @param {() => string[]} seams.listFiles the repo-relative files to scan
 * @param {(path: string) => string} seams.readFile repo-relative reader
 * @param {(path: string) => Promise<{ status: number, body: any }>} seams.request
 *   the GitHub REST reader, answering an API path with its status and parsed body
 * @returns {Promise<{ refCount: number, pinCount: number, upstreamCount: number,
 *   problems: string[], failures: string[] }>} the counts read, one line per pin
 *   problem, and one line per upstream whose answers this probe could not read
 * @throws {InputError} on a scan that read no pin
 */
export async function probePins({ listFiles, readFile, request }) {
  const { refCount, upstreams } = collectPins({ listFiles, readFile });
  if (refCount === 0) {
    throw new InputError(
      'the scan read no SHA-pinned `uses:` reference — this probe holds each one to its ' +
        "upstream's default-branch history, and a scan that read none is a read that found nothing",
    );
  }
  const problems = [];
  const failures = [];
  let pinCount = 0;
  let index = 0;
  for (const [upstream, pins] of upstreams) {
    pinCount += pins.size;
    index++;
    try {
      await probeUpstream(request, upstream, pins, problems);
    } catch (e) {
      if (e instanceof RateLimitError) {
        failures.push(rateLimitLine(e, upstream, upstreams.size - index));
        break;
      }
      if (!(e instanceof InputError)) throw e;
      failures.push(e.message);
    }
  }
  return { refCount, pinCount, upstreamCount: upstreams.size, problems, failures };
}

/**
 * The one line a rate limit is reported as.
 * @param {RateLimitError} limit the limit met
 * @param {string} upstream the upstream it was met at
 * @param {number} notProbed how many upstreams after it were not probed
 * @returns {string} the line
 */
function rateLimitLine(limit, upstream, notProbed) {
  let remedy = '; set GH_TOKEN to raise it';
  if (limit.authenticated)
    remedy = limit.remainingZero ? "; the run was authenticated, so this is the token's own limit" : ''; // prettier-ignore
  return (
    `${limit.message} met at ${upstream}; ${notProbed} further upstream(s) not probed; ` +
    `it resets ${limit.when}${remedy}`
  );
}

/**
 * One upstream's pins against its default branch, each pin problem pushed onto
 * `problems` as it is found.
 * @param {(path: string) => Promise<object>} request the GitHub REST reader
 * @param {string} upstream the `owner/repo`
 * @param {Map<string, string[]>} pins per SHA, the `file:line` sites stating it
 * @param {string[]} problems the run's pin problems, appended to
 * @returns {Promise<void>}
 * @throws {InputError} on an answer this probe does not read
 */
async function probeUpstream(request, upstream, pins, problems) {
  const repo = await answer(request, `/repos/${upstream}`, [200, 404]);
  if (repo.status === 404) {
    problems.push(`upstream ${upstream} is gone: its repository answers 404`);
    for (const [sha, sites] of pins)
      problems.push(`${upstream}@${sha} (${sites.join(', ')}) is unfetchable: its upstream is gone`); // prettier-ignore
    return;
  }
  const base = repo.body?.default_branch;
  if (typeof base !== 'string' || base === '') {
    throw new InputError(`GET /repos/${upstream} answered no default_branch`);
  }
  for (const [sha, sites] of pins) {
    const path = `/repos/${upstream}/compare/${encodeURIComponent(base)}...${sha}`;
    const cmp = await answer(request, path, [200, 404]);
    const pin = `${upstream}@${sha} (${sites.join(', ')})`;
    if (cmp.status === 404) {
      problems.push(`${pin} is unfetchable: the compare against ${base} answers 404`);
      continue;
    }
    const status = cmp.body?.status;
    if (OFF_HISTORY.has(status)) {
      problems.push(`${pin} is off the default-branch history: ${status} against ${base}`);
    } else if (!ON_HISTORY.has(status)) {
      throw new InputError(`GET ${path} answered compare status ${JSON.stringify(status)}`);
    }
  }
}

/**
 * The GitHub REST reader the command line uses: `fetch` against the API host,
 * with `GH_TOKEN` as a bearer token when given. Each answer states whether its
 * request was authenticated, and an answer carrying GitHub's rate-limit
 * headers carries them on as `rateLimit`.
 * @param {object} [options]
 * @param {string} [options.token] the token, or undefined for anonymous reads
 * @param {typeof globalThis.fetch} [options.fetchImpl] the fetch implementation
 * @returns {(path: string) => Promise<{ status: number, body: any,
 *   authenticated?: boolean, rateLimit?: { remaining: string | null, reset: string | null,
 *   retryAfter?: string | null } }>} the reader
 */
export function githubReader({ token, fetchImpl = globalThis.fetch } = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'docent-check-pin-history',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return async (path) => {
    const res = await fetchImpl(`${API}${path}`, { headers });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const out = { status: res.status, body, authenticated: Boolean(token) };
    const remaining = res.headers?.get('x-ratelimit-remaining') ?? null;
    const reset = res.headers?.get('x-ratelimit-reset') ?? null;
    const retryAfter = res.headers?.get('retry-after') ?? null;
    if (remaining !== null || reset !== null || retryAfter !== null)
      out.rateLimit = { remaining, reset, retryAfter };
    return out;
  };
}

/**
 * The machinery verdict's report: each input that answered with something
 * other than what this probe reads there.
 * @param {string[]} messages one line per such input
 * @returns {string} the report
 */
function machineryReport(messages) {
  return (
    `✗ an input this probe reads answered with something other than what it reads there:\n` +
    messages.map((m) => `    ${m}\n`).join('') +
    `\n  Exit 2 keeps machinery breakage apart from a pin off its upstream's history (exit 1).`
  );
}

/**
 * The command line's verdict over the given seams, as its exit code: 0 when
 * every pin is on its history, 1 when only pin problems were found, 2 when any
 * machinery breakage occurred, reported beside the pin problems found.
 * @param {object} seams the reads {@link probePins} takes, plus the output sinks
 * @param {(line: string) => void} seams.log the green-line sink
 * @param {(line: string) => void} seams.error the red-line sink
 * @returns {Promise<number>} the exit code
 */
export async function main({ listFiles, readFile, request, log, error }) {
  let result;
  try {
    result = await probePins({ listFiles, readFile, request });
  } catch (e) {
    if (!(e instanceof InputError)) throw e;
    error(machineryReport([e.message]));
    return 2;
  }
  const { refCount, pinCount, upstreamCount, problems, failures } = result;
  if (problems.length > 0) {
    for (const p of problems) error(`✗ ${p}`);
    error(
      `\n${problems.length} problem${problems.length === 1 ? '' : 's'}. Pin each action to a ` +
        `commit on its upstream's default branch (docs/guides/ci.md, "Pins reference stable history").`,
    );
  }
  if (failures.length > 0) {
    error(machineryReport(failures));
    return 2;
  }
  if (problems.length > 0) return 1;
  log(
    `✓ All ${refCount} SHA-pinned \`uses:\` reference(s) — ${pinCount} distinct pin(s) across ` +
      `${upstreamCount} upstream(s) — sit on their upstream's default-branch history.`,
  );
  return 0;
}

/* c8 ignore start -- CLI wrapper: main() and the reader are unit-tested over
 * injected seams; this glue binds them to the tree, the network and the
 * process. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main({
    listFiles: actionFiles,
    readFile: (rel) => readFileSync(join(ROOT, rel), 'utf8'),
    request: githubReader({ token: process.env.GH_TOKEN || undefined }),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  });
}
/* c8 ignore stop */
