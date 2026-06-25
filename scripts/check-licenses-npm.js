#!/usr/bin/env node
/**
 * check-licenses-npm.js — the npm half of Docent's dependency license gate.
 *
 * GPL-3.0-or-later project → DEFAULT-DENY: every third-party npm dependency whose
 * license is not on the global ALLOW list (or covered by a scoped, documented
 * EXCEPTION) FAILS the build, so a future dep with a novel incompatible license is
 * caught automatically. This is the conceptual mirror of the Rust half
 * (packages/desktop/src-tauri/deny.toml) — same allow/deny intent, same model.
 *
 * cargo-deny covers Rust; this covers npm. Run in CI by .github/workflows/test.yml
 * (the `dependency-audit` job, which the publish workflows depend on, so a license
 * violation blocks a release as well as a PR). The license-checker-rseidelsohn
 * version is pinned in package.json (devDependencies) for reproducibility.
 *
 * This is NOT an npm-workspaces repo, so each install root is scanned separately.
 * First-party packages are `"private": true` and excluded (excludePrivatePackages);
 * we rely on each first-party package.json declaring "license": "GPL-3.0-or-later".
 *
 * Usage: node scripts/check-licenses-npm.js
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const checker = require('license-checker-rseidelsohn');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The real npm install roots (this is not an npm-workspaces monorepo). Anything
// with its own package.json + node_modules that pulls third-party deps.
const INSTALL_ROOTS = [
  '.',
  'packages/extension',
  'packages/extension/tests/e2e',
  'packages/desktop/tests/integration',
];

// GLOBAL allowlist — GPL-3.0-compatible per the FSF license-compatibility list.
// Kept in lockstep with deny.toml's [licenses] allow. Do NOT widen this to make a
// specific package pass — add a scoped EXCEPTION instead.
const ALLOW = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'Zlib',
  '0BSD',
  'BSL-1.0',
  'MPL-2.0',
  'Unicode-DFS-2016',
  'Unicode-3.0',
  'CC0-1.0',
  'Unlicense',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'LGPL-2.1-or-later',
  'BlueOak-1.0.0', // OSI-approved permissive (glob / minimatch / lru-cache family)
  'MIT-0', // MIT minus the attribution clause — strictly more permissive
]);

// Scoped, per-package exceptions. A license here is allowed ONLY for the named
// package, never globally. Each carries a one-line justification. The package's
// actual license must match `license` exactly, or the exception does not apply
// (so a future relicense is re-surfaced rather than silently waved through).
const EXCEPTIONS = {
  // Dev-only build DATA, does not ship. SPDX Python-2.0 is generally
  // GPL-compatible (the historic choice-of-law incompatibility was resolved).
  argparse: { license: 'Python-2.0' },
  // Dev-only build DATA (browserslist data), does not ship. CC-BY-4.0 is one-way
  // compatible INTO GPLv3; it is a data/content license, not a code license.
  'caniuse-lite': { license: 'CC-BY-4.0' },
  // The two below are CC-BY-3.0 SPDX license-list DATA, pulled in only by this
  // gate's OWN engine (license-checker-rseidelsohn → spdx-expression-parse). This
  // is NOT a GPL-compatibility ruling — CC-BY-3.0 is NOT GPL-compatible. It is
  // allowed here solely because it is dev-only tooling data that never ships in any
  // Docent artifact, so no distribution obligation attaches. If the checker is ever
  // removed, remove these too.
  'spdx-exceptions': { license: 'CC-BY-3.0' },
  'spdx-ranges': { license: '(MIT AND CC-BY-3.0)' },
};

/**
 * Evaluate an SPDX license expression against the allow set.
 * Handles OR (any disjunct allowed → pass), AND (all conjuncts must pass), nested
 * parens, and `X WITH <exception>` (the exception only adds permissions, so the
 * verdict follows the base license X). license-checker appends `*` when it guessed
 * the license from a LICENSE file rather than the manifest — we strip it.
 */
