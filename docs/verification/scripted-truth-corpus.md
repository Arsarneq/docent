# Scripted-truth capture corpus

The "capture completeness" artifact of
[Replay Sufficiency — Falsifiability, item 3](../requirements/replay-sufficiency.md#falsifiability):
controlled pages where the input sequence itself is scripted, so CI diffs the
produced recording against known truth. This is the artifact that catches
missing-action capture gaps, which neither the schema, the sufficiency lint,
nor any locator machinery can see.

Nothing here replays a recording or resolves a locator. The corpus produces
`.docent.json` envelopes from scripted input and compares them to committed
truth files — Docent ships no consumer, and this directory is a repository and
CI artifact only (excluded from every release, like `reference-implementations/`).

Each rule this document makes in its own right carries a stable identifier
(**STC-n**) so other documents, reviews, and checks can cite it precisely. Identifiers are never renumbered; a retired
identifier stays reserved and is never reused. How each rule is verified — by
an existing named check, by a check that could be built, or by judgment — is
recorded per rule in the [clause registry](../clause-registry.json). The key
words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as described in
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119). Keywords appear on a
clause's operative requirement where it has one; definitional clauses bind as
stated without a keyword, and subsidiary absolutes inside a clause inherit its
force. A clause's scope runs from its marker to the next marker or heading;
identifiers reflect minting order and may appear out of numeric sequence.

## Truth doctrine

- **STC-1.** **Truth is derived from the script and the
  [capture principles](../architecture/system/capture-principles.md), never from recorder
  output.** A truth file states what a faithful capture _in the current
  format_ would record for its session's scripted input. Bootstrapping a truth
  by copying a produced envelope is allowed — followed by a mandatory
  line-by-line review against the script; anywhere current capture falls short
  of the reviewed truth, the divergence goes into the known-diffs baseline
  (issue-tagged in the manifest), never silently enshrined into the truth.
- **STC-2.** **Corpus diffs cover only current-format-expressible capture defects**:
  missing/extra/wrong actions and wrong field values. Facts the format cannot
  state (viewport, start URL, hover, readiness…) are the sufficiency lint's
  gap-predicate territory — truth files are schema-valid current-format
  documents, so such facts structurally cannot appear as corpus diffs.
