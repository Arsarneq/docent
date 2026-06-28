/**
 * next-release-version.js — Suggest the version to TAG for the next release of
 * each platform (extension-vX.Y.Z / desktop-vX.Y.Z).
 *
 * Docent versions two things independently per platform:
 *   - the APP version — the git tag (extension-v* / desktop-v*), written into
 *     manifest.json / tauri.conf.json by the publish workflow. This is the
 *     maintainer's semantic choice, and the thing this script suggests.
 *   - the SCHEMA version — schemas/<platform>.delta.json, classified and bumped
 *     mechanically by the release pipeline (see auto-version-schemas.js). This
 *     script only READS it, as one input to the app-version floor.
 *
 * The suggested tag = the last released app version bumped by the HIGHER of:
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

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
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

/** Commits touching `paths` since `tag`, with the aggregate bump level. */
function commitsSince(tag, paths) {
  // Records separated by RS (0x1e); subject/body by US (0x1f) — newline-safe.
  return parseCommitRecords(git(['log', `${tag}..HEAD`, '--format=%s%x1f%b%x1e', '--', ...paths]));
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
    const lastAppVersion = readJson(cfg.appVersionFile).version;
    const tag = latestTag(cfg.tagPrefix);

    console.log(platform);
    console.log('-'.repeat(platform.length));
    console.log(`  last released : ${lastAppVersion}  (${cfg.appVersionFile})`);
    if (tag) {
      const tagVersion = tag.slice(cfg.tagPrefix.length);
      if (tagVersion !== lastAppVersion) {
        console.log(`  ⚠ latest tag ${tag} (${tagVersion}) != app file — unreleased local bump?`);
      }
    }

    // Schema signal (FYI; auto-bumped by the release pipeline).
    const schemaLevel = schema.level;
    const schemaDesc = schema.releasedVersion
      ? `${schemaLevel}  (schema ${schema.releasedVersion} -> ${schema.requiredVersion})`
      : `${schemaLevel}  (first release / no dist yet)`;
    console.log(`  schema change : ${schemaDesc}`);
    const reasons = schema.reasons || [];
    for (const r of reasons.slice(0, 4)) console.log(`      [${r.level}] ${r.message}`);
    if (reasons.length > 4) console.log(`      ... and ${reasons.length - 4} more`);

    // Commit signal.
    let commitLevel = 'none';
    if (!tag) {
      console.log(
        '  commits       : tag not found locally — run `git fetch --tags` (schema-only suggestion)',
      );
    } else {
      const { total, level, notable, unrecognized } = commitsSince(tag, cfg.commitPaths);
      commitLevel = level;
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

    const finalLevel = higher(schemaLevel, commitLevel);
    const suggested = bumpVersion(lastAppVersion, finalLevel);
    const driver = describeDriver(schemaLevel, commitLevel, finalLevel);

    if (finalLevel === 'none') {
      console.log(
        `\n  -> no bump indicated — ${lastAppVersion} unchanged (is a release warranted?)\n`,
      );
    } else {
      console.log(
        `\n  -> suggested tag: ${cfg.tagPrefix}${suggested}   (${finalLevel}: ${driver})\n`,
      );
    }

    rows.push({
      platform,
      last: lastAppVersion,
      suggestedTag: finalLevel === 'none' ? '—' : `${cfg.tagPrefix}${suggested}`,
      level: finalLevel,
      driver,
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
