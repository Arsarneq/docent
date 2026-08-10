/**
 * check-area-map.js — admission test for `scripts/area-map.json` (the committed
 * map from repository areas to the code they own and the docs that govern them).
 * The map is data, so it can rot; this check makes every way it can rot loud:
 *
 *   (a) coverage  — every git-tracked file must resolve to at least one area
 *       (via a code pattern, doc-set membership, or a `// see docs/<path>.md`
 *       pointer in the file), or be a repo-wide doc, or match an `unassigned`
 *       entry. A file nobody owns is a red, not a shrug.
 *   (b) staleness — every code pattern (each brace alternative counted on its
 *       own) must match at least one tracked file, and every literal entry
 *       (docs, source-of-truth, repo-wide, unassigned) must point at something
 *       tracked. A dead entry is a red.
 *   (c) doc coverage — every tracked `.md` anywhere in the repo must be a
 *       repo-wide doc, belong to at least one area's doc set, or match an
 *       `unassigned` entry. Being owned only by a code pattern is not a
 *       doc-home decision: a doctrine doc the map places nowhere is a red.
 *       (Only tracked files are seen — the list is `git ls-files` — so
 *       gitignored docs are never scanned and never required here.)
 *   (d) self-failing unassigned list — an `unassigned` entry whose files all
 *       resolve through areas anyway (and, for a `.md`, are doc-placed anyway)
 *       is unnecessary and must be removed.
 *   (e) declared governance — a `declared-governance` entry names files that keep
 *       their code-area coverage but declare their own COMPLETE governing doc set
 *       explicitly (a `governed-by` array; `[]` states the set is empty), in place
 *       of the docs their covering area supplies. Each element is a literal doc
 *       path or an `area:<name>` reference, which stands for that area's whole doc
 *       set and expands to it. Outside a partitioned tree, a declaration whose set
 *       already equals what the area supplies states nothing new (redundant); a file
 *       declared twice, or one that also sources governance from a repo-wide doc
 *       or a `// see docs/…` pointer into a live doc set, is a red (conflict /
 *       cross-governed — declare in one place); a governed-by target that is
 *       untracked or homeless (in no doc set and not repo-wide) is a red.
 *   (f) governance partitions — `governance-partitions` lists the trees whose
 *       files each declare their own governance, one `{ pattern, reason }` entry
 *       per tree. Every tracked file matching a partition pattern carries a
 *       `declared-governance` entry, so a new file there states its subject rather
 *       than inheriting the union its tree ride supplies; a partition pattern
 *       matching no tracked file is stale (a red, as for `unassigned`), and a
 *       tracked file two partition entries both claim is a red naming them, since
 *       one entry per tree is what makes a partition's reason the file's own.
 *       Inside a partitioned tree an equal-set declaration is the honest statement
 *       — the alternative is a red, not an equivalent green — so partition-covered
 *       files are left out of the redundancy equality accounting while still
 *       counting toward their entry's total. Each side therefore reads the same
 *       declaration differently, and an entry belongs to one side of a boundary:
 *       an entry matching both partition-covered files and files outside every
 *       partition is refused, and splits at the boundary. That refusal displaces
 *       the redundancy red specifically — such an entry is left out of the
 *       redundancy accounting, whose own remedy (remove the entry) would
 *       contradict the split this one asks for; every other red still applies
 *       to it.
 *
 * What this check deliberately cannot see: a file or doc filed under the WRONG
 * area still passes — the map's content is reviewed, not derived. Pointer
 * comments are consulted only for files that would otherwise resolve to no
 * area; repo-wide pointer hygiene is not this check's job.
 *
 * `resolveFile` is the one implementation of "which areas own this file, and
 * which docs govern it" — this check and any other consumer of the map resolve
 * through it, so they cannot drift apart.
 *
 * An area owns code, a doc set, or both. A docs-only area (no `code`) is valid
 * as long as it carries a non-empty `docs` set — the home for governing prose
 * that no source file backs.
 *
 * Pattern language (closed world — anything else is a shape error): `*` within
 * a path segment, `**` as a whole segment (any depth, dotfiles included),
 * `{a,b}` alternation. Doc entries are literal paths, never patterns.
 *
 * Usage:
 *   node scripts/check-area-map.js      # or: npm run lint:area-map
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Repo-relative path of the map this check guards. */
export const MAP_PATH = 'scripts/area-map.json';

