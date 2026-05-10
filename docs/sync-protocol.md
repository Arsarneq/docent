# Docent Sync Protocol

The Docent sync protocol is a simple REST API that enables bidirectional
synchronization of projects and recordings between Docent clients and a remote
server. This document is the formal specification — it contains everything a
backend developer needs to implement a compatible sync server.

---

## Overview

Sync is manually triggered by the user. A full sync cycle consists of two
phases executed in order:

1. **Push** — the client sends each local project to the server via PUT.
2. **Pull** — the client fetches the project manifest, then retrieves each
   project's full data and merges it into local storage.

Conflict resolution is **server-wins**: when a project exists both locally and
on the server with the same `project_id`, the server version replaces the local
version after pull.

---

## Authentication

Authentication is optional. When the user configures an API key in Docent, the
client includes it as a Bearer token on every request:

```
Authorization: Bearer <api_key>
```

When no API key is configured, the `Authorization` header is omitted entirely.

A server that does not require authentication can ignore this header. A server
that requires authentication should return `401` or `403` when the token is
missing or invalid — the client will halt the entire sync operation on either
status code.

---

## Endpoints

### GET /projects

Returns the project manifest — a JSON array listing all projects on the server.

**Request:**

```http
GET /projects HTTP/1.1
Host: sync.example.com
Authorization: Bearer <api_key>
```

No request body. The `Authorization` header is present only when an API key is
configured.

**Response (200 OK):**

```json
[
  {
    "project_id": "019e11fd-78ba-7fdb-8362-6fe9f697f641",
    "name": "Login regression suite",
    "last_modified": "2026-05-10T18:30:00.000Z"
  },
  {
    "project_id": "019e2b4a-1234-7abc-9def-abcdef012345",
    "name": "Checkout flow",
    "last_modified": "2026-05-11T09:15:00.000Z"
  }
]
```

**Response fields (Project_Manifest entry):**

| Field | Type | Description |
|---|---|---|
| `project_id` | string (UUIDv7) | Unique project identifier. |
| `name` | string | Human-readable project name. |
| `last_modified` | string (ISO 8601) | Last modification timestamp. |

---

### GET /projects/:id

Returns the full data for a single project, including all recordings and their
complete step history.

**Request:**

```http
GET /projects/019e11fd-78ba-7fdb-8362-6fe9f697f641 HTTP/1.1
Host: sync.example.com
Authorization: Bearer <api_key>
```

No request body. The `Authorization` header is present only when an API key is
configured.

**Response (200 OK):**

