/**
 * check-npm-advisories.test.js — Unit tests for the npm advisory gate, whose
 * verdicts are listed in the check's own header. The gate's verdicts are driven
 * through `main` with fixture reports fed through its audit seam; the list and
 * date rules and the report reader are exercised directly; the audit command is
 * reached only through its spawn seam, so the suite never runs npm. The shipped
 * list is locked to its shape, and the audited npm roots to the tracked lockfiles
 * and to Dependabot's npm entries.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  AUDIT_COMMAND,
  IGNORED_ADVISORIES,
  InputError,
  checkList,
  isCalendarDay,
  judge,
  main,
  readReport,
  runAudit,
} from '../../../../scripts/check-npm-advisories.js';
import { INSTALL_ROOTS } from '../../../../scripts/check-licenses-npm.js';

const TODAY = '2026-10-03';

/** The repository root, where the audit runs for the root lockfile. */
const REPO = path.resolve(import.meta.dirname, '../../../..');

/** A root advisory object as npm's report states it under `via`. */
function root(name, id, severity = 'high') {
  return {
    source: 1,
    name,
    dependency: name,
    title: `${name} is vulnerable`,
    url: `https://github.com/advisories/${id}`,
    severity,
    range: '<=1.0.0',
  };
}

/**
 * An audit report over `entries` ({ name: { severity, via } }), with metadata
 * counts derived from the entries unless `counts` overrides them.
 */
function report(entries, counts = {}) {
  const tally = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  for (const e of Object.values(entries)) tally[e.severity] += 1;
  const vulnerabilities = Object.fromEntries(
    Object.entries(entries).map(([name, e]) => [name, { name, fixAvailable: false, ...e }]),
  );
  return JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities,
    metadata: { vulnerabilities: { ...tally, ...counts, total: 0 } },
  });
}

const BRACES = 'GHSA-vfj7-8cjw-p6xm';
const HCS = 'GHSA-ch52-4w7c-c8xp';

/** Today's shape of the report: two high roots, each with an inheriting entry. */
const TWO_ROOTS = {
  braces: { severity: 'high', via: [root('braces', BRACES)] },
  micromatch: { severity: 'high', via: ['braces'] },
  'http-cache-semantics': { severity: 'high', via: [root('http-cache-semantics', HCS)] },
  'make-fetch-happen': { severity: 'high', via: ['http-cache-semantics'] },
};

const entry = (id, pkg, until = '2026-11-03') => ({ id, package: pkg, reason: 'why', until });

/** The same report with its `vulnerabilities` keys in reverse order. */
const reversed = (entries) => Object.fromEntries(Object.entries(entries).reverse());
const LIST = [entry(BRACES, 'braces'), entry(HCS, 'http-cache-semantics')];

