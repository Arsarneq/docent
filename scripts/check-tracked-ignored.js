/**
 * check-tracked-ignored.js — every file the repository tracks is one its
 * `.gitignore` rules admit. Git answers this directly:
 * `git ls-files -z -i -c --exclude-per-directory=.gitignore` lists the tracked
 * files matching a `.gitignore` rule, and that list must be empty.
 *
 * Why it is worth a gate: an ignore rule has no effect on a file that is
 * already tracked, so the two can disagree silently and indefinitely. Either
 * side may be the wrong one — a file committed before the rule existed and
 * should now go, or a rule written wider than intended that would swallow a
 * file the repository deliberately commits (the assembled `index.html` panel
 * pages are the standing example; .gitignore says in place why they are not
 * ignored). Both are decisions someone should make deliberately, which is what
 * a red here forces.
 *
 * The question is scoped to the `.gitignore` files in the tree rather than to
 * git's standard exclude set, so a contributor's personal global excludes and
 * their local `info/exclude` cannot decide it: a file this repository
 * deliberately commits must not turn red because someone else ignores that name
 * on their own machine.
 *
 * The list is read NUL-separated because git otherwise renders a path holding a
 * non-ASCII or control character in its quoted C-style form — a path the
 * report's own `git rm --cached` suggestion would then not match.
 *
 * Usage:
 *   node scripts/check-tracked-ignored.js      # or: npm run lint:tracked-ignored
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** The git invocation that answers the question, kept in one place. */
export const GIT_ARGS = ['ls-files', '-z', '-i', '-c', '--exclude-per-directory=.gitignore'];

/**
 * Pure core: the offending paths in a NUL-separated `git ls-files` payload.
 * @param {string} stdout raw command output
 * @returns {string[]} tracked-but-ignored repo-relative paths, sorted
 */
export function parseFileList(stdout) {
  return stdout.split('\0').filter(Boolean).sort();
}

/**
 * Render the offenders as red output naming each path and the fix.
 * @param {string[]} offenders
 * @returns {string | null} the message, or null when the two agree
 */
export function formatProblem(offenders) {
  if (offenders.length === 0) return null;
  return (
    `✗ ${offenders.length} tracked file(s) match a .gitignore rule:\n` +
    offenders.map((f) => `    ${f}`).join('\n') +
    `\n\n  An ignore rule does not apply to a file that is already tracked, so this state is silent.\n` +
    `  Fix: untrack the file (\`git rm --cached <path>\`) if the ignore rule is right, or narrow the\n` +
    `  rule — and say in .gitignore why — if the file is deliberately committed.`
  );
}

/* c8 ignore start — the CLI wrapper runs git and prints; the parsing and
 * message logic it delegates to (parseFileList, formatProblem) is unit-tested. */
function run() {
  const offenders = parseFileList(execFileSync('git', GIT_ARGS, { encoding: 'utf8' }));
  const problem = formatProblem(offenders);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  console.log('✓ tracked files and ignore rules agree: no tracked file matches a .gitignore rule.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
/* c8 ignore stop */
