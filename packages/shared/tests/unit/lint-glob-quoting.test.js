/**
 * lint-glob-quoting.test.js — the root Markdown/CSS lint scripts must hand their
 * globs to the underlying tool in a form Windows `cmd.exe` delivers intact.
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
 * delivers a script's argv to the child, then asserting each gate's glob (a)
 * carries no literal single quote and (b) still resolves to real files. It runs
 * red against the single-quoted form regardless of the host platform.
 *
 * No public issue — tracked as a confirmed defect in the project's local backlog.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, globSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../../..');

const scripts = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;

/**
 * Tokenize a command string the way Windows `cmd.exe` (npm's default script
 * shell) delivers argv to the spawned tool: arguments split on unquoted
 * whitespace; a double quote groups its contents and is removed; a single quote
 * is an ordinary literal character and is kept. Modelling that single-quote rule
 * is the whole point — it is exactly what breaks the glob on Windows.
 *
 * @param {string} command
 * @returns {string[]} argv as the child process receives it under cmd.exe
 */
function windowsCmdArgv(command) {
  const argv = [];
  let current = null; // null = between args; string = accumulating an arg
  let inDoubleQuote = false;
  for (const ch of command) {
    if (ch === '"') {
      inDoubleQuote = !inDoubleQuote; // grouping only — the quote itself is dropped
      if (current === null) current = '';
      continue;
    }
    if (/\s/.test(ch) && !inDoubleQuote) {
      if (current !== null) {
        argv.push(current);
        current = null;
      }
      continue;
    }
    current = (current ?? '') + ch; // single quotes fall through here — kept literally
  }
  if (current !== null) argv.push(current);
  return argv;
}

/** Glob args a lint tool expands: positional (drop `-flags`), splitting off
 * markdownlint's `#`-prefixed negations, as cmd.exe would deliver them. */
function globArgsOf(script) {
  const [, ...args] = windowsCmdArgv(script);
  const positional = args.filter((a) => !a.startsWith('-'));
  return {
    all: positional,
    positive: positional.filter((a) => !a.startsWith('#')),
  };
}

const gates = [
  { name: 'lint:md', script: scripts['lint:md'] },
  { name: 'lint:css', script: scripts['lint:css'] },
];

describe('lint glob quoting is cross-platform (Windows cmd.exe delivery)', () => {
  for (const { name, script } of gates) {
    it(`regression_${name.replace(':', '_')}_glob_survives_windows_cmd_quoting`, () => {
      assert.ok(script, `${name} script is missing from package.json`);
      const { all, positive } = globArgsOf(script);

      // The defect: a single-quoted glob reaches the tool with its quotes intact.
      for (const arg of all) {
        assert.ok(
          !arg.includes("'"),
          `${name}: glob argument ${JSON.stringify(arg)} reaches the tool with a ` +
            `literal single quote under cmd.exe — it will match nothing on Windows. ` +
            `Use double quotes so both cmd.exe and POSIX shells deliver a bare glob.`,
        );
      }

      // And the glob the tool actually receives must resolve to real files —
      // the single-quoted form globs zero (the silent-pass / no-files failure).
      assert.ok(positive.length >= 1, `${name}: expected at least one positive glob`);
      for (const glob of positive) {
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
