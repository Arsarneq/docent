# Docent Documentation

Reference documentation for Docent, organized by artifact class. For an overview
of the project, start with the [root README](../README.md).

## Documentation map

Each area is one class of artifact with a defined charter, so a new doc goes inside an existing area instead of forcing a reorganization.

The map is reachability-complete, and CI enforces it in both directions (`npm run lint:links` / `npm run lint:reachability`):

- Every relative doc link must resolve.
- Every tracked Markdown file must be reachable by following links from the [root README](../README.md). A doc the link walk cannot reach fails the build, unless it is one of the reachability check's explicitly allowlisted non-doctrine assets.

The index is the schema in the direction that matters: no doctrine can live off this tree. Reachability alone does not make a document doctrine: [`scripts/area-map.json`](../scripts/area-map.json), which maps the repository's code to its governing docs, declares what a document governs, not its presence here.

### Requirements — positioning, the authoring contract, quality-attribute posture, and what a recording must guarantee

- [Product Positioning](requirements/business/positioning.md): how Docent differs (data, not code), the example consumer flows, and the two step-context modes a recording can carry.
- [Replay Sufficiency](requirements/replay-sufficiency.md): what a recording alone must be sufficient for, covering the principle, its scope boundaries, and the normative-vs-informative field taxonomy the guarantee stands on.
- [Recording Lifecycle](requirements/functional/recording-lifecycle.md): the recording-authoring contract as shipped. Per stage (create, capture, commit, edit, export/import, dispatch), what a user can do, what the system guarantees, and the owning documents.
- [Accessibility](requirements/non-functional/accessibility.md): the panels' current accessibility posture, and how it differs from the capture layer's use of accessibility APIs as a data source.

### Architecture — how the platforms are built

- [Capture Principles](architecture/system/capture-principles.md): the cross-platform rules for what may enter a recording (action vs effect, proxy capture, sensitive-value masking).
- [Shared Core](architecture/system/shared-core.md): the one-implementation architecture behind both platforms, covering the behavior-defining logic in the shared package, the platform-adapter seam it is consumed through, and the build-time sync that copies it into each platform package.
- [Persistence](architecture/system/persistence.md): where each platform keeps its data, covering the extension's `chrome.storage` model and storage-pressure handling, the desktop's session-file and credential-store split, and the deliberately ephemeral state.
- [Extension capture](architecture/application/extension/capture-principles.md): the Chrome-extension capture architecture.
- [Extension runtime](architecture/application/extension/runtime.md): the extension's MV3 service-worker runtime, covering lifecycle and the persisted-state model, the panel/recorder/worker message protocol, and the storage write-ownership contract.
- [Extension permissions](architecture/application/extension/permissions.md): the extension's closed permission enumeration, each entry's rationale traced to the code that needs it.
- [Desktop capture (Windows)](architecture/application/desktop/windows/capture-principles.md): the Windows desktop capture architecture.
- [Desktop capture pipeline (Windows)](architecture/application/desktop/windows/capture-pipeline.md): the stages of the input-hook → worker-pool delivery pipeline behind the Windows capture layer, the pre-capture budget, why the commit flush barrier waits as it does, what a recording holds where capture start is slow or fails, and how the element of a keystroke and the facts of typing are read.
- [Desktop application shell (Windows)](architecture/application/desktop/windows/application-shell.md): the Tauri shell around the Windows capture layer, covering the command surface and the `capture:action` event channel, the session-persistence commands and their credential-store chokepoint, the tray keep-alive behind background Auto-Sync, the native HTTP transport chokepoint, and the installer's declared file association.
- [Desktop capture seam](architecture/application/desktop/capture-seam.md): the cross-platform capture boundary inside the desktop crate, covering the trait a per-OS backend implements and the compile-everywhere stub posture.

Why the architecture folders nest as they do:

- `application/extension/` (flat): the extension is a single Chrome (Manifest V3) extension, one codebase that runs across Chromium-based browsers that support Chrome extensions.
- `application/desktop/windows/`: desktop capture is per-OS native stacks (UIA/WinEvent), so it nests per OS, leaving room for a future capture surface (e.g. Linux) beside it. The application-shell document nests under `windows/` for a different reason: desktop releases are scoped to Windows, so the shipped shell (its tray, credential store, and native file dialogs) is the Windows one.
- `application/desktop/`: the seam the per-OS backends plug into is OS-agnostic, so its document sits one level up.

### Design — UI/UX and interaction-design records

- [Shared interaction model](design/ui_ux/shared-interaction-model.md): the cross-platform interaction model behind the "same workflow on both platforms" claim, covering one panel structure, the same workflow verbs, and the deliberate per-platform differences with their owning documents.
- [Sync resolution UI](design/ui_ux/sync-resolution-ui.md): the shipped attention-badge and resolution-workflow UI contract: badge semantics, the review and conflict views, and the one shared implementation both panels render.