/** Characters a pattern may contain (checked before compiling). */
const PATTERN_ALLOWED = /^[A-Za-z0-9_\-./*{},]+$/;

/** A `// see docs/<path>.md` pointer inside a code file. */
const POINTER_RE = /\/\/\s*see\s+(docs\/[A-Za-z0-9_\-./]+\.md)\b/g;

/** Prefix marking a `governed-by` element as a reference to an area's doc set. */
export const AREA_REF_PREFIX = 'area:';

/**
 * Read the area name a `governed-by` element references.
 * @param {unknown} element one `governed-by` element
 * @returns {string | null} the referenced area name, or null for a literal path
 */
export function areaRefName(element) {
  return typeof element === 'string' && element.startsWith(AREA_REF_PREFIX)
    ? element.slice(AREA_REF_PREFIX.length)
    : null;
}

/**
 * Expand `{a,b}` alternation groups into plain patterns (recursive, so every
 * returned pattern is brace-free).
 * @param {string} pattern
 * @returns {string[]}
 */
export function expandBraces(pattern) {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];
  let depth = 0;
  for (let i = open; i < pattern.length; i++) {
    if (pattern[i] === '{') depth++;
    else if (pattern[i] === '}') {
      depth--;
      if (depth === 0) {
        const head = pattern.slice(0, open);
        const body = pattern.slice(open + 1, i);
        const tail = pattern.slice(i + 1);
        // Split the body on top-level commas only.
        const parts = [];
        let part = '';
        let d = 0;
        for (const ch of body) {
          if (ch === '{') d++;
          else if (ch === '}') d--;
          if (ch === ',' && d === 0) {
            parts.push(part);
            part = '';
          } else part += ch;
        }
        parts.push(part);
        return parts.flatMap((p) => expandBraces(head + p + tail));
      }
    }
  }
  throw new Error(`unbalanced braces in pattern: ${pattern}`);
}

const escapeRegExp = (s) => s.replace(/[.+^$()|\\]/g, '\\$&');

/**
 * Compile one brace-free pattern to an anchored RegExp. `**` (whole segment
 * only) crosses segment boundaries; `*` stays within one segment. Dotfiles
 * match — ownership here is by location, not by filename shape.
 * @param {string} pattern brace-free pattern
 * @returns {RegExp}
 */
export function globToRegExp(pattern) {
  if (!PATTERN_ALLOWED.test(pattern) || pattern.includes('{') || pattern.includes('}')) {
    throw new Error(`unsupported pattern syntax: ${pattern}`);
  }
  const segments = pattern.split('/');
  let re = '^';
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const last = i === segments.length - 1;
    if (seg === '**') {
      re += last ? '(?:.*)?' : '(?:[^/]+/)*';
    } else {
      if (seg.includes('**')) {
        throw new Error(`unsupported pattern syntax: "**" must be a whole segment in ${pattern}`);
      }
      re += seg.split('*').map(escapeRegExp).join('[^/]*');
      if (!last) re += '/';
    }
  }
  return new RegExp(re + '$');
}

/**
 * Extract `// see docs/<path>.md` pointer targets from a code file's content.
 * @param {string} content
 * @returns {string[]} repo-relative doc paths (deduplicated)
 */
export function extractDocPointers(content) {
  const targets = new Set();
  for (const m of content.matchAll(POINTER_RE)) targets.add(m[1]);
  return [...targets];
}

const isLiteralPath = (p) => typeof p === 'string' && p.length > 0 && !/[*{},]/.test(p);

/**
 * Validate the map's shape (keys, types, literal-path rules, non-empty
 * reasons). Content problems (staleness, coverage) are checked separately.
 * @param {any} map parsed area-map.json
 * @returns {string[]} shape errors (empty when well-formed)
 */
