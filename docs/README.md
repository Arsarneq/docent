# Docent Documentation

Reference documentation for Docent, organized by artifact class. For an overview
of the project, start with the [root README](../README.md).

## Documentation map

Each area is one class of artifact with a defined charter, so a new doc extends
the tree inside an existing area rather than forcing a reorganization.

### Requirements — what a recording must guarantee

- [Replay Sufficiency](requirements/replay-sufficiency.md) — what a recording,
  taken alone, must be sufficient for: the principle, its scope boundaries, and
  the normative-vs-informative field taxonomy the guarantee stands on.

### Architecture — how capture works

- [Capture Principles](architecture/system/capture-principles.md) — the
  cross-platform rules for what may enter a recording (action vs effect, proxy
  capture, sensitive-value masking).
- [Extension capture](architecture/application/extension/capture-principles.md) —
  the Chrome-extension capture architecture.
- [Desktop capture (Windows)](architecture/application/desktop/windows/capture-principles.md) —
  the Windows desktop capture architecture.

The extension is a single Chrome (Manifest V3) extension — one codebase that runs
across Chromium-based browsers that support Chrome extensions — so it sits flat
under `application/extension/`; desktop capture is per-OS native stacks
(UIA/WinEvent), so it nests under `application/desktop/windows/`, leaving room for a
future capture surface (e.g. Linux) beside it.

### Technical — the format and resolution specifications

- [Session Format](technical/session-format.md) — the formal `.docent.json`
  specification.
- [Locator Resolution](technical/locator-resolution.md) — the reference procedure
  that defines what "the recording's locators resolve correctly" means, and the
  conformance-vector scope.

### API — the sync interface

- [Sync Protocol](api/sync-protocol.md) — the REST protocol for syncing projects
  between clients and a server.

`api/` holds wire/transport protocols; the `.docent.json` data-format spec lives
under `technical/`.

### Verification — proving the guarantees

- [Scripted-Truth Corpus](verification/scripted-truth-corpus.md) — the
  falsifiability testing artifact: controlled sessions diffed against committed
  truth (capture completeness), and the inert conformance vectors for the locator
  procedure.

### Guides — running the project

- [Running CI locally](guides/local-ci.md) — run the CI test jobs on your own
  machine with [`act`](https://github.com/nektos/act), and the `windows-latest`
  boundary.

## Reference implementations

Runnable, protocol-accurate example artifacts live outside this folder — they are
repository and testing artifacts, never shipped in a release:

- [Reference implementations](../reference-implementations/README.md) — the index,
  including the reference server for the [Sync Protocol](api/sync-protocol.md).

## Reserved areas

Defined here so every future doc has an obvious home; a folder is created only when
its first real doc lands (no empty directories):

- `requirements/business/` — product positioning and business requirements. _Seed:
  the root README's "How this differs" / "Example consumers"._
- `requirements/functional/`, `requirements/non-functional/` — functional and
  quality-attribute requirements not yet written as standalone docs.
- `design/` (and `design/ui_ux/`) — UI/UX and interaction-design records.
- `user/` — end-user install-and-use guides. _Seed: the extension/desktop usage
  walkthroughs in the root README._
- `architecture/application/desktop/linux/` and any other future capture surface —
  a new surface slots in beside `windows/`.

## Schemas

The per-platform [JSON Schemas](../schemas/) are the authoritative source of truth
for the `.docent.json` format.

This repository intentionally contains no consumer of `.docent.json`, and no
example consumer. The reference sync server is a sync target — somewhere to store
and exchange sessions — not a consumer of the format. What a recording must be
sufficient _for_ is nonetheless defined:
[Replay Sufficiency](requirements/replay-sufficiency.md).

## Contributing

Contributor and project-governance docs live outside this folder:

- [Contributing guide](../.github/CONTRIBUTING.md) — development setup, project
  structure, coding conventions, testing, and PR guidelines
- [Contributor License Agreement](../CLA.md)
- [Code of Conduct](../.github/CODE_OF_CONDUCT.md) — the Contributor Covenant this project follows
- [Publishing](../.github/PUBLISHING.md) — release process for each platform,
  including a no-side-effects dry-run pre-flight
