/**
 * check-clause-preamble.js — admission test for the clause-bearing documents'
 * shared preamble and for the requirement-keyword convention that preamble
 * states. Two legs over one register — the documents `docs/clause-registry.json`
 * names in its `prefixes` map, so a document joins both legs the moment it
 * mints a prefix:
 *
 *   1. preamble parity — each registered document states the canonical
 *      preamble held here as one constant. The two per-document variables are
 *      COMPUTED, never authored: the prefix token the map already carries, and
 *      the relative link from the document to the registry. Comparison is
 *      whitespace-collapsed, so rewrapping a paragraph never reds, and the
 *      paragraph is located STRUCTURALLY — the one paragraph making the
 *      identifier claim — so a preamble split across paragraphs, or truncated
 *      part-way, reds rather than passing on a substring. The session-format
 *      (SF) and scripted-truth-corpus (STC) documents open the preamble with a
 *      qualifier ("Each rule this document makes in its own right…") because
 *      they also restate rules other artifacts own;
 *      those are a registered per-document map with reasons ({@link
 *      QUALIFIED_OPENING_DOCS}), never a loosened comparison.
 *   2. keyword convention — the preamble states that keywords appear on a
 *      clause's operative requirement. This leg holds the clause-bearing
 *      documents to it: inside a clause's scope (its marker to the next
 *      marker or heading — the doctrine's own rule, via the shared {@link
 *      extractClauseSection}), the lowercase spellings `must`, `should`, and
 *      `may` are red unless the sentence carrying one is allowlisted below
 *      with the reason it is not an operative requirement. Code spans and
 *      fenced blocks are masked before the scan, so a lowercase keyword inside
 *      `code` or an example never reds — and a clause leaving a code span open
 *      is itself red, because the mask would otherwise swallow prose and could
 *      hide a keyword inside it.
 *
 * Which surface this guards, next to its neighbour: this check matches the
 * lowercase requirement spellings inside DOCUMENT clause text, where an
 * unintended lowercase keyword hides an operative requirement; the clause
 * registry's own check refuses the full uppercase RFC 2119 set inside REGISTRY
 * ROW text, where a keyword would state a requirement the row has no standing
 * to make. Two surfaces, two guards, deliberately narrow on that one axis
 * each — neither is the general RFC 2119 linter, and neither reads the other's
 * subject.
 *
 * The allowlist is a negative list, so it carries its own admission test: an
 * entry whose fragment no longer appears in its clause is red, an entry whose
 * fragment appears more than once is red (an anchor that names two places
 * anchors neither), and an entry whose fragment carries no lowercase keyword
 * is red — every entry must be load-bearing, so removing a live one reds and
 * keeping a dead one reds too. Fragments are matched whitespace-flattened, so
 * rewrapping an allowlisted sentence keeps it green.
 *
 * Every register must be non-empty and every registered document readable and
 * anchored: an empty prefixes map, a document that will not read, or a
 * registered clause whose marker this check cannot find is machinery breakage
 * (exit 2), never a silently empty pass. Drift is exit 1.
 *
 * Honest limits: this reads the preamble paragraph and the clause scopes, never
 * the rest of a document — prose outside a clause's scope carries no keyword
 * rule and is unscanned. Whether an uppercase keyword is the RIGHT force for
 * its sentence, and whether an allowlisted sentence's recorded reason is
 * adequate, are review judgments this check does not make; it holds only that
 * a lowercase spelling inside a clause has been looked at and reasoned about.
 * The keyword shapes are the spellings named above — a requirement written as
 * `required`, `shall`, or `recommended` is outside this leg. A title-case
 * spelling (`Must`, `Should`, `May`) is outside it too, and outside the
 * registry check's uppercase guard as well, so it is the one shape neither
 * surface reads: the regex stays case-sensitive deliberately, because a
 * sentence-initial `Must` or `May` is ordinary capitalization far more often
 * than a keyword, and matching it would red sentences for where they start
 * rather than for what they require. What the mask covers is code spans and
 * fences and nothing else, so one of those spellings inside a link target
 * would red as prose does; and the span shape it reads is the single-backtick
 * one, so the interior of a double-backtick span is scanned as prose rather
 * than masked. Both of those are the conservative direction — a false red,
 * never a false green — and an allowlist entry records it if it ever happens.
 * A keyword written against a hyphen is unread for a different reason: the
 * shapes are word-bounded against `-` as well, so a coinage of that shape —
 * the every-entry-must-apply naming, which sits in STC-21's text for a rule
 * that is STC-5's, and whose operative sentence states its MUST in uppercase
 * at STC-5 — surfaces neither way: not a false red, not a false green, simply
 * outside what this leg reads, and recorded here as the limit it is.
 *
 * Usage:
 *   node scripts/check-clause-preamble.js   # or: npm run lint:clause-preamble
 */

