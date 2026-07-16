# Test

How Docent's own suites verify that the **application behaves as designed** — the
inside-out lens. This is the counterpart to
[Verification](../verification/scripted-truth-corpus.md): verification looks
outside-in and proves the recorded **data** keeps the guarantees the format makes
to a consumer ([Replay Sufficiency](../requirements/replay-sufficiency.md)); this
area documents the tests that prove the capture **software** itself works.

This area is documentation _about_ the suites — what each covers and the doctrine
behind it. It is not a how-to: the commands to run the suites live in the
[contributing guide](../../.github/CONTRIBUTING.md#running-tests), and running the
CI jobs on your own machine is covered in
[Running CI locally](../guides/local-ci.md).

## Documents

- [Test strategy — the pyramid](strategy/test-pyramid.md) — how the suites are
  layered (unit / integration / e2e) and how each test's layer is determined,
  including Rust test self-classification.
- [Test strategy — coverage reporting](strategy/coverage.md) — how coverage reaches
  Codecov and how it is sliced by flag (layer × language) and component (package).
- [Test strategy — mutation testing](strategy/mutation.md) — the weekly mutation-score
  signal (Stryker for JavaScript, cargo-mutants for Rust): what is mutated and why, and
  the ratchet-not-fixed-bar thresholds.
- [End-to-end tests — extension](e2e.md) — the extension's Playwright suite
  (real Chrome, real input): the capture specs plus the panel, service-worker,
  and sync flows, and the harness contract they run under (frame readiness,
  one-worker serialization, retries, settle waits).
- [Manual tests — extension](manual/extension.md) — the retired manual capture
  scenarios, each mapped to the automated test that replaced it.
- [Manual tests — Windows desktop](manual/windows.md) — the retired manual desktop
  scenarios, mapped to their Rust integration/unit replacements.
- [Backward-compatibility fixtures](backward-compat.md) — the frozen-export corpus
  that proves an older `.docent.json` still validates by shape against the current
  schema.

## Reserved areas

Named here so every future test doc has an obvious home; a folder is created only
when its first real doc lands (no empty directories — the same anti-scaffolding
rule as the [documentation map](../README.md)):

- `integration/` — the desktop integration suite (Playwright against a mocked
  Tauri backend), when it grows documentation of its own.
- `e2e/<surface>/` — the flat `e2e.md` splits per surface if a second surface's
  end-to-end suite is documented (the extension is the only one today).
- `manual/<surface>.md` — a new capture surface's manual history slots in beside
  `extension.md` and `windows.md` (e.g. `manual/linux.md` if Arsarneq/docent#84
  lands).
