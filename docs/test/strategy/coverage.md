# Test strategy — coverage reporting

How Docent's test coverage reaches Codecov, and how it is sliced. The layers it
reports on are described in [the test pyramid](test-pyramid.md).

Each rule carries a stable identifier (**COV-n**) so other documents, reviews,
and checks can cite it precisely. Identifiers are never renumbered; a retired
identifier stays reserved and is never reused. How each rule is verified — by an
existing named check, by a check that could be built, or by judgment — is
recorded per rule in the [clause registry](../../clause-registry.json). The key
words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as described in
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119). Keywords appear on a
clause's operative requirement where it has one; definitional clauses bind as
stated without a keyword, and subsidiary absolutes inside a clause inherit its
force. A clause's scope runs from its marker to the next marker or heading;
identifiers reflect minting order and can appear out of numeric sequence.

## How coverage reaches Codecov

**COV-1.** Each test job publishes its `lcov` as a build artifact instead of
uploading to Codecov directly. A single terminal `coverage-upload` job then
collects every artifact and uploads them back-to-back. This keeps the Codecov PR
comment from sitting on a stale intermediate value while jobs finish minutes
apart — the comment only converges once it has seen every upload, so bunching
them makes it correct sooner. If a job is skipped by a path filter, its artifact
is absent and that upload is silently skipped; Codecov `carryforward` keeps the
flag's last-known coverage.

## Flags and components

**COV-2.** Coverage is sliced two ways. **Flags** encode _how_ lines were
covered — the pyramid layer (`unit`, `integration`, `e2e`) crossed with language
(`javascript`, `rust`). **Components** encode _which package_ the code lives in
(`extension`, `desktop`, `shared`) — path-based filters defined in `codecov.yml`.

## Closed-world tracked-file lists (e2e and desktop integration)

**COV-3.** The two browser-driven Playwright suites cannot instrument source
files the way the unit runners do — they collect raw V8 coverage from live pages
and convert it to lcov afterwards. Each conversion filters the raw entries
against a **hard-coded, closed list** of source files and drops everything else:

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

What each list _says_ is machine-checked, even though what it omits is not:
`scripts/check-test-inventory.js` (the `lint` job's test-inventory gate) holds
every entry of each registered list to a tracked source file, and an entry that
carries both a served-URL match and a source path to one and the same file — so
an entry left behind by a rename reds instead of quietly collecting nothing.