import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractClauseSection, stripFences } from './check-test-inventory.js';

/** Repo-relative path of the registry whose `prefixes` map is the register. */
export const REGISTRY_PATH = 'docs/clause-registry.json';

/**
 * The structural anchor the preamble paragraph is located by: the identifier
 * claim every carrier makes, in both opening forms.
 */
export const PREAMBLE_ANCHOR = 'carries a stable identifier';

/** The two openings a carrier may use, keyed by the registration below. */
export const PREAMBLE_OPENINGS = {
  standard: 'Each rule carries a stable identifier',
  qualified: 'Each rule this document makes in its own right carries a stable identifier',
};

/**
 * The documents that open the preamble with the qualifier, each with the
 * reason it is not the standard opening. A document reaches the qualified form
 * by being registered here — never by a looser comparison — so adopting the
 * qualifier is a recorded decision rather than a silently accepted variant.
 */
export const QUALIFIED_OPENING_DOCS = {
  'docs/technical/session-format.md':
    'Orientation prose for a format the per-platform JSON Schemas define: most of what this document states is the schemas talking, so the qualifier separates the rules it makes on its own authority from the ones it restates.',
  'docs/verification/scripted-truth-corpus.md':
    'The corpus document describes committed artifacts — sessions, truth files, vectors, and the locks over them — alongside the rules it states itself, so the qualifier separates its own rules from the contracts those artifacts carry.',
};

/**
 * The canonical preamble, hand-wrapped here for reading and compared
 * whitespace-collapsed. `{OPENING}` is chosen by the registration above;
 * `{PREFIX}` and `{REGISTRY_LINK}` are computed per document from the registry
 * itself, so neither can be authored wrong in a carrier without reding.
 */
export const CANONICAL_PREAMBLE = `{OPENING} (**{PREFIX}-n**) so other documents,
reviews, and checks can cite it precisely. Identifiers are never renumbered; a
retired identifier stays reserved and is never reused. How each rule is
verified — by an existing named check, by a check that could be built, or by
judgment — is recorded per rule in the [clause registry]({REGISTRY_LINK}). The
key words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as described in
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119). Keywords appear on a
clause's operative requirement where it has one; definitional clauses bind as
stated without a keyword, and subsidiary absolutes inside a clause inherit its
force. A clause's scope runs from its marker to the next marker or heading;
identifiers reflect minting order and can appear out of numeric sequence.`;

/** The lowercase requirement spellings this check matches inside a clause. */
export const KEYWORD_RE = /(?<![A-Za-z0-9_-])(must|should|may)(?![A-Za-z0-9_-])/g;

/**
 * The sentences inside a clause scope that carry a lowercase requirement
 * spelling and are not operative requirements. Each entry names its document,
 * its clause, a whitespace-flattened fragment identifying the sentence, and the
 * reason that sentence states no requirement of its own. The reason is the
 * entry's substance: it is what a reviewer reads, and what a later change has
 * to still be true of.
 *
 * The test these entries apply, in four parts: a rule that stands on its own
 * takes its keyword; a subsidiary absolute, or a bullet of a definitional
 * list, inherits the force of the clause it sits inside; a bound on what a
 * clause already permits — or a note on how the specification evolves — grants
 * nothing; and a sentence that DESCRIBES rather than requires — an observed
 * fact, a rationale, a cross-reference, a restrictive relative clause, a
 * clause's own title — states no requirement for a keyword to carry.
 */
