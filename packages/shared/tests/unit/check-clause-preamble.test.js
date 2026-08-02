/**
 * check-clause-preamble.test.js — Unit tests for the clause-preamble admission
 * test (scripts/check-clause-preamble.js). Both legs are guards over committed
 * prose, so every red path has to fail loud: these prove the structural
 * paragraph location (missing, split, duplicated, fenced), the computed
 * per-document variables at every link depth and in both opening forms, the
 * whitespace-collapsed comparison, the keyword scan's masking of code spans and
 * fences, the allowlist's own admission tests (stale, ambiguous, keyword-free,
 * unregistered), and the vacuity refusals. Locks over the shipped material
 * close it: the committed tree satisfies both legs, every shipped allowlist
 * entry is load-bearing — removing any one of them reds — and every entry
 * carries a reason and an anchor a reviewer can weigh.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  REGISTRY_PATH,
  PREAMBLE_ANCHOR,
  PREAMBLE_OPENINGS,
  QUALIFIED_OPENING_DOCS,
  CANONICAL_PREAMBLE,
  KEYWORD_RE,
  KEYWORD_ALLOWLIST,
  InputError,
  flatten,
  maskCodeSpans,
  registryLink,
  expectedPreamble,
  locatePreamble,
  describeDivergence,
  auditPreambles,
  auditKeywords,
  readTreeFile,
  readRegistry,
  auditTree,
} from '../../../../scripts/check-clause-preamble.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');

/** A reader over a plain path → text map, refusing an unregistered path. */
function readerFor(files) {
  return (path) => {
    if (!(path in files)) throw new InputError(`${path} could not be read — not in this fixture`);
    return files[path];
  };
}

/** A synthetic carrier: the canonical preamble for `doc`, plus clause text. */
function carrier(doc, prefix, body = '') {
  return `# Title\n\nIntro prose.\n\n${expectedPreamble(doc, prefix)}\n\n## Rules\n\n${body}\n`;
}

/* ── The computed per-document variables ─────────────────────────────────── */

describe('registryLink — the link a carrier must use, computed not authored', () => {
  it('computes one hop up from a document one level under docs/', () => {
    assert.equal(registryLink('docs/api/dispatch.md'), '../clause-registry.json');
  });

  it('computes two hops from docs/architecture/system/', () => {
    assert.equal(
      registryLink('docs/architecture/system/capture-principles.md'),
      '../../clause-registry.json',
    );
  });

  it('computes three hops from the extension architecture directory', () => {
    assert.equal(
      registryLink('docs/architecture/application/extension/runtime.md'),
      '../../../clause-registry.json',
    );
  });

  it('computes four hops from the windows desktop directory', () => {
    assert.equal(
      registryLink('docs/architecture/application/desktop/windows/application-shell.md'),
      '../../../../clause-registry.json',
    );
  });

  it('every shipped carrier states the link this computes', () => {
    const { prefixes } = readRegistry((path) => readTreeFile(join(ROOT, path)));
    for (const doc of Object.values(prefixes)) {
      const text = readTreeFile(join(ROOT, doc));
      assert.ok(
        text.includes(`[clause registry](${registryLink(doc)})`),
        `${doc} does not state the computed registry link`,
      );
    }
  });
});

