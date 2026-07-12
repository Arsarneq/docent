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