export const KEYWORD_ALLOWLIST = [
  {
    doc: 'docs/technical/locator-resolution.md',
    clause: 'LR-9',
    fragment: 'Future volatility metadata may further tighten eligibility',
    reason:
      'A parenthetical note about metadata the format does not yet carry. It forecasts a possible future tightening rather than permitting anything today; the clause states its own requirement in the preceding sentence.',
  },
  {
    doc: 'docs/technical/session-format.md',
    clause: 'SF-1',
    fragment: 'What a recording must be sufficient _for_ is defined by the',
    reason:
      'A cross-reference naming the replay-sufficiency guarantee by its subject ("what a recording must be sufficient for"). The obligation belongs to that document; this sentence points at it.',
  },
  {
    doc: 'docs/technical/session-format.md',
    clause: 'SF-2',
    fragment: 'changes what a consumer may rely on',
    reason:
      'A parenthetical explaining why a required-status change is a major change. It describes the consequence for a consumer, and grants that consumer nothing.',
  },
  {
    doc: 'docs/technical/session-format.md',
    clause: 'SF-10',
    fragment: 'a version that can be read later must be as well-formed as one read today',
    reason:
      "The clause's rationale, stated after its requirement. The preamble's placement convention puts keywords on the operative requirement, and this sentence is the reason for that requirement rather than the requirement itself.",
  },
  {
    doc: 'docs/technical/session-format.md',
    clause: 'SF-11',
    fragment: "the action's effects may already be underway",
    reason:
      'An observed fact about when a worker-built description is measured. It states what the tree can already look like, not a licence any implementation is being granted.',
  },
  {
    doc: 'docs/technical/session-format.md',
    clause: 'SF-14',
    fragment: 'Fields may be **added** in minor versions',
    reason:
      'The registry row for this clause classifies exactly this sentence as a prose gloss it holds by review rather than by the check it cites. The operative requirement of the same sentence is the one it states in uppercase (consumers SHOULD ignore unknown fields); this half tells a reader how the format evolves.',
  },
  {
    doc: 'docs/architecture/application/extension/runtime.md',
    clause: 'ERT-1',
    fragment: 'The correlation signals that must outlive a single worker instance',
    reason:
      'A restrictive relative clause selecting WHICH signals are persisted — those whose lifetime exceeds one worker instance. It identifies a set; the clause states its requirement in its own sentence.',
  },
  {
    doc: 'docs/architecture/application/desktop/windows/capture-principles.md',
    clause: 'DCP-2',
    fragment: 'Events may arrive out-of-order from workers',
    reason:
      'The observed platform condition the rest of the clause is the answer to. Worker delivery order is not something the design permits; it is something it copes with.',
  },
  {
    doc: 'docs/api/sync-protocol.md',
    clause: 'SP-10',
    fragment: 'a concurrent client may overwrite it first',
    reason:
      'A parenthetical giving the reason a push is not proof of agreement. It states what can happen between two clients, and permits no participant anything.',
  },
  {
    doc: 'docs/api/sync-protocol.md',
    clause: 'SP-12',
    fragment: 'a rename of a unit you may have open is a separate, surprising change',
    reason:
      "A parenthetical contrasting the two cases the clause's scoping turns on. It describes the user's possible state — a unit open on screen — rather than granting a permission.",
  },
  {
    doc: 'docs/api/sync-protocol.md',
    clause: 'SP-15',
    fragment: 'a concurrent server change should raise',
    reason:
      'A restrictive relative clause naming the review or conflict the client would otherwise surface. It describes what the cached response suppresses; the clause places its obligation on the client transport.',
  },
  {
    doc: 'docs/api/sync-protocol.md',
    clause: 'SP-15',
    fragment: 'it may legitimately send an `ETag` with no `Cache-Control`',
    reason:
      'Part of the sentence disclaiming any server obligation: a server owes this clause nothing. Uppercasing would read as a permission granted to servers by a protocol clause that deliberately binds only the client.',
  },
  {
    doc: 'docs/verification/scripted-truth-corpus.md',
    clause: 'STC-6',
    fragment: 'at least one such element must exist in the catalogue',
    reason:
      'A bullet of the clause\'s definitional list — it opens "Pages are authored for determinism:" and its bullets bind as stated, keyword-free. This parenthetical states the catalogue-level property the identifier-less-element rule turns on; marking it alone would imply the bullets beside it bind less.',
  },
  {
    doc: 'docs/verification/scripted-truth-corpus.md',
    clause: 'STC-6',
    fragment: 'No two live tabs may share a URL',
    reason:
      'The prohibiting half of a bullet of the same definitional list: the list opens "Pages are authored for determinism:" and its bullets bind as stated, so this one prohibits as stated. Uppercasing it would rank one bullet of the list above its neighbours rather than add force to it, and would part it from the rule it shares a sentence with.',
  },
  {
    doc: 'docs/verification/scripted-truth-corpus.md',
    clause: 'STC-6',
    fragment: 'every navigation must be followed by a readiness wait',
    reason:
      'A bullet of the same definitional list, stating the driver discipline the frame-readiness probe depends on. It binds as stated alongside its neighbours, so uppercasing it would rank one bullet of the list above the rest rather than add force to it.',
  },
  {
    doc: 'docs/verification/scripted-truth-corpus.md',
    clause: 'STC-17',
    fragment: "a vector's `locators` may exceed the captured element",
    reason:
      "A bound rather than a grant: the sentence closes the augmentation to the two harness-measured strategies the clause is about, so uppercasing would read as a permission for a vector's locators to exceed the captured element where the sentence states the limit on it. Read as DI-3 and SP-15 are read — a sentence that bounds or describes is not one the clause hands out.",
  },
  {
    doc: 'docs/verification/scripted-truth-corpus.md',
    clause: 'STC-21',
    fragment: '**Sidecar shape, and what a relaxation may alter.**',
    reason:
      "The clause's bolded title, naming its subject. The clause's operative requirement carries its own keyword in the sentence below the title.",
  },
  {
    doc: 'docs/api/dispatch.md',
    clause: 'DI-3',
    fragment: 'Wrapper fields may be added over time',
    reason:
      "Uppercasing would grant a permission this clause does not have: the clause opens by closing the wrapper to its named fields, and the row cites a shipped test asserting exactly that key set. The sentence describes how the specification evolves, which is the specification's prerogative rather than a sender's. Distinct from the uppercase permissions kept in the corpus document (STC-5, STC-12), which state the operative rule their own clause makes.",
  },
  {
    doc: 'docs/api/dispatch.md',
    clause: 'DI-10',
    fragment: 'a payload that may contain PII',
    reason:
      "A parenthetical describing what a dispatched payload can hold, supporting the prohibition the same sentence states in uppercase. It is the reason for that clause's requirement, not a second requirement.",
  },
  {
    doc: 'docs/verification/sufficiency-lint.md',
    clause: 'SL-1',
    fragment: 'must name a leaf of the schema composition map',
    reason:
      "A subsidiary absolute inside a clause that opens with its own uppercase requirement; by the preamble's own sentence such absolutes inherit the clause's force, so restating it in uppercase would add nothing and imply a second, separable requirement.",
  },
  {
    doc: 'docs/verification/sufficiency-lint.md',
    clause: 'SL-4',
    fragment: 'absence must mean nothing, never a silent false',
    reason:
      "A subsidiary absolute inside the parenthetical that explains one of the malformed-contract cases the clause's own uppercase requirement refuses; it inherits that force per the preamble's definitional-clauses sentence.",
  },
];

