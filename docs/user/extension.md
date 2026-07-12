# Chrome Extension — user guide

How to record and send workflows with the Docent Chrome extension. To install a
released build, use the Chrome Web Store badge on the [root README](../../README.md);
to build and load the extension from source, see
[Contributing → Development Setup](../../.github/CONTRIBUTING.md#chrome-extension).

## Create a project

1. Click the Docent icon — the side panel opens
2. Click **+ New** to create a project
3. Click **+ New recording** — recording begins immediately

## Record steps

1. Perform the actions in the browser
2. Provide context for the step (type narration in narration mode, or select
   action/validation in simple mode)
3. Click **Done this step**
4. Repeat for each step

The **Done this step** button is disabled until at least one action has been
recorded.

**Clear** discards the recorded actions for the current step without committing the
step.

## Edit steps

| Control         | Action                                               |
| --------------- | ---------------------------------------------------- |
| Click narration | View recorded actions for that step (read-only)      |
| Pencil icon     | Re-record — replace narration and actions for a step |
| Clock icon      | History — view all previous versions of a step       |
| Trash icon      | Delete — soft delete, history preserved              |
| Drag            | Reorder steps                                        |

## Export

Click **Export** on the project view to download a `.docent.json` file.

## Import

Click **Import** on the projects list to load a previously exported `.docent.json`
file.

## Send

Dispatch recordings directly from the extension — no terminal or Node.js required.

### Configure the endpoint

1. Click the gear icon to open Settings
2. Enter the **Dispatch endpoint** URL (must start with `http://` or `https://`)
3. Optionally enter an **API key** — sent as `Authorization: Bearer <key>`
4. Click **Save**

Local endpoints (e.g. `http://localhost:3000`) are supported.

### Send a recording

1. Open a project
2. Click **Send** — the button is enabled when an endpoint is configured and the
   project has recordings with steps
3. If the project has multiple recordings, choose which to send (or **Send all**)
4. Review the endpoint URL, recording name(s), and step count in the confirmation
   view
5. Click **Send** to dispatch — the full recording history is sent. A success or
   error message is shown