function isAllowed(expression, allow) {
  if (!expression) return false;
  const tokens = String(expression)
    .replace(/\*/g, '')
    .replace(/\(/g, ' ( ')
    .replace(/\)/g, ' ) ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return false;

  let pos = 0;
  const peek = () => tokens[pos];
  const parseOr = () => {
    let value = parseAnd();
    while (peek() === 'OR') {
      pos++;
      value = parseAnd() || value;
    }
    return value;
  };
  const parseAnd = () => {
    let value = parseAtom();
    while (peek() === 'AND') {
      pos++;
      value = parseAtom() && value;
    }
    return value;
  };
  const parseAtom = () => {
    if (peek() === '(') {
      pos++; // consume '('
      const value = parseOr();
      if (peek() === ')') pos++; // consume ')'
      return value;
    }
    const id = tokens[pos++];
    const value = allow.has(id);
    if (peek() === 'WITH') {
      // DELIBERATE: base-follows handling — `X WITH <exception>` passes iff X is
      // allowed, regardless of the exception. This diverges from cargo-deny's
      // explicit-listing model but is sound because an SPDX license exception only
      // ADDS permissions (it never adds obligations), so it cannot make an allowed
      // base license incompatible.
      pos++; // consume 'WITH'
      pos++; // consume the exception id; verdict follows the base license
    }
    return value;
  };

  const result = parseOr();
  // A trailing unparsed token means an expression we don't understand → deny.
  return pos === tokens.length ? result : false;
}

function packageName(key) {
  // key is "name@version"; handle scoped "@scope/name@version".
  const at = key.lastIndexOf('@');
  return at > 0 ? key.slice(0, at) : key;
}

function scanRoot(relRoot) {
  const start = path.join(repoRoot, relRoot);
  if (!existsSync(path.join(start, 'node_modules'))) {
    // Fail-CLOSED in CI: an INSTALL_ROOTS entry with no node_modules is the only
    // fail-open path in the gate — the root would go unchecked. If CI ever drifts
    // from the install steps, hard-fail rather than silently pass. Locally, keep
    // warn-and-skip for dev convenience.
    if (process.env.CI) {
      console.error(
        `  ✗ ${relRoot}: node_modules absent in CI — this root would go UNCHECKED. ` +
          `Ensure the workflow runs \`npm ci\` for every INSTALL_ROOTS entry.`,
      );
      process.exit(1);
    }
    console.warn(
      `  ⚠ ${relRoot}: node_modules absent — SKIPPED (local run; \`npm ci\` here first).`,
    );
    return { scanned: 0, violations: [], usedExceptions: new Set() };
  }
  return new Promise((resolve, reject) => {
    checker.init({ start, excludePrivatePackages: true, color: false }, (err, packages) => {
      if (err) return reject(err);
      const violations = [];
      const usedExceptions = new Set();
      const keys = Object.keys(packages);
      for (const key of keys) {
        const info = packages[key];
        const name = packageName(key);
        // Multi-license ARRAYS (the deprecated `licenses: []` manifest form) are
        // joined with ' AND ' — fail-CLOSED: a legacy OR-dual-licensed package
        // expressed this way can be spuriously denied. Rare; revisit only if hit.
        const rawLicense = Array.isArray(info.licenses)
          ? info.licenses.join(' AND ')
          : info.licenses;
        // Strip license-checker's guessed-license `*` ONCE here, so the allow
        // check AND the exception compare below see the same normalized string
        // (otherwise a guessed license on an exception package would fail to match).
        const license = rawLicense ? String(rawLicense).replace(/\*/g, '').trim() : rawLicense;

        if (isAllowed(license, ALLOW)) continue;

        const exc = EXCEPTIONS[name];
        if (exc && exc.license === license) {
          usedExceptions.add(name);
          continue;
        }
        violations.push({ root: relRoot, package: key, license: license || 'UNKNOWN' });
      }
      resolve({ scanned: keys.length, violations, usedExceptions });
    });
  });
}

async function main() {
  console.log('npm license gate (default-deny) — scanning install roots:\n');
  let totalScanned = 0;
  const allViolations = [];
  const allUsedExceptions = new Set();

  for (const root of INSTALL_ROOTS) {
    const { scanned, violations, usedExceptions } = await scanRoot(root);
    totalScanned += scanned;
    allViolations.push(...violations);
    usedExceptions.forEach((e) => allUsedExceptions.add(e));
    if (scanned > 0) {
      console.log(`  ✓ ${root}: ${scanned} third-party packages checked`);
    }
  }

  // Surface (don't fail on) exceptions that never matched — they may be stale.
  const unusedExceptions = Object.keys(EXCEPTIONS).filter((n) => !allUsedExceptions.has(n));
  if (unusedExceptions.length > 0) {
    console.warn(
      `\n  ⚠ Declared exceptions not encountered this run (possibly stale): ${unusedExceptions.join(', ')}`,
    );
  }

  console.log(
    `\nScanned ${totalScanned} third-party package entries across ${INSTALL_ROOTS.length} roots.`,
  );

  if (allViolations.length > 0) {
    console.error(`\n✗ License gate FAILED — ${allViolations.length} disallowed package(s):\n`);
    for (const v of allViolations) {
      console.error(`    ${v.package}  →  ${v.license}   [${v.root}]`);
    }
    console.error(
      '\nA package carries a license that is neither on the global allowlist nor a\n' +
        'documented exception. Do NOT widen the allowlist to make one package pass —\n' +
        'add a scoped, justified entry to EXCEPTIONS, find an alternative, or drop it.\n',
    );
    process.exit(1);
  }

  console.log('\n✓ License gate PASSED — every third-party npm dependency is GPL-3.0-compatible.');
}

main().catch((err) => {
  console.error('check-licenses-npm.js errored:', err);
  process.exit(1);
});