/** Machinery breakage — an input this check reads could not be used. */
export class InputError extends Error {}

/**
 * Collapse every whitespace run to one space and trim, so hand wrapping is
 * invisible to every comparison this check makes.
 * @param {string} text
 * @returns {string}
 */
export function flatten(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Blank out inline code spans, preserving length so offsets into the masked
 * text index the original. A lowercase keyword inside `code` is a name, never
 * a requirement.
 * @param {string} flat whitespace-flattened text
 * @returns {string} the same text with code spans replaced by spaces
 */
export function maskCodeSpans(flat) {
  return flat.replace(/`[^`]*`/g, (span) => ' '.repeat(span.length));
}

/**
 * The link a document must use to reach the registry, computed from the two
 * paths rather than authored per document.
 * @param {string} docPath repo-relative path of the carrier
 * @returns {string} the relative link target
 */
export function registryLink(docPath) {
  return posix.relative(posix.dirname(docPath), REGISTRY_PATH);
}

/**
 * The preamble a given carrier must state, with its two variables resolved.
 * @param {string} docPath repo-relative path of the carrier
 * @param {string} prefix the clause prefix the registry maps to it
 * @param {typeof QUALIFIED_OPENING_DOCS} qualified the registered qualifiers
 * @returns {string} the expected preamble, whitespace-flattened
 */
export function expectedPreamble(docPath, prefix, qualified = QUALIFIED_OPENING_DOCS) {
  const opening = docPath in qualified ? PREAMBLE_OPENINGS.qualified : PREAMBLE_OPENINGS.standard;
  return flatten(CANONICAL_PREAMBLE)
    .replace('{OPENING}', opening)
    .replace('{PREFIX}', prefix)
    .replace('{REGISTRY_LINK}', registryLink(docPath));
}

/**
 * Locate the preamble structurally: the one paragraph making the identifier
 * claim, with fenced blocks blanked first so an illustrative preamble inside a
 * fence can neither be read as the real one nor make it ambiguous.
 * @param {string} markdown the document's text
 * @returns {{ paragraph: string } | { problem: string }}
 */
export function locatePreamble(markdown) {
  const paragraphs = stripFences(markdown)
    .split(/\n[ \t]*\n/)
    .filter((p) => p.includes(PREAMBLE_ANCHOR));
  if (paragraphs.length === 0) {
    return { problem: `states no preamble paragraph — none makes the "${PREAMBLE_ANCHOR}" claim` };
  }
  if (paragraphs.length > 1) {
    return {
      problem: `makes the "${PREAMBLE_ANCHOR}" claim in ${paragraphs.length} paragraphs — the preamble must be the one paragraph carrying it`,
    };
  }
  return { paragraph: paragraphs[0] };
}

/**
 * Report the first place two flattened texts part, so a finding names the
 * divergence rather than printing two paragraphs to diff by eye.
 * @param {string} expected
 * @param {string} found
 * @returns {string} a one-line description of where they part
 */
export function describeDivergence(expected, found) {
  let i = 0;
  while (i < expected.length && i < found.length && expected[i] === found[i]) i++;
  const context = expected.slice(Math.max(0, i - 60), i);
  const show = (text) => (i >= text.length ? '<end of paragraph>' : `"${text.slice(i, i + 60)}…"`);
  return `after "…${context}" it states ${show(found)} where the canonical text states ${show(expected)}`;
}

/**
 * Leg 1: every registered document states the canonical preamble.
 * @param {(path: string) => string} readDoc reader, refusing loudly
 * @param {Record<string, string>} prefixes the registry's prefix → doc map
 * @param {typeof QUALIFIED_OPENING_DOCS} qualified the registered qualifiers
 * @returns {string[]} problem lines
 * @throws {InputError} on an empty register
 */
export function auditPreambles(readDoc, prefixes, qualified = QUALIFIED_OPENING_DOCS) {
  const entries = Object.entries(prefixes);
  if (entries.length === 0) {
    throw new InputError(
      `${REGISTRY_PATH} carries an empty \`prefixes\` map — there is no register of clause-bearing documents to hold`,
    );
  }
  const problems = [];
  for (const [prefix, docPath] of entries) {
    const located = locatePreamble(readDoc(docPath));
    if (located.problem) {
      problems.push(`${docPath} ${located.problem}`);
      continue;
    }
    const found = flatten(located.paragraph);
    const expected = expectedPreamble(docPath, prefix, qualified);
    if (found !== expected) {
      problems.push(`${docPath} states a preamble that is not the canonical one: ${describeDivergence(expected, found)}`); // prettier-ignore
    }
  }
  for (const docPath of Object.keys(qualified)) {
    if (!Object.values(prefixes).includes(docPath)) {
      problems.push(`${docPath} is registered as a qualified-opening carrier but is no longer a clause-bearing document — drop the registration`); // prettier-ignore
    }
  }
  return problems;
}

