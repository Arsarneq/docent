# Docent Dispatch Protocol

Dispatch sends recordings from a Docent client to a user-configured HTTP
endpoint as a single POST — no terminal or intermediary required. This document
is the formal specification of that transport: the request, the payload
wrapper, the endpoint URL policy, and the client's delivery behaviour
(retries, size bounds, and send gating). The `.docent.json` data inside the
payload is defined by the per-platform [JSON Schemas](../../schemas/) and
oriented in the [Session Format](../technical/session-format.md); the wrapper
around it is defined here.

Each rule carries a stable identifier (**DI-n**) so other documents, reviews,
and checks can cite it precisely. Identifiers are never renumbered; a retired
identifier stays reserved and is never reused. How each rule is verified — by
an existing named check, by a check that could be built, or by judgment — is
recorded per rule in the [clause registry](../clause-registry.json). The key
words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as described in
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119). Keywords appear on a
clause's operative requirement where it has one; definitional clauses bind as
stated without a keyword, and subsidiary absolutes inside a clause inherit its
force. A clause's scope runs from its marker to the next marker or heading;
identifiers reflect minting order and may appear out of numeric sequence.

**DI-1.** An endpoint built against the [Request](#the-request),
[Payload structure](#payload-structure), and
[Response handling](#response-handling) sections is complete and correct — it
accepts the POST and returns a `2xx`. The remaining sections — validation,
retries, and send gating — bind the client, not the endpoint, with one named
exception: the [Endpoint scope and CORS](#endpoint-scope-and-cors) section
carries the endpoint's one deployment obligation (DI-15).

---

## Overview

Dispatch is user-triggered and one-way. The user selects one or more of a
project's recordings and confirms the send; the client builds one payload and
delivers it with one HTTP POST. There is no read-back, no listing, and no
server-side state the client depends on — the response body is not consumed
(see [Response handling](#response-handling)).

Dispatch is a separate contract from the [Sync Protocol](sync-protocol.md):
sync is bidirectional reconciliation against a server holding state, while
dispatch is fire-and-forget delivery to an ingestion endpoint. The two share
the client's transport machinery (the [transport seam](#transport-seam) and
the [endpoint URL policy](#endpoint-url-policy)) but nothing on the wire.

---

## Endpoint scope and CORS

A dispatch endpoint is an ingestion target for Docent clients: it receives
complete payloads and stores or forwards them, and Docent assumes nothing
about what happens after acceptance. A system that consumes recordings reads
them from wherever the endpoint put them — the protocol defines delivery
only.

A compliant endpoint does **not** need to emit CORS headers: the Chrome
extension sends through its `<all_urls>` host permissions and the desktop app
sends natively below the webview, so neither request is subject to the
browser's cross-origin rules.

**DI-15.** The
[Sync Protocol's server-scope reasoning](sync-protocol.md#server-scope-and-cors)
applies identically here: adding permissive CORS to an endpoint — especially
one bound to localhost or running without authentication — would let any
website the user visits reach it from the browser, and an unauthenticated
endpoint MUST NOT use `Access-Control-Allow-Origin: *`. This is the endpoint's
one deployment obligation (DI-1).

---

## The request

**DI-2.** A dispatch is a single `POST` of the [payload](#payload-structure)
to the configured endpoint URL, with `Content-Type: application/json`. When an
API key is configured, the client includes it as a Bearer token on the
request; when none is configured, the `Authorization` header is omitted
entirely:

```http
POST /ingest HTTP/1.1
Host: endpoint.example.com
Content-Type: application/json
Authorization: Bearer <api_key>
```

The request body is the five-field wrapper below. There are no other requests
in the protocol.

---

## Payload structure

**DI-3.** The HTTP POST body is the five-field wrapper below — the client
emits exactly these five top-level fields. The wrapper itself is not governed
by the platform schemas (they define the `.docent.json` contents); this
section is its defining specification.

```json
{
  "reading_guidance": "(string) Human-readable prose explaining the payload",
  "schema": { "(object) The JSON Schema for this platform" },
  "docent_format": { "platform": "(string)", "schema_version": "(string)" },
  "project": { ... },
  "recordings": [ ... ]
}
```

| Field              | Type   | Description                                                                                                                       |
| ------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `reading_guidance` | string | Prose explanation of the payload, written for a reader with no prior Docent knowledge. See [Reading guidance](#reading-guidance). |
| `schema`           | object | The full JSON Schema for the sending platform. An endpoint can use it for validation or ignore it.                                |
| `docent_format`    | object | Self-describing stamp: `{ platform, schema_version }`. See [Format stamp](../technical/session-format.md#format-stamp).           |
| `project`          | object | Project metadata.                                                                                                                 |
| `recordings`       | array  | Array of recording objects.                                                                                                       |

Wrapper fields may be added over time: an endpoint SHOULD tolerate unknown
top-level fields rather than hard-validating the key set. Additions are
announced by this specification — the wrapper carries no version signal of
its own; `docent_format` stamps the inner `.docent.json` format only.

The `.docent.json` export file contains `docent_format`, `project`, and
`recordings` (no `reading_guidance` or `schema` wrapper).

The stamp's values are read off the packaged schema itself — the single source
of truth — never hand-written. A client that cannot load its packaged schema
cannot build the wrapper: the send fails rather than emitting an unstamped
payload.

**DI-4.** The `project` and `recordings` entries are built by allowlist
projection: exactly the fields the platform schemas define for the project,
recording, and step shapes enter the payload, with each step's `actions`
carried verbatim as captured. Each selected recording is emitted with its
**full step history** — every version record, tombstones included — exactly as
an export would carry it (see
[Steps](../technical/session-format.md#steps)); the projection and a verbatim
export coincide because the step objects are schema-closed, so the allowlist
matches the schema's own closed field set. Selection decides which recordings
are sent, never which steps. Only committed step records enter a payload:
actions captured but not yet committed into a step are stored outside
`recording.steps` and never reach a dispatch.

---

## Reading guidance

The `reading_guidance` prose is shipped as an asset with each platform
(`packages/shared/assets/reading-guidance.md`, a consumer-facing product
asset packaged into the extension and the desktop app by the shared-code
sync) and loaded at send time.

**DI-5.** The shipped `reading_guidance` prose paraphrases schema-governed
semantics for a reader with no prior Docent knowledge. It MUST track the
schemas and this wrapper specification — the wrapper is not schema-governed,
so schema-tracking alone cannot catch wrapper drift: a change that alters the
format's semantics or the wrapper contract carries a review of the shipped
guidance asset in the same change, so no payload delivers stale guidance
beside a current schema. When the asset cannot be read, the field degrades to
an empty string and the send proceeds — guidance is a courtesy to the reader,
not a delivery precondition.

---

## Response handling

**DI-6.** The client treats any `2xx` status as acceptance and does not act on
the response body (it is parsed as JSON when parseable and discarded
otherwise) — a minimal or empty acknowledgment is sufficient. An endpoint
SHOULD return `2xx` when it has accepted the payload. The failure
classification is total: every non-`2xx` status is a failure; the transient
set — a network error, the 30-second per-attempt timeout, `429`, or any `5xx`
— is retried (DI-7), and every other surfaced status, including any non-`429`
`4xx` and any surfaced `1xx`/`3xx`, fails fast.

| Status                    | Class     | Client behavior                                             |
| ------------------------- | --------- | ----------------------------------------------------------- |
| `2xx`                     | success   | Send reported successful; response body not consumed.       |
| `429`                     | transient | Retried with backoff (DI-7); `Retry-After` honoured.        |
| `5xx`                     | transient | Retried with backoff (DI-7); `Retry-After` honoured.        |
| network error / timeout   | transient | Retried with backoff (DI-7).                                |
| any other surfaced status | permanent | Fails immediately; the status code is surfaced to the user. |

One acceptance edge case: a `2xx` whose declared `Content-Length` exceeds the
inbound response bound is still reported as a failed send (DI-9) — an endpoint
SHOULD keep acknowledgment bodies small, since the client never consumes the
body.

---

## Retries and duplicate delivery

**DI-7.** Transient failures — a network error, the 30-second per-attempt
timeout, HTTP `429`, or any `5xx` — are retried up to three times after the
first attempt (at most four attempts per send). Each retry is delayed by
full-jitter exponential backoff: a uniformly random delay up to a cap that
starts at 500 ms and doubles per retry, bounded at 8 s. A `Retry-After` header
on the response being retried overrides the jittered delay, capped at 30 s: a
value that parses as a non-negative integer (`parseInt` semantics — a sign
prefix is accepted, trailing text ignored) overrides the delay; anything else
(e.g. the HTTP-date form, or a negative value) falls back to the jitter
schedule. Every other
surfaced status — any `4xx` other than `429`, and any surfaced `1xx`/`3xx` —
fails fast with no retry, and when retries are exhausted the last transient
error is surfaced to the user.

**DI-8.** Delivery is **at-least-once per confirmed send**: a transient
failure after the endpoint has in fact received the request (e.g. a timeout on
the response path) is retried, so an endpoint MAY receive the same payload
more than once. The protocol carries no idempotency token.

**DI-16.** Every attempt of a send carries a byte-identical body — the payload
is serialized once, before the attempt loop — and the identifiers inside it
(`project_id`, `recording_id`, step `uuid`s) are stable across attempts, so an
endpoint that needs exactly-once processing can deduplicate on content or
identifiers.

---

## Size bounds

**DI-9.** Two size bounds apply per send, both client-side. Outbound: a
payload whose serialized JSON body exceeds 50 MB is rejected before any
attempt, and the user is advised to send recordings individually — the bound
is measured over the serialized string's UTF-16 code units, so the UTF-8 wire
body can be somewhat larger. Inbound: a response declaring a `Content-Length`
above 10 MB is rejected — a `2xx` response over the bound is reported as a
failed send despite the endpoint's acceptance (the acknowledgment-size
recommendation lives with the endpoint contract, in DI-6's scope).

---

## Endpoint URL policy

**DI-10.** An endpoint URL is accepted only when all of the following hold —
validated when the settings are saved, on both platforms, by a single shared
implementation that also guards the sync server URL settings:

1. The scheme is `http://` or `https://`.
2. It parses as a URL with a non-empty hostname.
3. It carries no embedded credentials (userinfo).
4. The host is not a link-local IPv4 address (`169.254.0.0/16`, which includes
   the cloud-metadata endpoint) — rejected on either scheme.
5. When an API key is configured alongside it: the scheme is `https://`, or
   the host is loopback (`localhost`, `127.0.0.0/8`, `::1`) over `http://` —
   a Bearer token (and a payload that may contain PII) MUST NOT travel
   plaintext past the local machine.

An empty value is valid and clears the endpoint (disabling Send — see
[Send eligibility](#send-eligibility-and-the-post-send-cooldown)). Without an
API key, plaintext `http://` to a non-link-local host is accepted at save
time; on the desktop, the transport policy below still applies at request
time.

**DI-11.** On the desktop, a single native command
([`packages/desktop/src-tauri/src/sync_http.rs`](../../packages/desktop/src-tauri/src/sync_http.rs))
is the only native, CORS-free outbound HTTP primitive exposed to the UI layer
— no general HTTP plugin is exposed — while the webview's own `fetch` remains
available under the CSP's `connect-src`, CORS-constrained; all shared dispatch
and sync traffic routes through the native command via the
[transport seam](#transport-seam) (DI-12). The command re-enforces a transport
policy of its own per request — overlapping with, but enforced independently
of, the webview CSP's `connect-src`: `https://` to any host, plaintext
`http://` only to loopback (regardless of whether an API key is configured —
deliberately stricter than DI-10's save-time rule), never a link-local
address, with a 30-second request timeout of its own.

---

## Transport seam

**DI-12.** Shared dispatch, sync, and connection-test logic issues every HTTP
request through a single transport seam
([`packages/shared/lib/http-transport.js`](../../packages/shared/lib/http-transport.js));
a platform MAY bind a native transport once at startup, and left unbound, the
seam defaults to the environment's `fetch`. The contract is a strict subset of
`fetch`: `(url, { method, headers, body, signal })` returning
`{ ok, status, headers.get(name), json(), text() }`.

- **Extension** — leaves the seam unbound: requests go through the webview's
  `fetch`, and the extension's `<all_urls>` host permissions bypass the
  browser's CORS at the network layer.
- **Desktop** — binds a native transport: each request crosses into Rust via
  the single native command (DI-11), removing CORS from the path entirely.
  The seam's `signal` is not forwarded to the native command — the per-attempt
  abort is enforced by the native 30-second timeout instead.

---

## Send eligibility and the post-send cooldown

These are client behaviours, not endpoint obligations.

**DI-13.** Send is available only when an endpoint URL is configured and the
open project has at least one recording whose resolved active view (the
[step-resolution rule](../technical/session-format.md#steps)) contains at
least one step. The send flow offers only recordings with at least one active
step — individually or all together — and shows a confirmation of the
endpoint, the selected recording names, and the active-step count before
anything is sent. Active steps gate eligibility and drive the displayed
counts; the payload itself carries each selected recording's full step
history (DI-4).

**DI-14.** After a successful send, the Send control is held disabled for a
5-second cooldown with a countdown hint — a rapid-resend guard against
dispatching the same selection twice in quick succession. A failed send starts
no cooldown. This is client presentation backed by in-memory state, not wire
protocol: it complements DI-7's transport backoff and guarantees nothing to an
endpoint.