### Technical — format orientation and the resolution specification

- [Session Format](technical/session-format.md): orientation prose for the `.docent.json` format. The per-platform [JSON Schemas](../schemas/) are the authoritative specification.
- [Locator Resolution](technical/locator-resolution.md): the reference procedure that defines what "the recording's locators resolve correctly" means, and the conformance-vector scope.

### API — the wire and transport protocols

- [Sync Protocol](api/sync-protocol.md): the REST protocol for syncing projects between clients and a server.
- [Dispatch Protocol](api/dispatch.md): the transport contract for sending recordings to a configured HTTP endpoint: the payload wrapper, the endpoint URL policy, retries, and delivery semantics.
- [Local Control Channel](api/control-channel.md): the opt-in loopback channel through which a local process runs the Chrome extension's structuring actions and, when a person allows it, exports the open project, covering the address, the pairing, the closed command set, and the threat model.

`api/` holds wire/transport protocols. The `.docent.json` format's orientation prose lives under `technical/`, and the schemas themselves (the format's authoritative specification) under [`schemas/`](../schemas/).

### Verification — proving the guarantees

- [Scripted-Truth Corpus](verification/scripted-truth-corpus.md): the falsifiability testing artifact: controlled sessions diffed against committed truth (capture completeness), and the inert conformance vectors for the locator procedure.
- [Static Sufficiency Lint](verification/sufficiency-lint.md): the falsifiability testing artifact for the static predicates: machine-checkable invariants over any recording's normative fields, baseline-locked in both directions over the frozen fixtures and the corpus truth files.

### Test — does the application behave as designed

- [Test suites](test/README.md): the inside-out lens on the capture software, covering the test-strategy doctrine (pyramid layering, coverage reporting, mutation testing), the per-suite documents (JavaScript unit, extension end-to-end, desktop Rust, desktop integration), the retired manual-test histories (extension and Windows desktop), and the backward-compatibility fixture corpus.

`verification/` and `test/` are two lenses on quality, and neither implies the other:

- `verification/` looks outside-in and proves the recorded **data** satisfies the guarantees the format makes to a consumer.
- `test/` looks inside-out and proves the capture **software** behaves as designed.

### User guides — recording with each platform

- [Chrome extension](user/extension.md): create a project, record and edit steps, export and import, dispatch a recording, and keep projects in sync with a server, all from the browser.
- [Desktop application (Windows)](user/desktop-windows.md): install the app, record native Windows workflows, dispatch them, and keep projects in sync.
- [Troubleshooting](user/troubleshooting.md): a by-symptom index across both platforms (import/export refusals, send failures, sync halts and attention badges, capture-side surprises), each routing to the document that owns the behavior.

### Guides — the project's CI and its docs governance

- [CI gates](guides/ci.md): what CI enforces on a pull request, on `main`, and on a schedule, covering each workflow's gate, the action SHA-pinning policy, and the workflow-security posture.
- [Running CI locally](guides/local-ci.md): reproduce the CI gates on your own machine, covering per-gate direct commands, whole jobs in containers with [`act`](https://github.com/nektos/act), and the Windows boundary two desktop jobs cannot cross.
- [Extending the docs governance](guides/docs-governance.md): the goals a change to the area map, the clause registry or the governance lints preserves; what adding a doc, adding a code file or minting a clause keeps green; and how to pick a passage's form when writing docs.

## Reference implementations

Runnable, protocol-accurate example artifacts live outside this folder. They are repository and testing artifacts, never shipped in a release:

- [Reference implementations](../reference-implementations/README.md): the index, including the reference server for the [Sync Protocol](api/sync-protocol.md).

## Reserved areas

Defined here so every future doc has an obvious home. A folder is created only when its first real doc lands (no empty directories):

- `architecture/application/desktop/linux/` and any other future capture surface: a new surface slots in beside `windows/`.

## Schemas

The per-platform [JSON Schemas](../schemas/) are the authoritative source of truth
for the `.docent.json` format.

The repository ships no consumer of `.docent.json` and no example consumer (see [Product Positioning](requirements/business/positioning.md)). What a recording must be sufficient _for_ is defined by [Replay Sufficiency](requirements/replay-sufficiency.md).

## Contributing

Contributor and project-governance docs live outside this folder:

- [Contributing guide](../.github/CONTRIBUTING.md): development setup, project structure, coding conventions, testing, and PR guidelines
- [Contributor License Agreement](../.github/CLA.md)
- [Code of Conduct](../.github/CODE_OF_CONDUCT.md): the Contributor Covenant this project follows
- [Security policy](../.github/SECURITY.md): how to report a vulnerability
- [Publishing](../.github/PUBLISHING.md): release process for each platform, including a no-side-effects dry-run pre-flight
