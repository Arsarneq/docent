/**
 * check-tracked-ignored.js — two things this repository holds about what its
 * index carries, each answered by its own question put to git.
 *
 *   1. every file the repository tracks is one its `.gitignore` rules admit.
 *      `git ls-files -z -i -c --exclude-per-directory=.gitignore` lists the
 *      tracked files matching a `.gitignore` rule, and that list must be empty.
 *   2. every entry the repository tracks is a regular file rather than a
 *      symbolic link. `git ls-files -z -s` lists the index with each entry's
 *      mode, and no entry may carry mode `120000`.
 *
 * Why the first is worth a gate: an ignore rule has no effect on a file that is
 * already tracked, so the two can disagree silently and indefinitely. Either
 * side may be the wrong one — a file committed before the rule existed and
 * should now go, or a rule written wider than intended that would swallow a
 * file the repository deliberately commits (the assembled `index.html` panel
 * pages are the standing example; .gitignore says in place why they are not
 * ignored). Both are decisions someone should make deliberately, which is what
 * a red here forces.
 *
 * Why the second is worth a gate BESIDE it rather than inside it: the ignore
 * question cannot see a symlink as a symlink. A `.gitignore` rule matches on
 * the path text, and its only type distinction is the trailing slash, which
 * selects directories; a tracked symlink is an index entry whose mode maps to a
 * link, which no pattern shape addresses. So a symlink checked into the index
 * satisfies the first question and answers nothing about the second. A tracked
 * symlink is a checkout hazard — the platforms differ on what one becomes when
 * the working tree is written — so it is a decision to make deliberately.
 *
 * That refusal is total over mode-`120000` entries: this check admits none. If
 * this repository ever tracks a symlink on purpose, the route is an explicit
 * admission entry recording the path and the reason it is deliberate — the
 * shape [`check-doc-reachability.js`](./check-doc-reachability.js)'s ALLOWLIST
 * uses — added in the change that first tracks one, and not before: a register
 * with no member states nothing and can only rot.
 *
 * The refusal names the path and its mode, never the link's target text: a
 * target can be a machine-local absolute path, and reprinting it puts one
 * machine's layout into a verdict every machine reads.
 *
 * Both lists are read NUL-separated because git otherwise renders a path
 * holding a non-ASCII or control character in its quoted C-style form — a path
 * the report's own `git rm --cached` suggestion would then not match.
 *
 * The two questions differ in what an EMPTY answer means, so the check reads
 * them differently. The ignore question's empty answer IS the green: no tracked
 * file matched a rule. The mode question is asked over the whole index, so a
 * checkout that tracks anything answers with one record per entry — an empty
 * answer there is the read having failed, not an index free of links. That
 * shape, and a record whose text the mode read does not model, are refused
 * outright on this check's own exit code (exit 2), never as a pass and never as
 * an offending entry (exit 1). The green line states how many entries the mode
 * question answered with, so a read that saw nothing cannot report a clean
 * index.
 *
 * Usage:
 *   node scripts/check-tracked-ignored.js      # or: npm run lint:tracked-ignored
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
// A shared reader only — that module imports node builtins and nothing else,
// so this command line still carries no parser or heavy module it does not
// use: importing a builtins-only module is within the lean-closure principle
// scripts/governance-data.js states.
import { selfPath } from './check-test-inventory.js';

export const SELF_PATH = selfPath(import.meta.filename);

/** The git invocation that answers the ignore question, kept in one place. */
export const GIT_ARGS = ['ls-files', '-z', '-i', '-c', '--exclude-per-directory=.gitignore'];

/**
 * The git invocation that answers the mode question. Deliberately without `-i`
 * and `-c`: those two scope the first question to the tracked files a
 * `.gitignore` rule matches, and this one is asked over the whole index —
 * every entry it carries, whatever any ignore rule says about the path.
 *
 * BOTH of this check's git reads are taken here rather than through the shared
 * population reader, each for its own reason: the ignore question above needs
 * flags that reader does not take (`-i`, `-c`, `--exclude-per-directory`), and
 * this one needs the mode standing beside each path rather than the path alone.
 */
export const GIT_MODE_ARGS = ['ls-files', '-z', '-s'];

/** The index mode a symbolic-link entry carries. */
export const SYMLINK_MODE = '120000';

/**
 * An input this check reads that answered with something other than the surface
 * it reads there — machinery breakage, reported on the check's own exit code so
 * it is never read as an index that carries an offending entry.
 */
export class InputError extends Error {}

/**
 * Pure core: the offending paths in a NUL-separated `git ls-files` payload.
 * @param {string} stdout raw command output
 * @returns {string[]} tracked-but-ignored repo-relative paths, sorted
 */
export function parseFileList(stdout) {
  return stdout.split('\0').filter(Boolean).sort();
}

