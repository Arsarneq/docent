/**
 * check-pin-history.test.js — Unit tests for the pin-history probe
 * (scripts/check-pin-history.js): every SHA-pinned action is held to its
 * upstream's default-branch history through GitHub's compare API. The reader is
 * injected, so no case reaches the network. The suite drives each verdict the
 * command line can take through `main` — the green line stating its counts, a
 * pin `ahead` of or `diverged` from its base, a compare that answers 404, an
 * upstream whose repository answers 404, and the machinery verdicts (a status
 * outside those the probe reads, a network failure, an answer missing the field
 * it reads, a scan that read no pin, a rate limit that stops the probe and is
 * reported once with the remedy that fits the run (anonymous, or authenticated at
 * its own limit), and
 * one upstream's breakage reported beside another's pin problem) —
 * together with the grouping of references
 * into pins, the compare made against the base the lookup returned, and the
 * real reader's request shape over an injected `fetch`. A real-tree case holds
 * the scan to reading pins from the committed workflows.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { actionFiles } from '../../../../scripts/check-action-pins.js';
import {
  InputError,
  collectPins,
  githubReader,
  main,
  probePins,
} from '../../../../scripts/check-pin-history.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

/** A two-file tree: three upstreams, one of them pinned twice at one SHA. */
const FILES = {
  '.github/workflows/one.yml': [
    'jobs:',
    '  x:',
    '    steps:',
    `      - uses: actions/checkout@${A} # v7`,
    `      - uses: actions/cache/restore@${B} # v5`,
    '      - uses: ./.github/actions/local',
    '      - uses: some/tagged@v1',
  ].join('\n'),
  '.github/workflows/two.yml': [
    'jobs:',
    '  y:',
    '    steps:',
    `      - uses: actions/checkout@${A} # v7`,
    `      - uses: dtolnay/rust-toolchain@${C}`,
  ].join('\n'),
};

const listFiles = () => Object.keys(FILES);
const readFile = (path) => FILES[path];

/**
 * A reader answering from a table of path → answer, recording each path asked.
 * @param {Record<string, { status: number, body?: any } | Error>} table
 * @returns {{ request: (path: string) => Promise<object>, asked: string[] }}
 */
function readerFrom(table) {
  const asked = [];
  const request = async (path) => {
    asked.push(path);
    const entry = table[path];
    if (entry instanceof Error) throw entry;
    if (!entry) return { status: 500, body: null };
    return { body: null, ...entry };
  };
  return { request, asked };
}

/** Every lookup and compare the two-file tree needs, each answering green. */
function greenTable() {
  return {
    '/repos/actions/checkout': { status: 200, body: { default_branch: 'main' } },
    '/repos/actions/cache': { status: 200, body: { default_branch: 'main' } },
    '/repos/dtolnay/rust-toolchain': { status: 200, body: { default_branch: 'master' } },
    [`/repos/actions/checkout/compare/main...${A}`]: { status: 200, body: { status: 'behind' } },
    [`/repos/actions/cache/compare/main...${B}`]: { status: 200, body: { status: 'identical' } },
    [`/repos/dtolnay/rust-toolchain/compare/master...${C}`]: { status: 200, body: { status: 'behind' } }, // prettier-ignore
  };
}

/**
 * The command line's verdict over the two-file tree and a reader table.
 * @param {object} table the reader's answers
 * @returns {Promise<{ code: number, out: string[], err: string[] }>}
 */
async function run(table, files = { listFiles, readFile }) {
  const out = [];
  const err = [];
  const { request } = readerFrom(table);
  const code = await main({
    ...files,
    request,
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  });
  return { code, out, err };
}

describe('collectPins — the SHA-pinned references, grouped by upstream and pin', () => {
  it('groups a subdirectory action under its repository and passes over local and tag references', () => {
    const { refCount, upstreams } = collectPins({ listFiles, readFile });
    assert.equal(refCount, 4);
    assert.deepEqual([...upstreams.keys()], ['actions/checkout', 'actions/cache', 'dtolnay/rust-toolchain']); // prettier-ignore
    assert.deepEqual(upstreams.get('actions/checkout').get(A), [
      '.github/workflows/one.yml:4',
      '.github/workflows/two.yml:4',
    ]);
    assert.deepEqual(upstreams.get('actions/cache').get(B), ['.github/workflows/one.yml:5']);
  });
});

