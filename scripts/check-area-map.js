/**
 * check-area-map.js — admission test for `scripts/area-map.json` (the committed
 * map from repository areas to the code they own and the docs that govern them).
 * The map is data, so it can rot; this check makes every way it can rot loud:
 *
 *   (a) coverage  — every git-tracked file must resolve to at least one area
 *       (via a code pattern, doc-set membership, or a `// see docs/<path>.md`
 *       pointer in the file), or be a repo-wide doc, or match an `unassigned`
 *       entry. A file nobody owns is a red, not a shrug.
 *   (b) staleness — every pattern the map states, in whichever list states it
 *       (an area's code patterns, an `unassigned` exception, a
 *       `declared-governance` declaration, a `governance-partitions` tree), must
 *       still describe the tree: each of its brace alternatives must match at
 *       least one tracked file. An alternative that matches nothing while its
 *       siblings still match reds on that alternative alone — braces expand to
 *       their groups' cross product, so what is held is what the pattern
 *       expands to rather than what its entry visibly spells, and the entry is
 *       rewritten until every expansion matches, the entry itself staying — and
 *       an entry with no live alternative left is stale as a whole. Every
 *       literal entry (docs, source-of-truth, repo-wide) must point at something
 *       tracked. A dead entry is a red.
 *   (c) doc coverage — every tracked `.md` anywhere in the repo must be a
 *       repo-wide doc, belong to at least one area's doc set, or match an
 *       `unassigned` entry. Being owned only by a code pattern is not a
 *       doc-home decision: a doctrine doc the map places nowhere is a red.
 *       (Only tracked files are seen — the list is `git ls-files` — so
 *       gitignored docs are never scanned and never required here.)
 *   (d) self-failing unassigned list — an `unassigned` entry earns its keep file
 *       by file. An entry whose files all resolve through areas anyway (and, for
 *       a `.md`, are doc-placed anyway) is unnecessary as a whole and must be
 *       removed; a file that resolves anyway beside files the tree still needs
 *       the entry for is red on that file alone, and the entry is narrowed until
 *       it covers only the files that need it. Necessity is accounted per FILE,
 *       so what an entry spells — one path, a brace alternation, a wide pattern
 *       — never decides which files it is answered for.
 *   (e) declared governance — a `declared-governance` entry names files that keep
 *       their code-area coverage but declare their own COMPLETE governing doc set
 *       explicitly (a `governed-by` array; `[]` states the set is empty), in place
 *       of the docs their covering area supplies. Each element is a literal doc
 *       path or an `area:<name>` reference, which stands for that area's whole doc
 *       set and expands to it. Outside a partitioned tree, a declaration whose set
 *       already equals what the area supplies states nothing new (redundant) —
 *       accounted per FILE, so an entry equal for every file it answers for is
 *       redundant as a whole, while one equal for some of them beside files it
 *       really does answer for is red on those files and splits; a file
 *       declared twice, or one that also sources governance from a repo-wide doc
 *       or a `// see docs/…` pointer into a live doc set, is a red (conflict /
 *       cross-governed — declare in one place); a governed-by target that is
 *       untracked or homeless (in no doc set and not repo-wide) is a red; and a
 *       declaration matching no tracked file is stale (a red, as for
 *       `unassigned`), with a dead brace alternative of a still-matching
 *       declaration red on that alternative alone.
 *   (f) governance partitions — `governance-partitions` lists the trees whose
 *       files each declare their own governance, one `{ pattern, reason }` entry
 *       per tree. Every tracked file matching a partition pattern carries a
 *       `declared-governance` entry, so a new file there states its subject rather
 *       than inheriting the union its tree ride supplies — that red naming the
 *       tree which claims the file and the reason its files declare one by one;
 *       a partition pattern matching no tracked file is stale (a red, as for
 *       `unassigned`), with a dead brace alternative of a still-matching pattern
 *       red on that alternative alone, and a
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
 *   (g) area necessity — an area earns its place by supplying something the rest
 *       of the map does not: docs some tracked file's governing set would
 *       otherwise lose, coverage some tracked file would otherwise lack, or the
 *       readability of the map itself. The question is asked by deleting it:
 *       every `area:<name>` reference to it is first inlined to the docs it
 *       stands for (so what is asked is what the area supplies, not whether
 *       something names it), and every tracked file is resolved again. An area
 *       whose deletion leaves every file governed by exactly the same docs, and
 *       leaves no file unowned, makes no contribution the rest of the map does
 *       not already make — a red naming it. Each area is judged on its own
 *       against the rest of the map: areas that supply the same docs each answer
 *       for the others, so each is named and each removal is a new question the
 *       next run answers. An area the map cannot be read without (deleting it
 *       leaves no areas at all) supplies that readability.
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
 *   node scripts/check-area-map.js                  # or: npm run lint:area-map
 *   node scripts/check-area-map.js --explain <path> # what the map says about one file
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Repo-relative path of the map this check guards. */
export const MAP_PATH = 'scripts/area-map.json';

/** `name` of the refusal `compileMap` raises on a map that is not shape-valid. */
export const SHAPE_ERROR_NAME = 'AreaMapShapeError';

/**
 * The printed verdict for a set of errors about the map — the one home of its
 * wording. The headline states what the file turned out to be, so a map that is
 * there and misshapen and a map that is not there to read are told apart on the
 * first line; the default is the shape verdict every `validateShape` red takes.
 */
const shapeVerdict = (errors, headline = `${MAP_PATH} is malformed`) =>
  `✗ ${headline}:\n` + errors.map((e) => `    ${e}`).join('\n');