describe('expectedPreamble — the canonical text with its variables resolved', () => {
  it('substitutes the prefix token the register carries', () => {
    assert.match(expectedPreamble('docs/api/dispatch.md', 'DI'), /\(\*\*DI-n\*\*\)/);
  });

  it('leaves no placeholder unresolved', () => {
    const text = expectedPreamble('docs/api/dispatch.md', 'DI');
    assert.doesNotMatch(text, /\{OPENING\}|\{PREFIX\}|\{REGISTRY_LINK\}/);
  });

  it('uses the standard opening for an unregistered document', () => {
    assert.ok(
      expectedPreamble('docs/api/dispatch.md', 'DI').startsWith(PREAMBLE_OPENINGS.standard),
    );
  });

  it('uses the qualified opening for a registered one', () => {
    const doc = Object.keys(QUALIFIED_OPENING_DOCS)[0];
    assert.ok(expectedPreamble(doc, 'SF').startsWith(PREAMBLE_OPENINGS.qualified));
  });

  it('is whitespace-flat, so the constant may be wrapped however it reads best', () => {
    assert.doesNotMatch(expectedPreamble('docs/api/dispatch.md', 'DI'), /\s\s|\n/);
    assert.match(CANONICAL_PREAMBLE, /\n/); // the constant itself is hand-wrapped
  });

  it('every qualified-opening registration carries a reason', () => {
    for (const [doc, reason] of Object.entries(QUALIFIED_OPENING_DOCS)) {
      assert.equal(typeof reason, 'string', `${doc} carries no reason`);
      assert.ok(reason.length > 40, `${doc}'s reason states nothing a reviewer can weigh`);
    }
  });
});

/* ── Structural location of the preamble paragraph ───────────────────────── */

describe('locatePreamble — the paragraph is found structurally', () => {
  it('returns the one paragraph making the identifier claim', () => {
    const doc = carrier('docs/api/dispatch.md', 'DI');
    assert.equal(flatten(locatePreamble(doc).paragraph), expectedPreamble('docs/api/dispatch.md', 'DI')); // prettier-ignore
  });

  it('reports a document that makes the claim nowhere', () => {
    const { problem } = locatePreamble('# Title\n\nNo preamble here.\n');
    assert.match(problem, /states no preamble paragraph/);
  });

  it('reports a document making the claim in two paragraphs', () => {
    const doc = `${carrier('docs/api/dispatch.md', 'DI')}\nEach rule carries a stable identifier, again.\n`;
    const { problem } = locatePreamble(doc);
    assert.match(problem, /in 2 paragraphs/);
  });

  it('never reads a fenced example as the preamble', () => {
    const fenced = `# Title\n\n\`\`\`text\nEach rule carries a stable identifier (**XX-n**) so other documents.\n\`\`\`\n`;
    assert.match(locatePreamble(fenced).problem, /states no preamble paragraph/);
  });

  it('the anchor it locates by is the claim both openings make', () => {
    assert.ok(PREAMBLE_OPENINGS.standard.includes(PREAMBLE_ANCHOR));
    assert.ok(PREAMBLE_OPENINGS.qualified.includes(PREAMBLE_ANCHOR));
  });
});

describe('describeDivergence — a finding names where the texts part', () => {
  it('names the first differing run on both sides', () => {
    const said = describeDivergence('the same text here', 'the same text there');
    assert.match(said, /it states "there…"/);
    assert.match(said, /canonical text states "here…"/);
  });

  it('names the end of a truncated paragraph rather than an empty quote', () => {
    assert.match(describeDivergence('one two three', 'one two'), /<end of paragraph>/);
  });
});

/* ── Leg 1: preamble parity ──────────────────────────────────────────────── */

