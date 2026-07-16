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
3. Click **Done this step** (labelled **Commit** in simple mode)
4. Repeat for each step

Captured actions accumulate in the **Captured actions** list until you commit
the step — the rules for that list are in [Pending actions](#pending-actions).

## Pending actions

While you record, each captured action joins the **Captured actions** list —
the step's pending actions. They become part of the recording only when you
commit the step:

| You do                                         | Pending actions                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| **Done this step** (**Commit** in simple mode) | Committed into the step — the next step starts from an empty list. |
| **Clear**                                      | Discarded, after a confirmation.                                   |
| **Pause**, then **Resume**                     | Preserved.                                                         |
| Open or create any recording                   | Discarded.                                                         |
| Restart the browser                            | Preserved.                                                         |

The commit button stays disabled while the list is empty; in narration mode it
also requires narration text.

Closing the side panel does not stop capture: actions keep accumulating while
the panel is closed. The reopened panel starts at the projects list, and
entering the recording again discards what accumulated in the meantime.

Re-recording a step (the pencil icon) starts from an empty list. Cancelling a
re-record does not restore the previous list — actions captured during the
re-record stay pending.

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

Click **Import** on the projects list and choose a previously exported
`.docent.json` file. Before anything is stored, the file must:

1. Parse as JSON — otherwise the import stops with "Could not read file — make
   sure it is a valid .docent.json".
2. Stay within the ingestion bounds: at most 10 MiB of JSON, nested at most
   64 levels deep.
3. Validate against the extension's schema, including its `docent_format`
   stamp — a file exported by a different platform or schema version is
   rejected by design (see
   [Import acceptance](../technical/session-format.md#import-acceptance)). To
   keep importing files across a schema version bump, pin the producing
   version — see
   [Schema version pinning](../technical/session-format.md#schema-version-pinning).

A file that fails the bounds or the schema check is rejected with "Import
failed: file does not match the Docent format." plus the first few validation
errors, and nothing is imported. When the packaged validator itself cannot
load, the import proceeds without the bounds and schema checks and the
degradation is logged to the console.

Importing a project that already exists creates a fresh copy: the copy gets a
new identity and its name is suffixed " (copy)"; the existing project is never
overwritten or merged.

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

## Sync

Sync keeps projects in step with a sync server, so recordings made on one
machine appear on the others. The extension talks to any server implementing
the [Sync Protocol](../api/sync-protocol.md); this section covers the
extension's controls.

### Configure the sync server

1. Click the gear icon to open Settings
2. Enter the **Sync server** URL (must start with `http://` or `https://`;
   `https://` is required when an API key is set, except for localhost)
3. Optionally enter an **API key** — sent as `Authorization: Bearer <key>`
4. Click **Save**

Saving a changed URL or API key invalidates the previous connection test and
turns Auto-sync off until a fresh test passes. Saving unchanged settings
leaves the previous test valid.

### Test the connection

Click **Test connection** (enabled once a sync server URL is configured). The
line below the button reads "Testing…" while the test runs, then one of:

| Status line                                                  | Meaning                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| Connection OK.                                               | The server responded; Auto-sync can be enabled.                    |
| Authentication failed — check your API key, then test again. | The server rejected the credentials.                               |
| Server unreachable — check the address, then test again.     | The server could not be reached, or returned an unexpected status. |

A result belongs to the settings it was taken against: change the URL or API
key and the status line disappears until you test again.

### Auto-sync

Turn on the **Auto-sync** toggle to sync automatically. It can be enabled only
when a sync server is configured and the connection test has passed for the
current settings; until then the toggle is disabled and a hint under it says
what is missing. While Auto-sync is on, Settings shows "Auto-sync active" and
the manual Sync button is hidden.

Auto-sync runs in the background — with the side panel closed, and across
browser restarts. A sync follows the main recording events — committing a
step, stopping capture, and creating or deleting a project or recording —
with bursts of events folded together; a backstop sync runs about once a
minute, and it also carries every other kind of edit and brings in other
machines' changes. While you are recording, automatic syncs stay quiet. An
authentication failure during any sync turns Auto-sync off — test the
connection again to re-enable it.

### Reconciliation toggles

Two Settings toggles, both off by default, let a sync apply safe incoming
changes without holding them for review:

- **Auto-accept updates** — applies an incoming change to a recording you have
  not changed, when it only extends that recording (same name and metadata).
- **Auto-accept deletions** — applies a server-side deletion of a recording or
  project you have not changed.

Neither ever resolves a conflict. A toggle change takes effect from the next
sync and also covers items already waiting for your review: turn a toggle on
and the matching undecided items are applied by the next sync. The exact rules
are in the
[Sync Protocol's reconcile phase](../api/sync-protocol.md#reconcile-phase).

### Manual sync

With Auto-sync off, the **Sync** button in the Projects list header runs one
sync. It is enabled once a sync server is configured, and reads "Syncing…"
while the sync runs.

### What a sync does

A sync pulls the server's projects, reconciles them with yours, and pushes
your changes back. It ends with a summary — counts of pushed and pulled
projects, skipped incompatible projects (each with its reason), auto-applied
updates and deletions, changes to review, conflicts, and errors — or
"Everything up to date". When anything needs your attention, the summary says
so and the affected rows are marked in the list.

A sync can instead halt:

| Message                                                                                               | What to do                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sync paused while you're recording. Stop capture, then sync again.                                    | Pause the recording, then sync.                                                                                                                                                 |
| Sync paused: a recording has uncommitted actions. Commit or clear them, then sync again.              | Commit the pending actions into a step, or **Clear** them, then sync.                                                                                                           |
| Sync stopped to protect your data and made no changes. Your work and any pending items are preserved. | Sync again — your local data is unchanged.                                                                                                                                      |
| Sync halted: authentication failed. Check your API key in Settings.                                   | Fix the API key and test the connection again. A push-phase failure lands after the pull — pulled items were already reconciled: new ones added, the rest held for your review. |

### Attention badges

After a sync, rows that need a decision carry a badge:

- **Review** — the server changed (or deleted) something you have not touched;
  you choose whether to apply it.
- **Conflict** — the same recording or project changed on both sides; you
  choose which version to keep.

A recording row in the project view shows its own badge. A project row shows
its own badge plus, when any of its recordings needs attention, one rolled-up
badge per kind — selecting a rolled-up badge opens the project so the marked
recordings become visible. Selecting any other badge opens the resolution
view; **Back** leaves the item unresolved and keeps the badge.

### Resolve a review

The review view shows the incoming version. **Accept** applies it to your
data and clears the badge. **Decline** keeps your version — the same incoming
version is not offered again, while a newer incoming version is.

### Resolve a conflict

The conflict view shows **Your version** and **Incoming version** side by
side; the absent side of a delete-vs-change conflict reads "Deleted (no
version on this side)". Choose **Keep your version** or **Keep incoming
version** — the kept version becomes the active one. When both sides carry a
version, the recording's step history keeps the committed steps of both (a
replaced step's earlier versions stay reachable through its History view);
keeping a deleted side removes the recording or project. Accepting a deletion
is always an explicit choice — a conflict never resolves to one on its own.
