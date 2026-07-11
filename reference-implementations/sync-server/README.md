# Reference Sync Server

The Reference Sync Server is a small, runnable implementation of the
[Docent Sync Protocol](../../docs/api/sync-protocol.md). It exists as a faithful, easy-to-read
example for adopters building their own compatible backend, and as a
protocol-accurate target for the Docent team's manual end-to-end testing of the
client sync cycle.

This server is part of the repository's
[reference implementations](../README.md).

It runs on Node.js using only the standard library (`node:http` and friends) —
no web framework, no build step — and persists to flat JSON files under the OS
temp folder through a pluggable storage seam. Like any compliant server, it is
**opaque**: it stores and returns each `Full_Project_Payload` verbatim and holds
no conflict, baseline, or version state.

> **This is a repository and testing artifact only.** The server lives under
> `reference-implementations/` (separate from `packages/`, which holds the
> shipped product) and is excluded from every release. It is never part of a
> product release and is not published to end users.

The [Sync Protocol](../../docs/api/sync-protocol.md) is the authoritative contract — it
describes what _any_ server must do. This document describes how _this_ reference
server implements that contract, and links to the protocol spec rather than
restating it.

---

## Scope: a sync target, not a consumer API

The sync server is an **opaque sync target** — it stores and returns whole
`Full_Project_Payload`s for Docent clients and holds no other state. It is **not**
a consumer-facing read API. A system that consumes recordings (an LLM/agentic
pipeline, a deterministic code mapper, a dashboard) should read from the
**storage** the server persists to — through its own service — rather than
calling the sync endpoints directly.

Consistent with that scope, the reference server sends **no CORS headers** and
binds to loopback. This is deliberate, not an omission:

- **Docent's own clients never need it.** The Chrome extension reaches the server
  through its `host_permissions`, and the desktop app issues sync requests
  natively (from Rust) rather than through the webview — so neither relies on the
  browser's cross-origin rules.
- **Permissive CORS on a local store is a hazard.** Adding a header such as
  `Access-Control-Allow-Origin: *` to a loopback-bound, optionally-open server
  would let _any website the user visits_ read and overwrite their local sync
  data from the browser. Do not add CORS to feed a browser-based consumer;
  integrate at the storage layer instead. If you deliberately expose your own
  server to a trusted browser origin, scope CORS to that exact origin — never
  `*`, and never on an unauthenticated server.

---

## Running the server

The server has no runtime dependencies and no build step. From
`reference-implementations/sync-server/`:

```bash
npm start
```

or equivalently:

```bash
node server.js
```

On startup it logs the bound URL, for example:

```text
Reference Sync Server listening on http://localhost:3000
```

### Configuration

| Setting | Source (in precedence order)                   | Default             |
| ------- | ---------------------------------------------- | ------------------- |
| Port    | `--port <n>` argv flag → `PORT` env var        | `3000`              |
| Token   | `--token <t>` argv flag → `SYNC_TOKEN` env var | unset (open server) |

The argv flag wins over the environment variable, so you can override a shell
export on a single run:

```bash
# Listen on port 4000 with a static Bearer token
node server.js --port 4000 --token my-secret-token

# Same, via environment variables
PORT=4000 SYNC_TOKEN=my-secret-token node server.js
```