export function validateShape(map) {
  const errors = [];
  if (typeof map !== 'object' || map === null) return ['map is not an object'];
  if (typeof map.description !== 'string' || !map.description) {
    errors.push('missing top-level "description" string');
  }
  const rw = map['repo-wide'];
  if (!rw || typeof rw !== 'object' || !Array.isArray(rw.docs)) {
    errors.push('"repo-wide" must be an object with a "docs" array');
  } else {
    for (const d of rw.docs) {
      if (!isLiteralPath(d))
        errors.push(`repo-wide doc is not a literal path: ${JSON.stringify(d)}`);
    }
    if (new Set(rw.docs).size !== rw.docs.length) errors.push('repo-wide docs contain duplicates');
  }
  if (!map.areas || typeof map.areas !== 'object' || Object.keys(map.areas).length === 0) {
    errors.push('"areas" must be a non-empty object');
    return errors;
  }
  for (const [name, area] of Object.entries(map.areas)) {
    const hasCode = Array.isArray(area.code) && area.code.length > 0;
    const hasDocs = Array.isArray(area.docs) && area.docs.length > 0;
    // An area owns code, a doc set, or both. A docs-only area (no code) is
    // valid only if it carries a non-empty doc set; an area that owns nothing
    // describes nothing.
    if (!hasCode && !hasDocs) {
      errors.push(`area "${name}": must own a non-empty "code" or "docs" array`);
    }
    if (area.code !== undefined) {
      if (!Array.isArray(area.code)) {
        errors.push(`area "${name}": "code" must be an array of patterns`);
      } else {
        for (const g of area.code) {
          if (typeof g !== 'string' || !g) {
            errors.push(`area "${name}": empty or non-string code pattern`);
            continue;
          }
          try {
            expandBraces(g).forEach(globToRegExp);
          } catch (e) {
            errors.push(`area "${name}": ${e.message}`);
          }
        }
      }
    }
    if (area.docs !== undefined && !Array.isArray(area.docs)) {
      errors.push(`area "${name}": "docs" must be an array`);
    } else if (Array.isArray(area.docs)) {
      for (const d of area.docs) {
        if (!isLiteralPath(d)) {
          errors.push(`area "${name}": doc entry is not a literal path: ${JSON.stringify(d)}`);
        }
      }
      if (new Set(area.docs).size !== area.docs.length) {
        errors.push(`area "${name}": doc entries contain duplicates`);
      }
    }
    if ('source-of-truth' in area) {
      if (!Array.isArray(area['source-of-truth'])) {
        errors.push(`area "${name}": "source-of-truth" must be an array`);
      } else {
        for (const s of area['source-of-truth']) {
          if (!isLiteralPath(s)) {
            errors.push(
              `area "${name}": source-of-truth entry is not a literal path: ${JSON.stringify(s)}`,
            );
          }
        }
      }
    }
  }
  if (!Array.isArray(map.unassigned)) {
    errors.push('"unassigned" must be an array');
  } else {
    for (const entry of map.unassigned) {
      if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string' || !entry.path) {
        errors.push(`unassigned entry missing "path": ${JSON.stringify(entry)}`);
        continue;
      }
      if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
        errors.push(
          `unassigned entry "${entry.path}" has no reason — every exception is justified`,
        );
      }
      try {
        expandBraces(entry.path).forEach(globToRegExp);
      } catch (e) {
        errors.push(`unassigned entry "${entry.path}": ${e.message}`);
      }
    }
  }
  if (!Array.isArray(map['declared-governance'])) {
    errors.push('"declared-governance" must be an array');
  } else {
    for (const entry of map['declared-governance']) {
      if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string' || !entry.path) {
        errors.push(`declared-governance entry missing "path": ${JSON.stringify(entry)}`);
        continue;
      }
      if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
        errors.push(
          `declared-governance entry "${entry.path}" has no reason — every declaration says what the file is`,
        );
      }
      if (!Array.isArray(entry['governed-by'])) {
        errors.push(
          `declared-governance entry "${entry.path}": "governed-by" must be present (an array; [] states the governing set is empty) — every declaration names its governing docs`,
        );
      } else {
        for (const d of entry['governed-by']) {
          const ref = areaRefName(d);
          if (ref === null) {
            if (!isLiteralPath(d)) {
              errors.push(
                `declared-governance entry "${entry.path}": governed-by is not a literal path: ${JSON.stringify(d)}`,
              );
            }
            continue;
          }
          const area = map.areas[ref];
          if (!area) {
            errors.push(
              `declared-governance entry "${entry.path}": governed-by reference "${d}" names an area this map does not define`,
            );
          } else if (!Array.isArray(area.docs) || area.docs.length === 0) {
            errors.push(
              `declared-governance entry "${entry.path}": governed-by reference "${d}" names an area that carries no docs — state the governing set with [] or literal doc paths`,
            );
          }
        }
      }
      try {
        expandBraces(entry.path).forEach(globToRegExp);
      } catch (e) {
        errors.push(`declared-governance entry "${entry.path}": ${e.message}`);
      }
    }
  }
  if (!Array.isArray(map['governance-partitions'])) {
    errors.push('"governance-partitions" must be an array');
  } else {
    for (const entry of map['governance-partitions']) {
      if (
        !entry ||
        typeof entry !== 'object' ||
        typeof entry.pattern !== 'string' ||
        !entry.pattern
      ) {
        errors.push(
          `governance-partitions entry missing "pattern": ${JSON.stringify(entry)} — each partition is an object naming the tree it covers, { "pattern": …, "reason": … }`,
        );
        continue;
      }
      if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
        errors.push(
          `governance-partitions entry "${entry.pattern}" has no reason — every partition records why its tree declares file by file`,
        );
      }
      try {
        expandBraces(entry.pattern).forEach(globToRegExp);
      } catch (e) {
        errors.push(`governance-partitions entry "${entry.pattern}": ${e.message}`);
      }
    }
  }
  return errors;
}