/**
 * The refusal `compileMap` raises when handed a map that is not shape-valid,
 * and `loadMap` raises for a file it cannot turn into a map at all. Its message
 * is the complete verdict — every error reported, under a headline naming the
 * map and what it turned out to be — so a consumer catching it prints the
 * message as its own red rather than re-deriving anything, and `name`
 * identifies the refusal without depending on a shared class instance.
 */
export class AreaMapShapeError extends Error {
  /**
   * @param {string[]} shapeErrors every error reported about the map
   * @param {string} [headline] what the file turned out to be, as the verdict names it
   */
  constructor(shapeErrors, headline) {
    super(shapeVerdict(shapeErrors, headline));
    this.name = SHAPE_ERROR_NAME;
    this.shapeErrors = shapeErrors;
  }
}

/**
 * The refusal posture every command line that resolves through the map shares,
 * in one home so they cannot answer differently: a map that is not shape-valid
 * is breakage on the check's own input, so the caller prints the refusal's own
 * message and ends red on the ordinary red path, while anything else it caught
 * is rethrown untouched. The printing and exiting seams are parameters so the
 * decision can be exercised without ending the process.
 * @param {unknown} err the error a caller caught around a map consumer
 * @param {object} [io] the print and exit seams
 * @param {(message: string) => void} [io.error] where the refusal is printed
 * @param {(code: number) => void} [io.exit] how the run ends
 * @throws {unknown} whatever it was handed, when that is not the shape refusal
 * @returns {void}
 */
export function refuseOnShapeError(
  err,
  { error = (m) => console.error(m), exit = (c) => process.exit(c) } = {},
) {
  if (err?.name !== SHAPE_ERROR_NAME) throw err;
  error(err.message);
  exit(1);
}

/** What the map is read for, stated on every refusal its read can raise. */
const MAP_READ_FOR =
  `every consumer reads a file's areas and its governing docs through this map, ` +
  `so restore it before any of that can be resolved`;

/**
 * Read the map from disk and parse it — the step that turns the committed file
 * into the object every consumer resolves through. The read is inside the
 * guarded region with the parse, following the same shape the clause-preamble
 * check reads its inputs through: a file that cannot be read at all and a file
 * whose text is not JSON are both refused with the same
 * {@link AreaMapShapeError} a shape-invalid map raises, each saying which of the
 * two it was. The input step and the shape step answering alike is what lets the
 * refusal posture every consumer already prints reach the read, so no consumer
 * answers a missing or broken map with a stack trace. The read seam is a
 * parameter so the decision can be exercised without touching the tree.
 * @param {(path: string) => string} [read] how the file's text is read
 * @throws {AreaMapShapeError} when the file cannot be read, or its text is not JSON
 * @returns {any} the parsed map
 */
export function loadMap(read = (p) => readFileSync(p, 'utf8')) {
  let text;
  try {
    text = read(MAP_PATH);
  } catch (err) {
    throw new AreaMapShapeError(
      [`${err.message} — ${MAP_READ_FOR}`],
      `${MAP_PATH} could not be read`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new AreaMapShapeError([`does not read as JSON — ${err.message} — ${MAP_READ_FOR}`]);
  }
}

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

/**
 * One compiled brace alternative: the pattern as the map states it, the
 * alternative it expands to, and the matcher that alternative compiles to.
 * @typedef {{ pattern: string, alternative: string, regex: RegExp }} Matcher
 */

/**
 * Compile one pattern into a matcher per brace alternative. Every
 * pattern-bearing entry the map states — an area's code patterns, an
 * `unassigned` exception, a `declared-governance` declaration, a
 * `governance-partitions` tree — compiles through this one idiom, so matching
 * and per-alternative liveness cannot drift apart between lists.
 * @param {string} pattern a pattern as the map states it (braces allowed)
 * @returns {Matcher[]} one entry per brace alternative
 */
export function compileAlternatives(pattern) {
  return expandBraces(pattern).map((alternative) => ({
    pattern,
    alternative,
    regex: globToRegExp(alternative),
  }));
}

/** Does any alternative of a compiled entry match this file? */
const matches = (matchers, file) => matchers.some((m) => m.regex.test(file));

const isLiteralPath = (p) => typeof p === 'string' && p.length > 0 && !/[*{},]/.test(p);

/**
 * Validate one justified list. The `unassigned`, `declared-governance`, and
 * `governance-partitions` lists state their entries in the same shape — an
 * object naming a file or tree under one key, a non-empty reason recording why
 * the entry exists, and a pattern that compiles — so they are validated once
 * here, with each list's own wording and its own extra checks passed in.
 * @param {object} spec
 * @param {any} spec.value the map's value for the list
 * @param {string} spec.list the map key the list sits under
 * @param {string} spec.key the entry field naming the file or tree
 * @param {string} spec.reasonWhy what this list's reason records
 * @param {string} [spec.missingHint] appended to the missing-key error
 * @param {(entry: any, errors: string[]) => void} [spec.extra] this list's further checks
 * @param {string[]} errors collected shape errors
 */
function validateJustifiedList({ value, list, key, reasonWhy, missingHint = '', extra }, errors) {
  if (!Array.isArray(value)) {
    errors.push(`"${list}" must be an array`);
    return;
  }
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || typeof entry[key] !== 'string' || !entry[key]) {
      errors.push(`${list} entry missing "${key}": ${JSON.stringify(entry)}${missingHint}`);
      continue;
    }
    const named = entry[key];
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
      errors.push(`${list} entry "${named}" has no reason — ${reasonWhy}`);
    }
    extra?.(entry, errors);
    try {
      compileAlternatives(named);
    } catch (e) {
      errors.push(`${list} entry "${named}": ${e.message}`);
    }
  }
}

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
            compileAlternatives(g);
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
  validateJustifiedList(
    {
      value: map.unassigned,
      list: 'unassigned',
      key: 'path',
      reasonWhy: 'every exception is justified',
    },
    errors,
  );
  validateJustifiedList(
    {
      value: map['declared-governance'],
      list: 'declared-governance',
      key: 'path',
      reasonWhy: 'every declaration says what the file is',
      // A declaration also names its governing docs: literal doc paths, or
      // `area:<name>` references to an area of this map that carries docs.
      extra: (entry, errs) => {
        if (!Array.isArray(entry['governed-by'])) {
          errs.push(
            `declared-governance entry "${entry.path}": "governed-by" must be present (an array; [] states the governing set is empty) — every declaration names its governing docs`,
          );
          return;
        }
        for (const d of entry['governed-by']) {
          const ref = areaRefName(d);
          if (ref === null) {
            if (!isLiteralPath(d)) {
              errs.push(
                `declared-governance entry "${entry.path}": governed-by is not a literal path: ${JSON.stringify(d)}`,
              );
            }
            continue;
          }
          const area = map.areas[ref];
          if (!area) {
            errs.push(
              `declared-governance entry "${entry.path}": governed-by reference "${d}" names an area this map does not define`,
            );
          } else if (!Array.isArray(area.docs) || area.docs.length === 0) {
            errs.push(
              `declared-governance entry "${entry.path}": governed-by reference "${d}" names an area that carries no docs — state the governing set with [] or literal doc paths`,
            );
          }
        }
      },
    },
    errors,
  );
  validateJustifiedList(
    {
      value: map['governance-partitions'],
      list: 'governance-partitions',
      key: 'pattern',
      reasonWhy: 'every partition records why its tree declares file by file',
      missingHint:
        ' — each partition is an object naming the tree it covers, { "pattern": …, "reason": … }',
    },
    errors,
  );
  return errors;
}