When no port is configured, the server binds the documented default port
**`3000`**. When no token is configured, the server runs open (see
[Authentication](#optional-bearer-authentication)).

---

## Protocol endpoints

The server implements the three endpoints of the
[Sync Protocol](../../docs/api/sync-protocol.md) exactly as specified there. The request and
response shapes — including the `Full_Project_Payload` and `Project_Manifest`
structures — are defined in the protocol spec and are not duplicated here. This
section only notes how this implementation behaves.

### GET /projects

Returns the [project manifest](../../docs/api/sync-protocol.md#get-projects): a JSON array of
`{ project_id, name, last_modified }` entries, one per stored project, with HTTP
`200`. An empty store returns `200` with `[]`.

Each entry's `project_id` and `name` come from the stored payload's `project`
object; `last_modified` is a server-maintained timestamp recorded on write (see
[Storage model](#storage-model)). The server reads nothing else from the
payload — not the `docent_format` stamp, not the recordings or steps.

### GET /projects/:id

Returns the stored [`Full_Project_Payload`](../../docs/api/sync-protocol.md#get-projectsid)
verbatim with HTTP `200` and `Content-Type: application/json`, or `404` when no
project with that id is stored. The payload is returned exactly as it was
written, without validation or reshaping.

Successful reads also carry an `ETag` header — see
[Conditional writes](#optional-conditional-write-docent152).

### PUT /projects/:id

Creates or replaces a whole project per the
[protocol contract](../../docs/api/sync-protocol.md#put-projectsid). The path `:id` must match
the `project_id` in the request body.

| Outcome                     | Status            | Body                |
| --------------------------- | ----------------- | ------------------- |
| New project stored          | `201 Created`     | `{ "ok": true }`    |
| Existing project replaced   | `200 OK`          | `{ "ok": true }`    |
| Path id ≠ body `project_id` | `400 Bad Request` | — (store unchanged) |
| Body is not valid JSON      | `400 Bad Request` | — (store unchanged) |

The payload is stored verbatim — the server never interprets the stamp,
recordings, or steps. On a successful write the server records a fresh
`last_modified` timestamp (used only for the manifest, never merged into the
payload) and returns an `ETag` header reflecting the newly stored content.

---

## Storage model

Request handling reaches stored projects **only** through a `Storage_Provider`
interface — no handler touches the filesystem directly. This is the pluggable
seam: an adopter swaps in a different backend (a database, an object store, etc.)
by replacing the provider at the single construction site in `server.js`, with
no change to the request-handling logic.

The default provider is the **File Storage Provider**. It persists each project
as a flat JSON file under a directory inside the OS temp folder:

```text
<os.tmpdir()>/docent-reference-sync-server/<project_id>.json
```

Each file wraps the verbatim payload alongside the server-maintained timestamp:

```json
{
  "last_modified": "2026-06-04T10:00:00.000Z",
  "payload": { "...": "the Full_Project_Payload, stored verbatim" }
}
```

Key properties:

- `last_modified` is stored **alongside** the payload, never inside it, so the
  payload returned by `GET /projects/:id` stays byte-for-byte faithful to what
  was written.
- The timestamp persists durably, so manifest entries remain correct after a
  restart (as long as the OS has not cleared the temp folder).
- The provider validates the `project_id` shape and rejects ids containing path
  separators or `..`, so a hostile id from a seed or `PUT` cannot escape the
  storage directory.

The OS temp folder is a deliberate signal: this storage is ephemeral and is not
intended for production use.

---

## Optional Bearer authentication

Authentication is optional and controlled entirely by whether a token is
configured (via `--token` or `SYNC_TOKEN`; see
[Configuration](#configuration)).

**When a token is set**, every request requires a matching
`Authorization: Bearer <token>` header:

| Request                     | Status             |
| --------------------------- | ------------------ |
| Header present and matching | served normally    |
| Header missing              | `401 Unauthorized` |
| Bearer token does not match | `403 Forbidden`    |

**When no token is set**, the server runs open: every request is served without
an `Authorization` header, and any header that is sent is ignored.

The auth check runs first for **every** request — both the protocol endpoints
and the non-protocol [debug affordances](#debug-affordances-non-protocol). A
configured token therefore leaves no unauthenticated state-mutating endpoint.

---

## Optional conditional write (docent#152)

The server implements the protocol's optional
[conditional write](../../docs/api/sync-protocol.md#optional-conditional-write)
(the server-side optimistic-concurrency capability delivered under
[docent#152](https://github.com/Arsarneq/docent/issues/152)). The wire contract
lives in that protocol section; what follows describes this implementation. It
is opt-in: when the relevant headers are absent the server behaves as a plain
last-write-wins store, exactly as the
[protocol's last-write-wins window](../../docs/api/sync-protocol.md#known-limitation-the-last-write-wins-window)
describes.

**ETag advertisement.** A successful `GET /projects/:id` and a successful
`PUT /projects/:id` both return an `ETag` header. The ETag is derived
deterministically from the stored payload's content only (a SHA-256 over a
canonical-JSON projection of the payload) — not from `last_modified`. So two
reads of the same unchanged project return the same ETag, and any change to the
content yields a different one.

**`If-Match` handling on writes.**

| `If-Match` on the `PUT`                                              | Behavior                                                                                           |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Absent                                                               | Last-write-wins: the payload is stored per the normal `PUT` rules, regardless of the current ETag. |
| Present and matches the stored ETag                                  | The write proceeds (`200`/`201`) and returns a fresh `ETag`.                                       |
| Present and does **not** match (including when no project is stored) | `412 Precondition Failed`; the store is left unchanged.                                            |

This lets a client send the version it based its edit on and have the server
reject a write based on a stale read, closing the overwrite window — while
remaining a valid plain server for clients that omit the header. The
conditional-write logic lives in its own clearly named unit rather than being a
hidden side effect of normal write handling.

---

## Debug affordances (non-protocol)

For manual end-to-end testing, the server provides three development
conveniences under a distinct `/__debug/` path prefix. **These are not part of
the Sync Protocol** — a protocol-only client never touches them, and they are
clearly separated from the three protocol endpoints by their path. When a token
is configured they are token-gated exactly like protocol requests.

### POST /\_\_debug/reset

Clears every stored project and reports the count removed:

```json
{ "ok": true, "cleared": 3 }
```

A subsequent `GET /projects` returns `[]`.

### GET /\_\_debug/dump

Returns a read-only summary of the current stored state — without mutating
anything:

```json
{
  "count": 1,
  "projects": [
    {
      "project_id": "019e11fd-78ba-7fdb-8362-6fe9f697f641",
      "name": "Expense report submission",
      "last_modified": "2026-06-04T10:00:00.000Z",
      "etag": "\"a1b2c3...\""
    }
  ]
}
```

This is a per-project summary, not the verbatim payloads — to retrieve a full
payload use `GET /projects/:id`.

### POST /\_\_debug/seed

Stores one or more payloads directly through the storage provider exactly as a
`PUT` would (verbatim, opaque, with a server-set `last_modified`) — **without**
requiring a client push, so a tester can stage a known server-side state. It
responds with the count seeded:

```json
{ "ok": true, "seeded": 2 }
```

The request body is either:

- an **array of `Full_Project_Payload` objects** supplied by the caller, or
- `{ "samples": true }` to seed the bundled both-platform sample payloads — one
  stamped `platform: "extension"` and one stamped `platform: "desktop-windows"`
  — so you can stage a mixed-platform server state for cross-platform pull
  testing.

The server stores each seeded payload verbatim without reading its
`docent_format` stamp (it stays opaque, so it never validates which platform a
payload claims). Invalid JSON is rejected with `400 Bad Request` and the store
is left unchanged.

---

## See also

- [Sync Protocol](../../docs/api/sync-protocol.md) — the authoritative protocol contract this
  server implements.
- [Session Format](../../docs/technical/session-format.md) — orientation prose for the
  `.docent.json` format whose schemas define the `Full_Project_Payload` shape.
