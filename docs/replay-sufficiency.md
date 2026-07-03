# Replay Sufficiency

What a recording must be sufficient _for_. The companion principle to
[Capture Principles](capture-principles.md): that document governs what may
enter a recording; this one governs what the recording, taken alone, must
enable.

---

## The Principle

**Assuming the application unchanged, a consumer holding only the recording can
reproduce the session from a different machine — including on async and
lazy-loaded UIs.**

Every capture decision is measured against this test. A recording that is
honest but not sufficient — every absence documented, every measurement true,
and still missing the one fact a consumer needs — fails it. Honesty governs the
_form_ of what Docent records (observed facts, never inventions); sufficiency
governs the _coverage_.

"Holding only the recording" is literal: the consumer may be unable to reach
the application while interpreting the recording, so everything needed to
decide _what_ to do must be in the file. Executing the reproduction naturally
requires the application itself.

---

## Scope Boundaries

The principle is a guarantee with a defined scope. Outside it, reproduction is
the consumer's preparation, not the recording's burden:

- **Backend data state is assumed unchanged.** Docent cannot predict or
  restore server-side changes. Recording and replay are assumed to run against
  the same application _and_ the same backend data state.
- **Masked values are consumer-supplied replay parameters.** Sign-in and other
  sensitive flows are recordable: the actions stay in the stream, and redaction
  masks the values ([Capture Principles — Sensitive Values](capture-principles.md#sensitive-values)).
  The recording states _where_ a value goes — the element's identity and its
  `redacted`/`masked` flags — and the consumer supplies _what_. A replay
  halting at a masked password is missing a parameter, not a recording defect.
- **Client-profile state is a consumer-prepared precondition.** Consent
  banners, first-run tours, and other UI that never appeared during capture
  (because the recording profile had already dismissed them) cannot be stated
  by the recording — Docent cannot observe UI that never rendered. The replay
  environment's client profile must be equivalent to capture-time. Practice
  note: recording from a fresh profile makes the dismissals part of the
  recording, and the recording self-contained in this respect.
- **Recorded geometry is reproduced by the consumer.** Viewport size and
  window rectangles are recorded facts whose reproduction is the consumer's
  obligation before geometry-dependent actions are replayed: window-relative
  coordinates do not survive a differently-sized window's reflow, and
  responsive layouts change structurally with the viewport.

---

## The Machine-Variance Envelope

"A different machine" is bounded. Replay must survive the differences in the
left column; the right column lists preconditions the consumer reproduces from
recorded facts (recorded where available — the schemas grow toward covering
every entry):

| Replay must survive                   | Consumer reproduces (from recorded facts) |
| ------------------------------------- | ----------------------------------------- |
| Machine speed (CPU, rendering)        | Application identity and version          |
| Network latency                       | Backend data state (assumed, see above)   |
| Window and monitor placement          | Authentication/session state (parameters) |
| Monitor count and arrangement         | Client-profile state (see above)          |
| Pointer/keyboard hardware differences | Viewport / window size                    |
| Background system activity            | DPI scaling and zoom                      |
|                                       | Locale and keyboard layout                |
|                                       | Timezone-sensitive rendering context      |

A replay failure caused by a right-column difference the consumer did not
reproduce is an environment problem, not a recording problem (see
[Failure Attribution](#failure-attribution)).

---

## Time

Recorded timestamps are **informative** wall-clock facts — never replay
instructions. Literal timing cannot transfer across machine speeds, so a
consumer derives nothing normative from timestamp spacing.

Readiness is expressed as **observable facts**, never as durations to wait.
`described_after_ms` is the model: an observed gap, exported so the consumer
can apply its own judgement instead of inheriting an implicit one. The consumer
owns its timeouts — a recording cannot encode "how long is too long" on a
slower machine, and a slow success is not a failed replay.

---

## Deliberate Insufficiencies

Known, documented places where the recording alone is not enough — learned
here, not from a failed replay:

- **Masked sensitive values** — parameter slots by design (see Scope
  Boundaries).
- **Coordinate-mode actions** — when no accessibility description was
  available, an action carries a screen point and window geometry instead of
  element identity; reproduction depends on reproducing that geometry, and no
  element-level claims are made.
- **Interactions outside the capture surface** — each platform enumerates the
  surface its capture layer observes and treats it as closed: an interaction
  that reaches none of it is not captured, with no per-case listing to go
  stale. The short exception lists cover only the non-obvious corners —
  interactions that appear to be within the surface but are intercepted
  before it or bypass it (OS-level hotkeys, assistive technologies that drive
  accessibility APIs directly): [extension](capture-principles-extension.md),
  [desktop](capture-principles-desktop.md).

---

## Failure Attribution

Every failed reproduction has exactly one of four verdicts. The definitions
exist so a failure is a diagnosis, not a dispute:

| Verdict                      | Meaning                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `recording-insufficient`     | The recording lacks a fact this principle obligates it to carry. The guarantee's burden.   |
| `environment-not-reproduced` | A right-column precondition (envelope above) was not established before replay.            |
| `application-changed`        | The application differs from capture time — outside the guarantee by definition.           |
| `consumer-defect`            | The recording carried what was needed; the consuming implementation misused or ignored it. |

---

## Falsifiability

"Sufficient" is a testable property, not an aspiration. A recording is
sufficient when all three hold:

1. **Static predicates** — for each action, the fields the
   [taxonomy](#field-taxonomy--normative-vs-informative) marks normative are
   present or legally absent, and their cross-field invariants hold. A pure
   function of the file, checkable by machine.
2. **Resolution conformance** — the recording's locators resolve to the
   acted-on elements under a documented reference resolution procedure,
   verified against ground-truth conformance vectors emitted at capture time
   (the recorder knows the acted-on element, so it can export the expected
   answer alongside the candidates).
3. **Capture completeness** — the capture pipeline reproduces known truth on
   scripted sessions: controlled applications where the input sequence is
   scripted, so the produced recording can be compared against it exactly.
   This is what catches missing-action gaps, which no locator machinery can
   see.

None of these artifacts is executable replay or resolution code. Docent ships
principles, specifications, and data — never a consumer, not even as a test
harness. The reference procedure defines what conformance _means_; consumers
remain free to resolve however they like, and the guarantee reads "the
reference procedure would have succeeded."

---

## Field Taxonomy — Normative vs Informative

The sufficiency guarantee stands on a defined subset of the format. Field
semantics live in the [Session Format](session-format.md) specification; this
taxonomy only classifies, by group:

**Normative** — the guarantee stands on these:

- **Element identity:** `locators[]`, the element description fields, and
  `selector`.
- **Interaction parameters:** `value`, `key` and `modifiers`, coordinates
  together with their recorded geometry context (`window_rect`, viewport
  facts).
- **Ordering and targeting:** the action array order, `context_id`, and the
  context lifecycle actions (`context_open`, `context_switch`,
  `context_close`).

**Informative** — evidence and context; a consumer may exploit them, the
guarantee does not stand on them:

- Timestamps (see [Time](#time)).
- Measurement and provenance facts: `match_count`/`match_index`,
  `described_after_ms`, `capture_mode`.
- Project and recording metadata, and narration text.
- Step version history — superseded and soft-deleted step versions. The
  resolved active view is the replayable sequence.

Consumers should ignore unknown fields (see
[Field stability](session-format.md#field-stability)); new fields enter as
informative unless this taxonomy says otherwise.
