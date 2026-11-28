# JavaScript unit tests

This guide is for a contributor who looks for or adds a unit test, and for a reviewer checking how a clause is verified. It sets out the unit layer of Docent's JavaScript suites: the shared modules in `packages/shared`, the desktop frontend in `packages/desktop`, and the Chrome extension in `packages/extension`, each with its own `tests/unit` directory. They run on Node's built-in test runner against pure modules, injected fakes, and composed schemas, with no browser, no Tauri backend, and no network involved. The machinery and size-budget suites also run against the committed tree and the built artifacts themselves.

Where to look:

| You want to                                                | Go to                                                                                                                                                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find what a test file covers                               | Its tree's table: [Shared modules](#shared-modules), [Desktop application](#desktop-application) or [Chrome extension](#chrome-extension)                                                                                 |
| Find the cases behind a clause's check-ref                 | The check-ref names the test file, or a check `scripts/check-<name>.js` whose cases are `check-<name>.test.js` in [Shared modules](#shared-modules)                                                                       |
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

The tables below enumerate each tree. [`check-test-inventory.js`](../../scripts/check-test-inventory.js) holds them to the directories they describe on every pull request: a test file with no row, or a row naming something the tree's discovery does not select, fails the build. Each row is one line. A Covers cell has no length limit; a cell that grows is answered in review ([Writing docs](../guides/docs-governance.md#writing-docs-pick-the-form-before-the-sentence)). The tables are written unpadded under a `<!-- prettier-ignore -->` marker, so editing a row changes that line alone. The same check holds this shape. It refuses an in-page link (`](#…)`) in a Covers cell to anything but a section headed by the file's name after its tree's table.

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
| `check-action-pins.test.js` | The Actions pin guard: every `uses:` pins to a commit SHA, with local refs exempt, and every `codecov/codecov-action` step states `fail_ci_if_error: true`; the two shapes of a read that found nothing are refused on the check's own exit code, and each of the command line's three verdicts is taken over a tree it scans. |
| `check-adapter-surface.test.js` | The adapter-seam admission test: the seam typedef's members held both ways against each concrete adapter the filename rule derives, and against the seam document's links (SC-3). |
| `check-area-map.test.js` | The area-map admission test: each way `scripts/area-map.json` can rot, its pattern semantics, the exceptions and declarations it earns file by file, and the governing docs a file resolves to. |
| `check-capture-surface.test.js` | The capture-surface admission test: both platforms' closed enumerations, the scanned population and the admission list keyed over it, and the extractors' refusals. |
| `check-ci-filter.test.js` | The CI path-filter admission test: the test workflow's filter split, the held-flag holdings maps held to their filters both ways, and the script closure each heavy job gates on. |
| `check-clause-governance.test.js` | The clause-governance check: a file a clause cites owes the clause's document under the area map, with recorded exceptions keyed by the citation. |
| `check-clause-form.test.js` | The clause-form check: one home per rule and grown clause units, over an injected registry, documents and baseline. |
| `check-clause-preamble.test.js` | The clause-preamble admission test: the canonical paragraph, its computed per-document variables, and the lowercase-keyword allowlist. |
| `check-clause-registry.test.js` | The clause-registry parity check: clause markers and `docs/clause-registry.json` rows agree, and each row's grammar, citations and test cases resolve. |
| `check-cli-smoke.test.js` | End-to-end smoke tests that a check-script wrapper runs green over the committed tree, and the harness locks over the `child-env.js` helpers and the git-environment preload. |
| `check-clippy-invocation.test.js` | The clippy-invocation admission test: the workflow's Clippy run line, the CI guide's gates row and the spans the guides state agree (CI-1). |
| `check-command-surface.test.js` | The desktop command-surface admission test: commands, the event channel and the capability grants held to the application-shell clause (DSH-1). |
| `check-doc-closure.test.js` | The doc-closure admission test: the CI guides' job, gate-row and runner-cell claims held to the workflows both ways, and each `npm run` and script-key citation in tracked markdown to a defined script key. |
| `check-doc-reachability.test.js` | The reachability lint: an unlinked document fails, links inside code fences are never followed, and a tracked listing naming no document is refused on the check's own exit code rather than answering over nothing. |
| `check-docs-disposition.test.js` | The pull-request body format check, and its welds to the surfaces it reads: CONTRIBUTING, the PR template, the publish workflows, and each scheduled workflow's cron and guide cell. |
| `check-extension-surface.test.js` | The extension-surface admission test: manifest permissions, the message dispatcher, capture-path payloads and the introspection handle held to EPM-1, ERT-4 and ERT-5. |
| `check-fresh-clone-setup.test.js` | The documented extension setup check: the contributing guide's Chrome Extension block, extracted, built into a script and run. |
| `check-licenses-npm.test.js` | The default-deny npm license gate: its denial paths and the SPDX expression evaluation behind them. |
| `check-no-release-outputs.test.js` | The release-output guard's two modes: a feature branch touches no release output, the automation branch carries nothing else, and which mode a run takes. |
| `check-npm-advisories.test.js` | The npm advisory gate, whose verdicts its header lists. |
| `check-pin-history.test.js` | The pin-history probe over an injected reader: each SHA-pinned action held to its upstream's default-branch history, and each verdict its command line takes. |
| `check-pr-title.test.js` | The Conventional Commits title validator, whose verdict becomes the squashed commit subject. |
| `check-proptest-seeds.test.js` | The proptest seed-file check over injected reads: each committed seed file keeps proptest's header and a dated review note on every seed line. |
| `check-release-tag.test.js` | A release tag's pre-release suffix and the release's pre-release flag agree in both directions. |
| `check-schema-echo.test.js` | The schema-echo admission test: the session-format and sync-protocol tables held to the composed schemas in both directions. |
| `check-test-inventory.test.js` | The test-inventory lint: these tables, the coverage lists, suite registration and the mutation kill sets held to the tree, with the row shape this page states. |
| `check-tracked-ignored.test.js` | The tracked-but-ignored lint: no tracked file matches a `.gitignore` rule and no tracked entry is a symbolic link. |
| `check-verification-inventory.test.js` | The verification-inventory admission test: the documented inventories, the strict-flip watch, and the suite each named CI job is held to run. |
| `check-version-sync.test.js` | The version-table check, and the platform roster that `update-version-table.js` and `bump-schema.js`, which have no suite of their own, read from `build-schemas.js`. |
| `check-workflow-bounds.test.js` | The workflow-bounds and cache-claims admission test: each job's `timeout-minutes` bound, and the CI guide's cache-key and pinned-tool tables held to the workflows. |
| `classify-decision-table.property.test.js` | The graded classification decision table is total and correct against an independently re-derived oracle. |
| `classify-deterministic.property.test.js` | Classification is deterministic, settings-independent, and free of user-input or I/O interaction. |
| `classify-schema-change.test.js` | The mechanical schema-change classifier behind auto-versioning, one case per rule and its escalate-when-ambiguous bias. |
| `conformance-vectors.test.js` | Hygiene locks over the committed conformance vectors: six locks per vector (match counts and committed-field equalities), the snapshot walker and the per-strategy coverage ledger. |
| `connection-test.test.js` | The connection probe's outcome classification and the settings fingerprint that invalidates a prior pass. |
| `contract.test.js` | Built payloads and export data validate against the platform schemas, which are the source of truth for the shapes. |
| `corpus-compare.test.js` | The corpus comparator: normalization classes, action alignment, relaxations, baseline mechanics, the session walk over an already-parsed catalogue, and its exit-code contract. |
| `decline-review.property.test.js` | Declining a Review keeps local, dismisses exactly that incoming version, pushes nothing, and advances no baseline. |
| `delete-vs-change-conflict.property.test.js` | A Unit deleted on one side and changed on the other is deferred as a Conflict retaining the changed side, at both granularities; a project held in the baseline whose own fields hold no agreement counts as changed, so its deletion on one side is a Conflict too. |
| `deletion-propagation.property.test.js` | A cycle never silently resurrects a deletion and never silently applies one. |
| `digest-unrecognized-fields.property.test.js` | The digest projection admits no unlisted field and invents no listed one. |
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
| `lint-glob-quoting.test.js` | Every root `lint:*` script hands its arguments to the underlying tool in a form both shells deliver intact; the pre-push hook's ESLint and rustfmt calls are held to what `lint:js` and rustfmt read, and every tracked JavaScript file under `packages/` to `lint:js` or the ignores. |
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
| `report-clause-doc-words.test.js` | The word report for documents that hold clauses: words before, after and the difference per changed document (a removed or renamed one included), the job summary copy, an exit code growth never changes, and exit 2 on a base ref with no merge base. |
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
| `vector-meta-schema.test.js` | The conformance-vector meta-schema module, whose committed-vector walk (`committedVectorFiles`, each vector parsed) the suite reads the committed vectors through. |

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
| `integration-suite-locks.test.js` | Locks over the desktop integration suite: specs read the fixture's shared shapes and its invoke record only where allowed, the helper lists, the guide's config sentence, and plain UTF-8. |
| `persistence-unit.test.js` | The persistence module's public surface, from the empty state through the load and save paths. |
| `persistence.test.js` | Serializing a session state and reading it back yields an equivalent state. |
| `reorder-buffer.test.js` | Ordered insertion over the adapter: sequence ordering, immediate delivery, completeness, id stripping, in-place redaction, and the held keys an action names once its step is complete. |
| `rust-action-types-lock.test.js` | The Rust action-mapping test's `VALID_ACTION_TYPES` list equals, as a set, the action types the composed desktop schema declares. |
| `schema-validation.test.js` | Desktop export data validates against the desktop schema composed from its source layers, negative cases included. |
| `settings.test.js` | Dispatch settings survive a save and load round trip. |

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
| `control-commands.test.js` | The mapping from a control-channel command to a panel action: the state each command needs, its refusals, and its result. |
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
| `service-worker.test.js` | The worker's message handlers: the panel protocol, import and export, the trusted-sender gate, redaction (a character key on a sensitive field stored as its one masked `type`), storage-failure recovery, and the end of typing asked of every frame. |
| `storage-quota.test.js` | The storage-pressure classifier: the warn band's threshold and the resume hysteresis. |
