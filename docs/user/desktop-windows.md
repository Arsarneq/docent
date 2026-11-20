# Desktop Application (Windows) — user guide

How to record and send workflows with the Docent Windows desktop application. To install a released build, see [Install](#install). To build and run from source, see [Contributing → Development Setup](../../.github/CONTRIBUTING.md#desktop-application-windows).

## Install

Download an installer from the newest desktop release on the [GitHub releases page](https://github.com/Arsarneq/docent/releases). Desktop releases are tagged `desktop-vX.Y.Z`. Every desktop release attaches two installers. Both install the same application, so pick either:

- `Docent.Desktop_X.Y.Z_x64-setup.exe`: the standard setup executable
- `Docent.Desktop_X.Y.Z_x64_en-US.msi`: the MSI package

Do not download the "Source code" archives. GitHub generates them for every release, and they contain the source repository, not the application.

Releases tagged `-rc.N` are beta builds for testing. Install a release without an `-rc` suffix unless you are testing a candidate.

### The SmartScreen warning

The installer is not yet code-signed ([docent#72](https://github.com/Arsarneq/docent/issues/72) tracks signing). When you run it, Windows SmartScreen warns that the app comes from an unknown publisher. To proceed:

1. Expand the warning's details (the **More info** link on most Windows versions).
2. Choose **Run anyway**. The installer then runs normally.

### Updates

The app has no auto-updater by design, so you control which version you run. To update, download the installer from a newer release and install it over the existing installation.

## Record a workflow

The desktop app has the same workflow as the Chrome extension:

1. Create a project and a recording.
2. Select a target application from the list of running windows.
3. Perform actions in native applications. Interactions are captured automatically.
4. Give context for each step and click **Done this step**.
5. Export as `.docent.json` or dispatch directly to an endpoint.

Desktop capture uses the Windows UI Automation accessibility API for rich element descriptions. When an element lacks accessibility data, capture falls back to coordinates for that one action. A single recording can mix both modes. For the full capture rules, see [Desktop capture (Windows)](../architecture/application/desktop/windows/capture-principles.md).

By default, Docent excludes its own process from capture. A recording then stays about the application you are demonstrating, instead of filling up with the clicks and typing you do in the Docent window. The **Exclude Docent from capture** checkbox below the target-application selector controls this, and a change takes effect immediately. The same [capture rules](../architecture/application/desktop/windows/capture-principles.md) say which windows the exclusion covers (the file dialogs and other windows Docent itself puts on screen).

## Send

Dispatch works exactly as in the extension: configure an endpoint in Settings, then click **Send** on a project. The extension guide's [Send section](extension.md#send) has the step-by-step flow.

## Sync

Sync keeps projects in step with a sync server. The desktop app shares the extension's controls, and Settings has the same fields. Configuring the server, testing the connection, Auto-sync, the reconciliation toggles, manual sync, attention badges, and resolving reviews and conflicts all work as the extension guide's [Sync section](extension.md#sync) describes.

One behavior is desktop-specific. While Auto-sync is on, closing the window hides it to the system tray instead of quitting, so automatic syncs keep running in the background. The tray icon's menu has **Show Docent**, which brings the window back, and **Quit**, which exits the app. With Auto-sync off, closing the window quits the app normally.

## Your data

The app keeps its data on your machine:

- **Projects, recordings, and settings** persist in `%APPDATA%/com.docent.desktop/session.json`. If that file is missing or unreadable, the app starts with an empty state.
- **API keys** (the dispatch and sync keys entered in Settings) are stored in Windows Credential Manager, never in the session file.
- **Uncommitted captured actions** live only in the running app. Quitting discards them; committed steps are already saved in the session file.