/**
 * Every occurrence of a fragment in a flattened clause text.
 * @param {string} haystack
 * @param {string} needle
 * @returns {number[]} start offsets
 */
function occurrencesOf(haystack, needle) {
  const found = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) {
    found.push(i);
  }
  return found;
}

/**
 * Leg 2: no clause scope carries an unallowlisted lowercase requirement
 * spelling, and every allowlist entry earns its place.
 * @param {(path: string) => string} readDoc reader, refusing loudly
 * @param {{ doc: string, clause: string }[]} clauses the registry's clause rows
 * @param {typeof KEYWORD_ALLOWLIST} allowlist the reasoned exceptions
 * @returns {string[]} problem lines
 * @throws {InputError} on an empty clause list or an unanchored clause
 */
export function auditKeywords(readDoc, clauses, allowlist = KEYWORD_ALLOWLIST) {
  if (clauses.length === 0) {
    throw new InputError(
      `${REGISTRY_PATH} carries no clause rows — there are no clause scopes to scan`,
    );
  }
  const problems = [];
  const registered = new Set(clauses.map(({ doc, clause }) => `${doc}::${clause}`));
  for (const entry of allowlist) {
    if (!registered.has(`${entry.doc}::${entry.clause}`)) {
      problems.push(`allowlist entry ${entry.clause} ("${entry.fragment}") names a clause ${REGISTRY_PATH} does not carry in ${entry.doc}`); // prettier-ignore
    }
  }
  for (const { doc, clause } of clauses) {
    const section = extractClauseSection(readDoc(doc), clause);
    if (section === '') {
      throw new InputError(
        `${doc} carries no \`**${clause}.**\` marker — the registered clause's scope cannot be read`,
      );
    }
    const flat = flatten(section);
    if ((flat.match(/`/g) ?? []).length % 2 === 1) {
      problems.push(`${doc} §${clause}: the clause carries an odd number of backticks — with a code span left open, the mask that keeps \`code\` out of this scan would swallow prose instead, and a lowercase keyword could hide inside it`); // prettier-ignore
      continue;
    }
    const scanned = maskCodeSpans(flat);
    const hits = [...scanned.matchAll(KEYWORD_RE)];
    const covered = [];
    for (const entry of allowlist.filter((e) => e.doc === doc && e.clause === clause)) {
      const at = occurrencesOf(flat, entry.fragment);
      if (at.length === 0) {
        problems.push(`${doc} §${clause}: the allowlisted sentence "${entry.fragment}" is no longer in the clause — a stale entry allows nothing and hides what changed`); // prettier-ignore
        continue;
      }
      if (at.length > 1) {
        problems.push(`${doc} §${clause}: the allowlisted fragment "${entry.fragment}" appears ${at.length} times in the clause — an anchor naming two places anchors neither`); // prettier-ignore
        continue;
      }
      const [start] = at;
      const end = start + entry.fragment.length;
      const inside = hits.filter((hit) => hit.index >= start && hit.index < end);
      if (inside.length === 0) {
        problems.push(`${doc} §${clause}: the allowlisted sentence "${entry.fragment}" carries no lowercase requirement keyword — the entry allows nothing and belongs removed`); // prettier-ignore
        continue;
      }
      covered.push([start, end]);
    }
    for (const hit of hits) {
      if (covered.some(([start, end]) => hit.index >= start && hit.index < end)) continue;
      const from = Math.max(0, hit.index - 70);
      const context = flat.slice(from, Math.min(flat.length, hit.index + 90));
      problems.push(`${doc} §${clause}: lowercase \`${hit[1]}\` inside the clause — "…${context}…". Uppercase it if it states the clause's requirement; allowlist it with the reason it does not`); // prettier-ignore
    }
  }
  return problems;
}

/**
 * Read one tracked file, refusing loudly rather than yielding empty text — an
 * unreadable document is not a document stating nothing.
 * @param {string} path repo-relative path
 * @returns {string}
 * @throws {InputError} naming the file and the underlying read error
 */
export function readTreeFile(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new InputError(`${path} could not be read — ${error.message}`);
  }
}

