# Reference implementations

Protocol-accurate example implementations of Docent's contracts, each with its own test suite. Each shows how to satisfy a published Docent specification. Some run as servers, others are modules a program builds on; each entry below says which. Each is an example artifact: **not** product code, and not a consumer of `.docent.json`.

Two invariants hold for everything in this directory:

- **Release-excluded.** These artifacts exist for the repository and its tests only. They are never bundled into a product release (a test enforces it).
- **The specification is the source of truth.** The normative specs live under [`docs/`](../docs/README.md). A reference implementation tracks its spec, never the other way round.

## Implementations

- [Sync server](sync-server/README.md): a runnable reference implementation of the [Sync Protocol](../docs/api/sync-protocol.md). It serves adopters building their own compatible backend, and is a protocol-accurate target for the Docent team's manual end-to-end testing of the client sync cycle.
- [Control client](control-client/README.md): a reference implementation of the local process side of the [Local Control Channel](../docs/api/control-channel.md). This module pairs with the Chrome extension's side panel and sends it the channel's commands, for anyone writing their own local process. It has no entry point of its own. Its suite tests it against a stand-in for the panel that follows the specification.
- [MCP server](mcp-server/README.md): a runnable reference implementation of a local process of the [Local Control Channel](../docs/api/control-channel.md), built on the control client. It offers the channel's commands as tools of the Model Context Protocol over stdio, and writes an export a person allowed to a file. Its suite drives it with the official MCP client against the same stand-in for the panel. The extension's end-to-end suite runs it against the real panel.