/**
 * Compile a map once so per-file resolution is cheap.
 *
 * Shape-validity is this function's enforced precondition, not a documented
 * assumption: a map `validateShape` rejects is refused here with an
 * {@link AreaMapShapeError} carrying every reported error, so a consumer of the
 * map fails on a named verdict about its input rather than deep inside the glob
 * machinery. (`auditMap` validates before calling and reports the errors as its
 * own result, so its graceful path never reaches this refusal.)
 *
 * This is the ONE place `area:<name>` references expand: each declared entry
 * carries both `rawGovernedBy` (the elements the map literally states, for
 * literal-target validation) and `expandedGovernedBy` (the doc set every
 * consumer of the declared governing set reads).
 * @param {any} map parsed area-map.json
 * @throws {AreaMapShapeError} when the map is not shape-valid
 * @returns {{
 *   map: any,
 *   areas: Map<string, { codeEntries: { pattern: string, matchers: Matcher[] }[], docs: Set<string> }>,
 *   docSets: Set<string>,
 *   repoWideDocs: Set<string>,
 *   unassigned: { path: string, matchers: Matcher[] }[],
 *   declaredGovernance: { path: string, matchers: Matcher[], rawGovernedBy: string[], expandedGovernedBy: string[] }[],
 *   partitions: { pattern: string, reason: string, matchers: Matcher[] }[]
 * }}
 */
export function compileMap(map) {
  const shapeErrors = validateShape(map);
  if (shapeErrors.length) throw new AreaMapShapeError(shapeErrors);
  const areas = new Map();
  for (const [name, area] of Object.entries(map.areas)) {
    areas.set(name, {
      codeEntries: (area.code ?? []).map((pattern) => ({
        pattern,
        matchers: compileAlternatives(pattern),
      })),
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
      matchers: compileAlternatives(e.path),
    })),
    declaredGovernance: (map['declared-governance'] ?? []).map((e) => ({
      path: e.path,
      matchers: compileAlternatives(e.path),
      rawGovernedBy: e['governed-by'] ?? [],
      expandedGovernedBy: expandGovernedBy(e['governed-by'] ?? []),
    })),
    partitions: (map['governance-partitions'] ?? []).map((e) => ({
      pattern: e.pattern,
      reason: e.reason,
      matchers: compileAlternatives(e.pattern),
    })),
  };
}

/**
 * Every pattern-bearing entry of a compiled map, in one list: the list it sits
 * in, the entry as the map states it, the subject a red names it by, and its
 * compiled alternatives. A leg that runs over patterns reads the map through
 * this enumeration, so a list added to the map cannot silently escape it.
 * @param {ReturnType<typeof compileMap>} compiled
 * @returns {{ list: string, entry: string, subject: string, matchers: Matcher[] }[]}
 */
export function patternEntries(compiled) {
  const sites = [];
  for (const [name, area] of compiled.areas) {
    // An area states one entry per code pattern, so each pattern is its own entry.
    for (const c of area.codeEntries) {
      sites.push({
        list: 'areas',
        entry: c.pattern,
        subject: `area "${name}": pattern "${c.pattern}"`,
        matchers: c.matchers,
      });
    }
  }
  for (const e of compiled.unassigned) {
    sites.push({
      list: 'unassigned',
      entry: e.path,
      subject: `"unassigned" entry "${e.path}"`,
      matchers: e.matchers,
    });
  }
  for (const e of compiled.declaredGovernance) {
    sites.push({
      list: 'declared-governance',
      entry: e.path,
      subject: `"declared-governance" entry "${e.path}"`,
      matchers: e.matchers,
    });
  }
  for (const p of compiled.partitions) {
    sites.push({
      list: 'governance-partitions',
      entry: p.pattern,
      subject: `"governance-partitions" entry "${p.pattern}"`,
      matchers: p.matchers,
    });
  }
  return sites;
}