/**
 * Parse the registry, refusing anything that is not the shape both legs read.
 * @param {(path: string) => string} readDoc reader, refusing loudly
 * @returns {{ prefixes: Record<string, string>, clauses: { doc: string, clause: string }[] }}
 * @throws {InputError} when the registry will not parse or is misshapen
 */
export function readRegistry(readDoc) {
  const raw = readDoc(REGISTRY_PATH);
  let registry;
  try {
    registry = JSON.parse(raw);
  } catch (error) {
    throw new InputError(`${REGISTRY_PATH} is not parseable JSON — ${error.message}`);
  }
  const prefixes = registry?.prefixes;
  if (!prefixes || typeof prefixes !== 'object' || Array.isArray(prefixes)) {
    throw new InputError(`${REGISTRY_PATH} carries no \`prefixes\` object`);
  }
  for (const [prefix, docPath] of Object.entries(prefixes)) {
    if (typeof docPath !== 'string' || docPath === '') {
      throw new InputError(`${REGISTRY_PATH} maps prefix \`${prefix}\` to no document path`);
    }
  }
  if (!Array.isArray(registry.clauses)) {
    throw new InputError(`${REGISTRY_PATH} carries no \`clauses\` array`);
  }
  registry.clauses.forEach((row, i) => {
    if (typeof row?.doc !== 'string' || typeof row?.clause !== 'string') {
      throw new InputError(`${REGISTRY_PATH} row \`clauses[${i}]\` carries no \`doc\`/\`clause\` pair`); // prettier-ignore
    }
  });
  return { prefixes, clauses: registry.clauses };
}

