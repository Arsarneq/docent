# Backward-compatibility fixture corpus (#87)

Real, frozen `.docent.json` exports used as **regression anchors** for schema
backward compatibility. Each fixture is validated against the _current_ published
platform schema by `backward-compat.test.js`.

## Why this exists

When a platform schema is edited, these fixtures answer one question: **would a
file exported by an older (or current) version of Docent still import cleanly
today?** If a schema change adds a required field, renames a property, or
tightens a type, the matching fixtures stop validating and the test fails with a
clear diff — turning a silent backward-compatibility break into a loud one.

## Layout — convention over configuration

```text
fixtures/
  <platform>/
    v<MAJOR.MINOR.PATCH>.docent.json
```

- `<platform>` maps to a platform in `scripts/build-schemas.js` `PLATFORMS`
  (e.g. `extension`, `desktop-windows`).
- The version in the filename records which schema version produced the export.

The test **auto-discovers** every `<platform>/<file>.docent.json` here and
validates it against that platform's schema, **composed from the source layers
in-memory** (via `composePlatform`) — not against the released copy under
`schemas/dist/`, which can lag a PR's schema changes. Adding a new platform (to
`PLATFORMS`) or a new historical version is purely additive: drop a file in, no
test changes.

## Adding a fixture

- **New historical version** (after a real schema bump): export a representative
  `.docent.json` from the version being frozen and commit it as
  `<platform>/v<old-version>.docent.json`. It must keep validating against the
  current schema for as long as backward compatibility is intended to hold.
- **New platform** (e.g. `desktop-linux` when #84 lands): create
  `fixtures/desktop-linux/` and add a real export. The harness picks it up with
  no code change. See Arsarneq/docent#84.

## Important

These are **real exports**, not hand-authored guesses. They are frozen on
purpose — fixed UUIDs and timestamps make them deterministic regression anchors.
Do not "fix" a fixture to make a failing test pass: a failure means a schema
change broke backward compatibility, which is the signal this corpus exists to
raise. Decide intentionally whether that break is acceptable (major version bump)
before touching a fixture.

## Caveat — the `docent_format.schema_version` const

`schema_version` is a `const` per published schema, so a fixture stamped at an
older version can never validate against a newer schema — the stamp alone
mismatches, regardless of real data-shape compatibility. A **major** schema bump
therefore breaks every frozen fixture on the stamp, and the only resolution today
is to re-stamp + rename the fixtures to the new version (a deliberate
regeneration, sanctioned only by an intentional major bump). This limits the
corpus to the _current_ version. Reworking the compat check to ignore the version
stamp (validate data shape, treat `schema_version` as any-string) would restore
true cross-version coverage — tracked as tech debt.