Returns a `Full_Project_Payload` object (see [Payload Shapes](#full_project_payload)
below for the complete example).

---

### PUT /projects/:id

Creates or updates a project on the server. The `:id` path parameter must match
the `project_id` inside the request body.

**Request:**

```http
PUT /projects/019e11fd-78ba-7fdb-8362-6fe9f697f641 HTTP/1.1
Host: sync.example.com
Content-Type: application/json
Authorization: Bearer <api_key>
```

The request body is a `Full_Project_Payload` object (see
[Payload Shapes](#full_project_payload) below).

The `Content-Type` header is always `application/json`. The `Authorization`
header is present only when an API key is configured.

**Response:**

The server should respond with `200 OK` when updating an existing project or
`201 Created` when storing a new project. The response body is not consumed by
the client — a minimal acknowledgment is sufficient:

```json
{ "ok": true }
```

---

## Payload Shapes

### Full_Project_Payload

The canonical shape for a complete project with all its recordings and step
history. Used as the response body for `GET /projects/:id` and the request body
for `PUT /projects/:id`.

```json
{
  "project": {
    "project_id": "019e11fd-78ba-7fdb-8362-6fe9f697f641",
    "name": "Login regression suite",
    "created_at": "2026-05-10T13:04:44.730Z",
    "metadata": {
      "jira": "PROJ-123",
      "tags": ["regression", "login"]
    }
  },
  "recordings": [
    {
      "recording_id": "019e12a4-0278-7c8e-aae6-01c26f002efb",
      "name": "Happy path login",
      "created_at": "2026-05-10T16:06:38.968Z",
      "metadata": { "zephyr": "TC-456" },
      "steps": [
        {
          "uuid": "019e12a4-633d-74d2-acd5-584085fb57f9",
          "logical_id": "019e12a4-633d-74d2-acd5-584085fb57f9",
          "step_number": 1,
          "created_at": "2026-05-10T16:06:39.000Z",
          "narration": "Navigate to login page and enter credentials",
          "narration_source": "typed",
          "actions": [
            {
              "type": "navigate",
              "timestamp": 1715353599000,
              "context_id": 1,
              "capture_mode": "dom",
              "nav_type": "typed",
              "url": "https://app.example.com/login"
            },
            {
              "type": "type",
              "timestamp": 1715353601000,
              "context_id": 1,
              "capture_mode": "dom",
              "element": {
                "tag": "INPUT",
                "id": "email",
                "name": "email",
                "role": "textbox",
                "type": "email",
                "text": null,
                "selector": "#email"
              },
              "value": "user@example.com"
            }
          ],
          "deleted": false
        },
        {
          "uuid": "019e12a4-733d-74d2-acd5-584085fb5800",
          "logical_id": "019e12a4-733d-74d2-acd5-584085fb5800",
          "step_number": 2,
          "created_at": "2026-05-10T16:06:40.000Z",
          "step_type": "validation",
          "expect": "present",
          "actions": [
            {
              "type": "click",
              "timestamp": 1715353602000,
              "context_id": 1,
              "capture_mode": "dom",
              "x": 512,
              "y": 340,
              "element": {
                "tag": "BUTTON",
                "id": "submit-btn",
                "name": null,
                "role": "button",
                "type": "submit",
                "text": "Log in",
                "selector": "#submit-btn"
              }
            }
          ],
          "deleted": false
        }
      ]
    }
  ]
}
```

**Project fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `project_id` | string (UUIDv7) | yes | Unique project identifier. |
| `name` | string | yes | Human-readable project name. |
| `created_at` | string (ISO 8601) | yes | Creation timestamp. |
| `metadata` | object | no | User-defined key-value pairs. Omitted when empty. |

**Recording fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `recording_id` | string (UUIDv7) | yes | Unique recording identifier. |
| `name` | string | yes | Human-readable recording name. |
| `created_at` | string (ISO 8601) | yes | Creation timestamp. |
| `metadata` | object | no | User-defined key-value pairs. Omitted when empty. |
| `steps` | array | yes | Full step history including re-recorded and deleted steps. |

The `steps` array contains the **complete version history** — it is not filtered
to active steps only. See the [Docent Session Format](./session-format.md)
documentation for the full step schema.

---

### Project_Manifest

The manifest is a JSON array returned by `GET /projects`. Each entry is a
lightweight summary used by the client to determine which projects to fetch.

```json
[
  {
    "project_id": "019e11fd-78ba-7fdb-8362-6fe9f697f641",
    "name": "Login regression suite",
    "last_modified": "2026-05-10T18:30:00.000Z"
  },
  {
    "project_id": "019e2b4a-1234-7abc-9def-abcdef012345",
    "name": "Checkout flow",
    "last_modified": "2026-05-11T09:15:00.000Z"
  }
]
```

| Field | Type | Required | Description |
|---|---|---|---|
| `project_id` | string (UUIDv7) | yes | Unique project identifier. Used as `:id` in subsequent requests. |
| `name` | string | yes | Human-readable project name. |
| `last_modified` | string (ISO 8601) | yes | Last modification timestamp. |

---

## Response Codes

The client interprets the following HTTP status codes:

| Code | Meaning | Client behavior |
|---|---|---|
| 200 | OK — request succeeded | Push: project marked as pushed. Pull: payload parsed and merged. |
| 201 | Created — new project stored | Same as 200 (treated as success). |
| 401 | Unauthorized — invalid or missing API key | Sync halted immediately. Error reported to user. |
| 403 | Forbidden — valid key but insufficient permissions | Sync halted immediately. Error reported to user. |
| 404 | Not found — project does not exist | Error recorded for that project. Other projects continue. |
| 500 | Internal server error | Error recorded for that project. Other projects continue. |

**Important:** A `401` or `403` response on any request (push or pull) causes
the client to halt the entire sync operation. All other error codes are
non-fatal — the client skips the failing project and continues with the rest.

---

## Sync Behavior

### Push phase

For each local project, the client sends:

```
PUT /projects/<project_id>
```

with the `Full_Project_Payload` as the JSON body. Projects are processed
sequentially. If a non-auth error occurs for one project, the client continues
pushing the remaining projects.

### Pull phase

1. The client fetches `GET /projects` to retrieve the manifest.
2. For each entry in the manifest, the client fetches
   `GET /projects/<project_id>` to retrieve the full payload.
3. Merge logic (server-wins):
   - If a pulled `project_id` matches a local project, the local project is
     **replaced entirely** with the server version.
   - If a pulled `project_id` has no local match, the project is **appended**
     to local storage.

### Ordering

Push always executes before pull. This ensures local changes reach the server
before the server version overwrites local data.

---

## Implementation Notes

- The server should store the `Full_Project_Payload` as-is. The client sends
  the complete project state on every push — there is no incremental/delta sync.
- The `last_modified` field in the manifest is informational. The current client
  does not use it for conditional fetching, but a future version may.
- The `metadata` field on projects and recordings is optional and may be absent
  from the payload. Treat missing `metadata` as an empty object.
- The `steps` array may be empty for recordings that have no captured steps yet.
- IDs use UUIDv7 format (time-ordered), but the server does not need to
  validate or generate them — they are always provided by the client.
- The server does not need to understand the internal structure of steps or
  actions. It stores and returns them verbatim.