/**
 * Record one wholly dead pattern-bearing entry against the list that states it.
 * The `unassigned` and `declared-governance` lists are named here and handed
 * over deliberately: their per-entry accounting walks the tracked files anyway
 * and reports a dead entry from there, so recording it again here would
 * double-fire. A list this dispatch does not answer for is a programming error
 * in this check — not map rot — so it throws rather than dropping that list's
 * dead entries in silence.
 * @param {{ list: string, entry: string, subject: string }} site a dead entry from patternEntries
 * @param {{ stalePatterns: string[], stalePartitions: string[] }} result the audit result being built
 * @throws {Error} when the entry's list has no whole-entry verdict here
 * @returns {void}
 */
export function recordDeadEntry(site, result) {
  switch (site.list) {
    case 'areas':
      result.stalePatterns.push(`${site.subject} matches no tracked file`);
      return;
    case 'governance-partitions':
      result.stalePartitions.push(site.entry);
      return;
    case 'unassigned':
    case 'declared-governance':
      return; // reported by that list's own per-entry accounting
    default:
      throw new Error(
        `no whole-entry verdict for pattern list "${site.list}" — every list patternEntries ` +
          `states is either reported here or delegated by name`,
      );
  }
}

/**
 * Resolve one file: the areas that own it (for coverage) and the docs that
 * govern it (for disposition). This is the single implementation of the
 * resolution rule — code patterns, doc-set membership, and (from `content`,
 * when given) `// see docs/<path>.md` pointers, which add every area whose doc
 * set contains the target.
 *
 * A file may instead **declare** its complete governing set via a
 * `declared-governance` entry: then its `docs` are exactly that declared set as
 * compiled — `expandedGovernedBy`, with `area:<name>` references already
 * expanded to their area's doc set, area docs and pointers contributing nothing
 * more — while `areas` (hence coverage) are unchanged. The declaration is also
 * reported as the map states it: `declaredEntryPaths` names the matching
 * entr(ies) and `rawGovernedBy` their elements verbatim, so a caller can show
 * what the map says beside what it expands to. `areaSuppliedDocs` always
 * reports the bare code/doc-set-area docs — the file's pre-declaration governing
 * set — so the admission test can tell whether a declaration does real work.
 * @param {string} file repo-relative path
 * @param {ReturnType<typeof compileMap>} compiled
 * @param {string | null} [content] file content for pointer scanning
 * @returns {{ areas: string[], docs: string[], areaSuppliedDocs: string[],
 *             declaredGovernance: boolean, declaredEntryPaths: string[],
 *             rawGovernedBy: string[], expandedGovernedBy: string[],
 *             repoWide: boolean, unassigned: boolean, pointerTargets: string[] }}
 */
export function resolveFile(file, compiled, content = null) {
  // Areas that own the file via a code pattern or doc-set membership (pointer-independent).
  const codeAreas = new Set();
  for (const [name, area] of compiled.areas) {
    if (area.docs.has(file) || area.codeEntries.some((c) => matches(c.matchers, file))) {
      codeAreas.add(name);
    }
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
    matches(e.matchers, file),
  );
  const declaredGovernance = declaredMatches.length > 0;
  const expandedGovernedBy = new Set(declaredMatches.flatMap((e) => e.expandedGovernedBy));
  let docs;
  if (declaredGovernance) {
    // exactly the declared set — area docs and pointers do not apply
    docs = new Set(expandedGovernedBy);
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
    declaredEntryPaths: declaredMatches.map((e) => e.path),
    rawGovernedBy: [...new Set(declaredMatches.flatMap((e) => e.rawGovernedBy))],
    expandedGovernedBy: [...expandedGovernedBy],
    repoWide: compiled.repoWideDocs.has(file),
    unassigned: compiled.unassigned.some((e) => matches(e.matchers, file)),
    pointerTargets,
  };
}

/**
 * Format what the map knows about one file, as the `--explain` mode prints it:
 * the areas that own it, the docs that govern it, the partitioned tree that
 * claims it (with the reason its files declare one by one), whether a
 * declaration answers for it (and if so which entry, what that entry states,
 * and the doc set it expands to), its repo-wide and exception membership, and
 * the doc pointers its content names. A path the tree does not carry is
 * reported as untracked — the map resolves against tracked files, so nothing is
 * guessed for it.
 *
 * The mode answers only what the map answers. A file in a partitioned tree that
 * declares nothing has no governing set yet — the docs its areas supply are not
 * it, which is the same reading `auditMap` reds it under — so the report states
 * the declaration it owes instead. A file that is itself a repo-wide doc is
 * reported as one wherever its own governing set would otherwise read as an
 * unqualified absence.
 * @param {object} opts
 * @param {string} opts.file repo-relative path
 * @param {ReturnType<typeof compileMap>} opts.compiled
 * @param {boolean} opts.tracked whether git tracks the path
 * @param {string | null} [opts.content] file content for pointer scanning
 * @returns {string} the report, one fact per line
 */