- **STC-3.** **CI stays green while known capture gaps are open.** The committed
  `corpus/known-diffs.<platform>.json` is locked in BOTH directions by
  `npm run corpus:check` and `corpus:check:desktop`: a NEW diff is a capture
  regression; a VANISHED diff
  means a fix landed — both fail CI until the baseline is deliberately
  regenerated (the comparator's `--write-baseline` flag) and reviewed. The
  `--strict`/`--lint-strict` flags exist but are CI-wired only once the
  baselines are empty (the gate slice).
- **STC-4.** **Hermetic.** Pages are committed under each session and served from
  loopback at a FIXED port by `corpus/serve.js` — the URL rule is
  `http://127.0.0.1:41730/<session-id>/<filename>` — so URL-bearing fields
  are deterministic; no session touches the public internet.

## Layout

```text
corpus/
  manifest.json                  the session catalogue (id, platform, page,
                                 script or driver, knownDiffIssues, notes,
                                 status)
  known-diffs.extension.json     per-platform both-direction baselines
  known-diffs.desktop-windows.json
  sessions/<id>/pages/           committed HTML an extension session runs
                                 against
  sessions/<id>/script.js        the extension input driver (real Playwright
                                 input only — the recorder drops synthetic
                                 events); desktop sessions name a Rust driver
                                 in the manifest instead
  sessions/<id>/truth.docent.json  the expected envelope (raw, schema-valid)
  sessions/<id>/overrides.json   optional relaxations sidecar
  out/                           gitignored per-run output (produced envelopes,
                                 diff reports)
```

## Run surface

The extension runner is `packages/extension/tests/e2e/corpus/corpus.spec.js`,
with two Playwright configs one level up in `packages/extension/tests/e2e/`: `playwright.corpus.config.js`
produces truth envelopes only, and `playwright.vectors.config.js` is the same
run with `CORPUS_VECTORS` set — the vector-emitting superset (STC-10), whose
truth envelopes are emitted unchanged. The comparator is
`scripts/corpus-compare.js` (normalization and alignment: STC-19 and STC-20;
the relaxation contract: STC-5 and STC-21; baseline mechanics: STC-3).

Local loops:

- **Extension:** `npm run corpus:produce:extension`, then
  `npm run corpus:check`. Vectors: `npm run vectors:produce:extension` runs
  the vectors config, and `npm run vectors:check` chains it with the hygiene
  locks.
- **Desktop (a Windows machine):** the Rust producer
  (`cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml --test corpus_capture -- --test-threads=1`),
  then `npm run corpus:assemble:desktop`, then `npm run corpus:check:desktop`.
  Vectors: `npm run vectors:check:desktop` chains the fixture-only producer
  (`vectors:produce:desktop` — the `v_vector_fixture` filter of the same Rust
  test), the assembler (`vectors:assemble:desktop`, which is
  `scripts/corpus-assemble-desktop-vectors.js`), and the hygiene locks.

In CI ([`test.yml`](../guides/ci.md#path-filtered-test-jobs)) the corpus
artifacts are produced by five jobs:

- **Extension corpus and vectors** — the `extension-e2e-tests` job produces
  both through the vectors config (one superset run: truth envelopes plus
  produced vectors and the produce-stage vector oracle), then runs
  `npm run corpus:check` in the same job.
- **Desktop corpus** — the `desktop-rust-tests` job (Windows) runs the
  producer in its auto-discovered integration tier and uploads the per-session
  event dumps as an artifact; the `desktop-corpus-diff` job (Linux) downloads
  them, runs `npm run corpus:assemble:desktop`, then
  `npm run corpus:check:desktop` (the STC-8 pipeline).
- **Desktop vectors** — the `desktop-vectors-produce` job (the pinned Windows
  image — STC-18) runs the `v_vector_fixture` producer and uploads the vector
  source dump; the `desktop-vectors-diff` job (Linux) runs
  `npm run vectors:assemble:desktop` (the normalized produced==committed
  oracle) and the hygiene locks.

The structural hygiene locks (STC-11) additionally run over the committed
vectors with the shared unit suite, with no producer involved — locally via
`npm run test:shared`, and in CI's `unit-tests` job, which runs the same
suite under coverage (`npm run test:coverage`).

## Comparator and relaxations

**STC-19.** **Comparison is over normalized envelopes.** Before any diff, one
pure, structure-aware pass maps exactly the per-run-nondeterministic field
classes below — and no others — to self-announcing placeholders, symmetrically
on both sides; every field outside the classes MUST compare exact, so an
unknown future field diffs noisily rather than being skipped silently. The
classes:

| Class                                                                     | Rule                                                                                                                                    |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| identifiers (`project_id`, `recording_id`, step `uuid` / `logical_id`)    | ordinal placeholders by first appearance — same value, same placeholder; distinct values stay distinct (`logical_id` grouping survives) |
| wall-clock stamps (`created_at`, action `timestamp`) and `schema_version` | fixed placeholders                                                                                                                      |
| context handles (`context_id`, `opener_context_id`)                       | ordinal placeholders through one shared map — same-context vs cross-context identity survives                                           |
| coordinates (action `x`/`y`; desktop non-null `window_rect`)              | value placeholders; presence vs null vs absence stays exact                                                                             |
| `described_after_ms`                                                      | positive (worker-describe latency) → placeholder; `0` (an input-time describe) stays exact                                              |
| coordinate-mode `selector` (`coord:x,y`)                                  | point placeholder; every other selector stays exact                                                                                     |

The pass walks the envelope structure (project → recordings → steps → actions
→ element/locators), never field names globally, so metadata keys and
narration text pass through verbatim whatever they are named. The scalar class
rules are exported as single-source helpers, and the desktop vector reproduce
oracle (STC-18) reuses them rather than re-implementing them — adding one
oracle-local rule of its own (the selector's above-window ancestry collapse,
applied by the vectors assembler, never by this comparator).

**STC-20.** **Order of operations and pointer conventions.** The comparator
normalizes both sides (STC-19), aligns each step's actions by longest common
subsequence over the action-type sequence — a missing or extra action costs
one finding, never a positional cascade — then applies each declared
relaxation to the truth entry at its pointer and to that entry's aligned
produced partner, and finally field-walks the aligned pairs. Recordings and
steps compare positionally: their boundaries are scripted truth, never aligned
around. Pointers in sidecars (STC-5) and in `missing-*` and `wrong-field`
findings index the truth document; `extra-*` findings carry a `produced:`
prefix.

**STC-5.** A session may carry an `overrides.json` sidecar of **relaxations**,
and the comparator holds them to a closed contract: the relaxation kinds are
exactly `match-stats`, `scroll-amounts`, and `path`; sidecar pointers index
the **truth** document, and relaxations are alignment-scoped on the produced
side — never raw produced positions; a `match-stats` relaxation is
locator-entry scoped (its pointer names the entry) and cross-checked against
the entry's strategy; the `scroll-amounts` class map keeps `0` exact and
relaxes only the covered scroll fields; redaction differences are never
relaxable — the comparator refuses the sidecar rather than compare around a
mask. Every sidecar entry must apply to some truth action — an unknown kind
or a pointer that matches nothing is refused. Machinery failures exit with a
distinct code (2), so tooling breakage can never read as a passing diff.

**STC-21.** **Sidecar shape, and what a relaxation may alter.** The sidecar is
the session's committed `overrides.json`, named by its `corpus/manifest.json`
entry's `overrides` key; it declares a `relaxations` array whose entries each
carry `pointer` (a truth pointer, STC-5), `relax` (the kind), and — for
`match-stats` — the `strategy` cross-check field. Each kind MUST alter exactly
its covered fields, replacing values on the truth entry and its aligned
produced partner alike:

- `match-stats` — the named truth entry's `match_count` and `match_index`
  (its produced counterpart is found by strategy within the aligned action);
- `scroll-amounts` — the nonzero values of exactly `scroll_top`,
  `scroll_left`, `delta_y`, and `delta_x` (STC-5's class map keeps `0` exact);
- `path` — the machine- and build-dependent path-bearing string fields,
  `file_path` and `source`.

An entry applies by pointer match — the every-entry-must-apply rule and the
`match-stats` strategy cross-check are STC-5's; application does not require
that a covered field's value actually change. One reach limit: an entry
whose pointer names a truth action inside a step or recording with no
produced counterpart is never reached by the walk, so it fails STC-5's
must-apply gate as unmatched rather than being applied.

## Page-authoring rules

**STC-6.** Pages are authored for determinism:

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

**STC-7.** Input drivers use only trusted-input-safe APIs — an API that
synthesizes untrusted events records nothing (Playwright's `selectOption` is
the known example; sessions drive dropdowns with real clicks and keys). A
driver never uses Tab to move focus off a field it just typed into (the blur
races the input-correlation window); deliberate blurs click a neutral target.
File uploads supply buffer-backed files with fixed names and bytes, never
machine-local paths.

## Desktop truth sessions

**STC-8.** The desktop truth leg reuses the same doctrine with a two-stage
pipeline: a Rust integration test drives real OS input against controlled
windows and serializes the captured events — in the same shape the runtime
emits — to per-session dump files; `npm run corpus:assemble:desktop` then
replays each dump through the real frontend pipeline (the reorder buffer, the
redaction chokepoint, the commit flush barrier's frontend collection path, and
the same shared session model and export the desktop panel uses) into envelopes
for the same
comparator (`npm run corpus:check:desktop`). In CI the producer runs on the
Windows job and uploads the dumps; a separate job assembles and diffs them.

**STC-9.** Desktop sessions are designed to be environment-independent: a
session window is deliberately never raised programmatically (a programmatic
raise succeeds locally and fails on a headless runner — the divergence would
make truths machine-dependent); the first scripted click is the deterministic
activation, and a primer window equalizes the session window's pre-click
non-foreground status across environments (see the retirement rule below for
sessions that stay unstable anyway).

**STC-22.** **Catalogue criterion — what earns a desktop session.** Each
committed desktop session pins exactly one capture behaviour end-to-end from
real OS input: an action-emission class (`d-click`; `d-double-click`'s
two-clicks truth), the activation/foreground proxy (`d-context-switch`), a
correlation gate (`d-selection-gate`), input coalescing (`d-type-edit`), the
redaction chokepoint (`d-redaction`), the scroll significance floor from both
sides (`d-scroll-above-floor`, `d-scroll-floor`), and the capture-mode
fallback (`d-coordinate`). A desktop capture behaviour earns a session when
all three hold: its faithful capture is statable as current-format truth
(STC-2); real OS input can drive it deterministically against a controlled
window under the environment-independence design (STC-9), using
trusted-input-safe drivers (the STC-7 rule, applied to OS input); and it pins
a behaviour no active session already pins — one behaviour per session, so a
red diff names the behaviour that regressed. A known capture divergence
enters with its session — baselined (STC-3) and issue-tagged in the manifest
(STC-1): a defect is baselined, never an admission bar.

## Conformance vectors

Inert data for [docs/technical/locator-resolution.md](../technical/locator-resolution.md#conformance-and-vector-scope)
(Conformance and Vector Scope): committed alongside the sessions whose pages they
reuse, one file per ground-truth element under `corpus/sessions/<id>/vectors/<key>.vector.json`,
shaped by the meta-schema `corpus/vector.schema.json`. A vector carries the recorded
`locators`, the `element_facts` (the captured element **minus** its nested
locators — the non-locator fact source), a `tree_snapshot` of the bound scope,
the `ground_truth` node inside it, and `matched_node_ids` (per candidate, the
snapshot nodes its stated query selects). Only `expected_outcome: "resolved"`
vectors ship. The inclusion criterion — which elements are in vector scope —
is owned by
[locator-resolution §LR-23](../technical/locator-resolution.md#conformance-and-vector-scope);
this document owns the inventory of shipped vectors and the machinery that
emits and locks them. Nothing here executes the resolution procedure.

### Emission (produced, then reviewed and committed)

**STC-10.** A superset of the corpus run, gated on the `CORPUS_VECTORS` env
var so truth production is byte-for-byte unaffected without it. At a non-mutating,
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

**STC-11.** Each lock is a per-candidate match **count** measured over the
committed snapshot, or a committed-field **equality** — never a run of the
resolution procedure. The `"resolved"` guarantee **emerges** from the counts and equalities;
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

**STC-12.** `corpus/vectors-coverage.json` maps each emitted strategy, per
platform, to the committed vector where it is the measured-unique candidate,
at element granularity (extension rows: `session`, `vector`, `element`,
`action_index`; desktop rows: `fixture`, `vector`, `element`). A lock ties
every emitted strategy to a real committed vector — on the desktop, a
strategy may instead carry a recorded reason on the ledger's gap side, and
the union equals the emitted set. On the extension, `role_name` and `label`
are schema-reserved and not emitted, so they are outside the extension's
vector scope.

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
  [docs/technical/locator-resolution.md](../technical/locator-resolution.md)) — so uniqueness
  and `tree_path` are counted over exactly what a query sees at the window.
- **STC-15.** **Locale determinism by authored provenance.** A committed snapshot MUST NOT
  freeze OS-locale strings. `control_type` / `automation_id` / `class_name` /
  structure are kept verbatim (stable, count-relevant); the localized `name` of
  any node that does **not** carry an authored content `automation_id` — whatever
  its tree position, so OS descendants (a scrollbar, a menu item) are covered — is
  normalized to a reserved placeholder. The window root keeps its authored title.
  A content query's value is an authored non-localized string that never equals
  the placeholder, so normalizing OS Names cannot change the match count for any
  content-targeting query.
- **STC-16.** **Fixture-sourced, producer-emitted.** Desktop vectors are sourced from a
  dedicated vector-only fixture window (`corpus/vector-fixtures.json`), not a manifest
  corpus session: it has no `truth.docent.json`, no known-diffs baseline key, and
  no sufficiency-baseline entry. Its `element_facts` + `locators` are captured
  through the real desktop path (never hand-authored); the vector is
  self-describing, so lock (2) checks internal consistency. The vector-carrying
  action is a worker-described one (its element carries measured stats); an
  input-time click element is unmeasured and sources no vector.
- **STC-17.** **Harness-measured `labeled_by` / `tree_path`.** Capture skips match stats for
  these two (`labeled_by` is not a UIA property-condition; `tree_path` counting
  is O(nodes × depth)). The offline harness has no runtime budget, so it measures
  both by evaluating their stated query over the committed snapshot and records
  the resulting `match_count` / `match_index` — derived FROM the snapshot, so lock
  (5) re-derives them. This is the only place a vector's `locators` may exceed the
  captured element, and only on those two strategies.
- **STC-18.** **Reproduce discipline: normalized, not byte-identical.** A desktop
  `element_facts` carries environment-variant fields a static DOM does not:
  `described_after_ms` (worker latency) and a `selector` whose ancestry above the
  window is the virtual-desktop root. The produced==committed oracle compares
  under the **reused shipped comparator class rules** (`scripts/corpus-compare.js`)
  plus one oracle-local rule the assembler applies, symmetric on both sides —
  `described_after_ms` 0-exact / positive→placeholder (comparator classes),
  the selector's above-window ancestry→placeholder (assembler-local) — while
  `element.role`
  (localized) is compared **exact** and is never a corroboration or query input.
  The retained OS-chrome subtree structure is fixed-CI-runner-bounded: produced on
  a pinned Windows image, so an image bump is a deliberate re-baseline
  (reproducibility, not cross-version invariance — the reproduce discipline
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
- **Coverage: all five emitted strategies.** Per the coverage ledger
  (STC-12): `automation_id`, `role_name`, `class_name`, `tree_path`, and
  `labeled_by` are each the measured-unique candidate in the committed
  fixture vector (`corpus/vectors-coverage.json`, `desktop-windows`);
  `desktop-windows-gaps` is an empty object, so no strategy is ever silently
  dropped.

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

- **STC-13.** The corpus does not exercise the side-panel commit/export UI
  (the envelope is assembled through the same shared production functions the
  panels call); panel flows stay covered by the main e2e suite. The desktop
  assembler replays event **arrival order** through the real JS pipeline; it
  does not exercise the live Tauri emit-to-listen bridge, the panel commit UI,
  persistence, or arrival timing.
- A `match-stats` relaxation can hide a `locator-pair-invariants` violation
  from the corpus diff — which is why produced files are additionally run
  through the sufficiency lint (`--lint`) and relaxations are per-entry,
  strategy-cross-checked, and reviewed.
- Truth files are also members of the sufficiency lint's corpus (the
  `sufficiency:check` paths include `corpus/sessions` — never `corpus/`, so
  the gitignored `corpus/out/` can't leak into the lint baseline). Their gap/fail
  findings live in `packages/shared/tests/fixtures/sufficiency-baseline.json`.

## Adding or retiring a session

**STC-14.** Add: create `corpus/sessions/<id>/` (pages, script, truth per the
doctrine above), register it in `corpus/manifest.json`, produce, review the
truth line-by-line, regenerate and review both baselines. Retire: never delete
silently — set
`"status": "retired"` in the manifest with a reason (and issue link); the
entry stays listed. A session that cannot pass CI reliably across its retry
budget is redesigned or retired — never relaxed into meaninglessness.
Removal decisions belong to the maintainer.