/**
 * Both legs over the tree.
 * @param {(path: string) => string} readDoc reader, refusing loudly
 * @returns {{ problems: string[], docCount: number, clauseCount: number }}
 */
export function auditTree(readDoc) {
  const { prefixes, clauses } = readRegistry(readDoc);
  return {
    problems: [...auditPreambles(readDoc, prefixes), ...auditKeywords(readDoc, clauses)],
    docCount: Object.keys(prefixes).length,
    clauseCount: clauses.length,
  };
}

/* c8 ignore start — the CLI wrapper drives the audit above and formats the
   verdict; the located, computed, and evaluated cores are unit-tested, and the
   wrapper's exit codes are pinned at the process boundary by the spawned-CLI
   cases in packages/shared/tests/unit. */
function run() {
  let audit;
  try {
    audit = auditTree(readTreeFile);
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    console.error(
      `✗ an input this check reads could not be used:\n` +
        `    ${error.message}\n\n` +
        `  This is machinery breakage, not a preamble that drifted — fix the file named\n` +
        `  above. Exit 2 keeps it distinct from the drift verdict (exit 1).\n`,
    );
    process.exit(2);
  }
  const { problems, docCount, clauseCount } = audit;

  if (problems.length) {
    console.error(
      `✗ the clause-bearing documents drifted from the preamble they share:\n` +
        problems.map((p) => `    ${p}`).join('\n') +
        `\n\n  The canonical preamble is one constant in this script (CANONICAL_PREAMBLE); each\n` +
        `  carrier's prefix token and registry link are computed from ${REGISTRY_PATH},\n` +
        `  so a carrier states the text and nothing else. A lowercase requirement keyword\n` +
        `  inside a clause is either the clause's own requirement — uppercase it — or it is\n` +
        `  not, and takes a KEYWORD_ALLOWLIST entry recording why.\n`,
    );
    process.exit(1);
  }
  console.log(
    `✓ clause preambles canonical: ${docCount} clause-bearing document(s) state the one ` +
      `preamble, and ${clauseCount} clause scope(s) carry no lowercase requirement keyword ` +
      `outside the ${KEYWORD_ALLOWLIST.length} reasoned allowlist entr(ies).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
/* c8 ignore stop */