export function explainFile({ file, compiled, tracked, content = null }) {
  if (!tracked) {
    return (
      `${file}\n` +
      `  untracked — ${MAP_PATH} resolves against the tracked tree, so nothing is stated for this path.`
    );
  }
  const r = resolveFile(file, compiled, content);
  const list = (values) => (values.length ? values.join(', ') : 'none');
  const matchedPartitions = compiled.partitions.filter((p) => matches(p.matchers, file));
  const owesDeclaration = matchedPartitions.length > 0 && !r.declaredGovernance;
  const lines = [file, `  areas: ${list(r.areas)}`];
  lines.push(
    owesDeclaration
      ? `  governing docs: not stated — this file owes its own declaration (below)`
      : `  governing docs: ${list(r.docs)}` +
          (r.repoWide ? ' (and it is itself a repo-wide doc — below)' : ''),
  );
  if (matchedPartitions.length) {
    lines.push(
      `  in a partitioned tree: ` +
        matchedPartitions.map((p) => `"${p.pattern}": ${p.reason}`).join(' | '),
    );
  }
  if (r.declaredGovernance) {
    lines.push(
      `  declared by: ${list(r.declaredEntryPaths)}`,
      `    governed-by as written: ${list(r.rawGovernedBy)}`,
      `    expanded doc set: ${list(r.expandedGovernedBy)}`,
    );
  } else if (owesDeclaration) {
    lines.push(
      `  declared by: no entry — every file in a partitioned tree states its own subject, so this` +
        ` one owes a "declared-governance" entry naming its governing set; what its areas supply` +
        ` is not that set.`,
    );
  } else {
    lines.push(`  declared by: no entry — the docs above are what its areas supply`);
  }
  lines.push(
    `  repo-wide doc: ${
      r.repoWide
        ? 'yes — a repo-wide doc governs every area, and editing it puts it in its own disposition scope'
        : 'no'
    }`,
    `  unassigned exception: ${r.unassigned ? 'yes' : 'no'}`,
    `  doc pointers: ${list(r.pointerTargets)}`,
  );
  return lines.join('\n');
}

/**
 * How many files one entry's red names before counting the rest — minted for a
 * straddling declaration's two sides, and the cap every red here that names
 * files of a single entry takes, so a wide entry states which files answered for
 * it without printing a wall that grows with the tree.
 */
export const FILE_SAMPLE = 3;

/** `a, b, c and 4 more` — one side's kept files, with the rest counted. */
const sample = (kept, total) =>
  kept.join(', ') + (total > kept.length ? ` and ${total - kept.length} more` : '');

/**
 * The map as it reads with one area deleted, with every `area:<name>` reference
 * to that area inlined to the docs it stands for first. Inlining is what makes
 * the deletion answerable: a reference names an area, so deleting a referenced
 * area would otherwise be refused as a broken reference before anything about
 * what it supplies could be asked, and the question here is what its doc set
 * supplies rather than whether some declaration spells its name.
 * @param {any} map parsed area-map.json
 * @param {string} name the area to delete
 * @returns {any} the same map without that area
 */
function withoutArea(map, name) {
  const inlined = map.areas[name]?.docs ?? [];
  const areas = { ...map.areas };
  delete areas[name];
  return {
    ...map,
    areas,
    'declared-governance': (map['declared-governance'] ?? []).map((e) => ({
      ...e,
      'governed-by': [
        ...new Set(
          (e['governed-by'] ?? []).flatMap((el) => (areaRefName(el) === name ? inlined : [el])),
        ),
      ],
    })),
  };
}

/**
 * (g) The areas that supply what the rest of the map already supplies: an area
 * is deleted, the map recompiled, and every tracked file resolved again against
 * it. An area whose deletion leaves every file governed by exactly the same docs
 * — and leaves no file that was owned unowned, since coverage the rest of the
 * map does not supply is a contribution of its own — makes no contribution the
 * rest of the map does not already make. Each area is judged on its own against
 * the rest of the map, never as a set: areas that supply the same docs each
 * answer for the others, so each is named and each removal is a new question the
 * next run answers.
 * An area whose deletion leaves the map unreadable (no areas at all) supplies
 * that readability, which is what the shape refusal here records; any other
 * error leaves as it arrived, since only the shape refusal answers a question
 * this leg asked.
 * @param {object} opts
 * @param {string[]} opts.files all git-tracked repo-relative paths
 * @param {any} opts.map parsed area-map.json (already shape-valid)
 * @param {ReturnType<typeof compileMap>} opts.compiled the same map, compiled
 * @param {(f: string) => (string | null)} opts.contentOf file content, for pointer resolution
 * @returns {string[]} the redundant area names, in the order the map states them
 */
function redundantAreaNames({ files, map, compiled, contentOf }) {
  const before = new Map(
    files.map((f) => {
      const r = resolveFile(f, compiled, contentOf(f));
      return [f, { docs: new Set(r.docs), owned: r.areas.length > 0 }];
    }),
  );
  const redundant = [];
  for (const name of Object.keys(map.areas)) {
    let trimmed;
    try {
      trimmed = compileMap(withoutArea(map, name));
    } catch (err) {
      // The map not being readable without the area is this leg's answer: the
      // area supplies that readability, so it is necessary. Anything else is
      // not an answer to the question asked here and leaves as it arrived.
      if (err?.name !== SHAPE_ERROR_NAME) throw err;
      continue;
    }
    const changes = files.some((f) => {
      const was = before.get(f);
      const now = resolveFile(f, trimmed, contentOf(f));
      if (was.owned && now.areas.length === 0) return true;
      return now.docs.length !== was.docs.size || now.docs.some((d) => !was.docs.has(d));
    });
    if (!changes) redundant.push(name);
  }
  return redundant;
}

