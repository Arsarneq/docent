<img src="extension/icons/icon.svg" alt="Docent icon" width="110" />
<h1>Docent</h1>

> Demonstrated Behaviour Capture and Dispatch

A Chrome extension that records browser interactions alongside step-by-step narration, and exports the result as a structured JSON file.

---

## What it does

Docent captures browser interactions and pairs them with narration for each step. The result is a `.docent.json` file that describes what happened, in order, with full context.

The dispatch script extracts the active steps from an export and sends them, along with a reading guide, to a configured HTTP endpoint.

---

## How this differs

Most browser recording tools produce code — Playwright scripts, Selenium tests, Puppeteer flows. They assume you want to replay what was recorded, and they assume a specific framework to replay it in.

Docent produces data, not code. Each step is a pair: what was narrated, and what actually happened in the browser. The output makes no assumptions about what receives it or what it does with it.

The dispatch payload includes a reading guide that describes the data format, so any receiving system can interpret it without prior knowledge of Docent.

---

## Example flow

The diagram below shows one example of how Docent fits into a larger workflow.

```mermaid
flowchart LR
    A([Person]) -->|demonstrates workflow| B[Docent]
    B -->|steps + narration| C[.docent.json]
    C -->|dispatch| D([Agentic system])
    D -->|implements| E([Test suite])
```

A person demonstrates a workflow once. Docent captures each step — the narration and the browser actions. The structured output is dispatched to an agentic system that produces a test suite.

The `.docent.json` format is the contract between capture and consumption.

---

## How it works

1. Open the Docent side panel in Chrome
2. Create a project and a recording — recording starts automatically
3. Narrate the step
4. Perform the actions in the browser
5. Click **Done this step** — repeat for each step
6. Click **Export** — a `.docent.json` file is downloaded
7. Run the dispatch script to send the active steps to a configured endpoint

Steps can be **re-recorded**, **reordered**, and **deleted** at any point before export. Full version history is preserved.

---

## Project structure

```
extension/              Chrome Extension (Manifest V3)
  manifest.json
  background/
    service-worker.js   Message routing, navigation and tab lifecycle capture
  content/
    recorder.js         DOM event capture (clicks, typing, navigation, tab lifecycle, drag, scroll, keyboard)
  sidepanel/
    index.html          Side panel UI
    panel.js
    panel.css
  lib/
    uuid-v7.js          UUID v7 generation and utilities
    session.js          Session model, versioning, resolution logic
dispatch/
  send.js               Extracts active steps and sends them to a configured HTTP endpoint
  reading-guidance.md   Included in every dispatch payload
docs/
  session-format.md     The .docent.json format specification
```

---

## Installation (development)

1. Clone the repo

```bash
git clone https://github.com/Arsarneq/docent.git
```

2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the `extension/` folder
5. The Docent icon appears in the Chrome toolbar

No build step required.

---

## Using the extension

### Create a project

1. Click the Docent icon — the side panel opens
2. Click **+ New** to create a project
3. Click **+ New recording** — recording begins immediately

### Record steps

1. Perform the actions in the browser
2. Type the narration for the step
3. Click **Done this step**
4. Repeat for each step

The **Done this step** button is disabled until at least one action has been recorded.

**Clear** discards the recorded actions for the current step.

### Edit steps

| Control | Action |
|---|---|
| Click narration | View recorded actions for that step (read-only) |
| Pencil icon | Re-record — replace narration and actions for a step |
| Clock icon | History — view all previous versions of a step |
| Trash icon | Delete — soft delete, history preserved |
| Drag | Reorder steps |

### Export

Click **Export** on the project view to download a `.docent.json` file.

### Import

Click **Import** on the projects list to load a previously exported `.docent.json` file.

---

## Dispatch

Extracts active steps from an export and sends them, along with a reading guide, to a configured HTTP endpoint.

**Requirements:** Node.js 20+

```bash
cd dispatch
npm install

# Set endpoint
export DOCENT_ENDPOINT_URL=https://your-endpoint.example.com
export DOCENT_ENDPOINT_API_KEY=your-key   # optional

# Send
node send.js my_project_1713261700000.docent.json

# Preview without sending
node send.js my_project_1713261700000.docent.json --dry_run

# Override endpoint inline
node send.js my_project_1713261700000.docent.json --endpoint https://other-endpoint.example.com

# Send only one recording from a multi-recording project
node send.js my_project_1713261700000.docent.json --recording "Login flow"
```

---

## Session format

See [docs/session-format.md](docs/session-format.md) — the `.docent.json` specification.

---

## Contributing

See [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md).

All contributors must sign the [CLA](CLA.md). The CLA Assistant bot handles this automatically on pull requests.

---

## Licence

[GNU General Public License v3.0](LICENSE)

Free to use privately or within your organisation without obligation.
Modified versions distributed publicly must be released under GPL-3.0.