/** Run the gate over a fixture, collecting what it prints. */
function gate(text, { list = LIST, today = TODAY } = {}) {
  const out = [];
  const err = [];
  const code = main({
    audit: () => text,
    npmRoots: ['.'],
    list,
    today,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('the gate’s verdicts over fixture reports', () => {
  it('every root listed: exit 0 with the green line naming the ignored ids', () => {
    const r = gate(report(TWO_ROOTS));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /reported 2 high or critical root advisories across 4 vulnerable package/);
    assert.match(r.out, /every one is on the ignore list and holds today/);
    assert.match(r.out, new RegExp(`ignored: ${BRACES} holds through 2026-11-03, ${HCS} holds through 2026-11-03`)); // prettier-ignore
  });

  it('nothing reported and an empty list: exit 0', () => {
    const r = gate(report({}), { list: [] });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /no high or critical advisory/);
  });

  it('an unlisted high root advisory: exit 1 naming it', () => {
    const r = gate(report(TWO_ROOTS), { list: [LIST[0]] });
    assert.equal(r.code, 1);
    assert.match(
      r.err,
      new RegExp(`✗ ${HCS} \\(http-cache-semantics; high\\) is not on the ignore list: http-cache-semantics is vulnerable — https://github.com/advisories/${HCS}`), // prettier-ignore
    );
  });

  it('an unlisted critical root advisory: exit 1 naming it', () => {
    const id = 'GHSA-aaaa-bbbb-cccc';
    const r = gate(report({ ...TWO_ROOTS, evil: { severity: 'critical', via: [root('evil', id, 'critical')] } })); // prettier-ignore
    assert.equal(r.code, 1);
    assert.match(r.err, new RegExp(`✗ ${id} \\(evil; critical\\) is not on the ignore list`));
  });

  it('a moderate-only report is below the gate: exit 0', () => {
    const r = gate(
      report({ 'fast-uri': { severity: 'moderate', via: [root('fast-uri', 'GHSA-hrr3-gc8f-f4qj', 'moderate')] } }), // prettier-ignore
      { list: [] },
    );
    assert.equal(r.code, 0, r.err);
  });

  it('a list entry the audit no longer reports: exit 1 as stale', () => {
    const r = gate(report(TWO_ROOTS), { list: [...LIST, entry('GHSA-zzzz-zzzz-zzzz', 'gone')] });
    assert.equal(r.code, 1);
    assert.match(r.err, /✗ ignore-list entry GHSA-zzzz-zzzz-zzzz \(gone\) is stale: the audit no longer reports it at high or critical — delete the entry/); // prettier-ignore
  });

  it('a list entry past its until day: exit 1 naming the day', () => {
    const r = gate(report(TWO_ROOTS), { list: [entry(BRACES, 'braces', '2026-10-02'), LIST[1]] });
    assert.equal(r.code, 1);
    assert.match(r.err, new RegExp(`✗ ignore-list entry ${BRACES} \\(braces\\) held through 2026-10-02 and has expired — re-check the advisory and renew or delete the entry`)); // prettier-ignore
  });

  it('an entry holds through its until day itself', () => {
    const r = gate(report(TWO_ROOTS), { list: [entry(BRACES, 'braces', TODAY), LIST[1]] });
    assert.equal(r.code, 0, r.err);
  });

  it('a list entry naming another package than the audit files it against: exit 1', () => {
    const r = gate(report(TWO_ROOTS), { list: [entry(BRACES, 'micromatch'), LIST[1]] });
    assert.equal(r.code, 1);
    assert.match(r.err, new RegExp(`✗ ignore-list entry ${BRACES} names package micromatch, but the audit files it against braces`)); // prettier-ignore
  });

  it('a moderate root missing its title is below the gate and never shape-checked: exit 0', () => {
    const via = root('fast-uri', 'GHSA-hrr3-gc8f-f4qj', 'moderate');
    delete via.title;
    const r = gate(report({ 'fast-uri': { severity: 'moderate', via: [via] } }), { list: [] });
    assert.equal(r.code, 0, r.err);
  });

  describe('an advisory filed against several packages', () => {
    const MULTI = 'GHSA-mmmm-nnnn-pppp';
    const TWO_PACKAGES = {
      'pkg-a': { severity: 'high', via: [root('pkg-a', MULTI)] },
      'pkg-b': { severity: 'high', via: [root('pkg-b', MULTI)] },
    };

    for (const [order, entries] of [
      ['key order as written', TWO_PACKAGES],
      ['key order reversed', reversed(TWO_PACKAGES)],
    ]) {
      it(`an entry naming either package passes (${order})`, () => {
        for (const pkg of ['pkg-a', 'pkg-b']) {
          const r = gate(report(entries), { list: [entry(MULTI, pkg)] });
          assert.equal(r.code, 0, r.err);
          assert.match(r.out, new RegExp(`ignored: ${MULTI} holds through 2026-11-03`));
        }
      });

      it(`an entry naming a third package reds, listing both (${order})`, () => {
        const r = gate(report(entries), { list: [entry(MULTI, 'pkg-c')] });
        assert.equal(r.code, 1);
        assert.match(r.err, new RegExp(`✗ ignore-list entry ${MULTI} names package pkg-c, but the audit files it against pkg-a, pkg-b — correct the entry`)); // prettier-ignore
      });

      it(`unlisted, the line names every package (${order})`, () => {
        const r = gate(report(entries), { list: [] });
        assert.equal(r.code, 1);
        assert.match(
          r.err,
          new RegExp(`✗ ${MULTI} \\(pkg-a, pkg-b; high\\) is not on the ignore list`),
        );
      });
    }

    it('a fix on a package other than the entry’s names that package', () => {
      const entries = {
        ...TWO_PACKAGES,
        'pkg-b': { ...TWO_PACKAGES['pkg-b'], fixAvailable: true },
      };
      const r = gate(report(entries), { list: [entry(MULTI, 'pkg-a')] });
      assert.equal(r.code, 1);
      assert.match(r.err, new RegExp(`✗ ignore-list entry ${MULTI} \\(pkg-a\\): a fix is available for pkg-b — refresh the lockfile`)); // prettier-ignore
    });

    it('a fix on one package and an object on the other: the same fix-available line in both key orders', () => {
      const fixAvailable = { name: 'other', version: '1.0.0', isSemVerMajor: true };
      const entries = {
        'pkg-a': { ...TWO_PACKAGES['pkg-a'], fixAvailable },
        'pkg-b': { ...TWO_PACKAGES['pkg-b'], fixAvailable: true },
      };
      const list = [entry(MULTI, 'pkg-a')];
      const a = gate(report(entries), { list });
      const b = gate(report(reversed(entries)), { list });
      for (const r of [a, b]) {
        assert.equal(r.code, 1);
        assert.match(r.err, new RegExp(`✗ ignore-list entry ${MULTI} \\(pkg-a\\): a fix is available for pkg-b — refresh the lockfile`)); // prettier-ignore
      }
      assert.equal(b.err, a.err);
    });

    it('critical under one package and high under the other: critical in both key orders', () => {
      const entries = {
        'pkg-a': { severity: 'critical', via: [root('pkg-a', MULTI, 'critical')] },
        'pkg-b': { severity: 'high', via: [root('pkg-b', MULTI, 'high')] },
      };
      for (const order of [entries, reversed(entries)]) {
        const r = gate(report(order), { list: [] });
        assert.equal(r.code, 1);
        assert.match(r.err, new RegExp(`✗ ${MULTI} \\(pkg-a, pkg-b; critical\\) is not on the ignore list`)); // prettier-ignore
      }
    });

    it('both key orders give the same exit code and lines', () => {
      for (const list of [[entry(MULTI, 'pkg-a')], [entry(MULTI, 'pkg-c')], []]) {
        const a = gate(report(TWO_PACKAGES), { list });
        const b = gate(report(reversed(TWO_PACKAGES)), { list });
        assert.deepEqual([b.code, b.out, b.err], [a.code, a.out, a.err]);
      }
    });
  });

  it('a listed advisory whose package now has a fix available: exit 1', () => {
    const r = gate(report({ ...TWO_ROOTS, braces: { ...TWO_ROOTS.braces, fixAvailable: true } }));
    assert.equal(r.code, 1);
    assert.match(r.err, new RegExp(`✗ ignore-list entry ${BRACES} \\(braces\\): a fix is available for braces — refresh the lockfile; the entry goes once the advisory is no longer reported at high or critical`)); // prettier-ignore
  });

  it('a fixAvailable object (a semver-major change elsewhere) is not a fix: exit 0', () => {
    const fixAvailable = { name: 'stylelint', version: '7.7.0', isSemVerMajor: true };
    const r = gate(report({ ...TWO_ROOTS, braces: { ...TWO_ROOTS.braces, fixAvailable } }));
    assert.equal(r.code, 0, r.err);
  });
});

describe('the machinery verdict, on exit 2', () => {
  /** Assert the gate refuses `text` on exit 2 with a message matching `re`. */
  function refuses(text, re, opts) {
    const r = gate(text, opts);
    assert.equal(r.code, 2, `${r.out}${r.err}`);
    assert.match(r.err, /answered with something other than what it reads there/);
    assert.match(r.err, /Exit 2 keeps that apart/);
    assert.match(r.err, re);
  }

  it('non-JSON output', () => refuses('npm ERR! network', /is not JSON/));

  it('a report lacking `vulnerabilities`', () => {
    refuses(JSON.stringify({ auditReportVersion: 2 }), /no `vulnerabilities` object/);
  });

  it("a report carrying npm's own error object quotes its code and summary", () => {
    const text = JSON.stringify({
      error: {
        code: 'ENOTFOUND',
        summary: 'request to https://registry.npmjs.org failed',
        detail: '',
      },
    });
    refuses(
      text,
      /npm audit reported an error: ENOTFOUND: request to https:\/\/registry\.npmjs\.org failed/,
    );
  });

  it('a report whose `vulnerabilities` is an array', () => {
    refuses(JSON.stringify({ vulnerabilities: [], metadata: {} }), /no `vulnerabilities` object/);
  });

  it('a report lacking the metadata counts', () => {
    refuses(JSON.stringify({ vulnerabilities: {} }), /no `metadata.vulnerabilities` count/);
  });

  it('an entry lacking `via`', () => {
    refuses(report({ braces: { severity: 'high' } }), /entry for braces carries no `severity`/);
  });

  it('a root advisory lacking a field read', () => {
    const via = root('braces', BRACES);
    delete via.title;
    refuses(report({ braces: { severity: 'high', via: [via] } }), /root advisory under braces lacks/); // prettier-ignore
  });

  it('a root advisory whose url names no GHSA id', () => {
    const via = { ...root('braces', BRACES), url: 'https://example.com/x' };
    refuses(report({ braces: { severity: 'high', via: [via] } }), /names no GHSA id/);
  });

  it('a gated entry whose chain reaches no root advisory is unexplained', () => {
    refuses(
      report({ ...TWO_ROOTS, orphan: { severity: 'high', via: ['missing-package'] } }),
      /entry for orphan is high but its `via` chain reaches no root advisory .* unexplained/,
    );
  });

  it('a high package whose only root advisory is moderate is unexplained', () => {
    refuses(
      report({
        lone: { severity: 'high', via: [root('lone', 'GHSA-qqqq-rrrr-ssss', 'moderate')] },
      }),
      /entry for lone is high .* unexplained/,
      { list: [] },
    );
  });

  it('a list entry with no package, before the audit is read', () => {
    const { package: _omitted, ...noPackage } = LIST[0];
    refuses(report(TWO_ROOTS), /ignore-list entry 1 lacks `package`/, { list: [noPackage] });
  });

  it('a failing audit command, driven through main', () => {
    const spawn = () => ({ status: 3, stdout: '', stderr: 'npm crashed' });
    const err = [];
    const code = main({ audit: () => runAudit({ spawn }), npmRoots: ['.'], list: [], today: TODAY, out: () => {}, err: (l) => err.push(l) }); // prettier-ignore
    assert.equal(code, 2);
    assert.match(err.join('\n'), /answered with something other than what it reads there:\n\s+`npm audit --json --package-lock-only` exited 3: npm crashed/); // prettier-ignore
  });

  it('a chain that cycles without a root is unexplained', () => {
    refuses(
      report({ a: { severity: 'high', via: ['b'] }, b: { severity: 'high', via: ['a'] } }),
      /entry for a is high .* unexplained/,
      { list: [] },
    );
  });

  it('metadata counts that disagree with the entries read', () => {
    refuses(report(TWO_ROOTS, { high: 3 }), /metadata counts 3 high or critical vulnerabilities but its entries carry 4/); // prettier-ignore
  });

  it('a malformed list (duplicate id), before the audit is read', () => {
    let audited = false;
    const r = main({
      audit: () => {
        audited = true;
        return report(TWO_ROOTS);
      },
      npmRoots: ['.'],
      list: [...LIST, LIST[0]],
      today: TODAY,
      out: () => {},
      err: () => {},
    });
    assert.equal(r, 2);
    assert.equal(audited, false);
    assert.throws(() => checkList([...LIST, LIST[0]]), /entry 3 repeats id GHSA-vfj7-8cjw-p6xm for root \./); // prettier-ignore
  });

  it('an error that is not an input error still ends on exit 2 with its message', () => {
    const err = [];
    const code = main({
      audit: () => {
        throw new Error('unexpected');
      },
      npmRoots: ['.'],
      list: [],
      today: TODAY,
      out: () => {},
      err: (l) => err.push(l),
    });
    assert.equal(code, 2);
    assert.match(err.join('\n'), /the check met an error it does not model:\n\s+unexpected/);
    assert.match(err.join('\n'), /Exit 2 keeps that apart/);
  });
});

describe('checkList — the list’s shape', () => {
  it('refuses each malformed entry', () => {
    assert.throws(() => checkList({}), InputError);
    assert.throws(() => checkList([null]), /entry 1 is not an object/);
    assert.throws(() => checkList([{ ...LIST[0], reason: '  ' }]), /entry 1 lacks `reason`/);
    assert.throws(() => checkList([{ id: BRACES, package: 'braces', until: '2026-11-03' }]), /lacks `reason`/); // prettier-ignore
    assert.throws(() => checkList([{ ...LIST[0], id: 'CVE-2026-1' }]), /not a GHSA id/);
    assert.throws(() => checkList([{ ...LIST[0], until: '2026-02-30' }]), /not a calendar day/);
    assert.doesNotThrow(() => checkList(LIST));
  });

  it('isCalendarDay accepts a real day only', () => {
    assert.equal(isCalendarDay('2026-11-03'), true);
    assert.equal(isCalendarDay('2028-02-29'), true);
    assert.equal(isCalendarDay('2026-02-29'), false);
    assert.equal(isCalendarDay('2026-1-03'), false);
    assert.equal(isCalendarDay(20261103), false);
  });

  it('the shipped list carries an id, a package, a reason and an until on every entry, unique ids per npm root, calendar-day untils', () => {
    assert.doesNotThrow(() => checkList(IGNORED_ADVISORIES));
    for (const e of IGNORED_ADVISORIES) {
      const keys = Object.keys(e)
        .filter((k) => k !== 'root')
        .sort();
      assert.deepEqual(keys, ['id', 'package', 'reason', 'until']);
    }
  });
});

describe('readReport and judge', () => {
  it('reads each gated root once, keyed by its GHSA id, and counts the gated entries', () => {
    const { roots, vulnerableCount } = readReport(report(TWO_ROOTS));
    assert.equal(vulnerableCount, 4);
    assert.deepEqual([...roots.keys()], [HCS, BRACES]); // sorted by id
    assert.deepEqual(roots.get(BRACES).packages, ['braces']);
    assert.deepEqual(roots.get(BRACES).fixPackages, []);
  });

  it('judge sorts every entry into exactly one verdict', () => {
    const { roots } = readReport(report(TWO_ROOTS));
    const v = judge({ roots, list: [entry(BRACES, 'braces')], today: TODAY });
    assert.deepEqual(
      v.ignored.map((e) => e.id),
      [BRACES],
    );
    assert.deepEqual(
      v.unlisted.map((r) => r.id),
      [HCS],
    );
    assert.deepEqual([v.stale, v.expired, v.mismatched, v.fixable], [[], [], [], []]);
  });
});

describe('runAudit — the command seam', () => {
  const ok = (status, stdout) => () => ({ status, stdout, stderr: '' });

  it('runs the audit command and returns its report on exit 0 or 1', () => {
    let called;
    const spawn = (cmd, opts) => {
      called = { cmd, opts };
      return { status: 1, stdout: '{"x":1}', stderr: '' };
    };
    assert.equal(runAudit({ spawn }), '{"x":1}');
    assert.equal(called.cmd, AUDIT_COMMAND);
    assert.equal(called.opts.shell, true);
    assert.equal(called.opts.cwd, REPO);
    runAudit({ spawn, npmRoot: 'packages/desktop/tests/integration' });
    assert.equal(called.opts.cwd, path.join(REPO, 'packages/desktop/tests/integration'));
    assert.equal(runAudit({ spawn: ok(0, '{}') }), '{}');
  });

  it('refuses a command that does not run, exits otherwise, or prints nothing', () => {
    assert.throws(() => runAudit({ spawn: () => ({ error: new Error('ENOENT') }) }), /did not run: ENOENT/); // prettier-ignore
    assert.throws(() => runAudit({ spawn: () => ({ status: 2, stdout: '', stderr: 'boom' }) }), /exited 2: boom/); // prettier-ignore
    assert.throws(() => runAudit({ spawn: ok(0, '  ') }), /printed no report/);
    assert.throws(() => runAudit({ spawn: ok(1, undefined) }), InputError);
  });
});

describe('every npm root, each judged on its own', () => {
  const SUB = 'packages/desktop/tests/integration';
  const SUB_ID = 'GHSA-dddd-eeee-ffff';
  const subReport = report({ ws: { severity: 'high', via: [root('ws', SUB_ID)] } });
  const byRoot = { '.': report(TWO_ROOTS), [SUB]: subReport };

  /** Run the gate over two roots, each with its own report. */
  function gate2(list) {
    const out = [];
    const err = [];
    const audited = [];
    const code = main({
      audit: (r) => {
        audited.push(r);
        return byRoot[r];
      },
      npmRoots: ['.', SUB],
      list,
      today: TODAY,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    return { code, audited, out: out.join('\n'), err: err.join('\n') };
  }

  it('audits every root, in order', () => {
    assert.deepEqual(gate2([...LIST, { ...entry(SUB_ID, 'ws'), root: SUB }]).audited, ['.', SUB]);
  });

  it('a second root’s own advisory, unlisted: exit 1 naming its root', () => {
    const r = gate2(LIST);
    assert.equal(r.code, 1);
    assert.match(r.err, new RegExp(`✗ ${SUB_ID} \\(ws; high\\) is not on the ignore list: .* \\[root: ${SUB}\\]`)); // prettier-ignore
    assert.doesNotMatch(
      r.err,
      new RegExp(BRACES),
      'the root lockfile’s listed advisories stay green',
    );
  });

  it('an entry scoped to the second root holds it there: exit 0 naming the root', () => {
    const r = gate2([...LIST, { ...entry(SUB_ID, 'ws'), root: SUB }]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /reported 3 high or critical root advisories across 5 vulnerable package\(s\) over 2 npm roots/); // prettier-ignore
    assert.match(r.out, new RegExp(`${SUB_ID} holds through 2026-11-03 \\[root: ${SUB}\\]`));
  });

  it('an entry naming no root is judged against the root lockfile only: stale there, the other root unlisted', () => {
    const r = gate2([...LIST, entry(SUB_ID, 'ws')]);
    assert.equal(r.code, 1);
    assert.match(r.err, new RegExp(`ignore-list entry ${SUB_ID} \\(ws\\) is stale: .* \\[root: \\.\\]`)); // prettier-ignore
    assert.match(r.err, new RegExp(`✗ ${SUB_ID} .* is not on the ignore list: .* \\[root: ${SUB}\\]`)); // prettier-ignore
  });

  it('an entry scoped to the root lockfile by name is the same as naming none', () => {
    const r = gate2([{ ...LIST[0], root: '.' }, LIST[1], { ...entry(SUB_ID, 'ws'), root: SUB }]);
    assert.equal(r.code, 0, r.err);
  });

  it('a stale entry scoped to the second root reds there', () => {
    const list = [...LIST, { ...entry(SUB_ID, 'ws'), root: SUB }, { ...entry(BRACES, 'braces'), root: SUB }]; // prettier-ignore
    const r = gate2(list);
    assert.equal(r.code, 1);
    assert.match(r.err, new RegExp(`ignore-list entry ${BRACES} \\(braces\\) is stale: .* \\[root: ${SUB}\\]`)); // prettier-ignore
  });

  it('a machinery failure in one root names that root: exit 2', () => {
    const err = [];
    const code = main({
      audit: (r) => (r === SUB ? 'npm ERR! network' : report(TWO_ROOTS)),
      npmRoots: ['.', SUB],
      list: LIST,
      today: TODAY,
      out: () => {},
      err: (l) => err.push(l),
    });
    assert.equal(code, 2);
    assert.match(err.join('\n'), new RegExp(`is not JSON \\[root: ${SUB}\\]`));
  });

  it('checkList: a root outside the audited set is malformed; one id may hold in two roots, never twice in one', () => {
    assert.throws(
      () => checkList([{ ...LIST[0], root: 'packages/nowhere' }], ['.', SUB]),
      /entry 1 \(GHSA-vfj7-8cjw-p6xm\) names root packages\/nowhere, which is not one of the audited npm roots/,
    );
    assert.throws(
      () => checkList([{ ...LIST[0], root: '' }], ['.', SUB]),
      /names root , which is not/,
    );
    assert.doesNotThrow(() => checkList([LIST[0], { ...LIST[0], root: SUB }], ['.', SUB]));
    assert.throws(
      () => checkList([LIST[0], { ...LIST[0], root: '.' }], ['.', SUB]),
      /entry 2 repeats id GHSA-vfj7-8cjw-p6xm for root \./,
    );
  });
});

describe('the audited npm roots', () => {
  // A GIT_ variable inherited from a hook (GIT_INDEX_FILE, say) would point the
  // listing at another index, so the child runs without them.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
  );
  const tracked =
    execFileSync('git', ['ls-files', '-z', '--', 'package-lock.json', '**/package-lock.json'], { cwd: REPO, env, encoding: 'utf8' }) // prettier-ignore
      .split('\0')
      .filter(Boolean)
      .map((f) => path.posix.dirname(f))
      .sort();

  it('are exactly the directories carrying a tracked lockfile', () => {
    assert.ok(
      tracked.length > 0,
      'git ls-files listed no lockfile — the comparison would prove nothing',
    );
    assert.deepEqual([...INSTALL_ROOTS].sort(), tracked);
  });

  it('each takes a Dependabot npm entry, and Dependabot names no other npm directory', () => {
    const config = yaml.load(readFileSync(path.join(REPO, '.github/dependabot.yml'), 'utf8'));
    const npmDirs = config.updates
      .filter((u) => u['package-ecosystem'] === 'npm')
      .map((u) => (u.directory === '/' ? '.' : u.directory.replace(/^\//, '')))
      .sort();
    assert.deepEqual(npmDirs, [...INSTALL_ROOTS].sort());
  });
});