/**
 * Compile a shape-valid map once so per-file resolution is cheap.
 *
 * This is the ONE place `area:<name>` references expand: each declared entry
 * carries both its RAW `governed-by` elements (what the map literally says, for
 * literal-target validation) and the EXPANDED doc set every consumer of the
 * declared governing set reads.
 * @param {any} map parsed area-map.json (must be shape-valid)
 * @returns {{
 *   map: any,
 *   areas: Map<string, { regexes: RegExp[], docs: Set<string> }>,
 *   docSets: Set<string>,
 *   repoWideDocs: Set<string>,
 *   unassigned: { path: string, regexes: RegExp[] }[],
 *   declaredGovernance: { path: string, regexes: RegExp[], governedBy: string[], governedDocs: string[] }[],
 *   partitions: { pattern: string, regexes: RegExp[] }[]
 * }}
 */
export function compileMap(map) {
  const areas = new Map();
  for (const [name, area] of Object.entries(map.areas)) {
    areas.set(name, {
      regexes: (area.code ?? []).flatMap((g) => expandBraces(g).map(globToRegExp)),
      docs: new Set(area.docs ?? []),
    });
  }
  /** Expand one entry's raw governed-by into the doc set it stands for. */
  const expandGovernedBy = (raw) => {
    const docs = new Set();
    for (const element of raw) {
      const ref = areaRefName(element);
      if (ref === null) docs.add(element);
      else for (const d of map.areas[ref]?.docs ?? []) docs.add(d);
    }
    return [...docs];
  };
  return {
    map,
    areas,
    docSets: new Set(Object.values(map.areas).flatMap((a) => a.docs ?? [])),
    repoWideDocs: new Set(map['repo-wide'].docs),
    unassigned: map.unassigned.map((e) => ({
      path: e.path,
      regexes: expandBraces(e.path).map(globToRegExp),
    })),
    declaredGovernance: (map['declared-governance'] ?? []).map((e) => ({
      path: e.path,
      regexes: expandBraces(e.path).map(globToRegExp),
      governedBy: e['governed-by'] ?? [],
      governedDocs: expandGovernedBy(e['governed-by'] ?? []),
    })),
    partitions: (map['governance-partitions'] ?? []).map((e) => ({
      pattern: e.pattern,
      regexes: expandBraces(e.pattern).map(globToRegExp),
    })),
  };
}

/**
 * Resolve one file: the areas that own it (for coverage) and the docs that
 * govern it (for disposition). This is the single implementation of the
 * resolution rule — code patterns, doc-set membership, and (from `content`,
 * when given) `// see docs/<path>.md` pointers, which add every area whose doc
 * set contains the target.
 *
 * A file may instead **declare** its complete governing set via a
 * `declared-governance` entry: then its `docs` are exactly that `governed-by`
 * set as compiled (`area:<name>` references already expanded to their area's
 * doc set — area docs and pointers contribute nothing more, the complete
 * override), while `areas` (hence coverage) are unchanged. `areaSuppliedDocs` always
 * reports the bare code/doc-set-area docs — the file's pre-declaration governing
 * set — so the admission test can tell whether a declaration does real work.
 * @param {string} file repo-relative path
 * @param {ReturnType<typeof compileMap>} compiled
 * @param {string | null} [content] file content for pointer scanning
 * @returns {{ areas: string[], docs: string[], areaSuppliedDocs: string[],
 *             declaredGovernance: boolean, governedBy: string[], declaredMatchCount: number,
 *             repoWide: boolean, unassigned: boolean, pointerTargets: string[] }}
 */
export function resolveFile(file, compiled, content = null) {
  // Areas that own the file via a code pattern or doc-set membership (pointer-independent).
  const codeAreas = new Set();
  for (const [name, area] of compiled.areas) {
    if (area.docs.has(file) || area.regexes.some((re) => re.test(file))) codeAreas.add(name);
  }
  const areas = new Set(codeAreas);
  const pointerTargets = content ? extractDocPointers(content) : [];
  for (const target of pointerTargets) {
    for (const [name, area] of compiled.areas) {
      if (area.docs.has(target)) areas.add(name);
    }
  }
  // The bare code/doc-set-area docs: the file's pre-declaration governing set.
  const areaSuppliedDocs = new Set();
  for (const name of codeAreas) {
    for (const d of compiled.map.areas[name].docs ?? []) areaSuppliedDocs.add(d);
  }
  // A declaration overrides governance with its own complete set.
  const declaredMatches = (compiled.declaredGovernance ?? []).filter((e) =>
    e.regexes.some((re) => re.test(file)),
  );
  const declaredGovernance = declaredMatches.length > 0;
  const governedBy = new Set(declaredMatches.flatMap((e) => e.governedDocs));
  let docs;
  if (declaredGovernance) {
    docs = new Set(governedBy); // exactly the declared set — area docs and pointers do not apply
  } else {
    docs = new Set();
    for (const name of areas) {
      for (const d of compiled.map.areas[name].docs ?? []) docs.add(d);
    }
  }
  return {
    areas: [...areas],
    docs: [...docs],
    areaSuppliedDocs: [...areaSuppliedDocs],
    declaredGovernance,
    governedBy: [...governedBy],
    declaredMatchCount: declaredMatches.length,
    repoWide: compiled.repoWideDocs.has(file),
    unassigned: compiled.unassigned.some((e) => e.regexes.some((re) => re.test(file))),
    pointerTargets,
  };
}

