# Test strategy — coverage reporting

How Docent's test coverage reaches Codecov, and how it is sliced. The layers it
reports on are described in [the test pyramid](test-pyramid.md).

## How coverage reaches Codecov

Each test job publishes its `lcov` as a build artifact instead of uploading to
Codecov directly. A single terminal `coverage-upload` job then collects every
artifact and uploads them back-to-back. This keeps the Codecov PR comment from
sitting on a stale intermediate value while jobs finish minutes apart — the
comment only converges once it has seen every upload, so bunching them makes it
correct sooner. If a job is skipped by a path filter, its artifact is absent and
that upload is silently skipped; Codecov `carryforward` keeps the flag's
last-known coverage.

## Flags and components

Coverage is sliced two ways. **Flags** encode _how_ lines were covered — the
pyramid layer (`unit`, `integration`, `e2e`) crossed with language (`javascript`,
`rust`). **Components** encode _which package_ the code lives in (`extension`,
`desktop`, `shared`) — path-based filters defined in `codecov.yml`.

## Closed-world tracked-file lists (e2e and desktop integration)

The two browser-driven Playwright suites cannot instrument source files the way
the unit runners do — they collect raw V8 coverage from live pages and convert
it to lcov afterwards. Each conversion filters the raw entries against a
**hard-coded, closed list** of source files and drops everything else:

- **Extension e2e** — `TRACKED_FILES` in
  `packages/extension/tests/e2e/global-teardown.js` (a hand-maintained subset
  of the sidepanel, background, and content scripts the suite loads).
- **Desktop integration** — `TRACKED_FILES` in
  `packages/desktop/tests/integration/coverage-fixture.js` (a hand-maintained
  subset of the desktop frontend scripts, served from `dist/` and reported
  against `src/`).

The lists are closed worlds on purpose: page coverage sees every script a page
loads (test pages, injected mocks, third-party fixtures), and the list is what
keeps the report to Docent's own source. The cost is a maintenance rule —
**a Docent source file the suites load reports no e2e/integration coverage
until it is added to the matching `TRACKED_FILES` list** in the same change.
It still executes under the suites; its lines are silently absent from the
lcov, so the gap shows up only as missing file entries on Codecov, never as a
red check. The gap is live today, and larger than the lists suggest: the
loaded-but-untracked set includes the desktop `auto-sync-host.js` and
`tauri-bridge.js`, the sidepanel `secret-crypto.js`, the extension `lib/`
modules the pages and service worker load, and both platforms' synced
`shared/` layer — the last structurally so, since the served copies cannot
map back to their `packages/shared/` sources.
