# Static sufficiency lint

The "static predicates" artifact of
[Replay Sufficiency — Falsifiability, item 1](../requirements/replay-sufficiency.md#falsifiability):
for each action, the fields the
[field taxonomy](../requirements/replay-sufficiency.md#field-taxonomy--normative-vs-informative)
marks normative are present or legally absent, and their cross-field
invariants hold. The lint ([`scripts/sufficiency-lint.js`](../../scripts/sufficiency-lint.js))
is a pure function of a `.docent.json` file — no application, no replay, no
ground truth. Items 2 and 3 of the falsifiability triad are owned elsewhere:
resolution conformance by the
[reference resolution procedure](../technical/locator-resolution.md) and its
conformance vectors, capture completeness by the
[scripted-truth corpus](scripted-truth-corpus.md). The seam with the corpus
beside this document: the corpus proves the capture pipeline reproduces known
truth on scripted sessions — the lint checks static predicates on **any**
recording, scripted or not, with nothing but the file and the schemas.

Each rule carries a stable identifier (**SL-n**) so other documents, reviews,
and checks can cite it precisely. Identifiers are never renumbered; a retired
identifier stays reserved and is never reused. How each rule is verified — by
an existing named check, by a check that could be built, or by judgment — is
recorded per rule in the [clause registry](../clause-registry.json). The key
words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as described in
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119). Keywords appear on a
clause's operative requirement where it has one; definitional clauses bind as
stated without a keyword, and subsidiary absolutes inside a clause inherit its
force. A clause's scope runs from its marker to the next marker or heading;
identifiers reflect minting order and may appear out of numeric sequence.

## Input contract

**SL-1.** Every input MUST be a contract-valid recording before any predicate
runs. The platform is read from the file's `docent_format.platform` stamp and
must name a leaf of the schema composition map; the contract is composed per
leaf (base → family → leaf, the
[layer model](../technical/session-format.md#json-schema-files)) and the file
validated against it with the version stamp relaxed by shape — the same
harness-local relaxation the
[backward-compat corpus](../test/backward-compat.md#validation-is-by-shape-not-by-version-stamp)
uses. Schema-invalid files and unknown stamps are refused loudly, with a
machinery exit distinct from any finding — the lint never reasons about a
file the contract does not recognize.

Family membership is derived from the composition chain, never hardcoded to
today's leaves: any leaf composed through the desktop family layer gets the
desktop-family predicates, so a future desktop surface is covered with no
lint change.

## Finding classes

**SL-2.** Findings come in exactly two classes, and a finding carries exactly
one — they are never conflated:

| Class  | Meaning                                                                                             |
| ------ | --------------------------------------------------------------------------------------------------- |
| `fail` | The current format can carry the fact and this recording does not — the recording is insufficient.  |
| `gap`  | The format itself cannot state the fact yet — not applicable today; each maps to open capture work. |

**SL-3.** Every `gap` predicate MUST carry a schema probe: a pattern check
against the composed schema that detects when the format HAS become able to
express the fact. The moment a probe matches, the lint refuses to run for
that platform until the predicate is promoted to `fail` — the gap→fail flip
is self-detecting in code, never a memory exercise.

## The predicates

The tables below are the whole catalogue (`--list` prints it from the code).
Predicates check strictly beyond the schema: anything the schema validator
already enforces is not re-checked. Each finding carries a stable pointer
(`rec[r].step[s].action[a]:<type>`, or `rec[r]` for recording-level
findings), and findings are sorted so baselines stay stable.

### Per-action predicates (all `fail` class)

| Predicate                       | Applies to                                      | Requires                                                                                                                                                                          |
| ------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `element-locators`              | element-bearing actions outside coordinate mode | The element carries at least one locator candidate.                                                                                                                               |
| `locator-pair-invariants`       | every locator entry                             | A numeric `match_index` only together with `match_count`, and `match_index < match_count`. `match_index: null` without a count is the legal encoding of "measured, matched zero". |
| `coordinate-geometry`           | desktop-family coordinate-mode point actions    | `window_rect` is present — without it the point is uninterpretable from the recording alone.                                                                                      |
| `coordinate-no-identity-claims` | desktop-family coordinate-mode elements         | No locators and no provider identity facts (`position_in_set`, `size_of_set`, `level`, `framework_id`, `described_after_ms`) — coordinate mode makes no element-identity claims.  |
| `type-value-nonempty`           | `type` actions on non-redacted elements         | A non-empty `value`.                                                                                                                                                              |
| `masking-honesty`               | actions on `redacted` elements                  | `text` is null and any `value` is exactly the shared mask — an empty value would erase the parameter-slot marker the scope boundaries stand on.                                   |
| `masked-locator-honesty`        | actions whose element carries locators          | Locator masking matches the contract's annotation (see below).                                                                                                                    |
| `key-nonempty`                  | `key` actions                                   | A non-empty `key`.                                                                                                                                                                |

### Recording-level predicates

Recording-scoped findings (pointer `rec[r]`): `context-introduced` emits
one per un-introduced context, named in the finding's message; the other
two emit at most one per recording.

| Predicate            | Class  | States                                                                                                                                                                                                                                                                |
| -------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context-introduced` | `fail` | Every non-null `context_id` is the recording's initial context or first appears on a `context_open`/`context_switch` action — the fail-class check [session-format §SF-10](../technical/session-format.md#actions) cites.                                             |
| `start-point`        | `gap`  | The recording's INITIAL context's first action states where reproduction begins (a `navigate`, or an introducing lifecycle action carrying `source`); a later source states where the recording went, not where it began. Non-initial contexts are not checked today. |
| `viewport-context`   | `gap`  | Browser-family point coordinates carry a viewport context — the format records no viewport size today.                                                                                                                                                                |

## Masking enforcement — the annotation contract

**SL-4.** Which locator strategies the lint holds to in-place masking is read
from the composed contract, never hardcoded: every strategy definition
declares the `x-value-derived` annotation
([locator-resolution §LR-24](../technical/locator-resolution.md#value-derived-strategies)
defines it), and the definitions annotated `true` form the enforced set. The lint
MUST refuse to run on a malformed annotation contract rather than guess: a
strategy definition that does not declare the annotation (absence must mean
nothing, never a silent false), an annotated definition with no `strategy`
const, or one with no `value` field each halt the lint loudly.

On that contract, `masked-locator-honesty` enforces exactly:

- on a `redacted` element, every value-derived entry is masked in place —
  the exact mask as its `value`, with `masked: true`;
- an entry the contract does not mark value-derived never claims
  `masked: true`;
- off `redacted` elements, no entry claims `masked: true` at all.

Match statistics remain legal on masked entries — they were measured
pre-masking at capture and are deliberately kept.

## The standing corpus and its baseline

**SL-5.** The lint's standing corpus — the frozen historical fixtures under
`packages/shared/tests/fixtures/` plus the scripted-truth corpus's committed
truth files (collected from `corpus/sessions`, never `corpus/`, so the
gitignored `corpus/out/` can never leak in) — is locked to the committed
baseline
[`packages/shared/tests/fixtures/sufficiency-baseline.json`](../../packages/shared/tests/fixtures/sufficiency-baseline.json)
in BOTH directions: a NEW finding is a regression to decide on intentionally,
a VANISHED finding is a stale baseline (a known gap closed or a rule
weakened) — both fail until the baseline is deliberately regenerated and
reviewed. A change to the predicate catalogue or the corpus therefore lands
with its regenerated baseline in the same change. Regenerate with:

```bash
node scripts/sufficiency-lint.js packages/shared/tests/fixtures corpus/sessions \
  --write-baseline packages/shared/tests/fixtures/sufficiency-baseline.json
```

Baseline entries are `"<class>:<id> <pointer>"` per file, keyed by
repo-relative forward-slash path. The lock
([`packages/shared/tests/unit/sufficiency-lint.test.js`](../../packages/shared/tests/unit/sufficiency-lint.test.js))
imports its file discovery and baseline serialization from the lint itself,
so the walk, filters, sorting, and entry format cannot diverge from what the
CLI's `--write-baseline` produces (the two-root list is stated separately in
the lock and the npm script; a divergence there fails the lock loudly rather
than being prevented) — and the same pass asserts every corpus member is
contract-valid.

The baseline is the honesty ledger, not a pass: it currently holds open
`fail` findings alongside the standing `gap` findings — the committed file
is the live enumeration of what is known-open. CI stays green while they
are open — and reddens the moment any of them appears, vanishes, or
moves.

## Entry points and enforcement

CLI:

```text
node scripts/sufficiency-lint.js <file-or-dir>... [--json] [--strict]
     [--baseline <path>] [--write-baseline <path>] [--list]
```

Directories are recursed for `.docent.json` files; relative paths resolve
against the repository root, so the CLI behaves identically from any
directory. With no paths it runs over the frozen fixtures.

| Flag                      | Effect                                                                       |
| ------------------------- | ---------------------------------------------------------------------------- |
| _(none)_                  | Advisory: report all findings, exit 0.                                       |
| `--strict`                | Exit 1 when any `fail`-class finding exists.                                 |
| `--baseline <path>`       | Exit 1 when findings differ from the committed baseline in either direction. |
| `--write-baseline <path>` | Write the current findings as the baseline.                                  |
| `--json`                  | Machine-readable output, keyed like the baseline (diffable against it).      |
| `--list`                  | Print the predicate catalogue (class, id, title).                            |

Exit 2 is a machinery refusal — unreadable or schema-invalid input, an
unknown platform stamp, an obsolete gap predicate (SL-3), or a malformed
annotation contract (SL-4) — never a baselineable finding.

Where it runs:

| Entry point                                                                                         | What it runs                                                                                       | Posture                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run sufficiency:check`                                                                         | fixtures + `corpus/sessions` against the committed baseline                                        | the both-direction gate (SL-5) at the command line                                                                                                                                                                                |
| `npm run test:shared` (the [unit suite](../../packages/shared/tests/unit/sufficiency-lint.test.js)) | the same file set against the same baseline, plus per-predicate pins on minimal hand-built actions | how the gate reaches CI — the unit-tests job runs it on every push; the pins catch a predicate that silently stops firing (or fires on legal absence)                                                                             |
| `npm run corpus:check` / `corpus:check:desktop` (the comparator's `--lint`)                         | each produced corpus envelope, immediately after the truth diff                                    | advisory; the comparator's `--lint-strict` exits 1 on `fail` findings over produced files and is CI-wired only once the known-diffs baselines are empty ([scripted-truth-corpus §STC-3](scripted-truth-corpus.md#truth-doctrine)) |

The lint's own `--strict` is the corresponding gate slice at this surface:
today's standing enforcement is the both-direction baseline lock, which
admits the ledgered findings while forbidding silent drift in either
direction.