/**
 * Pure core: audit the map against the tracked-file universe.
 * @param {object} opts
 * @param {string[]} opts.files all git-tracked repo-relative paths
 * @param {any} opts.map parsed area-map.json
 * @param {(f: string) => (string | null)} opts.readFile content reader (null if unreadable);
 *   consulted only for files that would otherwise resolve to no area
 * @returns {{
 *   shapeErrors: string[], zeroArea: string[],
 *   stalePatterns: string[], untrackedEntries: string[],
 *   uncoveredDocs: string[], staleUnassigned: string[],
 *   unnecessaryUnassigned: string[], badPointers: string[],
 *   staleGovernance: string[], redundantGovernance: string[],
 *   conflictingGovernance: string[], crossGovernedDeclaration: string[],
 *   badGovernedBy: string[], undeclaredInPartition: string[],
 *   stalePartitions: string[], overlappingPartitions: string[],
 *   straddlingGovernance: string[]
 * }}
 */
export function auditMap({ files, map, readFile }) {
  const empty = {
    shapeErrors: [],
    zeroArea: [],
    stalePatterns: [],
    untrackedEntries: [],
    uncoveredDocs: [],
    staleUnassigned: [],
    unnecessaryUnassigned: [],
    badPointers: [],
    staleGovernance: [],
    redundantGovernance: [],
    conflictingGovernance: [],
    crossGovernedDeclaration: [],
    badGovernedBy: [],
    undeclaredInPartition: [],
    stalePartitions: [],
    overlappingPartitions: [],
    straddlingGovernance: [],
  };
  const shapeErrors = validateShape(map);
  if (shapeErrors.length) return { ...empty, shapeErrors };

  const tracked = new Set(files);
  const compiled = compileMap(map);
  const result = { ...empty };

  // (b) staleness: every brace alternative matches >=1 tracked file.
  for (const [name, area] of Object.entries(map.areas)) {
    for (const g of area.code ?? []) {
      for (const alt of expandBraces(g)) {
        const re = globToRegExp(alt);
        if (!files.some((f) => re.test(f))) {
          result.stalePatterns.push(
            `area "${name}": pattern "${alt}"${alt === g ? '' : ` (from "${g}")`} matches no tracked file`,
          );
        }
      }
    }
    for (const d of [...(area.docs ?? []), ...(area['source-of-truth'] ?? [])]) {
      if (!tracked.has(d)) result.untrackedEntries.push(`area "${name}": ${d}`);
    }
  }
  for (const d of map['repo-wide'].docs) {
    if (!tracked.has(d)) result.untrackedEntries.push(`repo-wide: ${d}`);
  }

  // (a) coverage + (c) doc-coverage + (d) unassigned self-check.
  const unassignedHits = new Map(map.unassigned.map((e) => [e.path, { total: 0, needed: 0 }]));
  const isUnassigned = (f) => compiled.unassigned.some((e) => e.regexes.some((re) => re.test(f)));
  // declared-governance self-check: per entry, does it change any matched file's governing set?
  const govAcc = compiled.declaredGovernance.map((e) => ({
    e,
    total: 0,
    eligible: 0,
    allEqual: true,
    inPartition: 0,
    outsidePartition: 0,
  }));
  for (const file of files) {
    const bare = resolveFile(file, compiled);
    // A `.md` is doc-placed when it is repo-wide or in some area's doc set —
    // code-membership does NOT count, so a doctrine doc owned only by a code
    // pattern still needs an explicit home.
    const docPlaced = bare.repoWide || compiled.docSets.has(file);
    let owned = docPlaced || bare.areas.length > 0;
    if (!owned) {
      // Pointer rescue: a `// see docs/<path>.md` comment names the governing doc.
      const content = readFile(file);
      if (content != null) {
        const withContent = resolveFile(file, compiled, content);
        for (const target of withContent.pointerTargets) {
          if (!tracked.has(target)) {
            result.badPointers.push(`${file} points at untracked doc ${target}`);
          } else if (!compiled.docSets.has(target)) {
            result.badPointers.push(`${file} points at ${target}, which is in no area's doc set`);
          }
        }
        owned = withContent.areas.length > 0;
      }
    }
    // A file is red without an exception when it resolves to no area (a) or,
    // for a `.md`, when it is not doc-placed (c). An `unassigned` entry earns
    // its keep only by covering such a file.
    const failsCoverage = !owned;
    const failsDocCoverage = file.endsWith('.md') && !docPlaced;
    const redWithoutException = failsCoverage || failsDocCoverage;
    if (bare.unassigned) {
      for (const e of compiled.unassigned) {
        if (e.regexes.some((re) => re.test(file))) {
          const hit = unassignedHits.get(e.path);
          hit.total++;
          if (redWithoutException) hit.needed++;
        }
      }
    }
    if (failsCoverage && !bare.unassigned) result.zeroArea.push(file);

    // (f) governance partitions: inside a partitioned tree every file declares
    // its own governance, so an undeclared one is a red naming what to add.
    const matchedPartitions = compiled.partitions.filter((p) =>
      p.regexes.some((re) => re.test(file)),
    );
    const inPartition = matchedPartitions.length > 0;
    if (inPartition && !bare.declaredGovernance) result.undeclaredInPartition.push(file);
    // One entry per tree: a file two partition entries both claim sits under two
    // partition statements at once, so the overlap is named rather than silently
    // resolved (two entries with the same pattern are its degenerate case).
    if (matchedPartitions.length >= 2) {
      result.overlappingPartitions.push(
        `${file}: ${matchedPartitions.map((p) => `"${p.pattern}"`).join(', ')}`,
      );
    }

    // declared-governance: conflict, single-source, and per-entry redundancy accounting.
    if (bare.declaredGovernance) {
      const conflicted = bare.declaredMatchCount >= 2;
      if (conflicted) result.conflictingGovernance.push(file);
      let crossGoverned = bare.repoWide;
      if (!crossGoverned) {
        // Read content only to enforce single-source; this runs no pointer validation, so a
        // declared file's dead `// see` fixture strings (targets in no doc set) stay inert.
        const content = readFile(file);
        if (content != null && extractDocPointers(content).some((t) => compiled.docSets.has(t))) {
          crossGoverned = true;
        }
      }
      if (crossGoverned) result.crossGovernedDeclaration.push(file);
      // A partition-covered file is counted (so its entry is not stale) but left
      // out of the EQUALITY accounting: there, declaring the covering area's own
      // set is what the partition asks for, so it states something after all.
      const eligible = !conflicted && !crossGoverned && !inPartition;
      const areaSupplied = new Set(bare.areaSuppliedDocs);
      for (const acc of govAcc) {
        if (!acc.e.regexes.some((re) => re.test(file))) continue;
        acc.total++;
        if (inPartition) acc.inPartition++;
        else acc.outsidePartition++;
        if (eligible) {
          acc.eligible++;
          const gb = new Set(acc.e.governedDocs);
          if (gb.size !== areaSupplied.size || [...gb].some((d) => !areaSupplied.has(d))) {
            acc.allEqual = false;
          }
        }
      }
    }
  }
  // (f) staleness: every partition pattern describes a tree that exists.
  for (const p of compiled.partitions) {
    if (!files.some((f) => p.regexes.some((re) => re.test(f)))) {
      result.stalePartitions.push(p.pattern);
    }
  }
  // A declaration earns its keep by changing the governing set of some eligible matched file.
  for (const acc of govAcc) {
    // An entry reaching across a partition boundary is read under both sides'
    // rules at once, so it is refused and split at the boundary. The refusal
    // displaces the redundancy red specifically: the entry is left out of the
    // redundancy accounting, whose own remedy — remove the entry — would
    // contradict the split. Every other red still applies to it.
    const straddling = acc.inPartition > 0 && acc.outsidePartition > 0;
    if (straddling) result.straddlingGovernance.push(acc.e.path);
    if (acc.total === 0) result.staleGovernance.push(acc.e.path);
    else if (!straddling && acc.eligible >= 1 && acc.e.governedDocs.length > 0 && acc.allEqual) {
      result.redundantGovernance.push(acc.e.path);
    }
  }
  // badGovernedBy — a per-entry check on the RAW declared elements, independent of
  // matched files. Literal targets are validated here; an `area:<name>` reference
  // is validated as an area name by validateShape, and the docs it expands to are
  // validated by that area's own doc entries.
  for (const e of compiled.declaredGovernance) {
    for (const doc of e.governedBy) {
      if (areaRefName(doc) !== null) continue;
      if (!tracked.has(doc)) {
        result.badGovernedBy.push(`${e.path}: ${doc} (untracked)`);
      } else if (!compiled.docSets.has(doc) && !compiled.repoWideDocs.has(doc)) {
        result.badGovernedBy.push(`${e.path}: ${doc} (in no area's doc set nor repo-wide)`);
      }
    }
  }
  for (const [path, { total, needed }] of unassignedHits) {
    if (total === 0) {
      result.staleUnassigned.push(path);
    } else if (needed === 0) {
      result.unnecessaryUnassigned.push(path);
    }
  }

  // (c) every tracked `.md` (repo-wide, not just under docs/) is repo-wide, in
  // some area's doc set, or a justified `unassigned` exception. Only tracked
  // files are seen (the caller passes `git ls-files`), so gitignored docs are
  // never scanned and never required here.
  result.uncoveredDocs = files
    .filter(
      (f) =>
        f.endsWith('.md') &&
        !compiled.repoWideDocs.has(f) &&
        !compiled.docSets.has(f) &&
        !isUnassigned(f),
    )
    .sort();

  result.zeroArea.sort();
  return result;
}

