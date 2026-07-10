/**
 * docs-disposition-audit.js — weekly, non-gating audit of the "unaffected"
 * judgments recorded in merged PRs' `## Docs disposition` sections.
 *
 * A disposition line is a judgment, and judgments cannot be verified one at a
 * time — but they can be measured in aggregate. This harvests the merged PRs
 * of a lookback window and labels an `unaffected: <doc>` line a PROBABLE MISS
 * when a later merged PR edits that very doc while touching code that overlaps
 * the earlier PR's areas — i.e. the doc did need attention for that kind of
 * change, shortly after someone judged it didn't. The output is a rate with
 * counts, never a per-PR verdict: a probable miss is a sampling signal for
 * review calibration, not an accusation, and individual labels are printed
 * only in local `--detail` runs (never in CI, whose logs are public).
 *
 * Guards on the labeler:
 *   - PRs whose diff is mostly under docs/ do not act as miss evidence
 *     (documentation reorganisation would otherwise poison the measurement);
 *   - overlap is computed from the areas of each PR's changed non-doc files
 *     via scripts/area-map.json, so unrelated work editing the same doc does
 *     not count.
 *
 * Known approximation, stated rather than hidden: post-merge body edits are
 * flagged from the PR's update timestamp — any post-merge activity (a label, a
 * comment, branch deletion) trips it, so expect this count to run high to the
 * point of saturation; treat it as an upper bound only. A content-hash ledger
 * of bodies at merge time is the recorded follow-up that would make it exact.
 *
 * Retirement criterion, registered up front: if after eight weeks of runs
 * more than 70% of probable-miss labels prove to be false positives under
 * manual triage, this audit is retired rather than tuned into noise.
 *
 * Usage:
 *   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/docs-disposition-audit.js [--weeks N] [--detail]
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { compileMap, resolveFile, MAP_PATH } from './check-area-map.js';
import { extractSection, parseDispositionSection } from './check-docs-disposition.js';

/** A PR's diff is "mostly docs" when more than half its files sit under docs/. */
export function isDocsPrimary(files) {
  if (files.length === 0) return false;
  const docs = files.filter((f) => f.startsWith('docs/')).length;
  return docs * 2 > files.length;
}

/** The areas of a PR's changed non-doc files (glob resolution only). */
export function areasOfChange(files, compiled) {
  const areas = new Set();
  for (const f of files) {
    if (f.startsWith('docs/')) continue;
    for (const a of resolveFile(f, compiled).areas) areas.add(a);
  }
  return areas;
}

/**
 * Pure core: label probable misses across a window of merged PRs. Only
 * DOC-LEVEL "unaffected" judgments enroll: a clause-level line rides with a
 * doc the PR may well have updated, and a doc the PR itself edited was
 * demonstrably attended to — neither is auditable by "a later PR edited the
 * doc". A PR whose changed files resolve to no areas (docs-only PRs included)
 * can never be labeled — the overlap rule has nothing to match on; that blind
 * spot is accepted and declared here.
 * @param {object} opts
 * @param {{ number: number, mergedAt: string, body: string, files: string[] }[]} opts.prs
 *   merged PRs, any order
 * @param {any} opts.map parsed area-map.json
 * @returns {{
 *   scanned: number, withDispositions: number,
 *   unaffectedDocJudgments: number, probableMisses: { pr: number, doc: string, byPr: number }[]
 * }}
 */
export function labelProbableMisses({ prs, map }) {
  const compiled = compileMap(map);
  const ordered = [...prs].sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
  const enriched = ordered.map((pr) => {
    const section = extractSection(pr.body ?? '', 'Docs disposition');
    const lines = section ? parseDispositionSection(section).lines : [];
    return {
      ...pr,
      hasDispositions: section !== null,
      unaffected: [
        ...new Set(
          lines
            .filter((l) => l.verb === 'unaffected' && l.clause === null)
            .map((l) => l.doc)
            .filter((doc) => !pr.files.includes(doc)),
        ),
      ],
      areas: areasOfChange(pr.files, compiled),
      docsPrimary: isDocsPrimary(pr.files),
    };
  });

  const probableMisses = [];
  let unaffectedDocJudgments = 0;
  for (let i = 0; i < enriched.length; i++) {
    const p = enriched[i];
    unaffectedDocJudgments += p.unaffected.length;
    for (const doc of p.unaffected) {
      for (let j = i + 1; j < enriched.length; j++) {
        const q = enriched[j];
        if (q.docsPrimary) continue; // doc-churn PRs are not miss evidence
        if (!q.files.includes(doc)) continue;
        if (![...q.areas].some((a) => p.areas.has(a))) continue;
        probableMisses.push({ pr: p.number, doc, byPr: q.number });
        break; // one label per (pr, doc)
      }
    }
  }

  return {
    scanned: enriched.length,
    withDispositions: enriched.filter((e) => e.hasDispositions).length,
    unaffectedDocJudgments,
    probableMisses,
  };
}

