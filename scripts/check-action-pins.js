/**
 * check-action-pins.js — Fail if any GitHub Actions `uses:` is not pinned to a
 * full 40-character commit SHA.
 *
 * Pinning to a mutable tag (`actions/checkout@v6`) lets the tag's owner — or an
 * attacker who compromises their account — repoint it at malicious code that then
 * runs in CI. This guard keeps every action SHA-pinned so a future commit,
 * contributor, or agent can't silently reintroduce a tag pin. Local actions and
 * reusable workflows (`./…`) are exempt — they live in this repo. Dependabot
 * (the `github-actions` ecosystem) bumps the SHA + the trailing `# version`
 * comment on its weekly run.
 *
 * The offenders and the count of what was READ come from one pass over one
 * read, which is what makes the pass sayable: the green line states how many
 * `uses:` references were found and across how many files, so a scan that
 * stopped matching cannot report "nothing unpinned" while having seen nothing.
 * Two shapes of that are refused outright, on this check's own exit code
 * (exit 2), never as a pass and never as an unpinned action (exit 1): a file
 * list that names no file at all, and a file set carrying no `uses:` reference
 * between them. A single file without one is ordinary — many workflows have
 * none — so only the zero TOTAL is refused.
 *
 * Usage: node scripts/check-action-pins.js   # or: npm run check:action-pins
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const SHA_RE = /^[0-9a-f]{40}$/;

/** The two roots a `uses:` reference can be written under. */
export const WORKFLOWS_ROOT = '.github/workflows';
/** Composite actions live one directory down, each with its own definition. */
export const ACTIONS_ROOT = '.github/actions';

/**
 * An input this check reads that answered with something other than the surface
 * it reads there — machinery breakage, reported on the check's own exit code so
 * it is never read as an action that lost its pin.
 */
export class InputError extends Error {}

/**
 * Every `uses:` reference a workflow or composite-action file states, with the
 * 1-based line it stands on. This is the one read: the pin verdict and the
 * count of what was scanned both come from it, so a regex that stops matching
 * takes the count to zero rather than leaving an empty offender list behind.
 * @param {string} text the file's text
 * @returns {Array<{line: number, ref: string}>} the references, in file order
 */
export function readUses(text) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const m = line.match(/^\s*-?\s*uses:\s*(['"]?)([^'"#\s]+)\1/);
    if (m) out.push({ line: i + 1, ref: m[2] });
  });
  return out;
}

/**
 * Whether one reference is pinned as this guard requires: a local ref (`./…`,
 * `../…`) lives in this repository and is exempt; every other one carries a
 * full 40-character commit SHA after its last `@`.
 * @param {string} ref the reference as written
 * @returns {boolean}
 */
export function isPinned(ref) {
  if (ref.startsWith('./') || ref.startsWith('../')) return true;
  const at = ref.lastIndexOf('@');
  return SHA_RE.test(at === -1 ? '' : ref.slice(at + 1));
}

/**
 * Find `uses:` references in a workflow/action file that are NOT SHA-pinned.
 * Local refs (`./…`, `../…`) are exempt.
 *
 * The audit below reads and filters for itself, so this composition has no
 * caller outside the suite: it survives as the one place the two halves are
 * written as the single thing they mean — {@link readUses} filtered by
 * {@link isPinned} — which is what that suite reads them through.
 * @returns {Array<{line: number, ref: string}>}
 */
export function findUnpinned(text) {
  return readUses(text).filter(({ ref }) => !isPinned(ref));
}

/**
 * Workflow YAML + composite-action definitions to scan, as repo-relative paths.
 *
 * The population is a directory walk rather than the tracked listing every
 * other tree scan in this family takes. Two reasons, both about what this guard
 * is for: a workflow that is present but not yet tracked still runs on a push
 * once it is committed, and this check is what should have seen it; and the
 * composite-action root is a directory OF directories, each with its own
 * definition file, which a flat tracked pathspec does not describe.
 * @returns {string[]} repo-relative paths, workflows first
 */
