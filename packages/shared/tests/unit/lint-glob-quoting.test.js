/**
 * lint-glob-quoting.test.js — every root `lint:*` script hands its arguments
 * to the underlying tool in a form both shells deliver intact: none
 * single-quoted, each glob double-quoted and resolving to files; the quoting
 * rule stops at the lefthook hooks (`lefthook.yml` says why), while the
 * pre-push ESLint call is held to `lint:js`'s tree set less the trees the CI
 * guide names as CI's alone, and every tracked JavaScript file under
 * `packages/` is held to `lint:js`'s trees or the configuration's ignores.
 *
 * Regression: `npm run lint:md` and `npm run lint:css` were unusable on Windows.
 * Their globs were wrapped in SINGLE quotes. A POSIX shell strips single quotes,
 * so the tool receives a bare glob and expands it — but npm's script shell on
 * Windows is `cmd.exe`, which treats single quotes as ordinary characters and
 * passes them through literally. The tool then globs a pattern with the quote
 * characters still in it and matches nothing: `lint:md` linted zero files
 * (exit 0 — a silent false pass) and `lint:css` errored with "No files matching
 * the pattern" before linting anything. The fix double-quotes the globs —
 * `cmd.exe` strips double quotes, and a POSIX shell suppresses pathname
 * expansion inside them, so both shells deliver the bare glob.
 *
 * This guard reproduces the failure on any OS by modelling how `cmd.exe`
 * delivers a script's argv to the child. It runs red against the
 * single-quoted form regardless of the host platform.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, globSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../../..');

const scripts = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;

/** The characters that make an argument a pattern the tool expands. */
const GLOB_CHARS = /[*?[\]{}]/;

/**
 * Tokenize a command string the way Windows `cmd.exe` (npm's default script
 * shell) delivers argv to the spawned tool: arguments split on unquoted
 * whitespace; a double quote groups its contents and is removed; a single quote
 * is an ordinary literal character and is kept. Modelling that single-quote rule
 * is the whole point — it is exactly what breaks the glob on Windows.
 *
 * Each argument also records whether a glob character appeared in it outside
 * double quotes, where a POSIX shell would expand it before the tool runs.
 *
 * @param {string} command
 * @returns {{ value: string, bareGlob: boolean }[]} argv as the child receives it under cmd.exe
 */
function windowsCmdArgv(command) {
  const argv = [];
  let current = null; // null = between args; otherwise the arg being accumulated
  let inDoubleQuote = false;
  for (const ch of command) {
    if (ch === '"') {
      inDoubleQuote = !inDoubleQuote; // grouping only — the quote itself is dropped
      current ??= { value: '', bareGlob: false };
      continue;
    }
    if (/\s/.test(ch) && !inDoubleQuote) {
      if (current !== null) {
        argv.push(current);
        current = null;
      }
      continue;
    }
    current ??= { value: '', bareGlob: false };
    current.value += ch; // single quotes fall through here — kept literally
    if (!inDoubleQuote && GLOB_CHARS.test(ch)) current.bareGlob = true;
  }
  if (current !== null) argv.push(current);
  return argv;
}

/** Glob args a lint tool expands: positional args carrying a glob character,
 * with markdownlint's `#`-prefixed negations split off, as cmd.exe delivers them. */
function globArgsOf(argv) {
  const globs = argv.map((a) => a.value).filter((a) => !a.startsWith('-') && GLOB_CHARS.test(a));
  return { all: globs, positive: globs.filter((a) => !a.startsWith('#')) };
}

const gates = Object.entries(scripts)
  .filter(([name]) => name.startsWith('lint:'))
  .map(([name, script]) => ({ name, script }));

/**
 * The arguments of an ESLint command line, as cmd.exe delivers them.
 *
 * @param {string} argsText the arguments following the `eslint` word
 * @returns {string[]}
 */
function eslintArgs(argsText) {
  return windowsCmdArgv(argsText).map((a) => a.value);
}

/**
 * The trees an ESLint command line names, trailing slashes removed, so two
 * spellings of one tree compare equal.
 *
 * @param {string} argsText the arguments following the `eslint` word
 * @returns {Set<string>}
 */
function eslintTrees(argsText) {
  return new Set(eslintArgs(argsText).map((a) => a.replace(/\/+$/, '')));
}