describe('auditPreambles — every registered document states the one preamble', () => {
  const DOC = 'docs/api/dispatch.md';
  const prefixes = { DI: DOC };
  const audit = (files, register = prefixes, qualified = {}) =>
    auditPreambles(readerFor(files), register, qualified);

  it('passes a carrier stating the canonical text', () => {
    assert.deepEqual(audit({ [DOC]: carrier(DOC, 'DI') }), []);
  });

  it('passes a carrier that rewrapped its preamble', () => {
    const rewrapped = carrier(DOC, 'DI').replace(/identifier \(/, 'identifier\n(');
    assert.deepEqual(audit({ [DOC]: rewrapped }), []);
  });

  it('reds on a one-word divergence', () => {
    const drifted = carrier(DOC, 'DI').replace('never reused', 'never re-used');
    const problems = audit({ [DOC]: drifted });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /not the canonical one/);
  });

  it('reds on a truncated preamble', () => {
    const truncated = carrier(DOC, 'DI').replace(/ Keywords appear on a clause.*sequence\./s, '');
    assert.match(audit({ [DOC]: truncated })[0], /not the canonical one/);
  });

  it('reds on a preamble split across two paragraphs', () => {
    const split = carrier(DOC, 'DI').replace(' Keywords appear on a', '\n\nKeywords appear on a');
    assert.match(audit({ [DOC]: split })[0], /not the canonical one/);
  });

  it('reds on a registered document carrying no preamble at all', () => {
    assert.match(audit({ [DOC]: '# Dispatch\n\nProse.\n' })[0], /states no preamble paragraph/);
  });

  it('reds on a carrier stating another carrier’s prefix token', () => {
    const wrong = carrier(DOC, 'DI').replace('**DI-n**', '**SP-n**');
    assert.match(audit({ [DOC]: wrong })[0], /not the canonical one/);
  });

  it('reds on a carrier stating a registry link of the wrong depth', () => {
    const wrong = carrier(DOC, 'DI').replace('](../clause-registry.json)', '](../../clause-registry.json)'); // prettier-ignore
    assert.match(audit({ [DOC]: wrong })[0], /not the canonical one/);
  });

  it('reds on a carrier taking the qualified opening without registering it', () => {
    const taken = carrier(DOC, 'DI').replace(
      PREAMBLE_OPENINGS.standard,
      PREAMBLE_OPENINGS.qualified,
    );
    assert.match(audit({ [DOC]: taken })[0], /not the canonical one/);
  });

  it('passes the qualified opening once the document is registered for it', () => {
    const qualified = { [DOC]: 'Restates rules other artifacts own.' };
    const files = {
      [DOC]: carrier(DOC, 'DI').replace(PREAMBLE_OPENINGS.standard, PREAMBLE_OPENINGS.qualified),
    };
    assert.deepEqual(audit(files, prefixes, qualified), []);
  });

  it('reds on a qualified-opening registration whose document left the register', () => {
    const orphan = 'docs/technical/session-format.md';
    const problems = audit({ [DOC]: carrier(DOC, 'DI') }, prefixes, { [orphan]: 'a reason.' });
    assert.ok(
      problems.some((p) => p.includes(orphan) && p.includes('no longer a clause-bearing')),
      problems.join('\n'),
    );
  });

  it('the shipped qualified registrations are all still in the register', () => {
    const { prefixes: shipped } = readRegistry((path) => readTreeFile(join(ROOT, path)));
    for (const doc of Object.keys(QUALIFIED_OPENING_DOCS)) {
      assert.ok(Object.values(shipped).includes(doc), `${doc} is no longer clause-bearing`);
    }
  });

  it('refuses an empty register rather than passing vacuously', () => {
    assert.throws(() => audit({}, {}), { message: /empty `prefixes` map/ });
    assert.throws(
      () => audit({}, {}),
      (e) => e instanceof InputError,
    );
  });

  it('refuses an unreadable registered document rather than reading it as empty', () => {
    assert.throws(
      () => audit({}),
      (e) => e instanceof InputError,
    );
  });
});

/* ── Leg 2: the lowercase requirement-keyword scan ───────────────────────── */

describe('maskCodeSpans / KEYWORD_RE — what the scan can and cannot see', () => {
  it('masks a code span without moving the offsets around it', () => {
    const flat = 'before `may not` after';
    assert.equal(maskCodeSpans(flat).length, flat.length);
    assert.equal(maskCodeSpans(flat).indexOf('after'), flat.indexOf('after'));
  });

  it('matches the three lowercase spellings, whole-word only', () => {
    const hits = [...'must should may musty maybe re-may'.matchAll(KEYWORD_RE)].map((m) => m[1]);
    assert.deepEqual(hits, ['must', 'should', 'may']);
  });

  it('does not match the uppercase spellings', () => {
    assert.deepEqual([...'MUST MUST NOT SHOULD MAY'.matchAll(KEYWORD_RE)], []);
  });
});

