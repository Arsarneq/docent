/**
 * check-doc-reachability.js — every tracked Markdown file must be reachable by
 * following relative `.md` links from the root README.md, or be on the explicit
 * non-doctrine ALLOWLIST below. Exits 0 if so, 1 (listing offenders) if not.
 *
 * Complements `lint:links` (remark-validate-links): that proves existing links
 * RESOLVE; this proves every doc is REACHED. The doctrine the two enforce
 * together is stated in docs/README.md ("Documentation map"). This closes the
 * PR #271 drift class: `corpus/README.md` held real doctrine that no doc linked
 * (it was reachable only from code comments), which the link-checker cannot
 * detect.
 *
 * The walk is AST-based (unified + remark-parse): a `](x.md)` inside a fenced code
 * block is not a link node, so it can never falsely mark `x` reachable and mask a
 * real orphan.
 *
 * Usage:
 *   node scripts/check-doc-reachability.js      # or: npm run lint:reachability
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';

const posix = path.posix;

/** The file every doc must be reachable from. */
export const START = 'README.md';

/**
 * Tracked `.md` files that are legitimately unreachable from README because they
 * are NOT internal doctrine. Closed-world "describe what is" admission list — every
 * entry MUST carry a reason, and a stale entry (untracked, or now reachable) fails.
 */
export const ALLOWLIST = [
  // Consumer-facing shipped asset: the reading guide FOR a consumer of the
  // .docent.json format, shipped in packages/shared/assets/ (not docs/). It is not
  // internal doctrine, so the doc tree does not — and should not — link it.
  'packages/shared/assets/reading-guidance.md',
];

/**
 * Resolve a Markdown link URL to a repo-relative POSIX path, or null when it is not
 * an in-repo `.md` link (external scheme, same-page anchor, or a non-`.md` target).
 * @param {string} fromFile repo-relative posix path of the file containing the link
 * @param {string} url the raw link URL
 * @returns {string | null}
 */
export function resolveTarget(fromFile, url) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null; // external scheme (http:, mailto:, …)
  if (url.startsWith('#')) return null; // same-page anchor
  const clean = url.split('#')[0].split('?')[0];
  if (!clean) return null;
  const resolved = posix.normalize(posix.join(posix.dirname(fromFile), clean));
  return resolved.endsWith('.md') ? resolved : null;
}

/**
 * Extract the in-repo `.md` link targets from one Markdown document (AST-based, so
 * links inside fenced code blocks are ignored). Resolves reference-style links via
 * their definitions.
 * @param {string} markdown the document body
 * @param {string} fromFile repo-relative posix path of the document
 * @returns {string[]} resolved repo-relative `.md` targets
 */
export function extractMdLinks(markdown, fromFile) {
  const tree = unified().use(remarkParse).parse(markdown);
  const defs = new Map(); // reference-style: identifier -> url
  const direct = []; // inline + autolink urls
  const refs = []; // linkReference identifiers, resolved below
  visit(tree, (node) => {
    if (node.type === 'definition' && node.url) defs.set(node.identifier, node.url);
    else if (node.type === 'link' && node.url) direct.push(node.url);
    else if (node.type === 'linkReference') refs.push(node.identifier);
  });
  const urls = [...direct, ...refs.map((id) => defs.get(id)).filter(Boolean)];
  const targets = [];
  for (const url of urls) {
    const t = resolveTarget(fromFile, url);
    if (t) targets.push(t);
  }
  return targets;
}

/**
 * Pure core: BFS the `.md` link graph from `start` and report what the walk leaves out.
 * @param {object} opts
 * @param {string[]} opts.files repo-relative posix paths of all tracked `.md`
 * @param {(f: string) => (string | null)} opts.readFile reader (null if unreadable)
 * @param {string} [opts.start]
 * @param {string[]} [opts.allowlist]
 * @returns {{ orphans: string[], staleAllowlist: string[], reachable: Set<string> }}
 */
export function findOrphans({ files, readFile, start = START, allowlist = ALLOWLIST }) {
  const universe = new Set(files);
  const reachable = new Set();
  const queue = [];
  if (universe.has(start)) {
    reachable.add(start);
    queue.push(start);
  }
  while (queue.length) {
    const file = queue.shift();
    const content = readFile(file);
    if (content == null) continue;
    for (const target of extractMdLinks(content, file)) {
      if (universe.has(target) && !reachable.has(target)) {
        reachable.add(target);
        queue.push(target);
      }
    }
  }
  const allow = new Set(allowlist);
  const orphans = files.filter((f) => !reachable.has(f) && !allow.has(f)).sort();
  // Hygiene: an allowlist entry that is untracked, or is actually reachable, is stale.
  const staleAllowlist = allowlist.filter((a) => !universe.has(a) || reachable.has(a)).sort();
  return { orphans, staleAllowlist, reachable };
}

function run() {
  const files = execFileSync('git', ['ls-files', '*.md'], { encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const readFile = (f) => {
    try {
      return readFileSync(f, 'utf8');
    } catch {
      return null;
    }
  };

  const { orphans, staleAllowlist } = findOrphans({ files, readFile });
  let failed = false;

  if (orphans.length) {
    failed = true;
    console.error(
      `✗ ${orphans.length} Markdown file(s) unreachable from ${START} — internal doctrine must live in the linked doc tree:\n` +
        orphans.map((o) => `    ${o}`).join('\n') +
        `\n\n  Fix: link each into the doc tree (start at ${START}, branch out until no leaves),\n` +
        `  or — only if it is genuinely non-doctrine (e.g. a shipped consumer asset) — add it to\n` +
        `  ALLOWLIST in scripts/check-doc-reachability.js with a one-line reason.`,
    );
  }
  if (staleAllowlist.length) {
    failed = true;
    console.error(
      `${orphans.length ? '\n' : ''}✗ ${staleAllowlist.length} stale ALLOWLIST entr${
        staleAllowlist.length === 1 ? 'y' : 'ies'
      } in scripts/check-doc-reachability.js (untracked, or now reachable) — remove:\n` +
        staleAllowlist.map((s) => `    ${s}`).join('\n'),
    );
  }
  if (failed) process.exit(1);

  console.log(
    `✓ documentation reachable: all ${files.length - ALLOWLIST.length} tracked .md outside the allowlist reach from ${START}` +
      ` (+${ALLOWLIST.length} allowlisted non-doctrine).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
