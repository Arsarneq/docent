# Backward-compatibility fixture corpus (#87)

Real, frozen `.docent.json` exports used as **regression anchors** for schema
backward compatibility. Each fixture is validated for **shape** compatibility
against the _current_ platform schema by `backward-compat.test.js` (the version
stamp is deliberately ignored — see
[Validation is by shape](#validation-is-by-shape-not-by-version-stamp)).

The corpus lives under `packages/shared/tests/fixtures/`; its validating harness is
`packages/shared/tests/unit/backward-compat.test.js`.

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

The test **auto-discovers** every `<platform>/<file>.docent.json` under
`packages/shared/tests/fixtures/` and
validates it against that platform's schema, **composed from the source layers
in-memory** (via `composePlatform`) — not against the released copy under
`schemas/dist/`, which can lag a PR's schema changes. Adding a new platform (to
`PLATFORMS`) or a new historical version is purely additive: drop a file in, no
test changes.

## What lives in `fixtures/`

Discovery is by the `.docent.json` suffix — `backward-compat.test.js` globs
`<platform>/*.docent.json`, and the sufficiency lint's `collectFiles` picks up
every `.docent.json` recursively — so a file carrying that suffix under this
directory **is** a corpus member: it gets shape-validated and linted into the
baseline automatically. That is the admission rule: only a real frozen export
may carry the suffix here. The directory's residents are exactly:

1. **The frozen-export corpus** — `<platform>/v<version>.docent.json`, real
   exports frozen at a known schema version (see
   [Adding a fixture](#adding-a-fixture)).
2. **`sufficiency-baseline.json`** — the committed lint baseline (see
   [Sufficiency baseline](#sufficiency-baseline)); its plain `.json` suffix
   keeps it out of both discovery sweeps.
3. **`stub-schema.js`** — the one resident unrelated to the corpus: a minimal
   schema stub carrying just the `docent_format` consts that
   `buildPayload`/`buildExport` require, imported by the shared unit tests
   that exercise payload/export projection logic and need `payload.schema` to
   stay tiny (size- and timing-sensitive assertions). It lives here because it
   is shared test-fixture data rather than a test, and as a `.js` file it is
   invisible to both discovery sweeps. Tests asserting real schema content use
   `composePlatform()` instead.

## Adding a fixture

- **New historical version** (after a real schema bump): export a representative
  `.docent.json` from the version being frozen and commit it as
  `<platform>/v<old-version>.docent.json`. It must keep validating against the
  current schema for as long as backward compatibility is intended to hold.
- **New platform** (e.g. `desktop-linux` when #84 lands): create
  `packages/shared/tests/fixtures/desktop-linux/` and add a real export. The harness picks it up with
  no code change. See Arsarneq/docent#84.

## Important

These are **real exports**, not hand-authored guesses. They are frozen on
purpose — fixed UUIDs and timestamps make them deterministic regression anchors.
Do not "fix" a fixture to make a failing test pass: a failure means a schema
change broke backward compatibility, which is the signal this corpus exists to
raise. Decide intentionally whether that break is acceptable (major version bump)
before touching a fixture.

## Sufficiency baseline

`packages/shared/tests/fixtures/sufficiency-baseline.json` is the committed output of
the replay-sufficiency lint (`scripts/sufficiency-lint.js` — the static predicates of
[Replay Sufficiency](../requirements/replay-sufficiency.md)) over **two roots**:
this fixture corpus _and_ the
[scripted-truth corpus](../verification/scripted-truth-corpus.md)'s committed
truth recordings under `corpus/sessions/` (the `sufficiency:check` npm script
names both, and `sufficiency-lint.test.js` locks the findings over the same
two roots exactly). The frozen fixtures document historical truth — the
baseline locks the _rules_ and each corpus's known findings, not a claim
about current capture output; recordings produced by current code enter it as
scripted-truth sessions land under `corpus/sessions/`. A baseline diff in
either direction is a signal: a NEW finding means a predicate or corpus file
changed; a VANISHED finding means the baseline is stale. Regenerate
deliberately with

```bash
npm run sufficiency:check -- --write-baseline packages/shared/tests/fixtures/sufficiency-baseline.json
```

— the npm script supplies both roots, so this is the whole regeneration.
(Invoking `scripts/sufficiency-lint.js` directly with only the fixtures
directory writes a partial baseline the lock test rejects — its failure lists
the missing `corpus/sessions/` entries as NEW, because the lock recomputes
over both roots and diffs against the committed baseline.) Never regenerate
to silence a diff —
the same doctrine as the fixtures above.

## Validation is by SHAPE, not by version stamp

A strict validation would fail an older-version fixture on its `schema_version`
stamp alone — the published schema pins it as a `const`, per
[session-format § Format stamp](../technical/session-format.md#format-stamp)
(SF-7) — even when the data shape is fully compatible. To test what
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
- **The relaxation is one shared in-memory helper with a fixed consumer set.**
  It is implemented once — `relaxVersionStamp` in `scripts/build-schemas.js` —
  and consumed by the repository's three verification harnesses: this
  backward-compat test, the sufficiency lint (`scripts/sufficiency-lint.js`),
  and the scripted-truth corpus comparison (`scripts/corpus-compare.js`), so
  the harnesses can never drift apart on what "shape-valid" means. The
  published schemas (`schemas/dist/`), the source layers, and the generated
  import/sync validators keep the `const` intact — not a change to the
  intentional
  [import-time version gate](../technical/session-format.md#import-acceptance)
  (SF-13), which stays in force. Tests that exercise the real (const-bearing) validator derive their
  stamp from the current schema via `stampFromSchema(composePlatform(...))` rather
  than hardcoding a version, so they too need no edit on a bump.
