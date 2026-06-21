/**
 * check-action-pins.js — Fail if any GitHub Actions `uses:` is not pinned to a
 * full 40-character commit SHA.
 *
 * Pinning to a mutable tag (`actions/checkout@v6`) lets the tag's owner — or an
 * attacker who compromises their account — repoint it at malicious code that then
 * runs in CI (S17). This guard keeps every action SHA-pinned so a future commit,
 * contributor, or agent can't silently reintroduce a tag pin. Local actions and
 * reusable workflows (`./…`) are exempt — they live in this repo. Dependabot
 * (the `github-actions` ecosystem) bumps the SHA + the trailing `# version`
 * comment on its weekly run.
 *
 * Usage: node scripts/check-action-pins.js   # or: npm run check:action-pins
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const SHA_RE = /^[0-9a-f]{40}$/;

// Actions exempt from SHA-pinning. `ossf/scorecard-action` must be TAG-pinned: the
// OpenSSF `publish_results` verification rejects a commit SHA ("imposter commit"),
// and it is a low-risk read-only monitoring action — its job token is `read-all` +
// `security-events: write` + `id-token` only, with no release/secret/code-write
// access — so a repointed tag's blast radius is small. Dependabot still bumps it.
export const TAG_PINNED_ALLOWED = new Set(['ossf/scorecard-action']);

/**
 * Find `uses:` references in a workflow/action file that are NOT SHA-pinned.
 * Local refs (`./…`, `../…`) and the TAG_PINNED_ALLOWED actions are exempt.
 *
 * @returns {Array<{line: number, ref: string}>}
 */
export function findUnpinned(text) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const m = line.match(/^\s*-?\s*uses:\s*(['"]?)([^'"#\s]+)\1/);
    if (!m) return;
    const ref = m[2];
    if (ref.startsWith('./') || ref.startsWith('../')) return; // local action / reusable workflow
    const at = ref.lastIndexOf('@');
    if (TAG_PINNED_ALLOWED.has(at === -1 ? ref : ref.slice(0, at))) return; // documented exception
    const rev = at === -1 ? '' : ref.slice(at + 1);
    if (!SHA_RE.test(rev)) out.push({ line: i + 1, ref });
  });
  return out;
}

/** Workflow YAML + composite-action definitions to scan. */
function actionFiles() {
  const files = [];
  const wf = join(ROOT, '.github/workflows');
  if (existsSync(wf)) {
    for (const f of readdirSync(wf)) if (/\.ya?ml$/.test(f)) files.push(join(wf, f));
  }
  const actions = join(ROOT, '.github/actions');
  if (existsSync(actions)) {
    for (const sub of readdirSync(actions, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      for (const name of ['action.yml', 'action.yaml']) {
        const p = join(actions, sub.name, name);
        if (existsSync(p)) files.push(p);
      }
    }
  }
  return files;
}

function run() {
  let failures = 0;
  for (const file of actionFiles()) {
    const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/');
    for (const { line, ref } of findUnpinned(readFileSync(file, 'utf8'))) {
      console.error(`✗ ${rel}:${line} — not SHA-pinned: ${ref}`);
      failures++;
    }
  }
  if (failures) {
    console.error(
      `\n${failures} unpinned action${failures === 1 ? '' : 's'}. Pin each to a full 40-char ` +
        `commit SHA with a trailing \`# version\` comment, e.g.\n` +
        `  actions/checkout@<sha> # v6\n` +
        `Resolve a tag's SHA with: git ls-remote https://github.com/<owner>/<repo> <tag>`,
    );
    process.exit(1);
  }
  console.log('✓ All GitHub Actions are pinned to a commit SHA.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
