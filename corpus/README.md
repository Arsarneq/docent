# Scripted-truth capture corpus

The "capture completeness" artifact of
[Replay Sufficiency — Falsifiability, item 3](../docs/replay-sufficiency.md#falsifiability):
controlled pages where the input sequence itself is scripted, so CI diffs the
produced recording against known truth. This is the artifact that catches
missing-action capture gaps, which neither the schema, the sufficiency lint,
nor any locator machinery can see.

Nothing here replays a recording or resolves a locator. The corpus produces
`.docent.json` envelopes from scripted input and compares them to committed
truth files — Docent ships no consumer, and this directory is a repository and
CI artifact only (excluded from every release, like `reference-implementations/`).

## Truth doctrine

- **Truth is derived from the script and the
  [capture principles](../docs/capture-principles.md), never from recorder
  output.** A truth file states what a faithful capture _in the current
  format_ would record for its session's scripted input. Bootstrapping a truth
  by copying a produced envelope is allowed — followed by a mandatory
  line-by-line review against the script; anywhere current capture falls short
  of the reviewed truth, the divergence goes into the known-diffs baseline
  (issue-tagged in the manifest), never silently enshrined into the truth.
- **Corpus diffs cover only current-format-expressible capture defects**:
  missing/extra/wrong actions and wrong field values. Facts the format cannot
  state (viewport, start URL, hover, readiness…) are the sufficiency lint's
  gap-predicate territory — truth files are schema-valid current-format
  documents, so such facts structurally cannot appear as corpus diffs.
- **CI stays green while known capture gaps are open.** The committed
  `known-diffs.<platform>.json` is locked in BOTH directions by
  `npm run corpus:check`: a NEW diff is a capture regression; a VANISHED diff
  means a fix landed — both fail CI until the baseline is deliberately
  regenerated (the comparator's `--write-baseline` flag) and reviewed. The
  `--strict`/`--lint-strict` flags exist but are CI-wired only once the
  baselines are empty (the gate slice).
- **Hermetic.** Pages are committed under each session and served from
  loopback at a FIXED port by `corpus/serve.js` — the URL rule is
  `http://127.0.0.1:41730/<session-id>/<filename>` — so URL-bearing fields
  are deterministic; no session touches the public internet.

## Layout

```text
manifest.json                  the session catalogue (id, platform, page,
                               script, knownDiffIssues, notes, status)
known-diffs.extension.json     per-platform both-direction baseline
sessions/<id>/pages/           committed HTML the session runs against
sessions/<id>/script.js        the input driver (real Playwright input only —
                               the recorder drops synthetic events)
sessions/<id>/truth.docent.json  the expected envelope (raw, schema-valid)
sessions/<id>/overrides.json   optional relaxations sidecar
out/                           gitignored per-run output (produced envelopes,
                               diff reports)
```

Runner: `packages/extension/tests/e2e/corpus/corpus.spec.js` (config
`playwright.corpus.config.js`). Comparator: `scripts/corpus-compare.js`
(normalization spec, LCS action alignment, baseline mechanics — see its
header). Local loop: `npm run corpus:produce:extension`, then
`npm run corpus:check`.

## Page-authoring rules

- Interactive elements carry `id` + `data-testid` — EXCEPT elements
  deliberately left identifier-less so the derived `css` locator stays
  structural (at least one such element must exist in the catalogue).
- Across the catalogue, every emitted locator strategy is a measured-unique
  candidate (`match_count: 1`, `match_index: 0`) on at least one element —
  the conformance-vector work reuses these pages unchanged:

  | strategy                                                       | covered by      |
  | -------------------------------------------------------------- | --------------- |
  | id, test_id, text, title, alt_text, tag_name, css (structural) | ext-click-basic |
  | name                                                           | ext-file-upload |
  | placeholder                                                    | ext-type-blur   |

- Fixed pixel sizes for geometry the session depends on (scroll containers);
  no animation, no time/locale-dependent text, `lang="en"`, no external
  resources. The runner pins a 1280x720 viewport.
- Waits come from `packages/extension/lib/capture-timing.js` constants
  (`SCROLL_DEBOUNCE`, `SCROLL_MIN_DISTANCE_PX`), never magic numbers.
- No two live tabs may share a URL (the frame-readiness probe is keyed per
  URL), and every navigation must be followed by a readiness wait
  (`waitForFrameReadySince` — corpus URLs are stable across loads, so the
  plain per-URL wait would return stale).

## Conformance vectors

Inert data for [docs/locator-resolution.md](../docs/locator-resolution.md#conformance-and-vector-scope)
(Conformance and Vector Scope): committed alongside the sessions whose pages they
reuse, one file per ground-truth element under `sessions/<id>/vectors/<key>.vector.json`,
shaped by the meta-schema `vector.schema.json`. A vector carries the recorded
`locators`, the `element_facts` (the captured element **minus** its nested
locators — the non-locator fact source), a `tree_snapshot` of the bound scope,
the `ground_truth` node inside it, and `matched_node_ids` (per candidate, the
snapshot nodes its stated query selects). Only `expected_outcome: "resolved"`
vectors ship — the inclusion-criterion members: an element carrying at least one
eligible candidate recorded measured-unique (`match_count: 1`, `match_index: 0`).
Nothing here executes the resolution procedure.

### Emission (produced, then reviewed and committed)

A superset of the corpus run, gated on the `CORPUS_VECTORS` env var so truth
production is byte-for-byte unaffected without it. At a non-mutating,
non-navigating vector-carrying action, the session driver calls
`vector.mark(selector, key)`; the snapshot walker (`lib/snapshot-walker.js`,
injected via `page.evaluate`) serializes the bound frame's `documentElement`,
marking the ground truth by the **identity** of the element the driver just acted
on (never a positional index). Canonical serialization — attribute keys sorted,
children in document order, node text in the trim-only `element.text` form, node
ids in document order — so a produced snapshot is deterministic. After the run,
`element_facts` and `locators` are taken from the real recorded action (correlated
by element identity) and `matched_node_ids` are measured over the produced
snapshot. Produced vectors land under the gitignored `out/extension-vectors/`;
the run asserts each produced vector deep-equals its committed file — the
produce-stage oracle. Bootstrap a new vector by producing it, reviewing it, and
committing it (the truth doctrine above, applied to vectors).

### Hygiene locks (structural; `packages/shared/tests/unit`)

Each lock is a per-candidate match **count** measured over the committed
snapshot, or a committed-field **equality** — never a run of the resolution
procedure. The `"resolved"` guarantee **emerges** from the counts and equalities;
it is nowhere computed. For every committed vector:

1. it names an active manifest session of its platform;
2. `element_facts` + `locators` equal a captured element of that session
   (`element_facts` is that element minus its nested locators);
3. an eligible candidate is measured-unique (`match_count: 1`, `match_index: 0`);
4. `ground_truth.node_id` exists in `tree_snapshot`;
5. over the committed snapshot every eligible candidate (not masked, `match_index`
   not null) selects exactly the ground-truth node or is non-selecting (0 or >1) —
   none selects a single other node; the measured-unique candidate selects exactly
   the ground truth; and the recorded `matched_node_ids` re-derive;
6. the ground-truth node's committed `tag` (exact) and `text` (containment; vacuous
   when null) equal `element_facts`.

Lock 5's query evaluator implements the spec's Application step per strategy over
the serialized snapshot — attribute field-walks, the all-tag normalized-text
predicate, and Docent's own bounded `css` derivation grammar. A repo-level unit
test additionally greps the shipped runtime paths for identifiers unique to the
ordered procedure, so a resolver can never be smuggled into a shipped surface.

### Coverage ledger

`vectors-coverage.json` maps each emitted extension strategy to the committed
vector where it is the measured-unique candidate, at element granularity
(`session`, `vector`, `element`, `action_index`). A lock ties every emitted
strategy to a real committed vector; `role_name` and `label` are schema-reserved
and not emitted, so they are outside vector scope.

### Determinism

Extension snapshots are static by the page-authoring rules above (no animation,
no time/locale-dependent text, fixed viewport), so `produced == committed` holds
byte-deterministically across runs. (Localized and environment-string
normalization of a snapshot is a desktop concern — the extension leg needs none.)

## Out of scripted reach (loud exclusions)

- **Autofill fills (docent#233)** — Chrome's autofill dropdown is browser
  chrome; neither Playwright nor CDP can select an entry. Stays a manual
  scenario plus its issue.
- **`context_open`/`context_switch`/`context_close` as user actions** —
  tab/window chrome interactions have no trusted-input driver (a scripted
  `bringToFront`/`page.close()` is programmatic by definition, and capture
  rightly filters it). `ext-tab-open` pins the in-page half of the boundary:
  a user click that opens a tab records the click plus the new context's
  chrome-initiated navigate.
- **Recorder-presence loss (docent#222/#226)** — the corpus deliberately runs
  under the frame-readiness discipline that controls this failure class away;
  adversarial injection timing belongs to those issues, not to deterministic
  scripting.

## Known caveats

- The corpus does not exercise the side-panel commit/export UI (the envelope
  is assembled through the same shared production functions the panels call);
  panel flows stay covered by the main e2e suite.
- A `match-stats` relaxation can hide a `locator-pair-invariants` violation
  from the corpus diff — which is why produced files are additionally run
  through the sufficiency lint (`--lint`) and relaxations are per-entry,
  strategy-cross-checked, and reviewed.
- Truth files are also members of the sufficiency lint's corpus (the
  `sufficiency:check` paths include `corpus/sessions` — never `corpus/`, so
  the gitignored `out/` can't leak into the lint baseline). Their gap/fail
  findings live in `packages/shared/tests/fixtures/sufficiency-baseline.json`.

## Adding or retiring a session

Add: create `sessions/<id>/` (pages, script, truth per the doctrine above),
register it in `manifest.json`, produce, review the truth line-by-line,
regenerate and review both baselines. Retire: never delete silently — set
`"status": "retired"` in the manifest with a reason (and issue link); the
entry stays listed. A session that cannot pass CI reliably across its retry
budget is redesigned or retired — never relaxed into meaninglessness.
Removal decisions belong to the maintainer.