export function actionFiles() {
  const files = [];
  const wf = join(ROOT, WORKFLOWS_ROOT);
  if (existsSync(wf)) {
    for (const f of readdirSync(wf)) if (/\.ya?ml$/.test(f)) files.push(`${WORKFLOWS_ROOT}/${f}`);
  }
  const actions = join(ROOT, ACTIONS_ROOT);
  if (existsSync(actions)) {
    for (const sub of readdirSync(actions, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      for (const name of ['action.yml', 'action.yaml']) {
        const rel = `${ACTIONS_ROOT}/${sub.name}/${name}`;
        if (existsSync(join(ROOT, rel))) files.push(rel);
      }
    }
  }
  return files;
}

/**
 * Pure core: the pin verdict over a file set, and the counts that say what was
 * read to reach it. Both come from the one {@link readUses} pass per file.
 * @param {object} seams the reads this audit is taken through
 * @param {(path: string) => string} seams.readFile repo-relative reader
 * @param {() => string[]} seams.listFiles returns the repo-relative files to scan
 * @returns {{ fileCount: number, useCount: number,
 *             unpinned: Array<{ file: string, line: number, ref: string }> }}
 * @throws {InputError} when the listing names no file, or the files state no
 *   `uses:` reference between them
 */
export function auditActions({ readFile, listFiles }) {
  const files = listFiles();
  if (files.length === 0) {
    throw new InputError(
      `the scan of ${WORKFLOWS_ROOT}/ and ${ACTIONS_ROOT}/*/ yielded no file — this check reads ` +
        `every \`uses:\` reference from the files those two roots hold`,
    );
  }
  const unpinned = [];
  let useCount = 0;
  for (const file of files) {
    const uses = readUses(readFile(file));
    useCount += uses.length;
    for (const use of uses) if (!isPinned(use.ref)) unpinned.push({ file, ...use });
  }
  if (useCount === 0) {
    throw new InputError(
      `${files.length} file(s) under ${WORKFLOWS_ROOT}/ and ${ACTIONS_ROOT}/*/ state no \`uses:\` ` +
        `reference between them — this check holds each such reference to a commit SHA, and a ` +
        `set carrying none is a read that found nothing rather than a tree with nothing to pin`,
    );
  }
  return { fileCount: files.length, useCount, unpinned };
}

/* c8 ignore start -- CLI wrapper: the pure pieces above are unit-tested, and
 * each of the wrapper's three exit codes is pinned at the process boundary by a
 * spawned-CLI case in packages/shared/tests/unit — the committed tree's green,
 * the refusal, and an unpinned reference; this glue reads a tree and prints. */
function run() {
  let audit;
  try {
    audit = auditActions({
      readFile: (rel) => readFileSync(join(ROOT, rel), 'utf8'),
      listFiles: actionFiles,
    });
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    console.error(
      `✗ an input this check reads answered with something other than what it reads there:\n` +
        `    ${error.message}\n\n` +
        `  The offender list and the count of what was scanned come from one read, so a scan\n` +
        `  that found nothing is this verdict rather than a clean bill. Exit 2 keeps that apart\n` +
        `  from an action that is not pinned (exit 1).\n`,
    );
    process.exit(2);
  }
  if (audit.unpinned.length > 0) {
    for (const { file, line, ref } of audit.unpinned) {
      console.error(`✗ ${file}:${line} — not SHA-pinned: ${ref}`);
    }
    const n = audit.unpinned.length;
    console.error(
      `\n${n} unpinned action${n === 1 ? '' : 's'}. Pin each to a full 40-char ` +
        `commit SHA with a trailing \`# version\` comment, e.g.\n` +
        `  actions/checkout@<sha> # v6\n` +
        `Resolve a tag's SHA with: git ls-remote https://github.com/<owner>/<repo> <tag>`,
    );
    process.exit(1);
  }
  console.log(
    `✓ All ${audit.useCount} GitHub Actions \`uses:\` reference(s), read across ` +
      `${audit.fileCount} workflow and composite-action file(s), are pinned to a commit SHA.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
/* c8 ignore stop */
