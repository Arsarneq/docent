# Reference implementations

Runnable, protocol-accurate example implementations of Docent's contracts. A
reference implementation demonstrates how to satisfy a published Docent
specification and doubles as a conformance target for the Docent team's manual
end-to-end testing. It is an example artifact — **not** product code, and not a
consumer of `.docent.json`.

Two invariants hold for everything in this directory:

- **Release-excluded.** These artifacts exist for the repository and its tests
  only; they are never bundled into a product release (a test enforces it).
- **The specification is the source of truth.** The normative specs live under
  [`docs/`](../docs/README.md); a reference implementation tracks its spec, never
  the other way round.

## Implementations

- [Sync server](sync-server/README.md) — a reference implementation of the
  [Sync Protocol](../docs/api/sync-protocol.md), for adopters building their own
  compatible backend and as a protocol-accurate manual end-to-end target.
