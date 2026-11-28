/**
 * check-action-pins.test.js — Unit tests for the GitHub Actions SHA-pin guard:
 * every `uses:` must pin to a 40-char commit SHA; local `./…` refs are exempt.
 * The offender list and the count of what was read come from one pass, so the
 * two shapes where that read finds nothing — a file list naming no file, and a
 * file set stating no `uses:` reference between them — are refused here rather
 * than reported as a clean tree, and each of the command line's verdicts is
 * pinned at the process boundary: the committed tree's green, the refusals a
 * scan reading nothing raises, an unpinned reference and a codecov step without the flag.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ACTIONS_ROOT,
  InputError,
  WORKFLOWS_ROOT,
  actionFiles,
  auditActions,
  readCodecovSteps,
  findUnpinned,
  isPinned,
  readUses,
} from '../../../../scripts/check-action-pins.js';

const SHA = 'a'.repeat(40);
const ROOT = path.resolve(import.meta.dirname, '../../../..');

describe('findUnpinned — SHA-pin enforcement for `uses:`', () => {
  it('accepts a 40-char commit SHA pin', () => {
    assert.deepEqual(findUnpinned(`      - uses: actions/checkout@${SHA} # v6`), []);
  });

  it('flags a mutable tag pin', () => {
    const r = findUnpinned('      - uses: actions/checkout@v6');
    assert.equal(r.length, 1);
    assert.equal(r[0].ref, 'actions/checkout@v6');
  });

  it('flags a branch ref', () => {
    assert.equal(findUnpinned('      - uses: dtolnay/rust-toolchain@stable').length, 1);
  });

  it('flags a missing ref', () => {
    assert.equal(findUnpinned('      - uses: actions/checkout').length, 1);
  });

  it('exempts local actions / reusable workflows', () => {
    assert.deepEqual(findUnpinned('      uses: ./.github/workflows/test.yml'), []);
    assert.deepEqual(findUnpinned('      - uses: ./.github/actions/debug-env'), []);
  });

  it('handles quotes and reports the 1-based line number', () => {
    const text = ['jobs:', '  x:', "    - uses: 'owner/repo@v1'"].join('\n');
    const r = findUnpinned(text);
    assert.equal(r.length, 1);
    assert.equal(r[0].line, 3);
    assert.equal(r[0].ref, 'owner/repo@v1');
  });

  it('requires a SHA on subpath actions too', () => {
    assert.equal(findUnpinned('      - uses: github/codeql-action/upload-sarif@v3').length, 1);
    assert.deepEqual(
      findUnpinned(`      - uses: github/codeql-action/upload-sarif@${SHA} # v3`),
      [],
    );
  });

  it('ignores an uppercase/short hex that is not a full SHA', () => {
    assert.equal(findUnpinned('      - uses: a/b@DEADBEEF').length, 1);
    assert.equal(findUnpinned('      - uses: a/b@abc123').length, 1);
  });
});

describe('readUses — the one read the verdict and the count both come from', () => {
  it('returns every reference, pinned and unpinned alike, with its line', () => {
    const text = [
      'jobs:',
      '  x:',
      '    steps:',
      `      - uses: actions/checkout@${SHA} # v6`,
      '      - uses: actions/setup-node@v4',
      '      - run: npm ci',
      '      - uses: ./.github/actions/debug-env',
    ].join('\n');
    assert.deepEqual(readUses(text), [
      { line: 4, ref: `actions/checkout@${SHA}` },
      { line: 5, ref: 'actions/setup-node@v4' },
      { line: 7, ref: './.github/actions/debug-env' },
    ]);
    // The offenders are that same read, filtered — never a second scan.
    assert.deepEqual(findUnpinned(text), [{ line: 5, ref: 'actions/setup-node@v4' }]);
  });

  it('answers with nothing for a file that states no reference', () => {
    assert.deepEqual(readUses('jobs:\n  x:\n    steps:\n      - run: npm ci\n'), []);
  });

  it('isPinned exempts a local ref and holds every other to a full SHA', () => {
    assert.equal(isPinned('./.github/workflows/test.yml'), true);
    assert.equal(isPinned(`actions/checkout@${SHA}`), true);
    assert.equal(isPinned('actions/checkout@v6'), false);
    assert.equal(isPinned('actions/checkout'), false);
  });
});

describe('auditActions — the refusals a read that found nothing takes', () => {
  const codecov = (key) =>
    `      - uses: codecov/codecov-action@${SHA} # v7\n        with:\n          files: x\n${key}`;
  const strict = codecov('          fail_ci_if_error: true\n');
  const pinnedFile = `jobs:\n  x:\n    steps:\n      - uses: actions/checkout@${SHA} # v6\n${strict}`;

  /** The audit's two seams over a fixed file set, named as the audit takes them. */
  const over = (files) => ({ readFile: (f) => files[f], listFiles: () => Object.keys(files) });

  it('counts the files read and the references found, and names each offender', () => {
    const audit = auditActions(
      over({ 'a.yml': pinnedFile, 'b.yml': '      - uses: owner/repo@v1\n' }),
    );
    assert.equal(audit.fileCount, 2);
    assert.equal(audit.useCount, 3);
    assert.equal(audit.codecovCount, 1);
    assert.deepEqual(audit.lax, []);
    assert.deepEqual(audit.unpinned, [{ file: 'b.yml', line: 1, ref: 'owner/repo@v1' }]);
  });

  it('refuses a file list that names no file', () => {
    assert.throws(
      () => auditActions(over({})),
      (error) => error instanceof InputError && /yielded no file/.test(error.message),
    );
  });

  it('refuses a file set stating no `uses:` reference between them', () => {
    // The shape a scan that stopped matching leaves behind: files were read,
    // and nothing came back — which is not the same as nothing to pin.
    assert.throws(
      () => auditActions(over({ 'a.yml': 'jobs:\n  x:\n', 'b.yml': 'name: nothing\n' })),
      (error) => error instanceof InputError && /state no `uses:` reference/.test(error.message),
    );
  });

  it('names each codecov step lacking the flag, from the same read', () => {
    const audit = auditActions(over({ 'a.yml': pinnedFile, 'b.yml': codecov('') }));
    assert.equal(audit.codecovCount, 2);
    assert.deepEqual(audit.lax, [{ file: 'b.yml', line: 1 }]);
  });

  it('refuses a file set stating no codecov step, though it states references', () => {
    assert.throws(
      () => auditActions(over({ 'a.yml': `      - uses: actions/checkout@${SHA}\n` })),
      (error) =>
        error instanceof InputError &&
        /state no `codecov\/codecov-action` step/.test(error.message),
    );
  });

  it('does not refuse one file without a reference beside one with', () => {
    const audit = auditActions(over({ 'a.yml': 'name: nothing\n', 'b.yml': pinnedFile }));
    assert.equal(audit.useCount, 2);
    assert.deepEqual(audit.unpinned, []);
  });

  it('reads the committed tree through both roots it scans', () => {
    const files = actionFiles();
    assert.ok(files.some((f) => f.startsWith('.github/workflows/')), files.join('\n')); // prettier-ignore
    assert.ok(files.some((f) => f.startsWith('.github/actions/')), files.join('\n')); // prettier-ignore
  });
});