describe('auditKeywords — a lowercase keyword inside a clause is reasoned about', () => {
  const DOC = 'docs/api/dispatch.md';
  const clauses = [{ doc: DOC, clause: 'DI-1' }];
  const withClause = (body) => ({ [DOC]: `# Dispatch\n\n## Rules\n\n**DI-1.** ${body}\n` });

  it('passes a clause stating its requirement in uppercase', () => {
    const files = withClause('A sender MUST stamp the payload.');
    assert.deepEqual(auditKeywords(readerFor(files), clauses, []), []);
  });

  it('reds on an unallowlisted lowercase keyword, quoting its context', () => {
    const files = withClause('A sender should stamp the payload.');
    const problems = auditKeywords(readerFor(files), clauses, []);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /lowercase `should` inside the clause/);
    assert.match(problems[0], /A sender should stamp the payload/);
  });

  it('never reds on a keyword inside a code span', () => {
    const files = withClause('The `may` field is optional.');
    assert.deepEqual(auditKeywords(readerFor(files), clauses, []), []);
  });

  it('never reds on a keyword inside a fenced block in the clause', () => {
    const files = {
      [DOC]: `# Dispatch\n\n## Rules\n\n**DI-1.** A sender MUST stamp it:\n\n\`\`\`text\nthe sender may skip this line\n\`\`\`\n`,
    };
    assert.deepEqual(auditKeywords(readerFor(files), clauses, []), []);
  });

  it('stops at the next clause marker, so a neighbour’s prose is not attributed here', () => {
    const files = {
      [DOC]: `# Dispatch\n\n## Rules\n\n**DI-1.** A sender MUST stamp it.\n\n**DI-2.** A sender may retry.\n`,
    };
    const problems = auditKeywords(readerFor(files), clauses, []);
    assert.deepEqual(problems, [], 'DI-2 is not a registered clause in this fixture');
  });

  it('accepts a hit whose sentence is allowlisted', () => {
    const files = withClause('A sender MUST stamp it (a proxy may rewrite the header).');
    const allowlist = [
      { doc: DOC, clause: 'DI-1', fragment: 'a proxy may rewrite the header', reason: 'observed.' },
    ];
    assert.deepEqual(auditKeywords(readerFor(files), clauses, allowlist), []);
  });

  it('accepts an allowlisted sentence the document rewrapped', () => {
    const files = {
      [DOC]: `# Dispatch\n\n## Rules\n\n**DI-1.** A sender MUST stamp it (a proxy\nmay rewrite\nthe header).\n`,
    };
    const allowlist = [
      { doc: DOC, clause: 'DI-1', fragment: 'a proxy may rewrite the header', reason: 'observed.' },
    ];
    assert.deepEqual(auditKeywords(readerFor(files), clauses, allowlist), []);
  });

  it('reds on an allowlist entry whose sentence left the clause', () => {
    const files = withClause('A sender MUST stamp it.');
    const allowlist = [
      { doc: DOC, clause: 'DI-1', fragment: 'a proxy may rewrite the header', reason: 'observed.' },
    ];
    assert.match(auditKeywords(readerFor(files), clauses, allowlist)[0], /is no longer in the clause/); // prettier-ignore
  });

  it('reds on an allowlist entry whose sentence carries no lowercase keyword', () => {
    const files = withClause('A sender MUST stamp it (the proxy is transparent).');
    const allowlist = [
      { doc: DOC, clause: 'DI-1', fragment: 'the proxy is transparent', reason: 'observed.' },
    ];
    assert.match(
      auditKeywords(readerFor(files), clauses, allowlist)[0],
      /carries no lowercase requirement keyword/,
    );
  });

  it('reds on an allowlist fragment matching two places in the clause', () => {
    const files = withClause('It MUST stamp (a proxy may rewrite); again (a proxy may rewrite).');
    const allowlist = [
      { doc: DOC, clause: 'DI-1', fragment: 'a proxy may rewrite', reason: 'observed.' },
    ];
    const problems = auditKeywords(readerFor(files), clauses, allowlist);
    assert.match(problems[0], /appears 2 times/);
    // and neither hit is silently covered by the ambiguous anchor
    assert.equal(problems.filter((p) => p.includes('lowercase `may`')).length, 2);
  });

  it('reds on a clause leaving a code span open rather than masking prose', () => {
    // Unbalanced backticks would pair the open span with the next one, blanking
    // real prose — and a lowercase keyword inside that run would go unseen.
    const files = withClause('The `value field MUST be present, and a proxy may rewrite it.');
    const problems = auditKeywords(readerFor(files), clauses, []);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /odd number of backticks/);
  });

  it('reds on an allowlist entry naming a clause the registry does not carry', () => {
    const files = withClause('A sender MUST stamp it.');
    const allowlist = [{ doc: DOC, clause: 'DI-9', fragment: 'anything', reason: 'observed.' }];
    assert.match(
      auditKeywords(readerFor(files), clauses, allowlist)[0],
      /names a clause docs\/clause-registry\.json does not carry/,
    );
  });

  it('refuses an empty clause list rather than passing vacuously', () => {
    assert.throws(
      () => auditKeywords(readerFor({}), [], []),
      (e) => e instanceof InputError,
    );
  });

  it('refuses a registered clause whose marker is not in its document', () => {
    const files = { [DOC]: '# Dispatch\n\n## Rules\n\nNo markers here.\n' };
    assert.throws(
      () => auditKeywords(readerFor(files), clauses, []),
      /carries no `\*\*DI-1\.\*\*` marker/,
    );
  });
});