/**
 * Wilson 95% score interval for a proportion — honest bounds for the small
 * samples a weekly window yields.
 * @param {number} hits
 * @param {number} total
 * @returns {{ low: number, high: number }} bounds in [0, 1]
 */
export function wilsonInterval(hits, total) {
  if (total === 0) return { low: 0, high: 0 };
  const z = 1.96;
  const p = hits / total;
  const denom = 1 + z ** 2 / total;
  const center = p + z ** 2 / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p) + z ** 2 / (4 * total)) / total);
  return {
    low: Math.max(0, (center - spread) / denom),
    high: Math.min(1, (center + spread) / denom),
  };
}

/* c8 ignore start — the harvest below talks to the live API and is exercised
 * by the scheduled run itself; the labeling it feeds (labelProbableMisses,
 * isDocsPrimary, areasOfChange) is unit-tested above. */
async function api(path, token) {
  const res = await globalThis.fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'docs-disposition-audit',
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${path} -> ${res.status}`);
  return res.json();
}

async function harvest({ repo, token, weeks }) {
  const since = new Date(Date.now() - weeks * 7 * 24 * 3600 * 1000).toISOString();
  const prs = [];
  let editedAfterMerge = 0;
  let page = 1;
  for (; page <= 10; page++) {
    const batch = await api(
      `/repos/${repo}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100&page=${page}`,
      token,
    );
    if (batch.length === 0) break;
    for (const pr of batch) {
      if (!pr.merged_at || pr.merged_at < since) continue;
      const files = [];
      for (let fp = 1; fp <= 10; fp++) {
        const fbatch = await api(
          `/repos/${repo}/pulls/${pr.number}/files?per_page=100&page=${fp}`,
          token,
        );
        files.push(...fbatch.map((f) => f.filename));
        if (fbatch.length < 100) break;
      }
      if (pr.updated_at > pr.merged_at) editedAfterMerge++;
      prs.push({ number: pr.number, mergedAt: pr.merged_at, body: pr.body ?? '', files });
    }
    // The listing is ordered by updated_at (desc) and updated_at >= merged_at,
    // so once a whole batch was last updated before the window opened, no
    // later page can hold an in-window merge. Terminating on merged_at would
    // be wrong: any post-merge activity re-sorts an old PR to the top.
    if (batch.every((pr) => pr.updated_at < since)) break;
  }
  if (page > 10) {
    console.error('note: pagination cap (1000 PRs) reached — the window may be undercounted.');
  }
  return { prs, editedAfterMerge };
}

async function run() {
  const weeksArg = process.argv.indexOf('--weeks');
  const weeks = weeksArg !== -1 ? Number(process.argv[weeksArg + 1]) : 8;
  const detail = process.argv.includes('--detail');
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) {
    console.error('✗ GITHUB_REPOSITORY and GITHUB_TOKEN are required.');
    process.exit(1);
  }
  if (!Number.isFinite(weeks) || weeks <= 0) {
    console.error('✗ --weeks takes a positive number, e.g. --weeks 8');
    process.exit(1);
  }

  const map = JSON.parse(readFileSync(MAP_PATH, 'utf8'));
  const { prs, editedAfterMerge } = await harvest({ repo, token, weeks });
  const r = labelProbableMisses({ prs, map });

  const total = r.unaffectedDocJudgments;
  const rate = total === 0 ? 0 : (100 * r.probableMisses.length) / total;
  const ci = wilsonInterval(r.probableMisses.length, total);
  console.log(`## Docs-disposition audit (last ${weeks} weeks)`);
  console.log(`- merged PRs scanned: ${r.scanned}`);
  console.log(`- with a disposition section: ${r.withDispositions}`);
  console.log(`- "unaffected" doc judgments: ${total}`);
  console.log(
    `- probable misses: ${r.probableMisses.length} (${rate.toFixed(1)}% of judgments; 95% interval ${(100 * ci.low).toFixed(1)}–${(100 * ci.high).toFixed(1)}%)`,
  );
  console.log(`- bodies updated after merge (approximate signal): ${editedAfterMerge}`);
  console.log(
    `\nA probable miss means a later change edited a doc that an earlier, area-overlapping PR judged unaffected — a calibration signal for review, not a per-PR verdict. Individual labels are available only in local --detail runs.`,
  );
  if (detail && r.probableMisses.length) {
    console.log('\nDetail (local run only):');
    for (const m of r.probableMisses)
      console.log(`  #${m.pr} judged ${m.doc} unaffected; edited by #${m.byPr}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error('docs-disposition-audit.js errored:', err);
    process.exit(1);
  });
}
/* c8 ignore stop */
