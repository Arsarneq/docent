# Scripted-truth capture corpus

The "capture completeness" artifact of
[Replay Sufficiency — Falsifiability, item 3](replay-sufficiency.md#falsifiability):
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
  [capture principles](capture-principles.md), never from recorder
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
  `corpus/known-diffs.<platform>.json` is locked in BOTH directions by
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
corpus/
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
`packages/extension/tests/e2e/playwright.corpus.config.js`). Comparator:
`scripts/corpus-compare.js` (normalization spec, LCS action alignment, baseline
mechanics — see its header). Local loop: `npm run corpus:produce:extension`, then
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

Inert data for [docs/locator-resolution.md](locator-resolution.md#conformance-and-vector-scope)
(Conformance and Vector Scope): committed alongside the sessions whose pages they
reuse, one file per ground-truth element under `corpus/sessions/<id>/vectors/<key>.vector.json`,
shaped by the meta-schema `corpus/vector.schema.json`. A vector carries the recorded
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
`vector.mark(selector, key)`; the snapshot walker (`corpus/lib/snapshot-walker.js`,
injected via `page.evaluate`) serializes the bound frame's `documentElement`,
marking the ground truth by the **identity** of the element the driver just acted
on (never a positional index). Canonical serialization — attribute keys sorted,
children in document order, node text in the trim-only `element.text` form, node
ids in document order — so a produced snapshot is deterministic. After the run,
`element_facts` and `locators` are taken from the real recorded action (correlated
by element identity) and `matched_node_ids` are measured over the produced
snapshot. Produced vectors land under the gitignored `corpus/out/extension-vectors/`;
the run asserts each produced vector deep-equals its committed file — the
produce-stage oracle. Bootstrap a new vector by producing it, reviewing it, and
committing it (the truth doctrine above, applied to vectors).

### Hygiene locks (structural; `packages/shared/tests/unit`)

Each lock is a per-candidate match **count** measured over the committed
snapshot, or a committed-field **equality** — never a run of the resolution
procedure. The `"resolved"` guarantee **emerges** from the counts and equalities;
it is nowhere computed. For every committed vector:

1. it names an active manifest session of its platform, or an enumerated
   dedicated vector fixture (the truth-less desktop source — see below);
2. **session-sourced:** `element_facts` + `locators` equal a captured element of
   that session (`element_facts` is that element minus its nested locators);
   **fixture-sourced (desktop):** the producer-emitted `element_facts` +
   `locators` are self-describing — internally consistent and well-formed for
   their strategies (the labeled_by/tree_path additive-stats augmentation is the
   only permitted extra);
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

`corpus/vectors-coverage.json` maps each emitted extension strategy to the committed
vector where it is the measured-unique candidate, at element granularity
(`session`, `vector`, `element`, `action_index`). A lock ties every emitted
strategy to a real committed vector; `role_name` and `label` are schema-reserved
and not emitted, so they are outside vector scope.

### Determinism

Extension snapshots are static by the page-authoring rules above (no animation,
no time/locale-dependent text, fixed viewport), so `produced == committed` holds
byte-deterministically across runs. (Localized and environment-string
normalization of a snapshot is a desktop concern — the extension leg needs none.)

### Desktop leg

The desktop leg reuses this machinery — the same meta-schema, the same six locks,
the produced==committed oracle — with a desktop-shaped snapshot and evaluator.
The differences are all data:

- **Snapshot node (`desktop_node`).** A serialized node of the UI Automation
  Control view: `control_type` (non-localized), `name`, `automation_id`,
  `class_name`, `text`, a `labeled_by` relation edge (`target_node_id` |
  `target_name`), and `children`. The bound scope is the acted-on top-level
  **window, itself included** — the full Control view, no chrome excised (the
  desktop measurement scope in
  [docs/locator-resolution.md](locator-resolution.md)) — so uniqueness
  and `tree_path` are counted over exactly what a query sees at the window.
- **Locale determinism by authored provenance.** A committed snapshot must not
  freeze OS-locale strings. `control_type` / `automation_id` / `class_name` /
  structure are kept verbatim (stable, count-relevant); the localized `name` of
  any node that does **not** carry an authored content `automation_id` — whatever
  its tree position, so OS descendants (a scrollbar, a menu item) are covered — is
  normalized to a reserved placeholder. The window root keeps its authored title.
  A content query's value is an authored non-localized string that never equals
  the placeholder, so normalizing OS Names cannot change the match count for any
  content-targeting query.
- **Fixture-sourced, producer-emitted.** Desktop vectors are sourced from a
  dedicated vector-only fixture window (`corpus/vector-fixtures.json`), not a manifest
  corpus session: it has no `truth.docent.json`, no known-diffs baseline key, and
  no sufficiency-baseline entry. Its `element_facts` + `locators` are captured
  through the real desktop path (never hand-authored); the vector is
  self-describing, so lock (2) checks internal consistency. The vector-carrying
  action is a worker-described one (its element carries measured stats); an
  input-time click element is unmeasured and sources no vector.
- **Harness-measured `labeled_by` / `tree_path`.** Capture skips match stats for
  these two (`labeled_by` is not a UIA property-condition; `tree_path` counting
  is O(nodes × depth)). The offline harness has no runtime budget, so it measures
  both by evaluating their stated query over the committed snapshot and records
  the resulting `match_count` / `match_index` — derived FROM the snapshot, so lock
  (5) re-derives them. This is the only place a vector's `locators` may exceed the
  captured element, and only on those two strategies.
- **Reproduce discipline: normalized, not byte-identical.** A desktop
  `element_facts` carries environment-variant fields a static DOM does not:
  `described_after_ms` (worker latency) and a `selector` whose ancestry above the
  window is the virtual-desktop root. The produced==committed oracle compares
  under the **reused shipped comparator class rules** (`scripts/corpus-compare.js`),
  symmetric on both sides — `described_after_ms` 0-exact / positive→placeholder,
  the selector's above-window ancestry→placeholder — while `element.role`
  (localized) is compared **exact** and is never a corroboration or query input.
  The retained OS-chrome subtree structure is fixed-CI-runner-bounded: produced on
  a pinned Windows image, so an image bump is a deliberate re-baseline
  (reproducibility, not cross-version invariance — the 4a cross-machine discipline
  applied to the snapshot).
- **`labeled_by` via a merged UIA relation.** A raw Win32 EDIT exposes its
  preceding label as a Name but not as a UIA LabeledBy relation element. The
  fixture window is therefore a dedicated custom window class whose window
  procedure answers the UIA object request with a fragment-root provider
  implementing `IRawElementProviderHwndOverride`. The override returned for the
  EDIT host-delegates every property to the native control (so `control_type`
  stays `Edit`, `automation_id`/`class_name`/`name` flow through) and supplies
  **only** the LabeledBy relation — a small self-describing element whose Name is
  the label text. UIA **merges** the override onto the native element, so the
  relation is genuinely reported to any reader — the direct describe path and the
  Control-view walk alike — and nothing is synthesized in the reader. The EDIT's
  snapshot node then carries a real `labeled_by` edge, making `labeled_by` the
  measured-unique candidate. (`#[implement]` comes from a test-only dev-dependency
  that never enters the shipped build.)
- **Coverage: all five emitted strategies.** `automation_id`, `role_name`,
  `class_name`, `tree_path`, and `labeled_by` are each the measured-unique
  candidate in the committed fixture vector (`corpus/vectors-coverage.json`,
  `desktop-windows`); `desktop-windows-gaps` is an empty object. The coverage lock
  requires every emitted strategy to be either covered or a gap-with-a-reason (the
  union equals the emitted set), so no strategy is ever silently dropped.

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
  the gitignored `corpus/out/` can't leak into the lint baseline). Their gap/fail
  findings live in `packages/shared/tests/fixtures/sufficiency-baseline.json`.

## Adding or retiring a session

Add: create `corpus/sessions/<id>/` (pages, script, truth per the doctrine above),
register it in `corpus/manifest.json`, produce, review the truth line-by-line,
regenerate and review both baselines. Retire: never delete silently — set
`"status": "retired"` in the manifest with a reason (and issue link); the
entry stays listed. A session that cannot pass CI reliably across its retry
budget is redesigned or retired — never relaxed into meaninglessness.
Removal decisions belong to the maintainer.