describe('main — the verdicts the command line takes', () => {
  it('all reachable: exit 0 with a green line stating the counts', async () => {
    const { code, out, err } = await run(greenTable());
    assert.equal(code, 0);
    assert.deepEqual(err, []);
    assert.deepEqual(out, [
      "✓ All 4 SHA-pinned `uses:` reference(s) — 3 distinct pin(s) across 3 upstream(s) — sit on their upstream's default-branch history.",
    ]);
  });

  it('a pin ahead of its base: exit 1 naming the pin, its sites and the base', async () => {
    const table = greenTable();
    table[`/repos/actions/checkout/compare/main...${A}`] = {
      status: 200,
      body: { status: 'ahead' },
    };
    const { code, err } = await run(table);
    assert.equal(code, 1);
    assert.equal(
      err[0],
      `✗ actions/checkout@${A} (.github/workflows/one.yml:4, .github/workflows/two.yml:4) is off the default-branch history: ahead against main`,
    );
  });

  it('a pin diverged from its base: exit 1 naming the pin', async () => {
    const table = greenTable();
    table[`/repos/dtolnay/rust-toolchain/compare/master...${C}`] = { status: 200, body: { status: 'diverged' } }; // prettier-ignore
    const { code, err } = await run(table);
    assert.equal(code, 1);
    assert.equal(
      err[0],
      `✗ dtolnay/rust-toolchain@${C} (.github/workflows/two.yml:5) is off the default-branch history: diverged against master`,
    );
  });

  it('a compare answering 404: exit 1 naming the pin as unfetchable', async () => {
    const table = greenTable();
    table[`/repos/actions/cache/compare/main...${B}`] = { status: 404 };
    const { code, err } = await run(table);
    assert.equal(code, 1);
    assert.equal(
      err[0],
      `✗ actions/cache@${B} (.github/workflows/one.yml:5) is unfetchable: the compare against main answers 404`,
    );
  });

  it('a repository answering 404: exit 1 naming the upstream as gone and each pin to it', async () => {
    const table = greenTable();
    table['/repos/actions/checkout'] = { status: 404 };
    const { code, err } = await run(table);
    assert.equal(code, 1);
    assert.deepEqual(err.slice(0, 2), [
      '✗ upstream actions/checkout is gone: its repository answers 404',
      `✗ actions/checkout@${A} (.github/workflows/one.yml:4, .github/workflows/two.yml:4) is unfetchable: its upstream is gone`,
    ]);
  });

  it('a 5xx answer: exit 2, the machinery verdict', async () => {
    const table = greenTable();
    table['/repos/actions/cache'] = { status: 503 };
    const { code, out, err } = await run(table);
    assert.equal(code, 2);
    assert.deepEqual(out, []);
    assert.match(err[0], /GET \/repos\/actions\/cache answered HTTP 503/);
  });

  it('zero pins read: exit 2, never a pass', async () => {
    const { code, out, err } = await run(greenTable(), {
      listFiles: () => ['.github/workflows/none.yml'],
      readFile: () => 'jobs:\n  x:\n    steps:\n      - run: echo\n',
    });
    assert.equal(code, 2);
    assert.deepEqual(out, []);
    assert.match(err[0], /read no SHA-pinned `uses:` reference/);
  });

  it('a network failure: exit 2', async () => {
    const table = greenTable();
    table['/repos/dtolnay/rust-toolchain'] = new Error('getaddrinfo ENOTFOUND');
    const { code, err } = await run(table);
    assert.equal(code, 2);
    assert.match(err[0], /GET \/repos\/dtolnay\/rust-toolchain failed: getaddrinfo ENOTFOUND/);
  });

  it('a lookup naming no default branch: exit 2', async () => {
    const table = greenTable();
    table['/repos/actions/cache'] = { status: 200, body: {} };
    const { code, err } = await run(table);
    assert.equal(code, 2);
    assert.match(err[0], /answered no default_branch/);
  });

  it('a compare status the probe does not read: exit 2', async () => {
    const table = greenTable();
    table[`/repos/actions/cache/compare/main...${B}`] = { status: 200, body: { status: 'weird' } };
    const { code, err } = await run(table);
    assert.equal(code, 2);
    assert.match(err[0], /answered compare status "weird"/);
  });

  /**
   * The command line's verdict over the two-file tree read through the real
   * reader, every request answering one rate-limited 403.
   * @param {string} [token] the token the reader sends, or none
   */
  async function runRateLimited(token) {
    const fetchImpl = async () => ({
      status: 403,
      headers: new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790000000' }),
      text: async () => '{"message":"API rate limit exceeded"}',
    });
    const out = [];
    const err = [];
    const code = await main({
      listFiles,
      readFile,
      request: githubReader({ token, fetchImpl }),
      log: (line) => out.push(line),
      error: (line) => err.push(line),
    });
    return { code, out, err };
  }

  /** The machinery report around the given lines. */
  const machinery = (...lines) =>
    '✗ an input this probe reads answered with something other than what it reads there:\n' +
    lines.map((line) => `    ${line}\n`).join('') +
    "\n  Exit 2 keeps machinery breakage apart from a pin off its upstream's history (exit 1).";

  it('a rate-limited 403 on an anonymous run: the probe stops, one line naming GH_TOKEN, exit 2', async () => {
    const { code, out, err } = await runRateLimited(undefined);
    assert.equal(code, 2);
    assert.deepEqual(out, []);
    assert.deepEqual(err, [
      machinery(
        "GitHub's API rate limit (HTTP 403) met at actions/checkout; 2 further upstream(s) not probed; it resets at 2026-09-21T14:13:20.000Z; set GH_TOKEN to raise it",
      ),
    ]);
  });

  it("a rate-limited 403 on an authenticated run names the token's own limit", async () => {
    const { code, err } = await runRateLimited('t0k');
    assert.equal(code, 2);
    assert.deepEqual(err, [
      machinery(
        "GitHub's API rate limit (HTTP 403) met at actions/checkout; 2 further upstream(s) not probed; it resets at 2026-09-21T14:13:20.000Z; the run was authenticated, so this is the token's own limit",
      ),
    ]);
  });

  it('a 429 carrying retry-after is the rate limit, reported beside the pin problem found before it', async () => {
    const table = greenTable();
    table[`/repos/actions/checkout/compare/main...${A}`] = { status: 200, body: { status: 'ahead' } }; // prettier-ignore
    table['/repos/actions/cache'] = {
      status: 429,
      rateLimit: { remaining: '12', reset: '1790000000', retryAfter: '60' },
    };
    const { code, out, err } = await run(table);
    assert.equal(code, 2);
    assert.deepEqual(out, []);
    assert.deepEqual(err, [
      `✗ actions/checkout@${A} (.github/workflows/one.yml:4, .github/workflows/two.yml:4) is off the default-branch history: ahead against main`,
      '\n1 problem. Pin each action to a commit on its upstream\'s default branch (docs/guides/ci.md, "Pins reference stable history").',
      machinery(
        "GitHub's API rate limit (HTTP 429) met at actions/cache; 1 further upstream(s) not probed; it resets after 60 second(s); set GH_TOKEN to raise it",
      ),
    ]);
  });

  it('a 403 that is not a rate limit is a per-upstream failure, and the probe carries on', async () => {
    const table = greenTable();
    table['/repos/actions/cache'] = {
      status: 403,
      rateLimit: { remaining: '41', reset: '1790000000', retryAfter: null },
    };
    const { request, asked } = readerFrom(table);
    const err = [];
    const code = await main({ listFiles, readFile, request, log: () => {}, error: (l) => err.push(l) }); // prettier-ignore
    assert.equal(code, 2);
    assert.deepEqual(err, [machinery('GET /repos/actions/cache answered HTTP 403')]);
    assert.ok(
      asked.includes(`/repos/dtolnay/rust-toolchain/compare/master...${C}`),
      asked.join('\n'),
    );
  });

  for (const status of [403, 429]) {
    it(`a ${status} whose body names a rate limit is the rate limit, its reset unstated`, async () => {
      const table = greenTable();
      table['/repos/actions/checkout'] = {
        status,
        body: { message: 'API Rate Limit exceeded for 192.0.2.1.' },
      };
      const { code, err } = await run(table);
      assert.equal(code, 2);
      assert.deepEqual(err, [
        machinery(
          `GitHub's API rate limit (HTTP ${status}) met at actions/checkout; 2 further upstream(s) not probed; it resets at a time GitHub did not state; set GH_TOKEN to raise it`,
        ),
      ]);
    });
  }

  /** The one rate-limit line, met at actions/checkout on the two-file tree. */
  const limitedAtCheckout = (status, tail) =>
    machinery(
      `GitHub's API rate limit (HTTP ${status}) met at actions/checkout; 2 further upstream(s) not probed; it resets ${tail}`,
    );

  it('a 403 with x-ratelimit-remaining 0 and a reset, no body: the stop with that reset', async () => {
    const table = greenTable();
    table['/repos/actions/checkout'] = {
      status: 403,
      rateLimit: { remaining: '0', reset: '1790000000', retryAfter: null },
    };
    const { code, err } = await run(table);
    assert.equal(code, 2);
    assert.deepEqual(err, [
      limitedAtCheckout(403, 'at 2026-09-21T14:13:20.000Z; set GH_TOKEN to raise it'),
    ]);
  });

  it('x-ratelimit-remaining 0 with no reset header resets at a time GitHub did not state', async () => {
    const table = greenTable();
    table['/repos/actions/checkout'] = {
      status: 403,
      rateLimit: { remaining: '0', reset: null, retryAfter: null },
    };
    const { code, err } = await run(table);
    assert.equal(code, 2);
    assert.deepEqual(err, [
      limitedAtCheckout(403, 'at a time GitHub did not state; set GH_TOKEN to raise it'),
    ]);
  });

  it('a body-named secondary limit on an authenticated run states no remedy', async () => {
    const table = greenTable();
    table['/repos/actions/checkout'] = {
      status: 403,
      body: { message: 'You have exceeded a secondary rate limit.' },
      authenticated: true,
    };
    const { code, err } = await run(table);
    assert.equal(code, 2);
    assert.deepEqual(err, [limitedAtCheckout(403, 'at a time GitHub did not state')]);
  });

  it('an unreadable retry-after beside a valid reset resets at that reset', async () => {
    const table = greenTable();
    table['/repos/actions/checkout'] = {
      status: 403,
      rateLimit: { remaining: '0', reset: '1790000000', retryAfter: 'soon' },
    };
    const { code, err } = await run(table);
    assert.equal(code, 2);
    assert.deepEqual(err, [
      limitedAtCheckout(403, 'at 2026-09-21T14:13:20.000Z; set GH_TOKEN to raise it'),
    ]);
  });

  it('a retry-after stating an HTTP date resets at that date', async () => {
    const table = greenTable();
    table['/repos/actions/checkout'] = {
      status: 429,
      rateLimit: { remaining: null, reset: null, retryAfter: 'Wed, 21 Oct 2026 07:28:00 GMT' },
    };
    const { code, err } = await run(table);
    assert.equal(code, 2);
    assert.deepEqual(err, [
      machinery(
        "GitHub's API rate limit (HTTP 429) met at actions/checkout; 2 further upstream(s) not probed; it resets at 2026-10-21T07:28:00.000Z; set GH_TOKEN to raise it",
      ),
    ]);
  });

  it('a retry-after-only 403 through the real reader stops the probe with that reset', async () => {
    const fetchImpl = async () => ({
      status: 403,
      headers: new Headers({ 'retry-after': '30' }),
      text: async () => '{"message":"You have exceeded a secondary limit."}',
    });
    const err = [];
    const code = await main({
      listFiles,
      readFile,
      request: githubReader({ fetchImpl }),
      log: () => {},
      error: (line) => err.push(line),
    });
    assert.equal(code, 2);
    assert.deepEqual(err, [
      machinery(
        "GitHub's API rate limit (HTTP 403) met at actions/checkout; 2 further upstream(s) not probed; it resets after 30 second(s); set GH_TOKEN to raise it",
      ),
    ]);
  });

  it('an empty default_branch is the machinery verdict naming it', async () => {
    const table = greenTable();
    table['/repos/actions/cache'] = { status: 200, body: { default_branch: '' } };
    const { code, err } = await run(table);
    assert.equal(code, 2);
    assert.deepEqual(err, [machinery('GET /repos/actions/cache answered no default_branch')]);
  });

  it('a default branch with reserved characters reaches the compare URL encoded', async () => {
    const table = greenTable();
    table['/repos/actions/cache'] = { status: 200, body: { default_branch: 'release/v1 #x' } };
    const encoded = `/repos/actions/cache/compare/release%2Fv1%20%23x...${B}`;
    table[encoded] = { status: 200, body: { status: 'behind' } };
    const { request, asked } = readerFrom(table);
    const result = await probePins({ listFiles, readFile, request });
    assert.deepEqual(result.failures, []);
    assert.ok(asked.includes(encoded), asked.join('\n'));
  });

  it('one upstream answering 503 beside a pin ahead: both reported, exit 2', async () => {
    const table = greenTable();
    table['/repos/actions/cache'] = { status: 503 };
    table[`/repos/actions/checkout/compare/main...${A}`] = { status: 200, body: { status: 'ahead' } }; // prettier-ignore
    const { code, out, err } = await run(table);
    assert.equal(code, 2);
    assert.deepEqual(out, []);
    assert.deepEqual(err, [
      `✗ actions/checkout@${A} (.github/workflows/one.yml:4, .github/workflows/two.yml:4) is off the default-branch history: ahead against main`,
      '\n1 problem. Pin each action to a commit on its upstream\'s default branch (docs/guides/ci.md, "Pins reference stable history").',
      '✗ an input this probe reads answered with something other than what it reads there:\n' +
        '    GET /repos/actions/cache answered HTTP 503\n' +
        "\n  Exit 2 keeps machinery breakage apart from a pin off its upstream's history (exit 1).",
    ]);
  });

  it('rethrows an error that is not an input error', async () => {
    await assert.rejects(
      main({
        listFiles: () => {
          throw new TypeError('boom');
        },
        readFile,
        request: async () => ({ status: 200, body: null }),
        log: () => {},
        error: () => {},
      }),
      { name: 'TypeError', message: 'boom' },
    );
  });
});

