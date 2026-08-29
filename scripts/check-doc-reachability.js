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
 * The listing every leg reads is refused when it names no document at all: the
 * walk, the reachability answer, and the allowlist's staleness leg are all taken
 * over that listing, so an empty one would leave every document reachable by
 * having nothing to reach. That refusal is machinery breakage on this check's
 * own input, so it ends the run on this check's own exit code (exit 2), which
 * is what keeps it apart from a document that really is unreachable (exit 1).
 *
 * Usage:
 *   node scripts/check-doc-reachability.js      # or: npm run lint:reachability
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { trackedFilesUnder } from './check-test-inventory.js';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';

const posix = path.posix;

/**
 * This check's own path, DERIVED from the file it is written in rather than
 * written out: the path a verdict names is then the file that printed it, and a
 * rename carries the value with the file instead of leaving a literal behind.
 * The `node scripts/<name>.js` usage line in the header above is a comment and
 * stays hand-written — that is the stated boundary of this derivation.
 */
const SELF_PATH = `scripts/${path.basename(import.meta.filename)}`;

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

/**
 * The refusal a listing this check cannot walk raises. Everything below reads
 * the tracked Markdown listing: the walk starts at a member of it, reachability
 * is decided against it, and the allowlist is held stale against it. A listing
 * that names no document therefore answers "reachable" for every document there
 * is — the vacuous pass this refusal stands in place of.
 * @param {string[]} files the tracked `.md` listing, as the read answered
 * @returns {string | null} the refusal, or null when the listing names documents
 */
export function refuseEmptyListing(files) {
  if (files.length > 0) return null;
  return (
    `✗ the tracked listing of \`*.md\` named no document — this check walks the links from ${START}\n` +
    `  over exactly that listing, so a listing naming none leaves every document reachable by\n` +
    `  having nothing to reach, and the ALLOWLIST's own staleness leg is all that would red.\n` +
    `  The listing is a tracked-file read taken from the repository root: run this check there,\n` +
    `  in a checkout whose Markdown is tracked.\n` +
    `  This is breakage on the check's own input, so it ends on the check's own exit code\n` +
    `  (exit 2), apart from a document that is genuinely unreachable (exit 1).`
  );
}

function run() {
  // Through the shared population reader, so this listing states the same
  // quotepath policy every other tree scan does: a path carrying a non-ASCII
  // byte arrives as itself rather than quoted, and a link naming such a file
  // can match the listing instead of reading as an orphan.
  const files = trackedFilesUnder('*.md');
  const emptyListing = refuseEmptyListing(files);
  if (emptyListing !== null) {
    console.error(emptyListing);
    process.exit(2);
  }
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
        `  ALLOWLIST in ${SELF_PATH} with a one-line reason.`,
    );
  }
  if (staleAllowlist.length) {
    failed = true;
    console.error(
      `${orphans.length ? '\n' : ''}✗ ${staleAllowlist.length} stale ALLOWLIST entr${
        staleAllowlist.length === 1 ? 'y' : 'ies'
      } in ${SELF_PATH} (untracked, or now reachable) — remove:\n` +
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