/**
 * Pure core: how many entries the mode question's payload states, refusing one
 * that states none. The question is asked over the whole index, so any checkout
 * that tracks a file answers with a record per entry; a payload carrying none is
 * the read having failed rather than an index free of symbolic links, and the
 * green line's count comes from here so the two cannot be confused.
 * @param {string} stdout raw command output
 * @returns {number} the entries the payload states
 * @throws {InputError} when the payload states no entry at all
 */
export function countIndexEntries(stdout) {
  const count = stdout.split('\0').filter(Boolean).length;
  if (count === 0) {
    throw new InputError(
      `\`git ${GIT_MODE_ARGS.join(' ')}\` answered with no index entry — this check reads the ` +
        `mode beside every entry from that one listing, and a checkout tracking any file answers ` +
        `with a record apiece, so an answer naming none is a read that found nothing rather than ` +
        `an index carrying no symbolic link`,
    );
  }
  return count;
}

/**
 * Pure core: the symlink entries in a NUL-separated `git ls-files -s` payload.
 * Each record reads `<mode> <object> <stage>\t<path>`, so the mode is what the
 * record opens with and the path is what follows the tab. A record opening with
 * the symlink mode and carrying no tab is a shape this read does not model, and
 * is refused rather than reported with the whole record standing in for a path.
 * @param {string} stdout raw command output
 * @returns {string[]} tracked symlink repo-relative paths, sorted
 * @throws {InputError} when a symlink-mode record states no tab
 */
export function parseSymlinkPaths(stdout) {
  return stdout
    .split('\0')
    .filter(Boolean)
    .filter((record) => record.startsWith(`${SYMLINK_MODE} `))
    .map((record) => {
      const tab = record.indexOf('\t');
      if (tab === -1) {
        throw new InputError(
          `\`git ${GIT_MODE_ARGS.join(' ')}\` answered with a record opening on mode ` +
            `${SYMLINK_MODE} and carrying no tab — this check reads such a record as ` +
            `\`<mode> <object> <stage>\` then a tab then the path, so what came back states no ` +
            `path to name (the record's own text is not reprinted: this check prints paths and ` +
            `modes, never whatever else a record may carry)`,
        );
      }
      return record.slice(tab + 1);
    })
    .sort();
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

/**
 * Render the tracked symlinks as red output naming each path and its mode. The
 * link's target text is deliberately not printed: it can be a machine-local
 * absolute path, and this verdict is read on every machine.
 * @param {string[]} paths tracked symlink paths
 * @returns {string | null} the message, or null when the index carries none
 */
export function formatSymlinkProblem(paths) {
  if (paths.length === 0) return null;
  return (
    `✗ ${paths.length} tracked entr${paths.length === 1 ? 'y is' : 'ies are'} a symbolic link (index mode ${SYMLINK_MODE}):\n` +
    paths.map((f) => `    ${f}`).join('\n') +
    `\n\n  The ignore question above cannot see this: a .gitignore rule matches path text and its\n` +
    `  only type distinction is the trailing slash, which selects directories — a link is a mode\n` +
    `  on an index entry, which no pattern shape addresses.\n` +
    `  Fix: untrack the entry (\`git rm --cached <path>\`) and commit the file itself, or — if this\n` +
    `  repository is to track a link deliberately — add an admission entry to\n` +
    `  ${SELF_PATH} recording the path and its reason, in the change that first tracks one.`
  );
}

/* c8 ignore start — the CLI wrapper runs git and prints; the parsing, counting
 * and message logic it delegates to (parseFileList, countIndexEntries,
 * parseSymlinkPaths, formatProblem, formatSymlinkProblem) is unit-tested. */
function run() {
  const offenders = parseFileList(execFileSync('git', GIT_ARGS, { encoding: 'utf8' }));
  const modes = execFileSync('git', GIT_MODE_ARGS, { encoding: 'utf8' });
  let entryCount;
  let symlinks;
  try {
    entryCount = countIndexEntries(modes);
    symlinks = parseSymlinkPaths(modes);
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    console.error(
      `✗ an input this check reads answered with something other than what it reads there:\n` +
        `    ${error.message}\n\n` +
        `  The index-mode question is asked over every entry the index carries, so an answer this\n` +
        `  read cannot take is this verdict rather than a clean bill. Exit 2 keeps that apart from\n` +
        `  a tracked entry that offends (exit 1).\n`,
    );
    process.exit(2);
  }
  const problems = [formatProblem(offenders), formatSymlinkProblem(symlinks)].filter(Boolean);
  if (problems.length > 0) {
    console.error(problems.join('\n\n'));
    process.exit(1);
  }
  console.log(
    `✓ tracked files and ignore rules agree: across the ${entryCount} entr` +
      `${entryCount === 1 ? 'y' : 'ies'} the index carries, no tracked file matches a .gitignore ` +
      'rule, and no tracked entry is a symbolic link.',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
/* c8 ignore stop */
