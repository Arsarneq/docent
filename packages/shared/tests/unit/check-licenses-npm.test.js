/**
 * check-licenses-npm.test.js — Unit tests for the npm license gate
 * (scripts/check-licenses-npm.js) that gates CI (and, via the publish
 * workflows' test dependency, releases). The gate is default-deny; these tests
 * prove the denial paths fire (unknown licenses, unparseable expressions,
 * relicensed exception packages) and that the SPDX expression evaluation
 * (OR/AND/parens/WITH, guessed-license '*' stripping) behaves exactly as the
 * gate documents.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowed,
  packageName,
  classifyPackages,
  missingRootDisposition,
  staleExceptions,
  ALLOW,
  EXCEPTIONS,
} from '../../../../scripts/check-licenses-npm.js';

const allow = new Set(['MIT', 'Apache-2.0', 'BSD-3-Clause']);

describe('isAllowed — SPDX expression evaluation', () => {
  it('accepts a bare allowed id and rejects a bare unknown id', () => {
    assert.equal(isAllowed('MIT', allow), true);
    assert.equal(isAllowed('SSPL-1.0', allow), false);
  });

  it('OR passes when any disjunct is allowed', () => {
    assert.equal(isAllowed('SSPL-1.0 OR MIT', allow), true);
    assert.equal(isAllowed('SSPL-1.0 OR EUPL-1.2', allow), false);
  });

  it('AND requires every conjunct', () => {
    assert.equal(isAllowed('MIT AND Apache-2.0', allow), true);
    assert.equal(isAllowed('MIT AND SSPL-1.0', allow), false);
  });

  it('handles nested parentheses', () => {
    assert.equal(isAllowed('(MIT OR SSPL-1.0) AND Apache-2.0', allow), true);
    assert.equal(isAllowed('(MIT AND SSPL-1.0) OR BSD-3-Clause', allow), true);
    assert.equal(isAllowed('(MIT AND SSPL-1.0) OR EUPL-1.2', allow), false);
  });

  it('X WITH <exception> follows the base license verdict', () => {
    assert.equal(isAllowed('Apache-2.0 WITH LLVM-exception', allow), true);
    assert.equal(isAllowed('GPL-2.0-only WITH Classpath-exception-2.0', allow), false);
  });

  it("strips license-checker's guessed-license asterisk", () => {
    assert.equal(isAllowed('MIT*', allow), true);
  });

  it('denies empty, undefined, and trailing-garbage expressions', () => {
    assert.equal(isAllowed('', allow), false);
    assert.equal(isAllowed(undefined, allow), false);
    assert.equal(isAllowed('MIT SEE LICENSE IN LICENSE', allow), false);
  });
});

describe('packageName', () => {
  it('strips the version from plain and scoped keys', () => {
    assert.equal(packageName('lodash@4.17.21'), 'lodash');
    assert.equal(packageName('@scope/name@1.0.0'), '@scope/name');
  });
});

describe('classifyPackages — default-deny classification', () => {
  it('passes allowed packages and reports none used', () => {
    const { violations, usedExceptions } = classifyPackages(
      { 'a@1.0.0': { licenses: 'MIT' }, 'b@2.0.0': { licenses: 'Apache-2.0' } },
      { allow, exceptions: {} },
    );
    assert.deepEqual(violations, []);
    assert.equal(usedExceptions.size, 0);
  });

  it('flags a disallowed license with root and key', () => {
    const { violations } = classifyPackages(
      { 'bad@1.0.0': { licenses: 'SSPL-1.0' } },
      { allow, exceptions: {}, root: 'packages/extension' },
    );
    assert.deepEqual(violations, [
      { root: 'packages/extension', package: 'bad@1.0.0', license: 'SSPL-1.0' },
    ]);
  });

  it('flags a missing license as UNKNOWN', () => {
    const { violations } = classifyPackages({ 'mystery@1.0.0': {} }, { allow, exceptions: {} });
    assert.deepEqual(violations, [{ root: '.', package: 'mystery@1.0.0', license: 'UNKNOWN' }]);
  });

  it('applies a scoped exception only on an exact license match', () => {
    const exceptions = { special: { license: 'CC-BY-4.0' } };
    const ok = classifyPackages(
      { 'special@1.0.0': { licenses: 'CC-BY-4.0' } },
      { allow, exceptions },
    );
    assert.deepEqual(ok.violations, []);
    assert.deepEqual([...ok.usedExceptions], ['special']);

    // A relicense re-surfaces instead of being silently waved through.
    const relicensed = classifyPackages(
      { 'special@2.0.0': { licenses: 'SSPL-1.0' } },
      { allow, exceptions },
    );
    assert.equal(relicensed.violations.length, 1);
    assert.equal(relicensed.usedExceptions.size, 0);
  });

  it('matches an exception against the star-stripped license', () => {
    const exceptions = { special: { license: 'CC-BY-4.0' } };
    const { violations, usedExceptions } = classifyPackages(
      { 'special@1.0.0': { licenses: 'CC-BY-4.0*' } },
      { allow, exceptions },
    );
    assert.deepEqual(violations, []);
    assert.deepEqual([...usedExceptions], ['special']);
  });

  it('joins deprecated license arrays with AND (fail-closed)', () => {
    const both = classifyPackages(
      { 'legacy@1.0.0': { licenses: ['MIT', 'Apache-2.0'] } },
      { allow, exceptions: {} },
    );
    assert.deepEqual(both.violations, []);

    const mixed = classifyPackages(
      { 'legacy@1.0.0': { licenses: ['MIT', 'SSPL-1.0'] } },
      { allow, exceptions: {} },
    );
    assert.equal(mixed.violations.length, 1);
  });
});

describe('missingRootDisposition — the fail-open path stays closed in CI', () => {
  it('fails closed in CI and skips locally', () => {
    assert.equal(missingRootDisposition({ ci: true }), 'fail');
    assert.equal(missingRootDisposition({ ci: false }), 'skip');
  });
});

describe('staleExceptions', () => {
  it('names declared exceptions no scanned package used', () => {
    const exceptions = { a: { license: 'X' }, b: { license: 'Y' } };
    assert.deepEqual(staleExceptions(exceptions, new Set(['a'])), ['b']);
  });

  it('is empty when every exception matched', () => {
    const exceptions = { a: { license: 'X' } };
    assert.deepEqual(staleExceptions(exceptions, new Set(['a'])), []);
  });
});

describe('the shipped allow/exception data', () => {
  it('keeps the gate GPL-compatible: no copyleft-incompatible id on the global list', () => {
    // Spot checks on the committed data itself (the sets are code, not config).
    assert.equal(ALLOW.has('MIT'), true);
    assert.equal(ALLOW.has('SSPL-1.0'), false);
    assert.equal(ALLOW.has('CC-BY-3.0'), false); // exception-scoped only, never global
    for (const [name, exc] of Object.entries(EXCEPTIONS)) {
      assert.equal(typeof exc.license, 'string', `${name} exception must pin an exact license`);
    }
  });
});