/* c8 ignore start — the CLI wrapper reads the tracked-file list from git and the
 * map from disk, then prints; the shape/coverage/staleness/doc-coverage and the
 * declared-governance self-check logic it delegates to (validateShape, compileMap,
 * resolveFile, auditMap) are unit-tested above. */
function run() {
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const map = JSON.parse(readFileSync(MAP_PATH, 'utf8'));
  const readFile = (f) => {
    try {
      return readFileSync(f, 'utf8');
    } catch {
      return null;
    }
  };

  const r = auditMap({ files, map, readFile });
  const problems = [];
  if (r.shapeErrors.length) {
    problems.push(
      `✗ ${MAP_PATH} is malformed:\n` + r.shapeErrors.map((e) => `    ${e}`).join('\n'),
    );
  }
  if (r.zeroArea.length) {
    problems.push(
      `✗ ${r.zeroArea.length} tracked file(s) belong to no area:\n` +
        r.zeroArea.map((f) => `    ${f}`).join('\n') +
        `\n\n  Fix: extend an area's "code" patterns in ${MAP_PATH} (or its "docs" set, for a doc),\n` +
        `  give the file a "// see docs/<path>.md" comment naming its governing doc (the doc must\n` +
        `  be in an area's doc set), or — only if the file is genuinely owned by no area — add an\n` +
        `  "unassigned" entry with a reason.`,
    );
  }
  if (r.stalePatterns.length) {
    problems.push(
      `✗ ${r.stalePatterns.length} stale code pattern(s) in ${MAP_PATH} (matching nothing):\n` +
        r.stalePatterns.map((s) => `    ${s}`).join('\n') +
        `\n\n  Fix: update or remove each pattern — a pattern matching nothing no longer describes the tree.`,
    );
  }
  if (r.untrackedEntries.length) {
    problems.push(
      `✗ ${r.untrackedEntries.length} map entr(ies) point at untracked files:\n` +
        r.untrackedEntries.map((s) => `    ${s}`).join('\n') +
        `\n\n  Fix: repoint each entry at the file's new path, or remove it if the file is gone.`,
    );
  }
  if (r.uncoveredDocs.length) {
    problems.push(
      `✗ ${r.uncoveredDocs.length} tracked doc(s) have no home in ${MAP_PATH}:\n` +
        r.uncoveredDocs.map((s) => `    ${s}`).join('\n') +
        `\n\n  Fix: add each doc to the "docs" set of every area it governs, list it as a\n` +
        `  repo-wide doc, or — if it is genuinely governed by no area — add an "unassigned"\n` +
        `  entry with a reason. Being matched only by a code pattern is not a doc home.`,
    );
  }
  if (r.staleUnassigned.length) {
    problems.push(
      `✗ ${r.staleUnassigned.length} "unassigned" entr(ies) match no tracked file — remove:\n` +
        r.staleUnassigned.map((s) => `    ${s}`).join('\n'),
    );
  }
  if (r.unnecessaryUnassigned.length) {
    problems.push(
      `✗ ${r.unnecessaryUnassigned.length} "unassigned" entr(ies) are unnecessary (every matched file already resolves to an area) — remove:\n` +
        r.unnecessaryUnassigned.map((s) => `    ${s}`).join('\n'),
    );
  }
  if (r.badPointers.length) {
    problems.push(
      `✗ ${r.badPointers.length} doc pointer(s) do not resolve:\n` +
        r.badPointers.map((s) => `    ${s}`).join('\n') +
        `\n\n  Fix: point each "// see docs/…" comment at a tracked doc that belongs to an area's doc set.`,
    );
  }
  if (r.staleGovernance.length) {
    problems.push(
      `✗ ${r.staleGovernance.length} "declared-governance" entr(ies) match no tracked file — remove:\n` +
        r.staleGovernance.map((s) => `    ${s}`).join('\n'),
    );
  }
  if (r.redundantGovernance.length) {
    problems.push(
      `✗ ${r.redundantGovernance.length} "declared-governance" entr(ies) are redundant — every matched file's covering area already supplies exactly the declared docs, so the declaration states nothing new; remove:\n` +
        r.redundantGovernance.map((s) => `    ${s}`).join('\n'),
    );
  }
  if (r.conflictingGovernance.length) {
    problems.push(
      `✗ ${r.conflictingGovernance.length} file(s) are declared by multiple "declared-governance" entries — each file's governance is declared once:\n` +
        r.conflictingGovernance.map((s) => `    ${s}`).join('\n') +
        `\n\n  Fix: leave one entry answering for each file — narrow the overlapping "path" patterns\n` +
        `  so they no longer reach the same file, or merge them into a single entry whose\n` +
        `  "governed-by" states that file's complete governing set.`,
    );
  }
  if (r.crossGovernedDeclaration.length) {
    problems.push(
      `✗ ${r.crossGovernedDeclaration.length} "declared-governance" file(s) already carry governance from another source (a repo-wide doc, or a "// see docs/…" pointer into a live doc set):\n` +
        r.crossGovernedDeclaration.map((s) => `    ${s}`).join('\n') +
        `\n\n  Fix: a declared file's governing docs are exactly its "governed-by" — declare its governance in one place.`,
    );
  }
  if (r.badGovernedBy.length) {
    problems.push(
      `✗ ${r.badGovernedBy.length} "declared-governance" governed-by target(s) do not resolve:\n` +
        r.badGovernedBy.map((s) => `    ${s}`).join('\n') +
        `\n\n  Fix: each governed-by doc must be a tracked doc in some area's doc set, or a repo-wide doc\n` +
        `  (or an "area:<name>" reference to an area of this map that carries docs).`,
    );
  }
  if (r.undeclaredInPartition.length) {
    problems.push(
      `✗ ${r.undeclaredInPartition.length} file(s) sit in a "governance-partitions" tree and declare no governance:\n` +
        r.undeclaredInPartition.map((s) => `    ${s}`).join('\n') +
        `\n\n  Fix: every file in a partitioned tree states its own subject. Add a\n` +
        `  "declared-governance" entry in ${MAP_PATH} covering the file — a "path" naming it\n` +
        `  (a pattern may cover a family), a "reason" stating what the file is about, and a\n` +
        `  "governed-by" set: write "area:<name>" where the file owes that area's whole doc set,\n` +
        `  add each further doc its evidence names as a literal path, and write [] where no doc\n` +
        `  governs it. Stating the set your covering areas already supply is a legal answer here.`,
    );
  }
  if (r.stalePartitions.length) {
    problems.push(
      `✗ ${r.stalePartitions.length} "governance-partitions" pattern(s) match no tracked file — remove:\n` +
        r.stalePartitions.map((s) => `    ${s}`).join('\n'),
    );
  }
  if (r.overlappingPartitions.length) {
    problems.push(
      `✗ ${r.overlappingPartitions.length} tracked file(s) are claimed by more than one "governance-partitions" entry\n` +
        `  (each line names the file and the patterns that claim it):\n` +
        r.overlappingPartitions.map((s) => `    ${s}`).join('\n') +
        `\n\n  Fix: one entry per tree — narrow the patterns so each file's partition is stated once,\n` +
        `  or merge the entries into the single one whose "reason" describes that tree (two entries\n` +
        `  naming the same tree are the degenerate case of the same overlap).`,
    );
  }
  if (r.straddlingGovernance.length) {
    problems.push(
      `✗ ${r.straddlingGovernance.length} "declared-governance" entr(ies) reach across a "governance-partitions" boundary\n` +
        `  (each matches files inside a partitioned tree and files outside every partition):\n` +
        r.straddlingGovernance.map((s) => `    ${s}`).join('\n') +
        `\n\n  Fix: split each entry at the boundary — one entry for the files inside the partitioned\n` +
        `  tree, one for the files outside it — so each side is read under the rule that applies to\n` +
        `  it: inside a partitioned tree a declaration equal to the covering areas' own set is the\n` +
        `  honest statement and stays green, while outside one the same set states nothing new.`,
    );
  }

  if (problems.length) {
    console.error(problems.join('\n\n'));
    process.exit(1);
  }
  console.log(
    `✓ area map covers the tree: ${files.length} tracked files resolve across ` +
      `${Object.keys(map.areas).length} areas (+${map['repo-wide'].docs.length} repo-wide docs, ` +
      `${map.unassigned.length} justified exceptions, ` +
      `${(map['declared-governance'] ?? []).length} declared-governance entries, ` +
      `${(map['governance-partitions'] ?? []).length} governance partitions).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
/* c8 ignore stop */