describe('codecov steps — every upload error must fail its job', () => {
  const step = (extra = '') =>
    `      - name: up\n        uses: codecov/codecov-action@${SHA} # v7\n        with:\n          files: x\n${extra}`;

  it('reads a step strict only when its own lines state fail_ci_if_error: true', () => {
    assert.deepEqual(readCodecovSteps(step('          fail_ci_if_error: true\n')), [
      { line: 2, strict: true },
    ]);
    assert.deepEqual(readCodecovSteps(step()), [{ line: 2, strict: false }]);
    assert.equal(readCodecovSteps(step('          fail_ci_if_error: false\n'))[0].strict, false);
    assert.equal(readCodecovSteps(step('          # fail_ci_if_error: true\n'))[0].strict, false);
  });

  it('counts the key only inside the step’s `with:` mapping', () => {
    const env = '        env:\n          fail_ci_if_error: true\n';
    assert.equal(readCodecovSteps(step(env))[0].strict, false);
    assert.equal(readCodecovSteps(step().replace('        with:', env + '        with:'))[0].strict, false); // prettier-ignore
    assert.equal(readCodecovSteps(step('          fail_ci_if_error: true\n'))[0].strict, true);
  });

  it('does not credit a step with the next step’s key', () => {
    const text = step() + '      - name: next\n        with:\n          fail_ci_if_error: true\n';
    assert.deepEqual(readCodecovSteps(text), [{ line: 2, strict: false }]);
  });
});