/* ── The registry reader ─────────────────────────────────────────────────── */

describe('readRegistry — the register is refused, never guessed at', () => {
  const good = JSON.stringify({ prefixes: { DI: 'docs/api/dispatch.md' }, clauses: [] });

  it('reads the two surfaces both legs need', () => {
    const { prefixes, clauses } = readRegistry(readerFor({ [REGISTRY_PATH]: good }));
    assert.deepEqual(prefixes, { DI: 'docs/api/dispatch.md' });
    assert.deepEqual(clauses, []);
  });

  it('refuses unparseable JSON', () => {
    assert.throws(
      () => readRegistry(readerFor({ [REGISTRY_PATH]: '{ "prefixes": ' })),
      /is not parseable JSON/,
    );
  });

  it('refuses a registry carrying no prefixes object', () => {
    assert.throws(
      () => readRegistry(readerFor({ [REGISTRY_PATH]: '{"clauses":[]}' })),
      /carries no `prefixes` object/,
    );
  });

  it('refuses a prefix mapped to no document path', () => {
    assert.throws(
      () => readRegistry(readerFor({ [REGISTRY_PATH]: '{"prefixes":{"DI":null},"clauses":[]}' })),
      /maps prefix `DI` to no document path/,
    );
  });

  it('refuses a registry carrying no clauses array', () => {
    assert.throws(
      () => readRegistry(readerFor({ [REGISTRY_PATH]: '{"prefixes":{"DI":"d.md"}}' })),
      /carries no `clauses` array/,
    );
  });

  it('refuses a clause row that is not a doc/clause pair', () => {
    const bad = '{"prefixes":{"DI":"d.md"},"clauses":[{"doc":"d.md"}]}';
    assert.throws(
      () => readRegistry(readerFor({ [REGISTRY_PATH]: bad })),
      /row `clauses\[0\]` carries no/,
    );
  });
});

/* ── Real-tree locks ─────────────────────────────────────────────────────── */

describe('the shipped tree satisfies both legs', () => {
  const readTree = (path) => readTreeFile(join(ROOT, path));

  it('every clause-bearing document states the canonical preamble, and no clause carries an unreasoned lowercase keyword', () => {
    const { problems } = auditTree(readTree);
    assert.deepEqual(problems, []);
  });

  it('every allowlist entry is load-bearing — removing any one of them reds', () => {
    const { clauses } = readRegistry(readTree);
    assert.ok(KEYWORD_ALLOWLIST.length > 0, 'the allowlist is not empty');
    for (const dropped of KEYWORD_ALLOWLIST) {
      const without = KEYWORD_ALLOWLIST.filter((entry) => entry !== dropped);
      const problems = auditKeywords(readTree, clauses, without);
      assert.ok(
        problems.some((p) => p.includes(dropped.clause) && p.includes('lowercase')),
        `dropping ${dropped.clause} ("${dropped.fragment}") reds nothing — the entry allows nothing`,
      );
    }
  });
});

