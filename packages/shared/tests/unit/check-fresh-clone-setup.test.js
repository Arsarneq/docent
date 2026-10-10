/**
 * check-fresh-clone-setup.test.js — the extraction of the contributing guide's
 * Chrome Extension block, the script built from it, and the run path. The run
 * cases' empty-`tmp` assertions hold that the temporary directory is removed;
 * the builder case's exact line holds the trap, and the `kill -KILL $$` case,
 * whose bash runs no trap, holds the check's own removal. The run cases live
 * under a directory whose name carries a space, beside a seeded sibling the
 * run hook asserts intact, so an unquoted removal path cannot pass.
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CLONE_LINE,
  GREEN,
  InputError,
  LINE_BASE,
  SYNCED_SCHEMA,
  buildScript,
  extractCommands,
  run,
} from '../../../../scripts/check-fresh-clone-setup.js';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const SCRIPT = path.join(ROOT, 'scripts/check-fresh-clone-setup.js');
const doc = (body) =>
  `# Guide\n\n## Development Setup\n\n### Chrome Extension\n\n${body}\n### Desktop\n\n\`\`\`bash\nnpm run other\n\`\`\`\n`;
const fence = (lang, lines) => `\`\`\`${lang}\n${lines.join('\n')}\n\`\`\`\n`;
const GOOD = [
  CLONE_LINE,
  'cd docent',
  '',
  '# Install root dependencies',
  'npm install',
  '### not a heading',
  'npm run dev:extension',
];
const CREATE = `mkdir -p ${path.dirname(SYNCED_SCHEMA)} && touch ${SYNCED_SCHEMA}`;

describe('extractCommands', () => {
  it('takes the one bash block, comment and blank lines dropped', () => {
    assert.deepEqual(extractCommands(doc(fence('bash', GOOD))), [
      CLONE_LINE,
      'cd docent',
      'npm install',
      'npm run dev:extension',
    ]);
  });
  it('refuses two bash blocks, naming the count', () => {
    assert.throws(
      () => extractCommands(doc(fence('bash', GOOD) + '\n' + fence('bash', GOOD))),
      (e) => e instanceof InputError && /2 bash blocks/.test(e.message),
    );
  });
  it('refuses a block fenced as sh', () => {
    assert.throws(
      () => extractCommands(doc(fence('sh', GOOD))),
      (e) => e instanceof InputError && /0 bash blocks/.test(e.message),
    );
  });
  it('refuses a block without the public clone line', () => {
    assert.throws(
      () => extractCommands(doc(fence('bash', GOOD.slice(1)))),
      (e) => e instanceof InputError && /no "git clone/.test(e.message),
    );
  });
  it('refuses a document without the section', () => {
    assert.throws(() => extractCommands('# Guide\n'), InputError);
  });
  for (const line of [
    'a; b',
    'cat <<EOF',
    'a & b',
    'a &',
    'a &&',
    'a |',
    'a |&',
    'a \\',
    'exit 3',
    'exec sh -c true',
    'exit>/dev/null 3',
    'true && exit 3',
    'cd x || exit 1',
    'a | exit 3',
  ]) {
    it(`refuses ${line}`, () => {
      assert.throws(
        () => extractCommands(doc(fence('bash', [CLONE_LINE, line]))),
        (e) => e instanceof InputError && e.message.includes(`"${line}"`),
      );
    });
  }
  for (const line of [
    'a && b',
    'a || b',
    'a | b',
    'npm x 2>&1 | head',
    'true &>/dev/null',
    'exit0=1',
    'exec-helper',
    'exit=1',
    CLONE_LINE,
  ]) {
    it(`admits ${line}`, () => {
      assert.ok(extractCommands(doc(fence('bash', [CLONE_LINE, line]))).includes(line));
    });
  }
  it('the committed guide extracts the clone, the cd, the root install and the sync', () => {
    assert.deepEqual(
      extractCommands(readFileSync(path.join(ROOT, '.github/CONTRIBUTING.md'), 'utf8')),
      [CLONE_LINE, 'cd docent', 'npm install', 'npm run dev:extension'],
    );
  });
});

describe('buildScript', () => {
  it('traps first, one group and status per line, the clone at the source, the schema test, the sentinel last', () => {
    const lines = buildScript([CLONE_LINE, "echo 'x'"], "/a b's", "/w x'y").split('\n');
    assert.equal(lines[0], `trap 'rm -rf '\\''/w x'\\''\\'\\'''\\''y'\\''' EXIT`);
    assert.deepEqual(lines.slice(1, 5), [
      `{ git clone -q '/a b'\\''s' docent`,
      `} || exit ${LINE_BASE}`,
      `{ echo 'x'`,
      `} || exit ${LINE_BASE + 1}`,
    ]);
    assert.equal(lines[5], `test -f '/w x'\\''y/docent/${SYNCED_SCHEMA}' || exit ${LINE_BASE + 2}`);
    assert.equal(lines[6], `exit ${GREEN}`);
  });
});

describe('run', () => {
  let parent;
  let dir;
  let sibling;
  before(() => {
    parent = mkdtempSync(path.join(tmpdir(), 'fresh-clone-setup-test-'));
    dir = mkdtempSync(path.join(parent, 'a b'));
    sibling = path.join(parent, 'a');
    mkdirSync(sibling);
    writeFileSync(path.join(sibling, 'seed'), 'seed');
  });
  afterEach(() => assert.deepEqual(readdirSync(sibling), ['seed']));
  after(() => rmSync(parent, { recursive: true, force: true }));
  const fixture = (name, text) => {
    const p = path.join(dir, name);
    writeFileSync(p, text);
    return p;
  };
  const runCase = (name, argvOrLines, opts = {}) => {
    const tmp = path.join(dir, `${name}.tmp`);
    mkdirSync(tmp);
    const argv =
      typeof argvOrLines[0] === 'string' && argvOrLines[0].startsWith('--')
        ? argvOrLines
        : ['--doc', fixture(`${name}.md`, doc(fence('bash', argvOrLines)))];
    const lines = [];
    const out = [];
    const code = run(argv, { tmp, ...opts, error: (l) => lines.push(l), log: (l) => out.push(l) });
    assert.deepEqual(readdirSync(tmp), []);
    return { code, text: [...out, ...lines].join('\n') };
  };
  const expectRun = (r, code, fragment) => {
    assert.equal(r.code, code);
    if (fragment) assert.ok(r.text.includes(fragment), r.text);
  };
  it('a failure in a non-final && position is drift even when a later line creates the copy', () => {
    expectRun(
      runCase('and', [CLONE_LINE, 'cd docent', 'npm run no-such-script && echo after', CREATE]),
      1,
      'npm run no-such-script && echo after',
    );
  });
  it('no schema copy is drift', () => {
    expectRun(runCase('true', [CLONE_LINE, 'cd docent', 'true']), 1, 'left no');
  });
  it('the copy present is green', () => {
    expectRun(runCase('green', [CLONE_LINE, 'cd docent', CREATE]), 0, `ran on a fresh clone of`);
  });
  it('a failing clone is machinery', () => {
    expectRun(
      runCase('clone', ['mkdir docent && touch docent/x', CLONE_LINE, 'cd docent']),
      2,
      ROOT,
    );
  });
  it('a status no line owns is machinery', () => {
    expectRun(runCase('exit7', [CLONE_LINE, "eval 'exit 7'"]), 2, 'status 7');
  });
  it('an early exit is machinery', () => {
    expectRun(runCase('exit', [CLONE_LINE, 'eval exit']), 2, 'status 0');
  });
  it('a signal is machinery', () => {
    expectRun(runCase('kill', [CLONE_LINE, 'kill -TERM $$']), 2, 'SIGTERM');
  });
  it('a SIGKILL is machinery and the check removes the directory', () => {
    expectRun(runCase('killk', [CLONE_LINE, 'kill -KILL $$']), 2, 'SIGKILL');
  });
  it('a source that cannot be looked up is machinery', () => {
    expectRun(
      runCase('lookup', [CLONE_LINE], { source: path.join(dir, 'nowhere') }),
      2,
      'cannot change to',
    );
  });
  it('a tmp that does not exist is machinery', () => {
    expectRun(runCase('tmp', [CLONE_LINE], { tmp: path.join(dir, 'absent') }), 2, 'mkdtemp');
  });
  it('a document that does not exist is machinery', () => {
    expectRun(runCase('nodoc', ['--doc', path.join(dir, 'absent.md')]), 2, 'ENOENT');
  });
  it('a bare --doc is machinery', () => {
    expectRun(runCase('baredoc', ['--doc']), 2, '`--doc` needs a path');
  });
  it('the entry point runs (--dry-run on the committed guide)', () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
    );
    const r = spawnSync(process.execPath, [SCRIPT, '--dry-run'], { encoding: 'utf8', env });
    assert.equal(r.status, 0);
    assert.equal(
      r.stdout,
      [CLONE_LINE, 'cd docent', 'npm install', 'npm run dev:extension', ''].join('\n'),
    );
  });
});