describe('probePins — the compare is made against the base the lookup returned', () => {
  it('asks each upstream once and compares each pin once, with that upstream’s own default branch', async () => {
    const { request, asked } = readerFrom(greenTable());
    const result = await probePins({ listFiles, readFile, request });
    assert.deepEqual(result.problems, []);
    assert.deepEqual(asked, [
      '/repos/actions/checkout',
      `/repos/actions/checkout/compare/main...${A}`,
      '/repos/actions/cache',
      `/repos/actions/cache/compare/main...${B}`,
      '/repos/dtolnay/rust-toolchain',
      `/repos/dtolnay/rust-toolchain/compare/master...${C}`,
    ]);
  });

  it('collects an answer it does not read as one failure per upstream, never a pin problem', async () => {
    const { request } = readerFrom({});
    const result = await probePins({ listFiles, readFile, request });
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.failures, [
      'GET /repos/actions/checkout answered HTTP 500',
      'GET /repos/actions/cache answered HTTP 500',
      'GET /repos/dtolnay/rust-toolchain answered HTTP 500',
    ]);
  });

  it('throws InputError, the machinery class, on a scan that read no pin', async () => {
    const { request } = readerFrom({});
    await assert.rejects(probePins({ listFiles: () => [], readFile, request }), InputError);
  });
});

