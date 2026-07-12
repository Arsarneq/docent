<img align="left" width="110" src="packages/shared/assets/icons/icon.svg" alt="Docent icon" />

[![Tests](https://github.com/Arsarneq/docent/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/Arsarneq/docent/actions/workflows/test.yml)
[![codecov](https://codecov.io/gh/Arsarneq/docent/graph/badge.svg?branch=main)](https://codecov.io/gh/Arsarneq/docent)
[![JS coverage](<https://img.shields.io/codecov/c/github/Arsarneq/docent/main?flag=javascript&logo=javascript&logoColor=white&label=coverage%20(js)>)](https://app.codecov.io/gh/Arsarneq/docent?flags%5B0%5D=javascript)
[![Rust coverage](<https://img.shields.io/codecov/c/github/Arsarneq/docent/main?flag=rust&logo=rust&logoColor=white&label=coverage%20(rust)>)](https://app.codecov.io/gh/Arsarneq/docent?flags%5B0%5D=rust)
[![Mutation Testing](https://github.com/Arsarneq/docent/actions/workflows/mutation.yml/badge.svg)](https://github.com/Arsarneq/docent/actions/workflows/mutation.yml)
[![CodeQL](https://img.shields.io/badge/CodeQL-enabled-2088FF?logo=github&logoColor=white)](https://github.com/Arsarneq/docent/security/code-scanning)
[![Extension v3.0.0](https://img.shields.io/chrome-web-store/v/odhpdgpoknpaakjdkdbjdgpljmpblijh?logo=googlechrome&logoColor=white&label=Chrome%20Web%20Store)](https://chromewebstore.google.com/detail/docent/odhpdgpoknpaakjdkdbjdgpljmpblijh)
[![Desktop v2.0.0](https://img.shields.io/badge/Desktop_Release-v2.0.0-181717?logo=github&logoColor=white)](https://github.com/Arsarneq/docent/releases/tag/desktop-v2.0.0)
[![Node.js](https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Built with Tauri](https://img.shields.io/badge/Built%20with-Tauri-FFC131?logo=tauri&logoColor=white)](https://tauri.app/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](.github/CONTRIBUTING.md)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/Desktop-Windows-0078D4?logo=windows&logoColor=white)](packages/desktop)

<h1>Docent</h1>

> Captures demonstrated workflows as structured data — not code.

<!-- This tagline is mirrored in the repo's GitHub About description —
     if you change it, update the About to match. -->

Docent captures user interactions alongside step-by-step context and exports the result as structured JSON. It runs as a Chrome extension for browser workflows and as a native desktop application (Windows) for native application workflows. Both platforms produce `.docent.json` files with the same core structure, differentiated by platform-specific action types and fields.

---

## What it does

Docent captures interactions and pairs them with step-by-step context. The result is a `.docent.json` file that describes what happened, in order, with full context.

- **Chrome extension** — captures user actions in the browser: clicks, typing, keyboard, drag, scroll, file uploads. Browser chrome actions (address bar, back/forward, tabs) are captured via their immediate effects.
- **Desktop application** — captures user actions in native Windows applications via low-level input hooks and the UI Automation accessibility API, with per-action coordinate-based fallback for elements that lack accessibility data.

Both platforms follow the same principle: every captured action is a real user action — nothing programmatic, synthetic, or inferred. Programmatic side-effects (value changes from code, focus moves from scripts, window lifecycle from `window.open()`) are filtered out. A small amount of observed context is recorded alongside the actions to describe them faithfully, always kept distinct from the actions themselves.

Sensitive values are redacted at capture time on both platforms — passwords, credit-card / SSN / secret field values, and auth tokens in captured URLs are masked before anything is stored.

Recordings can be dispatched directly to a configured HTTP endpoint from either platform — no terminal or Node.js required.

See [Capture Principles](docs/architecture/system/capture-principles.md) for the full rules, with platform-specific details in [Extension](docs/architecture/application/extension/capture-principles.md) and [Desktop](docs/architecture/application/desktop/windows/capture-principles.md).

---

## How this differs

Most browser recording tools produce code — Playwright scripts, Selenium tests, Puppeteer flows. They assume you want to replay what was recorded, and they assume a specific framework to replay it in.

Docent produces data, not code. Each step pairs context — either a free-text narration or a structured action/validation classification — with the exact interactions captured. The output makes no assumptions about what receives it or what it does with it.

The dispatch payload includes a reading guide and the JSON Schema for the sending platform, so any receiving system can interpret it without prior knowledge of Docent.

---

## Example consumers

> Docent ships no consumer. Its contract with a consumer is data — the
> `.docent.json` format, a versioned JSON Schema per platform; whatever reads a
> recording is built separately and independently. The flows below are
> **examples** of what a consumer _could_ do — Docent makes no assumptions about
> which of them (if any) receives a recording.

### Agentic consumer (narration mode)

```mermaid
flowchart LR
    A([Person]) -->|demonstrates workflow| B[Docent]
    B -->|narration + actions| C[.docent.json]
    C -->|dispatch| D([LLM / agentic consumer])
    D --> E1([Test suite])
    D --> E2([Process documentation])
    D --> E3([RPA flow])
```

A person demonstrates a workflow, narrating each step in natural language. The
structured output is dispatched to an agentic consumer (an LLM) that has full
context — what the user did and what they meant — and can turn it into whatever
that consumer is built for: a test suite, written process documentation, an RPA
flow, an accessibility report. Docent neither performs nor ships any of this; it
delivers the data.

### Deterministic consumer (simple mode)

```mermaid
flowchart LR
    A([Person]) -->|demonstrates workflow| B[Docent]
    B -->|action/validation + actions| C[.docent.json]
    C -->|dispatch| D([Code mapper])
    D -->|generates directly| E([Executable automation])
```

A person demonstrates a workflow, tagging each step as either "action" (do this)
or "validation" (check this). A deterministic code mapper turns the structured
data directly into executable automation — no LLM required. Each action step
becomes a replay command, each validation step becomes an assertion. A test
suite is one such target; the same do/check shape maps just as cleanly to an RPA
flow or a monitoring check.

### The contract is data

Both paths consume the same `.docent.json` format. Docent captures and
delivers — it has no opinion about what receives the data or how it's used.
The same rule holds at every surface Docent exposes: recordings are defined by
per-platform versioned [JSON Schemas](#session-format), dispatch payloads carry
their own schema and reading guide, and sync servers implement a documented
[REST protocol](docs/api/sync-protocol.md). Each contract is data; none of it is
shipped code.

The affirmative half of that neutrality is a promise about the data itself:
**replay sufficiency** — assuming the application unchanged, a consumer holding
only the recording can reproduce the session from a different machine. See
[Replay Sufficiency](docs/requirements/replay-sufficiency.md) for the principle, its scope
boundaries, and what makes it testable.

---

## Schema versions

The current `.docent.json` schema version for each platform. Exported files are
self-describing — each carries a `docent_format` stamp with its platform and
schema version — so you never need to match versions by hand.

<!-- VERSION_TABLE_START -->

| Platform          | Schema version |
| ----------------- | -------------- |
| Chrome Extension  | 3.0.0          |
| Desktop (Windows) | 2.0.0          |

<!-- VERSION_TABLE_END -->

See [docs/technical/session-format.md](docs/technical/session-format.md#versioning) for the full versioning strategy.

---

## Chrome Extension

### Installation (development)

Build and load the unpacked extension from source — see [Contributing → Development Setup](.github/CONTRIBUTING.md#chrome-extension).

### Using the extension

Quickstart: click the Docent icon to open the side panel, create a project and start a recording, perform your actions and add each step's context (narration, or an action/validation classification), then **Done this step** — and **Export** a `.docent.json` file or **Send** it to a configured endpoint. The full walkthrough — editing and re-recording steps, history, import, and dispatch setup — is in the [extension user guide](docs/user/extension.md).

---

## Desktop Application (Windows)

### Installation (development — desktop)

Build and run the Tauri desktop app from source — see [Contributing → Development Setup](.github/CONTRIBUTING.md#desktop-application-windows).

### Using the desktop app

Quickstart: create a project and a recording, pick a target application from the running windows, perform actions (captured automatically), add each step's context and **Done this step**, then **Export** a `.docent.json` file or **Send** it to a configured endpoint. The full walkthrough is in the [desktop user guide](docs/user/desktop-windows.md).

---

## Session format

The `.docent.json` format is defined by per-platform JSON Schemas — the single source of truth for each Docent platform:

- [Extension schema](schemas/dist/extension.schema.json) — Chrome extension
- [Desktop Windows schema](schemas/dist/desktop-windows.schema.json) — Windows desktop

See [docs/technical/session-format.md](docs/technical/session-format.md) for annotated orientation prose covering both schemas.

---

## Contributing

Contributions are welcome — start with the **[contributing guide](.github/CONTRIBUTING.md)**. By participating you agree to the [Code of Conduct](.github/CODE_OF_CONDUCT.md), and all contributors sign the [CLA](CLA.md) (the CLA Assistant bot prompts you automatically on pull requests).

Project references:

- [Documentation index](docs/README.md) — the docs map by area: requirements, architecture, technical specs, the sync API, verification, and contributor guides
- [Contributing guide](.github/CONTRIBUTING.md) — setup, structure, conventions, testing, PRs
- [Code of Conduct](.github/CODE_OF_CONDUCT.md) — the Contributor Covenant we follow
- [Security policy](.github/SECURITY.md) — reporting a vulnerability
- [Publishing](.github/PUBLISHING.md) — the per-platform release process
- [Contributor License Agreement](CLA.md)

---

## Licence

[GNU General Public License v3.0](LICENSE)

Free to use privately or within your organisation without obligation.
Modified versions distributed publicly must be released under GPL-3.0.
