# Desktop Application (Windows) — user guide

How to record and send workflows with the Docent Windows desktop application. To
install a released build, use the Desktop Release badge on the
[root README](../../README.md); to build and run from source, see
[Contributing → Development Setup](../../.github/CONTRIBUTING.md#desktop-application-windows).

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