describe('githubReader — the request shape over an injected fetch', () => {
  /** A fetch double recording its calls and answering one fixed response. */
  function fakeFetch(status, text) {
    const calls = [];
    const impl = async (url, init) => {
      calls.push({ url, init });
      return { status, text: async () => text };
    };
    return { impl, calls };
  }

  it('reads anonymously without a token, against the API host', async () => {
    const { impl, calls } = fakeFetch(200, '{"default_branch":"main"}');
    const res = await githubReader({ fetchImpl: impl })('/repos/a/b');
    assert.deepEqual(res, { status: 200, body: { default_branch: 'main' }, authenticated: false });
    assert.equal(calls[0].url, 'https://api.github.com/repos/a/b');
    assert.equal(calls[0].init.headers.Authorization, undefined);
    assert.equal(calls[0].init.headers.Accept, 'application/vnd.github+json');
  });

  it('sends the token as a bearer token when given', async () => {
    const { impl, calls } = fakeFetch(404, '');
    const res = await githubReader({ token: 't0k', fetchImpl: impl })('/repos/a/b');
    assert.deepEqual(res, { status: 404, body: null, authenticated: true });
    assert.equal(calls[0].init.headers.Authorization, 'Bearer t0k');
  });

  it('answers a body that is not JSON as null, keeping the status', async () => {
    const { impl } = fakeFetch(502, '<html>bad gateway</html>');
    assert.deepEqual(await githubReader({ fetchImpl: impl })('/x'), {
      status: 502,
      body: null,
      authenticated: false,
    });
  });
});

describe('real-tree lock', () => {
  it('the scan reads SHA-pinned references from the committed workflows', () => {
    const { refCount, upstreams } = collectPins({
      listFiles: actionFiles,
      readFile: (rel) => readFileSync(join(ROOT, rel), 'utf8'),
    });
    assert.ok(refCount > 0, 'the committed tree states SHA-pinned references');
    assert.ok(upstreams.has('actions/checkout'), [...upstreams.keys()].join(', '));
    assert.ok(upstreams.has('dtolnay/rust-toolchain'), [...upstreams.keys()].join(', '));
  });
});