/**
 * Pure core: audit the map against the tracked-file universe.
 * @param {object} opts
 * @param {string[]} opts.files all git-tracked repo-relative paths
 * @param {any} opts.map parsed area-map.json
 * @param {(f: string) => (string | null)} opts.readFile content reader (null if unreadable);
 *   consulted for the files whose `// see docs/…` pointers can decide a resolution — those
 *   that would otherwise resolve to no area, those a declaration answers for, and, for the
 *   area-necessity leg, the tracked set it resolves twice. Each file is read at most once.
 * @returns {{
 *   shapeErrors: string[], zeroArea: string[],
 *   stalePatterns: string[], untrackedEntries: string[],
 *   uncoveredDocs: string[], staleUnassigned: string[],
 *   unnecessaryUnassigned: string[], unnecessaryUnassignedFiles: string[],
 *   badPointers: string[],
 *   staleGovernance: string[], redundantGovernance: string[],
 *   redundantGovernanceFiles: string[], redundantAreas: string[],
 *   conflictingGovernance: string[], crossGovernedDeclaration: string[],
 *   badGovernedBy: string[], undeclaredInPartition: string[],
 *   stalePartitions: string[], overlappingPartitions: string[],
 *   straddlingGovernance: string[], deadAlternatives: string[]
 * }}
 */
