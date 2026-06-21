/**
 * check-pr-title.js — Validate a pull-request title against Conventional Commits.
 *
 * Docent squash-merges, so the PR title becomes the commit subject on `main`.
 * That subject is what scripts/next-release-version.js parses to suggest the next
 * release tag (feat -> minor, fix/perf -> patch, ! / BREAKING -> major), and it is
 * the project's commit history. This check keeps that input well-formed.
 *
 * A valid title is `type(optional-scope)!?: summary`, where `type` is one of the
 * recognised Conventional Commit types. Exits 0 if valid, 1 with guidance if not.
 *
 * The title is read from argv[2] (local use) or $PR_TITLE (CI — passed via env,
 * never interpolated into the shell, so a crafted title cannot inject commands).
 *
 * Usage:
 *   node scripts/check-pr-title.js "feat(extension): add export button"
 *   PR_TITLE="fix: ..." node scripts/check-pr-title.js     # or: npm run check:pr-title -- "..."
 */

import { pathToFileURL } from 'node:url';

// Recognised Conventional Commit types (https://www.conventionalcommits.org/).
export const ALLOWED_TYPES = [
  'feat',
  'fix',
  'perf',
  'refactor',
  'docs',
  'test',
  'build',
  'ci',
  'chore',
  'style',
  'revert',
];

// `type(optional-scope)!?: summary`. The required `: ` immediately after the
// type/scope/! prevents matching a longer word (e.g. "feature:" or "fixup:").
const TITLE_RE = new RegExp(`^(${ALLOWED_TYPES.join('|')})(\\([^)]+\\))?(!)?: .+`);

/** @returns {boolean} true if `title` is a well-formed Conventional Commit subject. */
export function isValidTitle(title) {
  return typeof title === 'string' && TITLE_RE.test(title.trim());
}

function run() {
  const title = process.argv[2] || process.env.PR_TITLE || '';
  if (isValidTitle(title)) {
    console.log(`✓ PR title is a valid Conventional Commit: "${title.trim()}"`);
    return;
  }
  console.error(
    `✗ PR title is not a Conventional Commit.\n\n` +
      `  Got:      "${title}"\n` +
      `  Expected: <type>(<optional scope>)<optional !>: <summary>\n` +
      `  Types:    ${ALLOWED_TYPES.join(', ')}\n\n` +
      `  Examples: feat(extension): add export button\n` +
      `            fix(desktop): stop dropping early events\n` +
      `            chore!: drop Node 18 support\n\n` +
      `  Docent squash-merges, so the PR title becomes the commit on main and\n` +
      `  drives release versioning (see .github/CONTRIBUTING.md).`,
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
