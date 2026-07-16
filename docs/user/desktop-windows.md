# Desktop Application (Windows) — user guide

How to record and send workflows with the Docent Windows desktop application.
To install a released build, see [Install](#install); to build and run from
source, see
[Contributing → Development Setup](../../.github/CONTRIBUTING.md#desktop-application-windows).

## Install

Download an installer from the newest desktop release on the
[GitHub releases page](https://github.com/Arsarneq/docent/releases) — desktop
releases are tagged `desktop-vX.Y.Z`. Every desktop release attaches two
installers; both install the same application, so pick either:

- `Docent.Desktop_X.Y.Z_x64-setup.exe` — the standard setup executable
- `Docent.Desktop_X.Y.Z_x64_en-US.msi` — the MSI package

Download one of those two files — not the "Source code" archives, which GitHub
generates automatically for every release and contain the source repository,
not the application.

Releases tagged `-rc.N` are beta builds published for testing; install a
release without an `-rc` suffix unless you are testing a candidate.

### The SmartScreen warning

The installer is not yet code-signed
([docent#72](https://github.com/Arsarneq/docent/issues/72) tracks signing), so
when you run it Windows SmartScreen warns that the app comes from an unknown
publisher. To proceed, expand the warning's details — the **More info** link
on most Windows versions — and choose **Run anyway**; the installer then runs
normally.

### Updates

The app has no auto-updater by design, so you control which version you run.
To update, download the installer from a newer release and install it over the
existing installation.

## Record a workflow

The desktop app provides the same workflow as the Chrome extension:

1. Create a project and a recording
2. Select a target application from the list of running windows
3. Perform actions in native applications — interactions are captured automatically
4. Provide context for each step and click **Done this step**
5. Export as `.docent.json` or dispatch directly to an endpoint

The desktop capture layer uses the Windows UI Automation accessibility API for rich
element descriptions. When an element lacks accessibility data, it falls back to
coordinate-based capture for that individual action. A single recording can contain a
mix of both modes. (For the full capture rules, see
[Desktop capture (Windows)](../architecture/application/desktop/windows/capture-principles.md).)

## Send

The dispatch workflow is identical to the extension: configure an endpoint in
Settings, then click **Send** on a project. See the extension guide's
[Send section](extension.md#send) for the step-by-step dispatch flow.

## Sync

Sync keeps projects in step with a sync server, and the desktop app shares the
extension's controls: Settings has the same fields, and configuring the
server, testing the connection, Auto-sync, the reconciliation toggles, manual
sync, attention badges, and resolving reviews and conflicts all work as
described in the extension guide's [Sync section](extension.md#sync).

One behaviour is desktop-specific: while Auto-sync is on, closing the window
hides it to the system tray instead of quitting, so automatic syncs keep
running in the background. The tray icon's menu has **Show Docent**, which
brings the window back, and **Quit**, which exits the app. With Auto-sync off,
closing the window quits the app normally.

## Your data

The app keeps its data on your machine:

- **Projects, recordings, and settings** persist in
  `%APPDATA%/com.docent.desktop/session.json`. When that file is missing or
  unreadable, the app starts with an empty state.
- **API keys** — the dispatch and sync keys entered in Settings — are stored
  in Windows Credential Manager, never in the session file.
