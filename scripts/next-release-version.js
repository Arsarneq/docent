/**
 * next-release-version.js — Suggest the version to TAG for the next release of
 * each platform (extension-vX.Y.Z / desktop-vX.Y.Z).
 *
 * Docent versions two things independently per platform:
 *   - the APP version — the git tag (extension-v* / desktop-v*), written into
 *     manifest.json / tauri.conf.json inside the publish run only, after the
 *     version PR is opened, and never committed back: the committed files carry
 *     the SCHEMA version the version PR writes (update-version-table.js). This
 *     is the maintainer's semantic choice, and the thing this script suggests.
 *   - the SCHEMA version — schemas/<platform>.delta.json, classified and bumped
 *     mechanically by the release pipeline (see auto-version-schemas.js). This
 *     script only READS it, as one input to the app-version floor.
 *
 * The suggested tag = the last released app version (resolveReleaseBase: the
 * latest final tag, or the app file when no tag is found) bumped by the HIGHER of:
 *   - the schema change level since the last release (plan()), and
 *   - the conventional-commit level of commits touching the platform since its
 *     last release tag (feat -> minor, fix/perf -> patch, ! / BREAKING -> major).
 * It is a FLOOR, not a verdict: a breaking behaviour change the tooling can't
 * see still warrants a manual major. The final tag is always the maintainer's.
 *
 * Follows semantic versioning (https://semver.org/): a bump zeroes the
 * lower-precedence components (major -> X.0.0, minor -> X.Y.0, patch -> X.Y.Z+1),
 * reusing auto-version-schemas.js's bumpVersion. The suggestion is always a final
 * X.Y.Z: pre-release tags (-rc.1) are skipped when finding the last release, and
 * build-metadata (+build) tags are not handled.
 *
 * Read-only: never writes repo files. Safe to run anywhere (locally or in CI).
 * In GitHub Actions it also appends a markdown summary to $GITHUB_STEP_SUMMARY,
 * so the dispatched run shows the suggestion on its summary page.
 *
 * Usage:
 *   node scripts/next-release-version.js      # or: npm run version:next
 */

import { readFileSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { plan, bumpVersion } from './auto-version-schemas.js';
import { isValidTitle } from './check-pr-title.js';

const ROOT = resolve(import.meta.dirname, '..');

// Per-platform release config. Keys match PLATFORMS / the schema plan().
const PLATFORM_RELEASE = {
  extension: {
    tagPrefix: 'extension-v',
    appVersionFile: 'packages/extension/manifest.json',
    // Commits under these paths count toward the app version (shared/ is
    // cross-platform). Schema changes are reported separately via plan().
    commitPaths: ['packages/extension', 'packages/shared'],
  },
  'desktop-windows': {
    tagPrefix: 'desktop-v',
    appVersionFile: 'packages/desktop/src-tauri/tauri.conf.json',
    commitPaths: ['packages/desktop', 'packages/shared'],
  },
};

const RANK = { none: 0, patch: 1, minor: 2, major: 3 };
export const higher = (a, b) => (RANK[a] >= RANK[b] ? a : b);

function readJson(path) {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

// Output cap for one git call. The log of subjects and bodies since the last
// tag outgrows Node's 1 MiB default (`spawnSync git ENOBUFS`); 64 MiB matches
// scripts/check-npm-advisories.js, which raises it for the same reason.
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function git(args, cwd = ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
}

/**
 * Semver precedence of two final `X.Y.Z` versions: negative when `a` is lower,
 * positive when higher, 0 when equal. Components compare numerically.
 */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/**
 * The version the bump is applied to: the last final release. That is the
 * latest final tag's version whenever one exists; with no tag found, the app
 * file's. The committed app file carries the schema version
 * (the version PR writes it, and the tag's version reaches only the release
 * build — update-version-table.js, .github/PUBLISHING.md), so it lags the tag
 * whenever the app version is ahead of the schema version, and the file alone
 * would suggest a tag that already exists. A file ahead of the tag means the
 * schema version is ahead of the last app tag, a newer tag is not fetched
 * locally, or the file was edited by hand. App and schema versions are
 * independent, so the tag stays the base and the file only earns a note.
 * Pure, so it is unit-testable.
 *
 * @param {{ fileVersion: string, fileLabel: string, tag: string|null, tagVersion: string|null }} input
 * @returns {{ version: string, source: 'tag'|'file', note: string|null }} the base, which
 *   input it came from, and a plain-language note when the two disagree
 */
export function resolveReleaseBase({ fileVersion, fileLabel, tag, tagVersion }) {
  if (!tag) return { version: fileVersion, source: 'file', note: null };
  const cmp = compareVersions(tagVersion, fileVersion);
  if (cmp === 0) return { version: tagVersion, source: 'tag', note: null };
  if (cmp > 0) {
    return {
      version: tagVersion,
      source: 'tag',
      note:
        `${fileLabel} reads ${fileVersion}, behind ${tag}: the committed file carries ` +
        "the schema version, and the tag's version is written only into the release build. " +
        'Measured from the tag.',
    };
  }
  return {
    version: tagVersion,
    source: 'tag',
    note:
      `${fileLabel} reads ${fileVersion}, ahead of ${tag}: the committed file carries ` +
      'the schema version; that is the schema version ahead of the last app tag, a newer ' +
      'tag not fetched (run `git fetch --tags`), or a hand edit. Measured from the tag.',
  };
}

/**
 * Latest FINAL release tag matching `<prefix>*`, or null if none is
 * reachable/fetched. Pre-release tags (a `-` after the prefix, e.g.
 * `desktop-v2.1.0-rc.1`) are excluded, so the suggestion is anchored on the last
 * shipped release rather than an interim RC. The publish workflows' tag/prerelease
 * cross-check guarantees a `-suffix` tag is exactly a GitHub pre-release.
 */
function latestTag(prefix) {
  try {
    const tag = git([
      'describe',
      '--tags',
      '--abbrev=0',
      '--match',
      `${prefix}*`,
      '--exclude',
      `${prefix}*-*`,
    ]).trim();
    return tag || null;
  } catch {
    return null;
  }
}

/**
 * Conventional-commit bump level for one commit (subject + body). A subject that
 * is not a recognised Conventional Commit -> 'none', using the SAME predicate as
 * the PR-title gate (isValidTitle), so the bump signal and the "unrecognized"
 * count in parseCommitRecords can never contradict each other.
 */
export function classifyCommit(subject, body) {
  if (!isValidTitle(subject)) return 'none';
  const m = subject.trim().match(/^(\w+)(\([^)]*\))?(!)?: /);
  if (m[3] || /(^|\n)BREAKING[ -]CHANGE/.test(body)) return 'major';
  if (m[1] === 'feat') return 'minor';
  if (m[1] === 'fix' || m[1] === 'perf') return 'patch';
  return 'none';
}

/**
 * Parse a `git log --format=%s%x1f%b%x1e` stream into commit records and roll up
 * the aggregate bump level. Pure (no git), so it is unit-testable in isolation.
 *
 * git emits one record per commit as `subject US body RS`, with a newline before
 * each subsequent record — so records 2..n start with `\n` (stripped here) and
 * the trailing fragment is empty (filtered). `unrecognized` counts subjects that
 * are not valid Conventional Commits, whose bump signal can't be inferred.
 *
 * @returns {{ total: number, level: string, notable: Array<{subject: string, level: string}>, unrecognized: number }}
 */
export function parseCommitRecords(raw) {
  const records = raw
    .split('\x1e')
    .map((r) => r.replace(/^\n+/, ''))
    .filter((r) => r.trim());
  let level = 'none';
  let unrecognized = 0;
  const notable = [];
  for (const rec of records) {
    const [subject = '', body = ''] = rec.split('\x1f');
    const subj = subject.trim();
    const cl = classifyCommit(subj, body);
    level = higher(level, cl);
    if (cl !== 'none') notable.push({ subject: subj, level: cl });
    if (!isValidTitle(subj)) unrecognized++;
  }
  return { total: records.length, level, notable, unrecognized };
}

/**
 * Commits touching `paths` since `tag`, with the aggregate bump level.
 * `cwd` is the repository to read (the Docent checkout by default).
 */
export function commitsSince(tag, paths, cwd = ROOT) {
  // Records separated by RS (0x1e); subject/body by US (0x1f) — newline-safe.
  return parseCommitRecords(
    git(['log', `${tag}..HEAD`, '--format=%s%x1f%b%x1e', '--', ...paths], cwd),
  );
}

/**
 * One platform's suggestion from its inputs: the app file's version, the latest
 * final tag (or null), and the schema and commit bump levels. Pure — run() reads
 * git and the files and prints; this decides — so the whole per-platform
 * decision is unit-testable.
 *
 * @param {{ tagPrefix: string, fileVersion: string, fileLabel: string, tag: string|null, schemaLevel: string, commitLevel: string }} input
 * @returns {{ base: { version: string, source: 'tag'|'file', note: string|null }, level: string, suggestedTag: string|null, driver: string }}
 *   the release base, the bump level, the suggested tag (null when no bump is
 *   indicated) and what drove the level
 */
export function suggestRelease({
  tagPrefix,
  fileVersion,
  fileLabel,
  tag,
  schemaLevel,
  commitLevel,
}) {
  const tagVersion = tag ? tag.slice(tagPrefix.length) : null;
  const base = resolveReleaseBase({ fileVersion, fileLabel, tag, tagVersion });
  const level = higher(schemaLevel, commitLevel);
  return {
    base,
    level,
    suggestedTag: level === 'none' ? null : `${tagPrefix}${bumpVersion(base.version, level)}`,
    driver: describeDriver(schemaLevel, commitLevel, level),
  };
}

function describeDriver(schemaLevel, commitLevel, finalLevel) {
  if (finalLevel === 'none') return 'no version-affecting changes detected';
  const fromSchema = RANK[schemaLevel] === RANK[finalLevel];
  const fromCommits = RANK[commitLevel] === RANK[finalLevel];
  if (fromSchema && fromCommits) return `schema + commits (${finalLevel})`;
  if (fromSchema) return `schema diff (${finalLevel})`;
  return `commits (${finalLevel})`;
}

function run() {
  const schemaPlan = Object.fromEntries(plan().map((e) => [e.platform, e]));
  const rows = [];

  console.log('Next-release version suggestions');
  console.log('================================\n');
  console.log(
    'Docent versions the app (the git tag) and the .docent.json schema separately.\n' +
      'Each suggested tag is a FLOOR from the schema diff + conventional commits since\n' +
      "the last release — the final tag is the maintainer's call (bump higher for\n" +
      "breaking behaviour the tooling can't classify).\n",
  );

  for (const [platform, cfg] of Object.entries(PLATFORM_RELEASE)) {
    const schema = schemaPlan[platform] || { level: 'none', reasons: [], releasedVersion: null };
    const tag = latestTag(cfg.tagPrefix);
    const schemaLevel = schema.level;
    const commits = tag ? commitsSince(tag, cfg.commitPaths) : null;
    const sug = suggestRelease({
      tagPrefix: cfg.tagPrefix,
      fileVersion: readJson(cfg.appVersionFile).version,
      fileLabel: cfg.appVersionFile,
      tag,
      schemaLevel,
      commitLevel: commits ? commits.level : 'none',
    });

    console.log(platform);
    console.log('-'.repeat(platform.length));
    console.log(
      `  last released : ${sug.base.version}  (${sug.base.source === 'tag' ? tag : cfg.appVersionFile})`,
    );
    if (sug.base.note) console.log(`  note          : ${sug.base.note}`);

    // Schema signal (FYI; auto-bumped by the release pipeline).
    const schemaDesc = schema.releasedVersion
      ? `${schemaLevel}  (schema ${schema.releasedVersion} -> ${schema.requiredVersion})`
      : `${schemaLevel}  (first release / no dist yet)`;
    console.log(`  schema change : ${schemaDesc}`);
    const reasons = schema.reasons || [];
    for (const r of reasons.slice(0, 4)) console.log(`      [${r.level}] ${r.message}`);
    if (reasons.length > 4) console.log(`      ... and ${reasons.length - 4} more`);

    // Commit signal.
    if (!commits) {
      console.log(
        '  commits       : tag not found locally — run `git fetch --tags` (schema-only suggestion)',
      );
    } else {
      const { total, level, notable, unrecognized } = commits;
      console.log(
        `  commits       : ${total} since ${tag} touching ${cfg.commitPaths.join(', ')} -> ${level}`,
      );
      for (const c of notable.slice(0, 6)) console.log(`      [${c.level}] ${c.subject}`);
      if (notable.length > 6)
        console.log(`      ... and ${notable.length - 6} more version-affecting`);
      if (unrecognized > 0)
        console.log(
          `      (${unrecognized} non-conventional subject${unrecognized === 1 ? '' : 's'} not classified — commit signal may be incomplete)`,
        );
    }

    if (sug.suggestedTag === null) {
      console.log(
        `\n  -> no bump indicated — ${sug.base.version} unchanged (is a release warranted?)\n`,
      );
    } else {
      console.log(`\n  -> suggested tag: ${sug.suggestedTag}   (${sug.level}: ${sug.driver})\n`);
    }

    rows.push({
      platform,
      last: sug.base.version,
      suggestedTag: sug.suggestedTag ?? '—',
      level: sug.level,
      driver: sug.driver,
    });
  }

  console.log(
    'Schema versions are bumped automatically at release; preview with `npm run version:schemas:check`.',
  );

  writeStepSummary(rows);
}

/** In GitHub Actions, surface the suggestion as a job-summary markdown table. */
function writeStepSummary(rows) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const lines = [
    '## Next-release version suggestions',
    '',
    '| Platform | Last released | Suggested tag | Bump | Driver |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| \`${r.platform}\` | ${r.last} | ${r.suggestedTag === '—' ? '—' : `\`${r.suggestedTag}\``} | ${r.level} | ${r.driver} |`,
    ),
    '',
    '> A **floor** from the schema diff + conventional commits since the last release. ' +
      "The tag is the maintainer's call — bump higher for breaking behaviour the tooling can't classify.",
    '',
  ];
  appendFileSync(file, lines.join('\n') + '\n', 'utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