describe('lint script quoting is cross-platform (Windows cmd.exe delivery)', () => {
  it('the argument model keeps a single quote literal', () => {
    const [, arg] = windowsCmdArgv("t 'a/**'");
    assert.ok(arg.value.includes("'"), 'cmd.exe passes a single quote through to the tool');
  });

  it('the argument model flags a bare glob', () => {
    const [, arg] = windowsCmdArgv('t a/**');
    assert.equal(arg.bareGlob, true);
  });

  it('the argument model admits a double-quoted glob', () => {
    const [, arg] = windowsCmdArgv('t "a/**"');
    assert.equal(arg.value, 'a/**');
    assert.equal(arg.bareGlob, false);
  });

  it("the pre-push ESLint call reaches every lint:js tree except the ones the CI guide names as CI's alone", () => {
    const hook = readFileSync(path.join(ROOT, 'lefthook.yml'), 'utf8').match(
      /\blint-js:\s*\n\s*run:\s*npx eslint\s+(.+)/,
    );
    assert.ok(hook, 'lefthook.yml: no pre-push lint-js command running `npx eslint` was found');
    const script = scripts['lint:js'].match(/^eslint\s+(.+)$/);
    assert.ok(script, 'package.json: lint:js does not run eslint');

    const ciGuide = readFileSync(path.join(ROOT, 'docs/guides/ci.md'), 'utf8').replace(/\s+/g, ' ');
    const sentence = ciGuide.match(/CI's `lint:js` also covers (.+?)(?:, so|\.)/);
    assert.ok(
      sentence,
      'docs/guides/ci.md: the §Local hooks sentence "CI\'s `lint:js` also covers … and …" ' +
        'naming the trees the pre-push hook leaves to CI was not found',
    );
    const ciOnly = [...sentence[1].matchAll(/`([^`]+)`/g)].map((m) => m[1].replace(/\/+$/, ''));

    // The comparison is between trees: a flag in either list has no tree to match.
    for (const [file, argsText] of [
      ['lefthook.yml', hook[1]],
      ['package.json lint:js', script[1]],
    ]) {
      const flags = eslintArgs(argsText).filter((a) => a.startsWith('-'));
      assert.deepEqual(
        flags,
        [],
        `${file}: the ESLint call carries ${flags.join(', ')}; the tree comparison admits no flags`,
      );
    }

    const expected = [...eslintTrees(script[1])].filter((t) => !ciOnly.includes(t)).sort();
    assert.deepEqual(
      [...eslintTrees(hook[1])].sort(),
      expected,
      "the pre-push ESLint call in lefthook.yml must list lint:js's trees less the trees " +
        "docs/guides/ci.md §Local hooks names as CI's alone; add the tree to the hook, or " +
        `name it in that sentence (it names as CI's alone: ${ciOnly.join(', ')})`,
    );
  });

  it('every tracked JavaScript file under packages/ is reached by lint:js or ignored by the configuration', async () => {
    const trees = [...eslintTrees(scripts['lint:js'].replace(/^eslint\s+/, ''))];
    const config = (await import(path.join(ROOT, 'eslint.config.js'))).default;
    const ignores = config
      .filter((block) => block.ignores && Object.keys(block).length === 1)
      .flatMap((block) => block.ignores);
    const files = execFileSync('git', ['ls-files', '-z', '--', 'packages'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\0')
      .filter((f) => /\.(js|mjs|cjs)$/.test(f));
    assert.ok(files.length > 0, 'git ls-files listed no JavaScript file under packages/');
    const unreached = files.filter(
      (f) =>
        !trees.some((t) => f.startsWith(t + '/')) &&
        !ignores.some((pattern) => path.matchesGlob(f, pattern)),
    );
    assert.deepEqual(
      unreached,
      [],
      'these tracked files are under no tree lint:js lists and match no ignore pattern in ' +
        'eslint.config.js: add their tree to lint:js (and the pre-push hook), or ignore them',
    );
  });

  it('the guard reads the lint script family', () => {
    for (const name of ['lint:md', 'lint:css', 'lint:js']) {
      assert.ok(
        gates.some((g) => g.name === name),
        `${name} is missing from the guarded set`,
      );
    }
  });

  for (const { name, script } of gates) {
    it(`regression_${name.replaceAll(':', '_').replaceAll('-', '_')}_args_survive_windows_cmd_quoting`, () => {
      const [, ...args] = windowsCmdArgv(script);

      // The defect: a single-quoted argument reaches the tool with its quotes intact.
      for (const { value } of args) {
        assert.ok(
          !value.includes("'"),
          `${name}: argument ${JSON.stringify(value)} reaches the tool with a ` +
            `literal single quote under cmd.exe — it names nothing on Windows. ` +
            `Use double quotes so both cmd.exe and POSIX shells deliver it bare.`,
        );
      }

      // A glob outside double quotes is expanded by a POSIX shell and passed
      // through by cmd.exe — the two shells hand the tool different inputs.
      for (const { value, bareGlob } of args) {
        assert.ok(
          !bareGlob,
          `${name}: glob argument ${JSON.stringify(value)} is not double-quoted — ` +
            `a POSIX shell expands it before the tool runs, cmd.exe does not.`,
        );
      }

      // And each glob the tool actually receives must resolve to real files —
      // the single-quoted form globs zero (the silent-pass / no-files failure).
      for (const glob of globArgsOf(args).positive) {
        const matches = globSync(glob, {
          cwd: ROOT,
          exclude: (p) => p.includes('node_modules'), // keep the walk off node_modules
        });
        assert.ok(
          matches.length >= 1,
          `${name}: glob ${JSON.stringify(glob)} (as cmd.exe delivers it) matches no ` +
            `files — the gate would lint nothing on Windows.`,
        );
      }
    });
  }
});
