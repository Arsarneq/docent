# Backward-compatibility fixture corpus (#87)

Real, frozen `.docent.json` exports used as **regression anchors** for schema
backward compatibility. Each fixture is validated for **shape** compatibility
against the _current_ platform schema by `backward-compat.test.js` (the version
stamp is deliberately ignored — see
[Validation is by shape](#validation-is-by-shape-not-by-version-stamp)).

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

## Validation is by SHAPE, not by version stamp

The published schema pins `docent_format.schema_version` as a `const` (= the
current release), so on a strict validation an older-version fixture would fail on
the **stamp alone**, even when its data shape is fully compatible. To test what
actually matters — _does an old export still fit today's shape?_ —
`backward-compat.test.js` validates each fixture against a clone of the current
schema with the `schema_version` const **relaxed to a plain string** (the
`platform` const is kept). A `v2` fixture therefore validates against a `v3`
schema if, and only if, the shape still fits.

Two consequences:

- **A schema major bump needs ZERO fixture re-stamping.** Frozen fixtures keep
  validating across versions; only a genuine _shape_ change makes one fail, which
  is exactly the signal this corpus exists to raise. (This closes the manual
  re-stamp sweep that bit the 3.0.0 / 2.0.0 release.)
- **The relaxation is local to this test harness.** The published schemas
  (`schemas/dist/`), the source layers, and the generated import/sync validators
  keep the `const` intact — strict import-time version-gating is intentional and
  untouched. Tests that exercise the real (const-bearing) validator derive their
  stamp from the current schema via `stampFromSchema(composePlatform(...))` rather
  than hardcoding a version, so they too need no edit on a bump.