describe('the command line’s verdict over the committed tree', () => {
  it('exits 0 and states what it read', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/check-action-pins.js')], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /pinned/i);
    assert.match(
      r.stdout,
      /All \d+ codecov\/codecov-action step\(s\) state fail_ci_if_error: true/,
    );
    assert.match(r.stdout, /reference\(s\), read across \d+ workflow and composite-action file/);
  });
});

describe('the command line’s other verdicts, over throwaway trees', () => {
  const STRICT_STEP = `  - uses: codecov/codecov-action@${SHA} # v7\n    with:\n      fail_ci_if_error: true\n`;
  const CODECOV_STEP = `steps:\n  - name: up\n    uses: codecov/codecov-action@${SHA} # v7\n    with:\n      files: x\n`;
  // The check derives the root it scans from the file it is written IN, never
  // from the working directory, so a throwaway tree carries a copy of the
  // script beside the two roots. The copy is the shipped text run unchanged —
  // this script imports node builtins only, so it runs wherever it is placed.
  const SOURCE = path.join(ROOT, 'scripts', 'check-action-pins.js');
  let root = null;

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /**
   * A throwaway tree with both scanned roots present, `files` written under
   * them, and the script beside them. Returns the copy's path, which is what
   * makes that tree the one the run reads.
   */
  function tree(files = {}) {
    root ??= mkdtempSync(path.join(tmpdir(), 'docent-pins-cli-'));
    const dir = mkdtempSync(path.join(root, 'case-'));
    for (const rel of [WORKFLOWS_ROOT, ACTIONS_ROOT, 'scripts']) {
      mkdirSync(path.join(dir, ...rel.split('/')), { recursive: true });
    }
    const script = path.join(dir, 'scripts', 'check-action-pins.js');
    copyFileSync(SOURCE, script);
    for (const [rel, text] of Object.entries(files)) {
      const target = path.join(dir, ...rel.split('/'));
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    return script;
  }

  /** Run the copied CLI over the tree it sits in. */
  function run(script) {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  it('both roots present and naming no file is the refusal, on exit 2', () => {
    const r = run(tree());
    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /answered with something other than what it reads there/);
    assert.match(r.stderr, /yielded no file/);
    assert.match(r.stderr, /Exit 2 keeps that apart/);
    assert.doesNotMatch(r.stderr, /^\s+at /m);
  });

  it('a workflow carrying an unpinned reference ends on exit 1 instead', () => {
    const r = run(
      tree({
        [`${WORKFLOWS_ROOT}/test.yml`]:
          ['jobs:', '  x:', '    steps:', '      - uses: actions/checkout@v6', ''].join('\n') +
          STRICT_STEP,
      }),
    );
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /test\.yml:4 — not SHA-pinned: actions\/checkout@v6/);
    assert.match(r.stderr, /1 unpinned action\./);
  });

  it('a pinned codecov step without the flag ends on exit 1, naming file and line', () => {
    const r = run(tree({ [`${WORKFLOWS_ROOT}/test.yml`]: CODECOV_STEP }));
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /test\.yml:3 — codecov\/codecov-action step without fail_ci_if_error/);
  });

  it('pinned workflows with no codecov step are the refusal, on exit 2', () => {
    const r = run(
      tree({ [`${WORKFLOWS_ROOT}/test.yml`]: `steps:\n  - uses: actions/checkout@${SHA}\n` }),
    );
    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /state no `codecov\/codecov-action` step/);
  });

  it('an unpinned reference and a lax codecov step are both reported in one run', () => {
    const r = run(
      tree({
        [`${WORKFLOWS_ROOT}/test.yml`]: CODECOV_STEP + '  - uses: actions/checkout@v6\n',
      }),
    );
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /not SHA-pinned: actions\/checkout@v6/);
    assert.match(r.stderr, /step without fail_ci_if_error/);
  });
});