describe('the shipped allowlist entries carry a reason and an anchor', () => {
  it('every allowlist entry records a reason a reviewer can weigh', () => {
    for (const entry of KEYWORD_ALLOWLIST) {
      assert.ok(entry.reason.length > 60, `${entry.clause} states no substantive reason`);
      assert.ok(entry.fragment.length > 10, `${entry.clause} anchors on too little text`);
    }
  });
});

// The exit-code contract is a process-boundary fact — 0 green, 1 a preamble or
// keyword that drifted, 2 machinery breakage that must never read as drift —
// and only a spawn observes it. Every file the CLI reads is cwd-relative (the
// registry and the documents its prefixes map names), so a temporary tree
// holding copies of exactly those is a complete input surface. Env: the
// script's import closure reads no process.env, so the inherited environment is
// already the pinned one.
describe('check-clause-preamble: CLI exit codes at the process boundary', () => {
  const SCRIPT = join(ROOT, 'scripts', 'check-clause-preamble.js');
  const { prefixes } = readRegistry((path) => readTreeFile(join(ROOT, path)));
  const READS = [REGISTRY_PATH, ...Object.values(prefixes)];
  let root = null;

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** A temporary tree holding copies of the files the CLI reads. */
  function tree(mutate = null) {
    root ??= mkdtempSync(join(tmpdir(), 'docent-preamble-cli-'));
    const dir = mkdtempSync(join(root, 'case-'));
    const files = new Map(READS.map((rel) => [rel, readFileSync(join(ROOT, rel), 'utf8')]));
    if (mutate) mutate(files);
    for (const [rel, text] of files) {
      const target = join(dir, ...rel.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    return dir;
  }

  /** Run the real CLI against a temporary tree; returns its exit status. */
  function run(dir) {
    const result = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  it('exit 0 over pristine copies of the files it reads', () => {
    const { status, stdout } = run(tree());
    assert.equal(status, 0, stdout);
    assert.match(stdout, /clause preambles canonical/);
  });

  it('exit 1 with the drift verdict when a carrier’s preamble diverges', () => {
    const doc = 'docs/api/dispatch.md';
    const { status, stderr } = run(
      tree((files) => {
        const text = files.get(doc);
        assert.ok(text.includes('never reused'), 'the mutation anchor moved');
        files.set(doc, text.replace('never reused', 'never re-used'));
      }),
    );
    assert.equal(status, 1);
    assert.match(stderr, /drifted from the preamble they share/);
    assert.match(stderr, /docs\/api\/dispatch\.md/);
  });

  it('exit 1 when a clause grows an unallowlisted lowercase keyword', () => {
    const doc = 'docs/api/dispatch.md';
    const { status, stderr } = run(
      tree((files) => {
        const text = files.get(doc);
        assert.ok(text.includes('**DI-10.**'), 'the mutation anchor moved');
        files.set(doc, text.replace('**DI-10.**', '**DI-10.** A sender should retry once.'));
      }),
    );
    assert.equal(status, 1);
    assert.match(stderr, /lowercase `should` inside the clause/);
  });

  it('exit 2 with the machinery verdict when the registry will not parse', () => {
    const { status, stderr } = run(tree((files) => files.set(REGISTRY_PATH, '{ "prefixes": ')));
    assert.equal(status, 2);
    assert.match(stderr, /could not be used/);
    assert.match(stderr, /is not parseable JSON/);
    // The verdict it must never be mistaken for.
    assert.doesNotMatch(stderr, /drifted from the preamble/);
  });

  it('exit 2 when a registered document is missing from the tree', () => {
    const { status, stderr } = run(tree((files) => files.delete('docs/api/dispatch.md')));
    assert.equal(status, 2);
    assert.match(stderr, /could not be read/);
  });
});
