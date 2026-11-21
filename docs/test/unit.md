# JavaScript unit tests

The unit layer of Docent's JavaScript suites: the shared modules in `packages/shared`, the desktop frontend in `packages/desktop`, and the Chrome extension in `packages/extension`, each with its own `tests/unit` directory. They run on Node's built-in test runner against pure modules, injected fakes, and composed schemas, with no browser, no Tauri backend, and no network involved. The machinery and size-budget suites also run against the committed tree and the built artifacts themselves.

Where to look:

| You want to                                                | Go to                                                                                                                                                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find what a test file covers                               | Its tree's table: [Shared modules](#shared-modules), [Desktop application](#desktop-application) or [Chrome extension](#chrome-extension)                                                                                 |
| Add, rename or remove a test file                          | The same table: keep the file's one-line row there in step. `npm run lint:test-inventory` holds each table to its directory, and the paragraph just before [Shared modules](#shared-modules) states the shape a row takes |
| Run a suite                                                | [CONTRIBUTING § Running Tests](../../.github/CONTRIBUTING.md#running-tests)                                                                                                                                               |
| Know whether a suite runs the shipped code or a copy of it | The paragraph right after this table, and [CONTRIBUTING § Single-source logic](../../.github/CONTRIBUTING.md#single-source-logic)                                                                                         |
| See how this layer sits beneath the others                 | [The test pyramid](strategy/test-pyramid.md)                                                                                                                                                                              |

Where a suite does not run the shipped code it describes, it drives an extracted module, a copy of the shipped text, or a replica reshaped from it. A content script and a panel that awaits at the top level cannot be imported under the runner, nor can a module-private function. The service worker imports under the runner behind a fake `chrome` global, which is how the background sync-host and navigation-proxy suites drive it. The copies named in [CONTRIBUTING § Single-source logic](../../.github/CONTRIBUTING.md#single-source-logic) carry parity guards that hold them to the text that ships. The following are reshaped from the shipped code, and pin only themselves where they stand in for it or seed it:

- In the extension tree: the worker's replicated handlers beyond its append chokepoint, its frame-registration fixture, the panel suite's simulated send, cancel and export handlers, and the capture-timing suite's recent-action decision.
- In the shared tree: the settings state-machine suite's panel settings logic and, as fixture seeds, the sync suites' allowlisted projections (their baseline and payload builders).
- In the desktop tree: the settings suite's save and load, and the import suite's stand-in validator.

Where a suite holds the module's output to one of those projections, the projection serves as an oracle there, and a drift fails the comparison.

Every tree is discovered the same way: a `node --test` glob over the test files at the top of its `tests/unit` directory. A file joins its suite by matching `*.test.js` there. A helper beside the tests is outside the suite because its name does not match. A file one directory deeper is outside it because the glob reads only the top level.

Every runner invocation the root and extension manifests' scripts state (`node`, its own flags, `--test`), and every direct one in the test workflow, carries `--import` of `packages/shared/tests/support/git-env-preload.js`. Each test file's process loads it ahead of the file, because the runner forwards the flag to every process it spawns. It drops every `GIT_*` name from that process's environment before the file loads. So a caller's exported git variable (a hook's, a parent git process's, a CI step's) reaches no suite those invocations run. The per-case helpers (a child's scrubbed environment, the in-process scrub, a deliberate poison) stay in `child-env.js` for the suites that read, spawn or poison on purpose. The harness locks in `check-cli-smoke.test.js` hold the preload and its wiring on each of those surfaces.

ESLint reads every JavaScript file under each package's `tests` directory, through `npm run lint:js` and the pre-push hook alike, with each runtime's globals declared in `eslint.config.js`. The commands that run each suite live in the [contributing guide](../../.github/CONTRIBUTING.md#running-tests). How this layer sits beneath the others is in [the test pyramid](strategy/test-pyramid.md), and how its coverage reaches Codecov is in [coverage reporting](strategy/coverage.md).

The tables below enumerate each tree. [`check-test-inventory.js`](../../scripts/check-test-inventory.js) holds them to the directories they describe on every pull request: a test file with no row, or a row naming something the tree's discovery does not select, fails the build. Each row is one line. Its Covers cell states what the file covers in at most 300 characters. A file whose coverage takes more keeps its summary there and ends the cell with a link to a section headed by the file's name after its tree's table, where the rest stands as bullets. The tables are written unpadded under a `<!-- prettier-ignore -->` marker, so editing a row changes that line alone. The same check holds this shape: the cap, the compact form, each Covers link reaching its own file's section, and each such section linked from its file's row, one per file, under that file's tree.

## Shared modules

`packages/shared/tests/unit` — the session model and the format tooling around
it, the sync client with its detection, resolution, and scheduling layers, the
dispatch path, the shared rendering module, and the unit suites of the CI
machinery under `scripts/`.

<!-- prettier-ignore -->
| Test file | Covers |
| --- | --- |
| `abort-on-unretainable.property.test.js` | An inability to retain a version in recoverable form aborts the operation while preserving state, at both points a version is retained. |
| `accept-review.property.test.js` | Accepting a Review-and-Accept item applies the incoming change, advances the baseline per unit, and marks the item applied. |
| `attention-indicator-derivation.property.test.js` | Derivation of the attention indicators from a sync state: which Units need attention, Review versus Conflict, and the row each sits on. |
| `auth-failure-halt.property.test.js` | An authentication rejection halts the cycle and leaves every deferred Conflict and Review recoverable. |
| `backward-compat.test.js` | Every frozen fixture export still validates against the current platform schema composed from its source layers. |
| `baseline-advancement.property.test.js` | The baseline advances only on confirmed agreement or adoption, never on push, at the adopted unit's grain (a recording's entry, siblings untouched, or the whole project); an accepted deletion review clears that grain; a recording agreed in a baseline-less project leaves the project fields unagreed. |
| `brand-new-auto-add.property.test.js` | Brand-new Units are auto-added and recorded in the baseline, while a Unit absent locally but present in the baseline is never resurrected. |
| `build-size.test.js` | Size tripwires over the schema files, which stay lean because both platforms ship them. |
| `capture-active-halt.property.test.js` | While capture is active a cycle starts no work at all, and the same state is allowed to sync once capture ends. |
| `changed-incoming-review.property.test.js` | An incoming change to a locally unchanged recording is deferred to Review whenever the toggle is off or the change is not a fast-forward. |
| `changed-local-outgoing-push.property.test.js` | A routine one-sided local change is pushed automatically, and only eligible Units reach the wire as local. |
| `check-action-pins.test.js` | The Actions pin guard: every `uses:` pins to a commit SHA, with local refs exempt; the two shapes of a read that found nothing are refused on the check's own exit code, and each of the command line's three verdicts is taken over a tree it scans. |
| `check-adapter-surface.test.js` | The adapter-seam admission test. [Detail](#check-adapter-surfacetestjs) |
| `check-area-map.test.js` | The area-map admission test. [Detail](#check-area-maptestjs) |
| `check-capture-surface.test.js` | The capture-surface admission test: both platforms' closed enumerations, the scanned population and the admission list keyed over it, and the extractors' refusals. |
| `check-ci-filter.test.js` | The CI path-filter admission test. [Detail](#check-ci-filtertestjs) |
| `check-clause-governance.test.js` | The clause-governance check. [Detail](#check-clause-governancetestjs) |
| `check-clause-preamble.test.js` | The clause-preamble admission test: the canonical paragraph, its computed per-document variables, and the lowercase-keyword allowlist. |
| `check-clause-registry.test.js` | The clause-registry parity check. [Detail](#check-clause-registrytestjs) |
| `check-cli-smoke.test.js` | End-to-end smoke tests that a check-script wrapper runs green over the committed tree. [Detail](#check-cli-smoketestjs) |
| `check-clippy-invocation.test.js` | The clippy-invocation admission test. [Detail](#check-clippy-invocationtestjs) |
| `check-command-surface.test.js` | The desktop command-surface admission test. [Detail](#check-command-surfacetestjs) |
| `check-doc-closure.test.js` | The doc-closure admission test. [Detail](#check-doc-closuretestjs) |
| `check-doc-reachability.test.js` | The reachability lint: an unlinked document fails, links inside code fences are never followed, and a tracked listing naming no document is refused on the check's own exit code rather than answering over nothing. |
| `check-docs-disposition.test.js` | The pull-request body format check. [Detail](#check-docs-dispositiontestjs) |
| `check-extension-surface.test.js` | The extension-surface admission test. [Detail](#check-extension-surfacetestjs) |
| `check-fresh-clone-setup.test.js` | The documented extension setup check. [Detail](#check-fresh-clone-setuptestjs) |
| `check-licenses-npm.test.js` | The default-deny npm license gate: its denial paths and the SPDX expression evaluation behind them. |
| `check-no-release-outputs.test.js` | The release-output guard's two modes. [Detail](#check-no-release-outputstestjs) |
| `check-npm-advisories.test.js` | The npm advisory gate, whose verdicts its header lists. [Detail](#check-npm-advisoriestestjs) |
| `check-pin-history.test.js` | The pin-history probe over an injected reader. [Detail](#check-pin-historytestjs) |
| `check-pr-title.test.js` | The Conventional Commits title validator, whose verdict becomes the squashed commit subject. |
| `check-proptest-seeds.test.js` | The proptest seed-file check over injected reads. [Detail](#check-proptest-seedstestjs) |
| `check-release-tag.test.js` | A release tag's pre-release suffix and the release's pre-release flag agree in both directions. |
| `check-schema-echo.test.js` | The schema-echo admission test. [Detail](#check-schema-echotestjs) |
| `check-test-inventory.test.js` | The test-inventory lint. [Detail](#check-test-inventorytestjs) |
| `check-tracked-ignored.test.js` | The tracked-but-ignored lint. [Detail](#check-tracked-ignoredtestjs) |
| `check-verification-inventory.test.js` | The verification-inventory admission test. [Detail](#check-verification-inventorytestjs) |
| `check-version-sync.test.js` | The version-table check. [Detail](#check-version-synctestjs) |
| `check-workflow-bounds.test.js` | The workflow-bounds and cache-claims admission test. [Detail](#check-workflow-boundstestjs) |
| `classify-decision-table.property.test.js` | The graded classification decision table is total and correct against an independently re-derived oracle. |
| `classify-deterministic.property.test.js` | Classification is deterministic, settings-independent, and free of user-input or I/O interaction. |
| `classify-schema-change.test.js` | The mechanical schema-change classifier behind auto-versioning, one case per rule and its escalate-when-ambiguous bias. |
| `conformance-vectors.test.js` | Hygiene locks over the committed conformance vectors. [Detail](#conformance-vectorstestjs) |
| `connection-test.test.js` | The connection probe's outcome classification and the settings fingerprint that invalidates a prior pass. |
| `contract.test.js` | Built payloads and export data validate against the platform schemas, which are the source of truth for the shapes. |
| `corpus-compare.test.js` | The corpus comparator: normalization classes, action alignment, relaxations, baseline mechanics, the session walk over an already-parsed catalogue, and its exit-code contract. |
| `decline-review.property.test.js` | Declining a Review keeps local, dismisses exactly that incoming version, pushes nothing, and advances no baseline. |
| `delete-vs-change-conflict.property.test.js` | A Unit deleted on one side and changed on the other is deferred as a Conflict retaining the changed side, at both granularities; a project held in the baseline whose own fields hold no agreement counts as changed, so its deletion on one side is a Conflict too. |
| `deletion-propagation.property.test.js` | A cycle never silently resurrects a deletion and never silently applies one. |
| `digest-unrecognized-fields.property.test.js` | The digest projection admits no unlisted field and invents no listed one. [Detail](#digest-unrecognized-fieldspropertytestjs) |
| `dispatch-cooldown.test.js` | The post-send cooldown that guards a rapid resend, driven by an injectable clock. |
| `dispatch-core.test.js` | Endpoint-URL validation, the send path's error and retry handling, and the payload builder's edge cases. |
| `dispatch-payload.test.js` | Payload assembly with metadata, and the simple-mode step fields it carries. |
| `divergence-conflict.property.test.js` | A diverged Unit records a Conflict retaining both versions and applies no version during the cycle. |
| `docs-disposition-audit.test.js` | The weekly disposition audit's probable-miss labeller, and the shapes it deliberately stays quiet on. |
| `failed-add-isolation.property.test.js` | A failed brand-new add is isolated: that Unit is left unsynced and the rest of the cycle still completes. |
| `fast-forward-superset.property.test.js` | An auto-applied fast-forward requires an append-only superset; anything else is held for Review even with the toggle on. |
| `field-sensitivity.test.js` | The shared sensitive-field and URL redaction: masking on strong signals, and no over-masking of legitimate fields. |
| `gating-parity.property.test.js` | The live-work gating is identical however the cycle was triggered. |
| `generated-validators.test.js` | The generated standalone validators accept valid payloads and reject the cases that matter, the format stamp included. |
| `http-transport.test.js` | The platform HTTP seam: the default global transport, a bound one, the lazy read, and the reset. |
| `idempotent-detection.property.test.js` | Repeated cycles over unchanging inputs neither duplicate a deferred record nor flip a Unit between Review and Conflict. |
| `import-project.test.js` | The shared import builder: a reconstructed project re-exports to a file that still validates. |
| `interaction-free-automatic.property.test.js` | The automatic half of a cycle completes with no user interaction and adopts no deferred incoming change. |
| `internal-failure-blocking.property.test.js` | An internal detection or resolution failure blocks the cycle and leaves the durable store exactly as it was. |
| `item-type-routing-guard.property.test.js` | The routing guard rejects the other type's interface for a deferred item, without mutating any state. |
| `lint-glob-quoting.test.js` | Every root `lint:*` script hands its arguments to the underlying tool in a form both shells deliver intact. [Detail](#lint-glob-quotingtestjs) |
| `lock-unlock-round-trip.property.test.js` | Closing a lock makes the recording eligible again on the very next cycle. |
| `locked-recording-exclusion.property.test.js` | A locked recording is excluded from the inbound merge while every other Unit in the same cycle still reconciles. |
| `locked-recording-push-preservation.property.test.js` | A locked recording stays in the outbound payload at its agreed-or-pulled version, never at its un-reconciled local edits. |
| `next-release-version.test.js` | The commit-to-semver bump classifier and the increment arithmetic it relies on, the release base the bump is applied to (the latest final tag, or the app file when no tag is found), the per-platform suggestion built on it, and the read of a git log larger than the default child-process buffer. |
| `no-baseline-no-one-sided-change.property.test.js` | With no recorded baseline, classification never attributes a change to one side. |
| `no-discard-no-overwrite.property.test.js` | A cycle discards nothing and overwrites nothing without a resolution. |
| `no-permanent-loss.property.test.js` | Across cycles interleaved with resolutions, no committed local step record is ever permanently lost. |
| `no-resolution-execution.test.js` | A repository-level guard that the resolution procedure is implemented in no shipped runtime path. |
| `pending-action-protection.property.test.js` | The pre-flight gate halts before any transport when a recording holding pending actions is unprotected. |
| `per-unit-push-assembly.property.test.js` | The outbound payload is assembled per unit: nothing present on any side is omitted, and no un-reconciled version clobbers the server. |
| `performance.test.js` | Time budgets for the data layer's core operations on large sessions — a guard against accidental quadratic work. |
| `placement-contract.test.js` | Placement and protocol contracts: where the shared logic lives, that both panels import it, the endpoints a cycle uses, the connection probe's use of the read endpoint alone, and the trigger's addition of no request of its own. |
| `policy-settings-scope.property.test.js` | The reconciliation-policy settings move only the local-unchanged cases and never auto-resolve a divergence. |
| `pull-precedes-push.property.test.js` | Every pull precedes every push, and a push runs only after a reconcile that did not halt. |
| `regression.test.js` | Regression cases for the session model: fixes named by the PR that landed them, edge cases by the behaviour they hold. |
| `render-views.test.js` | The shared list and detail rendering functions, and the structure of the fragment they render into. |
| `render.test.js` | The shared rendering helpers: escaping, action description, and the canonical active-view resolver they run through. |
| `reported-counts.property.test.js` | A completed cycle's reported sets equal the sets the cycle actually produced. |
| `resolution-append-only-tombstone.property.test.js` | Resolution preserves the append-only history and never resurrects a tombstoned step. |
| `resolution-clear-vs-retain.property.test.js` | A completed resolution clears its record; one that fails or is abandoned retains it and changes nothing. |
| `resolution-propagates-next-cycle.property.test.js` | A resolution issues no push, and the resolved state propagates on the next cycle per the resolved-against baseline. |
| `resolution-recoverability.property.test.js` | Both versions stay recoverable through a successful resolution, and the retained snapshot is never cleared. |
| `resolve-conflict-fixtures.test.js` | Hand-built fixtures for step histories that are easy to get wrong: interleaved re-records, tombstones, and delete-versus-change. |
| `resolve-explicit-logical-id.property.test.js` | A per-step divergence requires explicit input, and histories are never combined unless the user supplies the combination. |
| `revision-r1-scenarios.test.js` | Hand-built multi-cycle storylines pinning the round-trips the pull-first order enables. |
| `safeguard-composition.property.test.js` | Stamp compatibility, schema validation, and per-project error isolation compose without any of them becoming a Conflict. |
| `schema-composition.test.js` | The layered schema build contract: every platform composes consistently, and each layer keeps to its own scope. |
| `schema-split.test.js` | The per-platform published schemas carry their own platform's content and share the cross-platform definitions. |
| `security.test.js` | Escaping, secret isolation in exports and payloads, import validation, injection scope, and storage-key naming. |
| `session.test.js` | The session model: project, recording, and step creation, step versioning, active-view resolution, deletion, and reordering. |
| `simple-mode.test.js` | Simple-mode step creation and rendering, from creation through deletion and reordering. |
| `stamp-compatibility.test.js` | The stamp check that classifies an incoming payload's format mismatch with an actionable reason. |
| `sufficiency-lint.test.js` | The replay-sufficiency baseline lock over the lint's standing corpus, in both directions, plus a pin per predicate. |
| `sync-baseline.test.js` | The baseline read and advance helpers, including the recoverable deep copy each advance records. |
| `sync-capture-toggle.test.js` | Capture beginning while a cycle is in progress: the work in flight completes and no new work starts. |
| `sync-client.test.js` | The shared sync client: its push, pull, and cycle functions against a stubbed `fetch`, and the payload builders and pull projection called directly — held to the composed schemas and to each other. |
| `sync-conflict-ui.test.js` | The shared resolution-workflow renderer: each item's controls, the wrong-interface redirect, and the indicators that open it. |
| `sync-interruption.test.js` | Interruption and concurrency edges: partial failures reported accurately, and no duplicated projects. |
| `sync-large-payload.test.js` | Large projects round-trip through push and pull without truncation, corruption, or shape loss. |
| `sync-scheduler.property.test.js` | The cooldown-debounced scheduler's invariants over arbitrary interleavings of triggers, settles, and restarts. |
| `sync-scheduler.test.js` | Focused example checks of the scheduler's coalescing state machine and the trigger that drives it. |
| `sync-settings-state-machine.test.js` | The policy toggles and the background-sync enable state machine, driven against the real shared settings layer. |
| `sync-store-roundtrip.property.test.js` | A sync state survives a save and load round trip through the store adapter. |
| `sync-store.test.js` | The deferred-item record helpers: idempotence, mutual exclusion, the none state, and the client-local settings. |
| `uuid-v7.test.js` | UUID v7 generation: format, monotonic ordering, uniqueness, and the comparison helpers around it. |
| `validate-import.test.js` | The shared ingestion validator wrapper: its bounds checks and its delegation to an injected schema validator. |
| `vector-meta-schema.test.js` | The conformance-vector meta-schema module, whose committed-vector walk (`committedVectorFiles`, each vector parsed) the suite reads the committed vectors through. [Detail](#vector-meta-schematestjs) |

### `check-adapter-surface.test.js`

- The derivation of the concrete adapters from the filename rule, and the test trees and contract file it leaves out.
- The derivation's refusals and the below-two red.
- The diff against the seam document's own link targets.
- Both held directions between the typedef and each derived adapter's default-exported literal, the platform-specific member it admits, and the decoy literals beside it.
- The key and value positions a template literal can stand in.
- The extractors' refusals.
- The command line, run over a scratch repository the derivation can read.
- Its tree reads and its spawns run clear of the `GIT_*` environment through the shared suites' one child-environment home, which a regression case holds under a poisoned index.

### `check-area-map.test.js`

- Each way the map can rot.
- The pattern semantics that make its coverage total.
- The necessity an exception and a declaration each earn, file by file.
- The place an area earns by supplying what the rest of the map does not.
- The read and compile boundaries' refusals.
- The shared segment compiler, held to the map's own semantics and admission.
- The declared and expanded governing sets.
- The per-file explanation mode.
- The brace expansion, held to its one home, reached through the compile idiom.

### `check-ci-filter.test.js`

- Each way the workflow's filter split can drift.
- The exported literal/glob matcher, read through by every case that splits an entry.
- The locator contract both filter-map readers reach the filter step by.
- The reader the command line and this suite share: each input observed on its own, and the closure together with the wrapper's own call by a source lock over the check's text.
- Each held flag's holdings map (`SUITE_HELD_HOLDINGS` and the per-flag maps in `HELD_FLAG_HOLDINGS`), held to its filter in both directions.
- The duplicate-entry leg.
- Each heavy job whose own closure is non-empty, held to gating on `buildScripts`.
- The redundancy between the ciCore legs.
- The command model, form by form.
- The closure walk over a synthetic tree on disk: the npm-run chain and its cycle guard, a flagged `node` entry, the import and spawn edges, an entry outside `scripts/`, the forms read as no invocation, and the `scripts/`-relative over-include.
- A real-tree lock over the committed workflow.
- The CI guide's flag bullets and flag-exception sentence, held to citing the holdings maps and to naming no file a filter lists.
- Each holder suite's header, held to naming the map it points at.
- The step reader this check and `check-doc-closure.js` share:
  - The job's own steps, whole and in order.
  - The empty list for an absent job, a job stating no steps, and a `steps:` block that is not a list (a string and the mapping shape a bare walk ends its run on alike).

### `check-clause-governance.test.js`

- A cited path owes the clause's own doc, and a cited pattern owes it for every file it names, reported one finding per pattern.
- A recorded exception is keyed by the citation token, so one granted to a pattern answers for the whole set that token names.
- A cited governing doc owes itself alone.
- The shared tokenizer's own citations, held from both sides: recorded where the clause's doc sits outside its declared governance, reported stale where it sits inside.

### `check-clause-registry.test.js`

- Marker and row agreement.
- Citation resolvability, including patterns and the shared split-and-edge shape.
- The closed row grammar.
- Cases resolved against a cited JavaScript or Rust file's declarators.
- The runnable-check predicate.
- The server-binding floor: a `check-exists` row that pins its clause on the reference server's suite names the reference server, and the reference server's suite directory it keys on is held to the tree.
- The lock surfaces.
- The map's and fixtures' citations.
- Read failures under the tree's own subject.
- The refusal the read of the registry itself raises, and the one its surface red states for a map it cannot use. Each names what it found: a file it could not read, text that is not JSON, or text that is JSON but not the map object.
- The built fix block.

### `check-cli-smoke.test.js`

- Every invocation here is deterministic-green against the committed tree, pins every variable its target reads itself and, from the shared suites' one child-environment home (`packages/shared/tests/support/child-env.js`), runs clear of the `GIT_*` environment a spawned git answers to. That is the property a case is admitted on.
- The harness locks beside them prove that home holds for every suite importing it:
  - The child scrub.
  - The environment-pinning helper putting back what it pinned: a name that carried a value, one that did not, and the path where its body throws.
  - The in-process route running its work with no `GIT_*` name set and putting each one back.
- The runner-level preload beside that home: every runner invocation of the root and extension manifests' scripts and of the test workflow's direct steps (`node`, its own flags, `--test`) is followed by `--import` of it, and it strips a poisoned environment from a test process the runner spawns, the control without it red.
- The red paths stay with each script's own unit tests.

### `check-clippy-invocation.test.js`

- The run lines read out of the workflow.
- The gates row, read through the doc-closure reader.
- The stated spans a fenced or multi-line one never joins.
- Each disagreement between the three.
- The register, held from both sides.
- The refusals:
  - A workflow stating no clippy step.
  - A clippy step carrying a quote.
  - A guide whose gates table states no Clippy row.
  - A read or a parse that throws.
  - A guide listing narrowed below the guides the scan must read.
- A real-tree lock.

### `check-command-surface.test.js`

- Every red-path family.
- The derived channel's emit, listen, and clause-prose sides:
  - That prose, read for the channel's absence and for a foreign channel-shaped token standing beside it.
  - The event row, refused where it states a channel that read cannot see, with the token shape's near misses, its grant exemptions, the same-shape tokens that name no channel at all, and the residue the two shapes leave between them pinned against both readers.
  - A partial rename over the real document.
- The grant enumeration, read as the clause section's list:
  - Held both ways against the capability files.
  - An item whose first backticked token is not a grant, refused by name in one line.
  - A grant listed in two items, refused as a duplicate.
  - A list whose every item is refused still running every other leg.
  - Every other grant mention held to membership in it, over synthetic text and over the real document with an item removed.
- The comment and fence strippers beside the strings-blanked anchor view.
- A real-tree lock.

### `check-doc-closure.test.js`

- Each closure leg of the guides and the job partition.
- The registered script-key citations, held in both directions.
- The runner cells, read through each table's own grammar, and the act verdicts against the boundaries the workflow states.
- The diagnosis for a workflow with no top-level `jobs:` key. Its wording lives in this check alone, and another check that acts on the condition asks `isJobAnchorProblem` instead of repeating the words.
- A real-tree lock.

### `check-docs-disposition.test.js`

- Its red paths.
- Each declared class that skips the sections, and the head-repository derivation deciding the release-automation one.
- The welds onto the committed surfaces it reads:
  - Both publish workflows to the automation branch and to one generated body apiece.
  - CONTRIBUTING's exemption paragraph to the fields the exemption reads, and to citing the release-output surface by its home.
  - The governance line CONTRIBUTING fences and the PR template scaffolds, to the constant the check builds its own output from.
  - The per-doc grammar CONTRIBUTING fences and the template scaffolds, to the same forms the check's own red output renders from.
  - The clause example's anchor, to a clause the registry carries as judgment-only.
  - The mutation cadence, to the workflow schedule that is the fact (its trigger set and each cron field read on its own, the cron's comment included), and to each prose surface restating it at that surface's own site.
  - Each scheduled workflow's guide cell, section and cron comment, welded to that workflow's own cron.
  - The cron-derived cadence word, bound to the shipped one.
- Every section is cut by the shared heading slice, so a fenced heading neither opens a section nor ends one, a line written directly under the heading is a line of it, and a bare `##` marker whose title sits on the next line states no section.
- Each reader of a section's interior takes that same code-block-blanked view, so an illustration written inside a code block, fenced or indented, credits no document, states no governance line and marks no change record. A line indented four spaces under the heading credits no document in the per-doc lines, where the same line at the margin does. A line under a fence run inside a `<details>` block written with no blank line after its opener, by contrast, is a line the body shows and is counted as one.
- Each of those readings answers the same for a body delivered with CRLF endings as for one written with LF.
- The lines the red output prints for pasting, taken off it and pasted back as live lines.
- The scope a changed file resolves to when its name carries a non-ASCII byte, held beside the ASCII sibling it must answer alike.
- The shipped template, audited as-is so its guidance comments stay inert.
- The refusal it prints for each governance-data file it reads:
  - For the map, one that no longer fits the shape read through it and one whose text is not JSON.
  - For the registry, one whose text is not JSON and one it cannot read at all.

### `check-extension-surface.test.js`

- The manifest's permissions.
- The dispatcher, read over the derived background population (one switch, standing in the service worker), and the literal shapes its type reads accept.
- The asymmetric capture-path pair beside the population's own machinery guards (the table held forward to the service worker's guards, held back from every guard the population makes).
- The panel's literal sends against their documented enumerations.
- The clause's own sender statement, held present in the clause's scope: the absent, duplicated (in a paragraph of its own and inside the one the claim already sits in), moved-out, and fenced readings, with the fail-closed form pinned.
- The capture-path payload weld over the derived content population:
  - That population's own machinery guard, which answers a file list naming nothing on its own line.
  - The callee grammar the send scan reads: the receiver written bare and written under each global-object qualifier, the step forms plain, optional, computed and optional computed, and the optional call, each read as one site; and the alias of the receiver, the unqualified and the destructured callee, the platform object reached through another object or a private field, and a `sendMessage` on a port or a wrapper receiver, each locked as contributing none.
  - The types its sends state, diffed both ways against the table.
  - The hold per send site, each site held to the whole row, so two copies of one send meet it together and two sites that differ are each named.
  - The Payload cell grammar and each near miss it refuses.
  - The shapes a key position can stand in that hide a name (a method, an accessor under a bare or quoted name, a generator), and the keys no cell could state.
  - The column-name locks, holding each spelled column to a name its own header carries.
  - That clause's payload statement and the recorder paragraph's own existence claim, each held present the same way.
- The introspection handle's member surface:
  - The anchored freeze the members are read from, and each refusal around it.
  - The member diff in both directions.
  - The reach test against the worker's own module-scope bindings, with the identifiers a healthy tree leaves outside it pinned green.
  - The per-member weld holding each row and its member's body to one another in both directions.
  - The cell grammar the Reaches column is read by, and each near miss it refuses.
  - The grammar sentence and the clause's own closure sentence, each held present in the clause's scope exactly once.
  - The mention count over the production population that keeps the handle out of every module but the one that assigns it.
- The panel population's own machinery guard, which answers a file list naming nothing in place of the quiet-send line.
- The agreement lock holding each of the wrapper's population arguments to the derivation it is assigned from rather than to a spelling.
- The one key test both object scans read, spelled once where the predicate is defined and reached by a call at each scan.

### `check-fresh-clone-setup.test.js`

- The Chrome Extension block, read from fixture documents and from the committed guide:
  - One bash block, comment and blank lines dropped, and a `#` line inside the fence neither ending the section nor kept.
  - Two blocks, a block fenced `sh`, a missing clone line, a missing section and each refused line shape refused, and the admitted shapes kept.
  - The committed guide's commands.
- The script built from them: the trap's quoting, one group and status per line, the clone pointed at the checkout, the schema copy's test and the green sentinel last.
- The run path in process: drift at a failing line or a missing schema copy, green, and the machinery verdicts (a failing clone, a status or signal no line owns, an early exit, a failed lookup, temporary directory or document, a bare `--doc`). Each run leaves no temporary directory behind under a path carrying a space. With it, one spawned entry-point dry run over the committed guide.

### `check-no-release-outputs.test.js`

- A feature branch touches no release output, and the automation branch carries nothing else.
- The head-ref derivation and the mode switch, over each shape the CI inputs arrive in.
- Each guard step's own env block, held to the event fields that derivation reads.
- The automation branch's name, held to the contributor-facing documents that spell it out.
- The paths it reads from the diff and from the working tree, taken as git writes them, so a name carrying a byte outside ASCII reaches the guard whole.
- The status records the drift reading takes, a rename among them, whose trailing entry is the name the file had rather than a record of its own.

### `check-npm-advisories.test.js`

- The verdicts are driven through the gate, with fixture reports fed through its audit seam.
- The list and date rules and the report reader are exercised directly.
- The audit command is reached only through its spawn seam, so the suite never runs npm.
- Each npm root is judged on its own.
- The audited roots are held to the tracked lockfiles and to Dependabot's npm entries.

### `check-pin-history.test.js`

- The references grouped into pins by upstream, a subdirectory action under its repository, and local and tag references passed over.
- Each verdict the command line takes:
  - The green line stating its counts.
  - A pin ahead of or diverged from its base.
  - A compare answering 404, and an upstream whose repository answers 404.
  - The machinery verdicts (a status outside those the probe reads, a network failure, a lookup naming no default branch, a compare status it does not read, a scan that read no pin).
  - The rate limit, which stops the probe and is reported once with the remedy that fits an anonymous or an authenticated run.
  - A machinery failure on one upstream, reported beside a pin problem another upstream showed.
- The compare made against the base the lookup returned.
- The real reader's request shape over an injected `fetch`.
- A real-tree case holding the scan to reading pins from the committed workflows.

### `check-proptest-seeds.test.js`

- A reviewed file passing with its counts stated.
- A header-only file passing with zero seed lines.
- Zero files passing with the count stated.
- An altered or truncated header reported once at its first diverging line, with the seed lines from it on still audited.
- A seed out of form (wrong length or case), red with its line quoted.
- A seed line carrying no review note, and one whose note is not in the reviewed form, each red naming file:line with the line quoted.
- A line of no seed shape, a review note dated on no calendar day, and one with no reason, each red.
- The closing advice pinned for each problem kind, and joined when several redden.
- An unreadable file as the machinery verdict.
- CRLF line endings read as the same lines.
- A seed file in proptest's in-crate layout (a `.txt` file under `proptest-regressions/`), passing when reviewed and redding naming file:line when not.
- A real-tree case holding the committed seed files to passing.

### `check-schema-echo.test.js`

- Each echo of the composed schemas in both directions:
  - The sync protocol's payload tables against the schema root and the project and recording defs among them, with their selection refusals.
  - The sync document read empty or not at all.
  - The coverage leg over that document's `Field`-headed tables in both directions.
- The register leg's two refusals (a pattern citation, and a Markdown-reaching token naming no path the leg can match), and its reading of emphasis and of separator-carrying prose.
- The command line's machinery and drift exit codes over copied trees.
- A real-tree lock.

### `check-test-inventory.test.js`

- The inventory, coverage-list, and kill-set red paths.
- The row-shape class over an opted-in inventory (the Covers cap, the compact form, the detail links and headings, a mixed-case file name's anchor, one file's detail sections in two trees, a heading-shaped line in a code block).
- The mutate-scope agreement and dead modules.
- The registration closure.
- The undiscovered-binary admission by either route.
- The kill-set membership legs:
  - The specifier classification and its refusal.
  - The dynamic-import edge and its computed non-edge.
  - The property precedence and the mixed residue.
  - Both directions of both engines' test-surface leg.
  - The in-module entry's presence.
  - The import-aware integration classifier.
  - The module leg and its empty-expansion refusal.
  - The `pub use` guard.
  - The `cfg(test)` reading each side of the Rust walk is compiled with: the outer attribute's item, the inner attribute's block and its file-level form, a gate a comment or a string merely quotes, the re-export count taken over the whole source either way, and the crate module and the integration target read as each is built.
  - The one refusal each distinct refusal text states (the file, and the specifier where one is involved) however many walks meet it, and the allowlist held from both sides.
- The shared tokenizer's token streams and its reading of regular-expression literals.
- The blanked-literal view that renders the same scan in both of its readings.
- The Rust comment-stripped view.
- The lone-literal reader.
- The declarator read that answers where a token stream states a test case and with what title.
- The shared doc-scan primitives:
  - The subsection tag, whole-header selection, and the column and whole-span readers.
  - The column reader's named form: a header cell addressed by its name, matched against the trimmed header, and its refusal of a name no header cell carries.
  - The fence model's reading, which is CommonMark's own except for one departure: a lone carriage return is read as part of its line. A code block opens wherever CommonMark opens one (in a block quote, on a list-marker line, at the indents each container allows) and is blanked line for line. So a nested example stays fenced, an info string carrying a backtick opens none, a raw HTML block's own text stays live, and an unclosed fence runs to the end of the block that holds it.
  - The one heading slice both readers cut a section with.
- The object-literal walk, the brace-bounded case collector, and the source-scanning welds read over the real tree.
- The self-path derivation: its binding leg over the scripts and the shared suites less its own file, and its hand-copy scan over the scripts.
- The literal-to-pattern escape: no tracked check or shared unit suite re-spells the class, and every caller among them takes the primitive from its home.
- The quotepath policy, stated in one docblock with no second copy under `scripts/`. The reading it names is driven over three names: one carrying a non-ASCII byte, one holding a newline where the platform can write one, and one padded with spaces. Each is held against the reading git gives without it, read from the repository the caller names and answering with nothing where git names nothing.
- The return shape of each audit the check declares with `export function`, held to its own `@returns` tag.
- The real-tree locks. Among them, the desktop integration suite's `describe > test` paths are held distinct across its directory, which is the whole of that lock. Where a full path is stated by more than one file elsewhere in the tree, the repetition is what the tree means: the platform adapters' suites under the same titles, a dispatch suite's payload cases stated beside another's, check suites' same-named real-tree locks. A bare title repeats wider again.

### `check-tracked-ignored.test.js`

- The two questions put to git, the ignore question and the index-mode one, each with the flags it deliberately carries and omits.
- The reading of their answers, including the mode question's own refusals, an answer naming no entry and a record the read does not model, against the ignore question's empty answer as its green.
- The link verdict, which names a path and its mode and never the link's target.

### `check-verification-inventory.test.js`

- Each inventory against what it describes.
- The strict-flip watch.
- The job-suite leg, with the named job's own steps resolved to the argument set their commands state:
  - Continuations are joined first.
  - A step resolves through the root manifest's scripts where it names one, and from its own command text where it spells the invocation out.
  - The registered glob is taken off the discovery descriptor rather than spelled.
  - The carrying command is held, on either side of the `npm run`, to one plain command, standing alone on the only command line it states as an invocation this reading models, with the flags of that invocation it admits (named in the check) and a `--test` plain but for `--import` of the git-environment preload, the one flag the argument reader admits after it (held in `check-test-inventory.test.js`). The refusal names the shape, the word or the flag it found.
  - A flag outside the sets the check names, refused rather than read.
  - A command after a `cd`, left unread, with the step it stands in named beside the finding where what follows the `cd` could have carried a suite.
  - A `working-directory` that moves the command, stated for the step, the job or the workflow root, refused so another manifest's same-named script cannot answer for the root one.
  - Each refused by name: a segment stating a modelled invocation somewhere other than its own head, a script key this reader cannot read, a run-verb flag that answers that key from another package's manifest, a verb that runs a manifest script and this reading does not resolve, or an argument list that could not be read whole.
  - Refused by name beside them: an `npm run` the root manifest defines no script for, and a command the argument reader will not model.
  - Refused beside the suite-absent finding: a carrying command that does not stand alone, a step carrying the suite under a condition, and a truthy or expression-valued tolerance or an environment key this reading cannot evaluate.
  - The tolerance and that key, stated above the step, refused as the job's.
  - The job, the scan and the registration, each refused by name.
- The exit-code contract.
- The leg set the check exports, held to its header docblock both ways and rendered into its success line.

### `check-version-sync.test.js`

- Each committed table, read row by row against the schema versions the leaf delta files carry. A swapped pair, a duplicated row, a missing one, and a version that is only a substring of the stated one each red.
- The platform roster the check shares with the release-time scripts that have no suite of their own (the version-table writer and the manual bumper), read by each from the schema builder that states it:
  - The writer refuses a key the roster no longer states.
  - The bumper accepts exactly the keys it does.
  - The builder's chain roster and its surface roster are held to the same key set, so a platform stated in one of them cannot ship without the other.

### `check-workflow-bounds.test.js`

- The bound each job states, the reusable-workflow caller the platform bounds elsewhere, and the steps' bounds summed below the job's own, with an unbounded step outside it.
- The workflow-file boundary it reads through, and the one read a run gives each workflow: both leg sets over it, and the refusal order an unshared read would raise.
- The CI guide's key-families and pinned-tools tables, both ways:
  - A cache no row describes, and a row describing none.
  - An identity cell that is not one backticked name.
  - Each cell read by the column that names it and held against the surface answering for it (the local-CI guide's own subsection for the doc-mention column).
  - A restore and its save stating different path lists.
  - Two family names nesting inside one exact path list, and one name stated twice there over one hash input.
  - Each family's own prefix first in its restore keys, with a fallback reaching an entry under a shared stem refused and one reaching a different stem left alone.
  - A coverage job's cached `target` tree, keyed on its own toolchain step's `cachekey` in the family prefix and in every fallback. That step is the toolchain action itself, unconditional and ahead of the first cache step. A job measuring nothing or caching no `target` tree is left alone (#700).
  - A split save stating no gate, read as unconditional.
  - The guide subsection those cells are read from, cut by the shared heading slice so a heading stated more than once yields its first run.
  - A key's version segment, install pin and guide version, held to one another.
- The shapes it refuses on its own exit code rather than passing vacuously. [`check-workflow-bounds.js`](../../scripts/check-workflow-bounds.js) is the home of the complete set. Among them:
  - An input it cannot read, that reads empty or will not parse.
  - A block that is not the map or list it reads there, through each seam a job is reached by.
  - A bound that is not a literal positive number.
  - A cache step stating no path list or key.
  - A key group it cannot pair or a key it cannot split.
  - Two entries claiming one identity.
  - A table selected other than once or stating no row, one stating no column a cell is read by name from, one stating a column no claim answers for, or one whose header states a column name more than once.
  - A class or subsection yielding nothing.
- The CLI's verdicts over committed copies.
- A real-tree lock.

### `conformance-vectors.test.js`

- Per-candidate match counts and committed-field equalities, per platform; lock (5) re-derives every eligible candidate's recorded `match_count` and `match_index`.
- Beside the meta-schema case, a per-vector case holding each vector's `element_facts` + `locators` to the element check (the platform element definition and the locator pair rule).

### `digest-unrecognized-fields.property.test.js`

- Unrecognized top-level server fields are dropped before hashing, so they can never shift content identity.
- An allowlisted field's presence is copied rather than defaulted (an absent `metadata` and an empty one stay distinct), while its value is canonicalized.

### `lint-glob-quoting.test.js`

- No script's argument is single-quoted; each glob is double-quoted and resolves to files.
- The pre-push hook's ESLint call reaches every tree `lint:js` does, except the ones the CI guide names as CI's alone.
- The hook's rustfmt call runs only when a pushed file is one rustfmt reads.
- Every tracked JavaScript file under `packages/` is reached by `lint:js` or ignored by the configuration.

### `vector-meta-schema.test.js`

- Its shipped outcome equals the meta-schema's const.
- Its validator (`metaSchemaErrors`) names each seeded violation.
- The vector emitters stamp that outcome and reproduce each committed vector from inputs rebuilt from it.
- Its element check (`elementCheckErrors`) returns exactly the errors of each seeded element mutant on both platforms.
- The desktop assembler, over seeded dumps that include one for every committed desktop vector, holds its exit code and messages: the produce-stage meta-schema and element-check gates, and the completeness rule. That rule fails a run in which a committed desktop vector is not reproduced (a drifted element id or tag, a renamed fixture), while a fixture with no committed vectors bootstraps.

## Desktop application

`packages/desktop/tests/unit` — the desktop frontend's adapter to the Tauri
backend, its persistence, export, import, dispatch, and settings paths, and the
ordering buffer the capture stream arrives through. The Rust side of the
application has its own suite, documented in
[Desktop Rust tests](desktop-rust.md).

<!-- prettier-ignore -->
| Test file | Covers |
| --- | --- |
| `adapter-tauri.test.js` | The Tauri adapter: settings, theme, recording mode, schema loading, send, the completeness-barrier wrappers, redaction, and the panel's mirror-back beside a seam save over one shared session store — the interleave between the adapter's round-trip and the panel's whole-blob save. |
| `auto-sync-host.test.js` | The desktop background sync host: one shared cycle, coalesced triggers, triggers dropped while capture runs, and the failure policy. |
| `build-size.test.js` | Size tripwires over the built desktop bundle: the JavaScript budget and the total. |
| `dispatch.test.js` | The desktop dispatch service: settings loaded and saved through the backend, the reading guidance, and schema loading. |
| `export.test.js` | A built export validates against the desktop schema contract and carries every recording, full step history, and project metadata. |
| `import.test.js` | A duplicate import produces a distinct copy, and a non-conforming file is rejected with the local list unchanged. |
| `integration-suite-locks.test.js` | Locks over the desktop integration suite. [Detail](#integration-suite-lockstestjs) |
| `persistence-unit.test.js` | The persistence module's public surface, from the empty state through the load and save paths. |
| `persistence.test.js` | Serializing a session state and reading it back yields an equivalent state. |
| `reorder-buffer.test.js` | Ordered insertion over the adapter: sequence ordering, immediate delivery, completeness, id stripping, in-place redaction, and the held keys an action names once its step is complete. |
| `rust-action-types-lock.test.js` | The Rust action-mapping test's `VALID_ACTION_TYPES` list equals, as a set, the action types the composed desktop schema declares. |
| `schema-validation.test.js` | Desktop export data validates against the desktop schema composed from its source layers, negative cases included. |
| `settings.test.js` | Dispatch settings survive a save and load round trip. |

### `integration-suite-locks.test.js`

- Its specs read the shared shapes from the fixture rather than re-declaring them.
- Its specs reach the mock's invoke record only where the lock allows. On a comment-stripped view, every mention of `_getInvokeCalls` over the spec files is held to the one settle probe the lock names, and `_clearInvokeCalls` to no mention anywhere, the probe included. The scan reads the spec files only, and escaped spellings and computed names are unseen.
- The fixture's shared-helpers section and the suite guide's shared-helpers section name every helper the fixture declares with `export function` or `export const`, the mock-server installer excepted. The fixture's section is read from its rule-line heading to the next, and the guide's from its bold lead-in to the next bold lead-in or heading.
- The guide's configuration sentence states the values `playwright.config.js` sets.
- The tree keeps plain UTF-8 without a byte-order mark or double-encoded text.

## Chrome extension

`packages/extension/tests/unit` — the extension's adapter, panel, and background
paths: the capture logic extracted from the content script, the service worker's
message handlers and navigation listeners, this tree's parity guards, named in
[CONTRIBUTING § Single-source logic](../../.github/CONTRIBUTING.md#single-source-logic),
and the static-source guards over what the content script and the service
worker may contain. The browser-driven
half of the extension is documented in
[End-to-end tests](e2e.md).

<!-- prettier-ignore -->
| Test file | Covers |
| --- | --- |
| `adapter-chrome.test.js` | The Chrome adapter: settings, theme, recording mode, schema loading, the pending-count and action-event subscriptions, and send. |
| `auto-sync-host.test.js` | The background sync host wired in the service worker: one shared cycle, run headless, with its state persisted for the panel, and a cycle requested by a stop the panel sends while capture is off. |
| `build-size.test.js` | Size tripwires over the extension bundle, per type and in total. |
| `capture-timing.test.js` | The capture-timing constants' validity and relative ordering, and the recent-user-action decision they drive. |
| `control-channel-host.test.js` | The local control channel's host, run against the shipped module with a fake socket: off by default, one code per turn-on, the export grant fixed at turn-on and the trace of each export, redialling and its cap, and every route that turns the channel off. |
| `control-channel.test.js` | The local control channel's pure core: the loopback address, the pairing code and the labelled proof in each direction, the indicator's export line, frame parsing, the closed command set and its bounds, and the session's pairing and command handling. |
| `control-commands.test.js` | The mapping from a control-channel command to a panel action: the state each command needs, its refusals, and its result. [Detail](#control-commandstestjs) |
| `dispatch.test.js` | Settings round-trip, endpoint validation, payload fidelity, the authorization header, and the action-event subscription. |
| `e2e-suite-locks.test.js` | The end-to-end guide's retry, attempt, trace, timeout and worker sentences held to the Playwright config, each key read as text and set exactly once. |
| `frame-trust.test.js` | The per-frame trust predicate deciding whether an appended action may enter a recording. |
| `held-keys-relay.test.js` | The keys held across a tab's frames: named to its other frames; forgotten at a release, a blur, a drag, the Meta key's release, a frame's leaving and a new recorder in a frame; handed over at a pointer press; the watch an action's keys are taken through; one recorder's numbered reports. |
| `naming.property.test.js` | Extension actions carry the platform-neutral naming and capture mode the extension schema contract states, each type one the composed extension schema declares. |
| `navigation-logic.test.js` | The navigation and tab-creation capture decisions across transition types and timing states, and a static-source guard that the worker's listeners decide through the module. |
| `panel.test.js` | The send gate in the panel, run against the shipped send-gate module: button state, recording selection and the confirmation summary; the cancel path is simulated. |
| `project-export.test.js` | The panel's export build, run against the shipped module: the project open in the panel asked for by its id, the stamped document, and failures answered in-band. |
| `recorder-logic.test.js` | The extracted content-script logic (selectors, locators, element description, the key-press decision with its shortcut modifiers, the sensitive-element and no-typed-text rules held equal to the worker's, part-by-part fields, the scroll decision) and the recorder's scroll literals. |
| `recorder-mirror-parity.test.js` | The recorder's two copies of the capture logic stay textually identical under the mechanical transformation. |
| `recording-mode.test.js` | Recording-mode persistence through the Chrome adapter. |
| `regression-294-window-rect.test.js` | A static-source guard that the extension emits no desktop-only window rectangle field. |
| `schema-validation.test.js` | Extension export data validates against the extension schema composed from its source layers, negative cases included. |
| `secret-crypto.test.js` | At-rest key encryption: the envelope shape, the round trip, the path taken after a restart, and tampered ciphertext. |
| `service-worker-held-keys.test.js` | The worker adding the keys held in a tab's other frames to an action: the holding frame asked first, behind a standing hold too; a late release not named; the keys of a silent or gone frame or an earlier document forgotten, as at a navigation, a tab or window switch, and a stop. |
| `service-worker-mirror-parity.test.js` | The append chokepoint's and the active-unit helpers' second copies stay textually identical to the shipped functions, the chokepoint under indentation only. |
| `service-worker-navigation.test.js` | The worker's navigation proxy through its registered listeners: the duplicate check, the last-URL marker and its self-clear, and the new-tab link path. |
| `service-worker-static-import.test.js` | A static-source guard that the background path uses the statically imported validator, never a dynamic import. |
| `service-worker-wake-unread.test.js` | A worker whose read of its stored state failed, through its registered listener: it answers every panel request with that error and writes nothing over the stored projects. |
| `service-worker-wake.test.js` | The worker's first messages after a wake, behind a storage that answers late: projects listed and created before the stored state is read are kept with the stored ones, and a recording can be created in such a project. |
| `service-worker.test.js` | The worker's message handlers: the panel protocol, import and export, the trusted-sender gate, redaction (a character key on a sensitive field stored as its one masked `type`), and storage-failure recovery. [Detail](#service-workertestjs) |
| `storage-quota.test.js` | The storage-pressure classifier: the warn band's threshold and the resume hysteresis. |

### `control-commands.test.js`

- The state each command needs, and the refusals when it is missing.
- The export of the open project as the Export button builds it, an export only with the grant.
- A pause, a resume or a create the service worker refused, answered with a fixed text.
- The storage and re-record notice codes.
- Results of identifiers, names, counts, flags and codes.

### `service-worker.test.js`

- Through the shipped worker's listener, each project- and recording-scoped message found by the ids it carries, or refused unless it names the active project and recording.
- The end of typing the worker asks the frames for:
  - Every frame asked ahead of a step commit and a stop, within the bound.
  - A pointer press relayed to the tab's other frames, with what the pressing frame writes next stored behind their answers.
  - A tab whose registration is gone reseeded first.
- Capture stopped once no recording is active.