export function auditMap({ files, map, readFile }) {
  const empty = {
    shapeErrors: [],
    zeroArea: [],
    stalePatterns: [],
    deadAlternatives: [],
    untrackedEntries: [],
    uncoveredDocs: [],
    staleUnassigned: [],
    unnecessaryUnassigned: [],
    unnecessaryUnassignedFiles: [],
    badPointers: [],
    staleGovernance: [],
    redundantGovernance: [],
    redundantGovernanceFiles: [],
    redundantAreas: [],
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
  // Content is read through one cache: several legs ask the same file for its
  // `// see docs/…` pointers, and the area-necessity leg resolves the tracked
  // set once per area, so a file is read at most once however often it is asked.
  const contents = new Map();
  const contentOf = (f) => {
    if (!contents.has(f)) contents.set(f, readFile(f));
    return contents.get(f);
  };

  // (b) staleness, one leg over every pattern-bearing entry the map states.
  // An alternative that matches nothing beside siblings that still match is a
  // red about the ALTERNATIVE — its own condition, its own fix — and does not
  // double-fire the whole-entry red. An entry with no live alternative left is
  // dead as a whole: the `unassigned` and `declared-governance` lists report
  // that through the per-entry accounting further down (which walks the same
  // files anyway), so the area code patterns and the `governance-partitions`
  // trees report it here.
  for (const site of patternEntries(compiled)) {
    const dead = site.matchers.filter((m) => !files.some((f) => m.regex.test(f)));
    if (dead.length === 0) continue;
    if (dead.length < site.matchers.length) {
      for (const m of dead) {
        result.deadAlternatives.push(
          `${site.subject} — alternative "${m.alternative}" matches no tracked file`,
        );
      }
      continue;
    }
    recordDeadEntry(site, result);
  }
  for (const [name, area] of Object.entries(map.areas)) {
    for (const d of [...(area.docs ?? []), ...(area['source-of-truth'] ?? [])]) {
      if (!tracked.has(d)) result.untrackedEntries.push(`area "${name}": ${d}`);
    }
  }
  for (const d of map['repo-wide'].docs) {
    if (!tracked.has(d)) result.untrackedEntries.push(`repo-wide: ${d}`);
  }

  // (a) coverage + (c) doc-coverage + (d) unassigned self-check. Each entry
  // keeps the files it covered that the tree does not need it for, so necessity
  // can be answered per file when the entry as a whole is still needed.
  const unassignedHits = new Map(
    map.unassigned.map((e) => [e.path, { total: 0, needed: 0, inert: 0, inertSample: [] }]),
  );
  const isUnassigned = (f) => compiled.unassigned.some((e) => matches(e.matchers, f));
  // declared-governance self-check: per entry, does it change any matched file's governing set?
  // Each side of a partition boundary also keeps the first few files it matched,
  // so a straddling entry's red can name them without retaining (or printing) a
  // file list that grows with the tree.
  // Each entry also keeps the eligible files it states nothing new for, so
  // equality can be answered per file when the entry as a whole still states
  // something.
  const govAcc = compiled.declaredGovernance.map((e) => ({
    e,
    total: 0,
    eligible: 0,
    allEqual: true,
    equal: 0,
    equalSample: [],
    inPartition: 0,
    outsidePartition: 0,
    insideSample: [],
    outsideSample: [],
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
      const content = contentOf(file);
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
        if (matches(e.matchers, file)) {
          const hit = unassignedHits.get(e.path);
          hit.total++;
          if (redWithoutException) hit.needed++;
          else {
            hit.inert++;
            if (hit.inertSample.length < FILE_SAMPLE) hit.inertSample.push(file);
          }
        }
      }
    }
    if (failsCoverage && !bare.unassigned) result.zeroArea.push(file);

    // (f) governance partitions: inside a partitioned tree every file declares
    // its own governance, so an undeclared one is a red naming what to add —
    // and naming the tree that claims it with the reason that tree declares file
    // by file, which is the answer the author tripping it needs.
    const matchedPartitions = compiled.partitions.filter((p) => matches(p.matchers, file));
    const inPartition = matchedPartitions.length > 0;
    if (inPartition && !bare.declaredGovernance) {
      result.undeclaredInPartition.push(
        `${file} — in the partitioned tree ` +
          matchedPartitions.map((p) => `"${p.pattern}": ${p.reason}`).join(' | '),
      );
    }
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
      const conflicted = bare.declaredEntryPaths.length >= 2;
      if (conflicted) result.conflictingGovernance.push(file);
      let crossGoverned = bare.repoWide;
      if (!crossGoverned) {
        // Read content only to enforce single-source; this runs no pointer validation, so a
        // declared file's dead `// see` fixture strings (targets in no doc set) stay inert.
        const content = contentOf(file);
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
        if (!matches(acc.e.matchers, file)) continue;
        acc.total++;
        if (inPartition) {
          acc.inPartition++;
          if (acc.insideSample.length < FILE_SAMPLE) acc.insideSample.push(file);
        } else {
          acc.outsidePartition++;
          if (acc.outsideSample.length < FILE_SAMPLE) acc.outsideSample.push(file);
        }
        if (eligible) {
          acc.eligible++;
          const gb = new Set(acc.e.expandedGovernedBy);
          const equal = gb.size === areaSupplied.size && [...gb].every((d) => areaSupplied.has(d));
          if (equal) {
            acc.equal++;
            if (acc.equalSample.length < FILE_SAMPLE) acc.equalSample.push(file);
          } else acc.allEqual = false;
        }
      }
    }
  }
  // A declaration earns its keep by changing the governing set of some eligible matched file.
  for (const acc of govAcc) {
    // An entry reaching across a partition boundary is read under both sides'
    // rules at once, so it is refused and split at the boundary — the red naming
    // the files it matched on each side, which is what the split is made along.
    // The refusal displaces the redundancy red specifically: the entry is left
    // out of the redundancy accounting, whose own remedy — remove the entry —
    // would contradict the split. Every other red still applies to it.
    const straddling = acc.inPartition > 0 && acc.outsidePartition > 0;
    if (straddling) {
      result.straddlingGovernance.push(
        `${acc.e.path} — inside a partitioned tree: ${sample(acc.insideSample, acc.inPartition)};` +
          ` outside every partition: ${sample(acc.outsideSample, acc.outsidePartition)}`,
      );
    }
    // An entry declaring the empty set states that absence itself, and a
    // straddling one is answered by the refusal above, so neither is read for
    // equality. What is left is accounted per file: equal for every file the
    // entry answers for is the entry's own red, equal for some of them is a red
    // on those files — one condition each, so the two never double-fire. The
    // files come out under the entry that declares them, sampled, so one wide
    // entry is one line however many files it reaches.
    const accountable = !straddling && acc.e.expandedGovernedBy.length > 0;
    if (acc.total === 0) {
      result.staleGovernance.push(acc.e.path);
    } else if (accountable && acc.eligible >= 1 && acc.allEqual) {
      result.redundantGovernance.push(acc.e.path);
    } else if (accountable && acc.equal > 0) {
      result.redundantGovernanceFiles.push(
        `${sample(acc.equalSample, acc.equal)} — declared by "declared-governance" entry "${acc.e.path}"`,
      );
    }
  }
  // badGovernedBy — a per-entry check on the RAW declared elements, independent of
  // matched files. Literal targets are validated here; an `area:<name>` reference
  // is validated as an area name by validateShape, and the docs it expands to are
  // validated by that area's own doc entries.
  for (const e of compiled.declaredGovernance) {
    for (const doc of e.rawGovernedBy) {
      if (areaRefName(doc) !== null) continue;
      if (!tracked.has(doc)) {
        result.badGovernedBy.push(`${e.path}: ${doc} (untracked)`);
      } else if (!compiled.docSets.has(doc) && !compiled.repoWideDocs.has(doc)) {
        result.badGovernedBy.push(`${e.path}: ${doc} (in no area's doc set nor repo-wide)`);
      }
    }
  }
  // Necessity per file: an entry no covered file needs is the entry's own red,
  // and an entry the tree still needs is read file by file for the ones it
  // covers that resolve anyway — one condition each, so the two never
  // double-fire. The files come out under the entry that covers them, sampled,
  // so one wide entry is one line however many files it reaches.
  for (const [path, { total, needed, inert, inertSample }] of unassignedHits) {
    if (total === 0) {
      result.staleUnassigned.push(path);
    } else if (needed === 0) {
      result.unnecessaryUnassigned.push(path);
    } else if (inert > 0) {
      result.unnecessaryUnassignedFiles.push(
        `${sample(inertSample, inert)} — covered by "unassigned" entry "${path}"`,
      );
    }
  }

  result.redundantAreas = redundantAreaNames({ files, map, compiled, contentOf });

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
 * map from disk, then prints; the shape/coverage/staleness/doc-coverage, the
 * declared-governance self-check, the area-necessity leg, the per-file
 * explanation, the read that turns the committed file into the map, and the
 * refusal it prints for a file it cannot read as that map it delegates to
 * (validateShape, compileMap, resolveFile, auditMap, explainFile, loadMap,
 * refuseOnShapeError) are unit-tested above. */
function run() {
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  let map;
  try {
    map = loadMap();
  } catch (err) {
    // A file this check cannot read as the map it guards — one it cannot read at
    // all, or text that is not JSON — is breakage on its own input, printed as
    // the refusal states it on the ordinary red path, never a stack trace.
    refuseOnShapeError(err);
  }
  const readFile = (f) => {
    try {
      return readFileSync(f, 'utf8');
    } catch {
      return null;
    }
  };

  const args = process.argv.slice(2);
  const explainAt = args.indexOf('--explain');
  // The full audit is what a bare invocation asks for, so an argument opening
  // with `--` that is not the one flag this check has — a mistyped `--explain`,
  // say — is answered as the typo it is rather than running the audit silently.
  // A repo-relative path never opens that way, so the flag's own value is held
  // to the same rule.
  const unknownFlags = args.filter((a, i) => i !== explainAt && a.startsWith('--'));
  if (unknownFlags.length) {
    console.error(
      `✗ unrecognized argument(s): ${unknownFlags.join(' ')}\n` +
        `  usage: node scripts/check-area-map.js [--explain <path>]`,
    );
    process.exit(1);
  }
  if (explainAt !== -1) {
    const target = args[explainAt + 1];
    if (!target) {
      console.error(`✗ --explain takes one repo-relative path, e.g. --explain ${MAP_PATH}`);
      process.exit(1);
    }
    let compiled;
    try {
      compiled = compileMap(map);
    } catch (err) {
      // A map that no longer fits the shape this check reads it through is a
      // refusal on its own input, printed as the refusal states it on the
      // ordinary red path — never a stack trace.
      refuseOnShapeError(err);
    }
    console.log(
      explainFile({
        file: target,
        compiled,
        tracked: files.includes(target),
        content: readFile(target),
      }),
    );
    return;
  }

  const r = auditMap({ files, map, readFile });
  const problems = [];
  if (r.shapeErrors.length) problems.push(shapeVerdict(r.shapeErrors));
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
  if (r.deadAlternatives.length) {
    problems.push(
      `✗ ${r.deadAlternatives.length} brace alternative(s) in ${MAP_PATH} match no tracked file,\n` +
        `  in entries whose other alternatives still do:\n` +
        r.deadAlternatives.map((s) => `    ${s}`).join('\n') +
        `\n\n  Fix: rewrite the entry so every alternative it expands to matches the tree. With one\n` +
        `  brace group that is updating or removing the named alternative; with several the\n` +
        `  alternatives are the groups' cross product, so the dead one need not appear in the\n` +
        `  entry as written. The rest of the entry still describes the tree, so the entry stays.`,
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
  if (r.unnecessaryUnassignedFiles.length) {
    problems.push(
      `✗ ${r.unnecessaryUnassignedFiles.length} "unassigned" entr(ies) cover file(s) the tree does not need them for, beside files it does — each file named already resolves to an area (and a doc is already doc-placed); each entry names up to ${FILE_SAMPLE} of them, with any remainder counted:\n` +
        r.unnecessaryUnassignedFiles.map((s) => `    ${s}`).join('\n') +
        `\n\n  Fix: narrow each named entry so it covers only the files that need it — the exception\n` +
        `  stays for those — then re-run; each run names the next files that entry still covers\n` +
        `  unnecessarily, until none is left. An entry is answered for file by file, so what it\n` +
        `  spells (one path, a brace alternation, a wide pattern) does not decide which files it\n` +
        `  is needed for.`,
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
  if (r.redundantGovernanceFiles.length) {
    problems.push(
      `✗ ${r.redundantGovernanceFiles.length} "declared-governance" entr(ies) state nothing new for file(s) they declare, beside files they do state something for — each file named has a covering area already supplying exactly the declared docs; each entry names up to ${FILE_SAMPLE} of them, with any remainder counted:\n` +
        r.redundantGovernanceFiles.map((s) => `    ${s}`).join('\n') +
        `\n\n  Fix: split each named entry so it declares only the files whose governing set it\n` +
        `  changes; the files above take what their areas supply — then re-run; each run names\n` +
        `  the next files that entry still states nothing new for, until none is left. Equality\n` +
        `  is answered file by file, so an entry covering a family answers for each file in that\n` +
        `  family.`,
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
        `  (each matches files inside a partitioned tree and files outside every partition; each\n` +
        `  side names up to ${FILE_SAMPLE} of the files it matched, with any remainder counted):\n` +
        r.straddlingGovernance.map((s) => `    ${s}`).join('\n') +
        `\n\n  Fix: split each entry at the boundary — one entry for the files inside the partitioned\n` +
        `  tree, one for the files outside it — so each side is read under the rule that applies to\n` +
        `  it: inside a partitioned tree a declaration equal to the covering areas' own set is the\n` +
        `  honest statement and stays green, while outside one the same set states nothing new.`,
    );
  }

  if (r.redundantAreas.length) {
    problems.push(
      `✗ ${r.redundantAreas.length} area(s) supply what the rest of the map already supplies — with the area deleted (and every "area:<name>" reference to it inlined to the docs it stands for), every file it reached still resolves to an area, governed by exactly the same docs:\n` +
        r.redundantAreas.map((s) => `    ${s}`).join('\n') +
        `\n\n  Fix: remove ONE of the areas above, or give it the docs or code that make it supply\n` +
        `  something the rest of the map does not — then re-run. Each was judged on its own\n` +
        `  against the rest of the map, so these are alternatives rather than a set to remove\n` +
        `  together: areas that supply the same docs each answer for the others, and each\n` +
        `  removal is a new question the next run answers. An area is the unit a contributor\n` +
        `  loads, so one whose every contribution the rest of the map already makes adds a\n` +
        `  name without adding governance.`,
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
