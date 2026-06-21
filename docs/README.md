# Docent Documentation

Reference documentation for Docent. For an overview of the project, start with
the [root README](../README.md).

## Contents

- [Capture Principles](capture-principles.md) — the core rules for what Docent
  captures, with platform-specific details for the
  [extension](capture-principles-extension.md) and [desktop](capture-principles-desktop.md)
- [Session Format](session-format.md) — the formal `.docent.json` specification
- [Sync Protocol](sync-protocol.md) — the REST API for syncing projects between
  clients and a server
- [Reference Sync Server](reference-sync-server.md) — a small, runnable reference
  implementation of the [Sync Protocol](sync-protocol.md), for adopters building
  their own compatible backend
- [Running CI locally](local-ci.md) — run the CI test jobs on your own machine
  with [`act`](https://github.com/nektos/act), and the `windows-latest` boundary

The per-platform [JSON Schemas](../schemas/) are the authoritative source of
truth for the `.docent.json` format.

This repository intentionally contains no consumer of `.docent.json`, and no
example consumer. The reference sync server is a sync target — somewhere to store
and exchange sessions — not a consumer of the format.

## Contributing

Contributor and project-governance docs live outside this folder:

- [Contributing guide](../.github/CONTRIBUTING.md) — development setup, project
  structure, coding conventions, testing, and PR guidelines
- [Contributor License Agreement](../CLA.md)
- [Publishing](../.github/PUBLISHING.md) — release process for each platform,
  including a no-side-effects dry-run pre-flight
