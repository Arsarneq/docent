# Chrome Extension — user guide

How to record and send workflows with the Docent Chrome extension. To install a released build, use the Chrome Web Store badge on the [root README](../../README.md). To build and load the extension from source, see [Contributing → Development Setup](../../.github/CONTRIBUTING.md#chrome-extension).

## Create a project

1. Click the Docent icon. The side panel opens.
2. Click **+ New**, name the project and click **Create project**.
3. Click **+ New recording**, name it and click **Create & start recording**. Recording begins as the recording is created.

## Record steps

1. Perform the actions in the browser.
2. Give the step context: type narration in narration mode, or select action/validation in simple mode.
3. Click **Done this step** (labeled **Commit** in simple mode).
4. Repeat for each step.

Captured actions collect in the **Captured actions** list until you commit the step ([Pending actions](#pending-actions) gives the rules). For the full capture rules (what is recorded, and the actions the extension leaves out), see [Extension capture](../architecture/application/extension/capture-principles.md).

## Pending actions

While you record, each captured action joins the **Captured actions** list as one of the step's pending actions. They become part of the recording only when you commit the step:

| You do                                         | Pending actions                                                                                                |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Done this step** (**Commit** in simple mode) | Committed into the step. The next step starts from an empty list.                                              |
| **Clear**                                      | Discarded, after a confirmation.                                                                               |
| **Pause**, then **Resume**                     | Preserved.                                                                                                     |
| Open or create any recording                   | Discarded.                                                                                                     |
| Restart the browser                            | Kept until you open or create a recording, which discards it (the reopened panel starts at the projects list). |

The commit button stays disabled while the list is empty. In narration mode it also needs narration text.

Closing the side panel does not stop capture: actions keep collecting while it is closed. The reopened panel starts at the projects list. Entering the recording again discards what collected in the meantime.

Re-recording a step (the pencil icon) starts from an empty list. Canceling a re-record does not restore the previous list: actions captured during the re-record stay pending. Leaving the recording through the breadcrumb ends a re-record the way Cancel does.

### Side panels in two windows

Each browser window has its own side panel. Each panel works on the project and recording it shows: renaming, metadata, deleting, history and reordering act there. Capture is one per browser, though:

- Actions, and the pending list, go to the recording last opened or created in any panel.
- Opening or creating a project in any panel stops capture until a recording is opened or created.
- After another panel opens or creates a project or a recording, this panel refuses **Resume**, **Done this step**, **Clear** and re-record with a message such as "Commit failed: Not the active recording". It refuses **Pause** the same way while the other panel is capturing.
- A refused action changes nothing, and the panel then shows its recording as paused.

To record into this panel's recording again, open it again from its project.

## Edit steps

| Control         | Action                                              |
| --------------- | --------------------------------------------------- |
| Click narration | View recorded actions for that step (read-only)     |
| Pencil icon     | Re-record: replace narration and actions for a step |
| Clock icon      | History: view all previous versions of a step       |
| Trash icon      | Delete (soft delete, history preserved)             |
| Drag            | Reorder steps                                       |

## Export

Click **Export** on the project view to download a `.docent.json` file.

## Import

Click **Import** on the projects list and choose a previously exported `.docent.json` file. Before anything is stored, the file must:

1. Parse as JSON. Otherwise the import stops with "Could not read file — make sure it is a valid .docent.json".
2. Stay within the ingestion bounds: at most 10 MiB of JSON, nested at most 64 levels deep.
3. Validate against the extension's schema, including its `docent_format` stamp. A file exported by a different platform or schema version is rejected by design (see [Import acceptance](../technical/session-format.md#import-acceptance)). To keep importing files across a schema version bump, pin the producing version (see [Schema version pinning](../technical/session-format.md#schema-version-pinning)).

A file failing the bounds or schema check is rejected with "Import failed: file does not match the Docent format." plus the first few validation errors. Nothing is imported. If the packaged validator itself cannot load, the import goes ahead without the bounds and schema checks, and logs the degradation to the console.

Importing a project that already exists creates a fresh copy. The copy gets a new identity, and its name gets the suffix " (copy)". The existing project is never overwritten or merged.

## Send

Dispatch recordings directly from the extension, with no terminal or Node.js.

### Configure the endpoint

1. Click the gear icon to open Settings.
2. Enter the **Dispatch endpoint** URL (`http://` or `https://`). Once an API key is set, `https://` is required except for a loopback address. The full policy is in [Dispatch — endpoint URL policy](../api/dispatch.md#endpoint-url-policy).
3. Optionally enter an **API key**, sent as `Authorization: Bearer <key>`.
4. Click **Save**.

Local endpoints (for example `http://localhost:3000`) are supported.

### Send a recording

1. Open a project.
2. Click **Send**. The button is enabled when an endpoint is configured, the project has recordings with steps, and the short cooldown after the previous send has passed.
3. If the project has multiple recordings, choose which to send (or **Send all**).
4. In the confirmation view, review the endpoint URL, recording name(s) and step count.
5. Click **Send** to dispatch. The full recording history is sent, then a success or error message shows.

## Sync

Sync keeps projects in step with a sync server, so recordings made on one machine appear on the others. The extension works with any server that implements the [Sync Protocol](../api/sync-protocol.md).

### Configure the sync server

1. Click the gear icon to open Settings.
2. Enter the **Sync server** URL (`http://` or `https://`). Once an API key is set, `https://` is required except for a loopback address.
3. Optionally enter an **API key**, sent as `Authorization: Bearer <key>`.
4. Click **Save**.

Saving a changed URL or API key invalidates the previous connection test and turns Auto-sync off until a fresh test passes. Saving unchanged settings leaves the previous test valid.

### Test the connection

Click **Test connection** (enabled once a sync server URL is configured). The line below the button reads "Testing…" while the test runs, then one of:

| Status line                                                  | Meaning                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| Connection OK.                                               | The server responded; Auto-sync can be enabled.                    |
| Authentication failed — check your API key, then test again. | The server rejected the credentials.                               |
| Server unreachable — check the address, then test again.     | The server could not be reached, or returned an unexpected status. |

A result belongs to the settings it was taken against. If you change the URL or API key, the status line disappears until you test again.

### Auto-sync

Turn on the **Auto-sync** toggle to sync automatically. You can enable it only when a sync server is configured and the connection test has passed for the current settings. Until then the toggle is disabled, and a hint under it says what is missing. While Auto-sync is on, Settings shows "Auto-sync active" and the manual Sync button is hidden.

Auto-sync runs in the background, with the side panel closed and across browser restarts. One caveat, in the extension: a browser restart clears the session-held key that decrypts the stored API key (see [Persistence](../architecture/system/persistence.md)). The stored key then reads as not configured. With a key-protected server, the first background cycle after a restart is sent without the key, and the server rejects it. Auto-sync then turns itself off until you re-enter the key and test the connection again.

A sync follows the main recording events, with bursts of events folded together:

- committing a step;
- closing a recording (leaving its view; in the extension, pausing capture also requests one);
- creating or deleting a project or recording.

A backstop sync runs about once a minute. It also carries every other kind of edit and brings in other machines' changes. While you are recording, automatic syncs stay quiet. An authentication failure during any sync turns Auto-sync off. Test the connection again to re-enable it.

### Reconciliation toggles

Two Settings toggles, both off by default, let a sync apply safe incoming changes without holding them for review:

- **Auto-accept updates** applies an incoming change to a recording you have not changed, when the change only extends that recording (same name and metadata).
- **Auto-accept deletions** applies a server-side deletion of a recording or project you have not changed. A project whose name and metadata this client and the server have not yet agreed on counts as changed.

Neither toggle ever resolves a conflict. A toggle change takes effect from the next sync. It also covers items already waiting for your review: turn a toggle on and the next sync applies the matching undecided items. The exact rules are in the [Sync Protocol's reconcile phase](../api/sync-protocol.md#reconcile-phase).

### Manual sync

With Auto-sync off, the **Sync** button in the Projects list header runs one sync. It is enabled once a sync server is configured, and reads "Syncing…" while the sync runs.

### What a sync does

A sync pulls the server's projects, reconciles them with yours, and pushes your changes back. It ends with "Everything up to date" or a summary with counts of pushed and pulled projects, skipped incompatible projects (each with its reason), auto-applied updates and deletions, changes to review, conflicts, and errors. When anything needs your attention, the summary says so and the affected rows are marked in the list.

A sync can instead halt:

| Message                                                                                               | What to do                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sync paused while you're recording. Stop capture, then sync again.                                    | Pause the recording, then sync.                                                                                                                                                                                                                  |
| Sync paused: a recording has uncommitted actions. Commit or clear them, then sync again.              | Commit the pending actions into a step, or **Clear** them, then sync.                                                                                                                                                                            |
| Sync stopped to protect your data and made no changes. Your work and any pending items are preserved. | Sync again. Your local data is unchanged.                                                                                                                                                                                                        |
| Sync halted: authentication failed. Check your API key in Settings.                                   | Fix the API key and test the connection again. A push-phase failure lands after the pull, so pulled items were already reconciled: new ones added, automatic updates and deletions applied as your toggles allow, the rest held for your review. |

### Attention badges

After a sync, rows that need a decision carry a badge:

- **Review**: the server changed (or deleted) something you have not touched. You choose whether to apply it.
- **Conflict**: the same recording or project changed on both sides. You choose which version to keep. A project whose name and metadata this client and the server have not yet agreed on counts as changed on the side that still holds it when the other side deletes it (sync protocol [SP-10](../api/sync-protocol.md#reconcile-phase)).

A recording row in the project view shows its own badge, and so does a project row. A project row also shows one rolled-up badge per kind when any of its recordings needs attention. Selecting a rolled-up badge opens the project to show the marked recordings. Selecting any other badge opens the resolution view, where **Back** leaves the item unresolved and keeps the badge.

### Resolve a review

The review view shows the incoming version. **Accept** applies it to your data and clears the badge. **Decline** keeps your version. The same incoming version is not offered again, but a newer one is.

### Resolve a conflict

The conflict view shows **Your version** and **Incoming version** side by side. In a delete-vs-change conflict, the absent side reads "Deleted (no version on this side)". Choose **Keep your version** or **Keep incoming version**. The kept version becomes the active one:

- When both sides carry a version, the recording's step history keeps the committed steps of both. A replaced step's earlier versions stay reachable through its History view.
- Keeping a deleted side removes the recording or project.

Accepting a deletion is always an explicit choice: a conflict never resolves to one on its own.

## Local control

Local control lets a program on your own computer run the panel for you. The program can:

- create a project or a recording;
- pause and resume capture;
- commit a step;
- export the project open in the panel, only if you allow it when you turn local control on.

It cannot delete, rename, import, send, sync, or change a setting. It is off until you turn it on, and it turns off when you close the panel.

1. Note the port that the program driving Docent listens on. You can start the program before or after the next step.
2. In the panel header, open **Local control** and enter the port. To let the program export, tick **Let the local program export the project open here, with its full step history** (the box starts unticked). Then choose **Turn on**. A banner on every view then says local control is on and shows a pairing code: sixteen letters and digits in four groups of four, such as `7K3M-Q9XZ-4HTR-WB2N`. The hyphens only make it easier to read.
3. Give the pairing code to the program. Once it has paired, the code disappears from the banner.
4. Choose **Turn off** in the banner to end it.

The export choice holds until local control turns off, which unticks the box again, so you choose at each turn-on. To change it, turn local control off and on again. While export is allowed, the banner says so. After each export, it names the project exported and counts the exports so far. An export holds the whole project open in the panel (every recording, with its full step history, deleted steps included). It is the same file the **Export** button writes. Whichever project you open while export is allowed is the one the program can export.

While a program drives the panel, it moves by itself: a new project opens, a new recording starts, a committed step joins the list. Creating a recording or a project drops uncommitted captured actions, as when you do it yourself. A command sent while you re-record a step or commit one is refused, and the program is told why.

A program can also ask the panel where it stands. The panel always answers, even while you re-record a step, with:

- the open project and recording;
- whether capture is on;
- how many actions and steps there are;
- whether export is allowed;
- which storage warning, if any, the panel shows;
- whether you are re-recording a step.

A pairing code works once. Local control turns itself off, and tells you why, when:

- pairing fails;
- the program disconnects;
- no program has answered on the port after 150 tries (about five minutes when nothing listens there).

Turn it on again to get a new code. The panel only ever connects to your own computer (`127.0.0.1`).

The [Local Control Channel](../api/control-channel.md) document specifies the protocol a program speaks.
