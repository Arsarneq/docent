# Locator Resolution — the Reference Procedure

The reference procedure for resolving a recorded element's `locators[]` to a
live element. It implements item 2 of
[Replay Sufficiency — Falsifiability](../requirements/replay-sufficiency.md#falsifiability):
this document defines what "the recording's locators resolve correctly"
_means_, so that conformance is testable against published vectors.

Each rule carries a stable identifier (**LR-n**) so other documents, reviews,
and checks can cite it precisely. Identifiers are never renumbered; a retired
identifier stays reserved and is never reused. How each rule is verified — by
an existing named check, by a check that could be built, or by judgment — is
recorded per rule in the [clause registry](../clause-registry.json). The key
words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as described in
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119). Keywords appear on a
clause's operative requirement where it has one; definitional clauses bind as
stated without a keyword, and subsidiary absolutes inside a clause inherit its
force. A clause's scope runs from its marker to the next marker or heading;
identifiers reflect minting order and may appear out of numeric sequence.

**Status.** This is a specification, not shipped code.

**LR-1.** Docent publishes this procedure and (with the scripted-truth corpus
work) inert conformance vectors — never an implementation; a Docent artifact
MUST NOT execute the procedure. Consumers remain free to resolve
however they like; the sufficiency guarantee reads "the reference procedure
would have succeeded."

**Scope.** The procedure defines _resolution_ for the resolvable core, with
exactly three outcomes. It never decides what a failure _means_ — interpreting
a `not-resolved` (recording? environment? missing parameter? application
change?) belongs to
[Replay Sufficiency — Failure Attribution](../requirements/replay-sufficiency.md#failure-attribution).

**Governing rules.**

**LR-2.** The procedure consults the recorded match statistics only
conservatively — for eligibility exclusions — it MUST NOT use them to decide
an outcome.

**LR-3.** The recording's `locators[]` order remains semantics-free; any
evaluation order an implementation chooses has no effect on the outcome (see
[No short-circuit](#the-algorithm)).

---

## Element Identity

**LR-4.** The aggregate outcome counts _distinct_ live elements, so element
identity is normative:

| Platform  | Two matches are the same element when…                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------ |
| Extension | they are the same DOM node in the resolved document (node identity)                                                      |
| Desktop   | the automation engine reports them equal within one resolution session (`CompareElements` / runtime-identifier equality) |

All cross-candidate comparison in this procedure uses this definition.

---

## Applicability

**LR-5.** The procedure applies when both preconditions hold; outside them it
is **inapplicable** — a stated boundary, not an outcome:

1. **The live scope is uniquely bound.** The scope is the platform's stated
   measurement scope
   ([Session Format — Measurement semantics](../technical/session-format.md#measurement-semantics)):
   the capturing frame's document root, or the acted-on element's top-level
   window. Frame identity is currently carried only by `frame_src` (null for
   the top frame); when it does not identify exactly one live frame,
   multi-frame disambiguation is not yet expressible by the format. Scopes are
   never unioned, and recorded match counts are comparable only under a bound
   scope.
2. **The element carries at least one eligible candidate.** An element with no
   locator entries has the outcome `no-candidates` — its resolvability is
   governed by the static sufficiency lint (`element-locators`), not by this
   procedure. The legacy `selector` string is not a resolution candidate.

**LR-6.** Entries in `locators[]` are independent candidates. Strategy
uniqueness is not assumed — the schema permits multiple entries with the same
strategy, and each is evaluated on its own.

---

## The Algorithm

**LR-7.** Per-candidate verdicts are computed independently for every eligible
candidate. **No short-circuit:** every eligible candidate MUST be evaluated to
completion, because cross-candidate disagreement is the procedure's
wrong-referent check — an implementation that stops at the first success
conforms only by accident.

### 1. Eligibility

**LR-8.** A candidate is **ineligible as a selector** when:

- `masked: true` — its value is the mask, not the observation; or
- `match_index: null` — the recorder measured this candidate as _not_
  matching the acted-on element; letting it select at replay would be a
  wrong-referent by construction.

**LR-9.** Ineligible entries MUST take no part in selection or corroboration.
(Future volatility metadata may further tighten eligibility; the capture
backlog tracks per-load volatile identifiers.)

### 2. Application — the strategy table

**LR-10.** How each strategy's recorded fields form the live query is defined
by the platform tables below — both tables are part of this clause; fields not
listed do not participate in the query.

**Extension** (queries run over the bound document root; standard,
non-piercing matching):

| `strategy`    | Live query                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `id`          | elements whose `id` attribute equals `value`                                                                                |
| `test_id`     | elements whose attribute named `attribute` equals `value`                                                                   |
| `name`        | elements whose `name` attribute equals `value`                                                                              |
| `tag_name`    | elements with tag `value`                                                                                                   |
| `text`        | elements whose normalized visible text equals `value` (the recorded value is normalized and capped as stated in the schema) |
| `placeholder` | elements whose `placeholder` attribute equals `value`                                                                       |
| `title`       | elements whose `title` attribute equals `value`                                                                             |
| `alt_text`    | elements whose `alt` attribute equals `value`                                                                               |
| `css`         | elements matched by the selector `value`                                                                                    |
| `role_name`   | _schema-reserved; not currently captured_ (accessible-name computation is pending capture work)                             |
| `label`       | _schema-reserved; not currently captured_                                                                                   |

**LR-11.** Reserved strategies have no application semantics until the capture
work that emits them lands; conformance vectors cover emitted strategies only.

**Desktop** (queries run over the bound top-level window, Control view,
window itself included):

| `strategy`      | Live query                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------ |
| `automation_id` | elements whose AutomationId equals `value`                                                 |
| `role_name`     | elements whose **non-localized** control type equals `role` AND whose name equals `name`   |
| `class_name`    | elements whose class name equals `value`                                                   |
| `labeled_by`    | elements whose label relation resolves to an element named `value`                         |
| `tree_path`     | the element reached by walking `value`'s segments from the window root in the Control view |

**LR-25.** `role_name.role` binds to the non-localized control type — the
same value as the recorded `element.tag` — never to the localized
`element.role`. `role_name.name` participates in selection only.

### 3. Corroboration — the wrong-referent guard

**LR-12.** A candidate's single live match MUST NOT contradict the recorded
element facts. The fact source is **exactly the top-level `element` object's
non-null fields** — locator entries (masked or not) are never corroboration
inputs.

- **LR-13.** **`tag`** — equality. On desktop, `tag` is the non-localized control type;
  the localized `element.role` is excluded from contradiction tests
  (locale-fragile by definition).
- **LR-14.** **`text`** — the recorded text is a truncated (100-character) rendering;
  comparison is prefix/containment against the live element's visible text
  normalized the same way, never raw equality. When recorded text is null —
  including on `redacted` elements — the test is vacuously satisfied.
- **LR-15.** **Staleness advisory.** Element descriptions can be captured
  after the action's effects began (`described_after_ms` states the observed
  gap where recorded; deferred captures without the field carry no signal). A
  text contradiction **alone** MUST NOT reject a candidate when at least one
  field with discriminating power — `id`, `name`, or a test-attribute value —
  positively corroborates. `tag` alone never suffices: any same-tag element
  passes it trivially, and treating it as corroboration would disable this
  guard.

### 4. Per-candidate verdict

**LR-16.** The per-candidate verdict follows from the candidate's live match
count and the corroboration result:

| Live matches for the candidate    | Verdict                                                   |
| --------------------------------- | --------------------------------------------------------- |
| exactly one, corroboration passes | **candidate-resolved** (names that element)               |
| exactly one, corroboration fails  | **corroboration-disqualified** (recorded as a diagnostic) |
| zero                              | non-selecting                                             |
| more than one                     | non-selecting                                             |

### 5. Aggregate

**LR-17.** Collect the distinct elements named by candidate-resolved verdicts,
using [Element Identity](#element-identity). Then apply the **containment
filter**, which MUST operate on recorded facts only: when candidate-resolved elements stand
in an ancestor/descendant or label↔labelled-control relation, keep those
matching the recorded identity fields, tested in order `tag`, then
`id`/`name`, then `text`. Exactly one survivor collapses the related set to
that element; zero survivors or a tie leave the set plural. The filter MUST
NOT reduce the distinct count below what the recorded facts disambiguate.

---

## Outcomes

**LR-18.** Exactly three:

| Outcome         | Condition                                                                    |
| --------------- | ---------------------------------------------------------------------------- |
| `no-candidates` | the element carries no locator entries (see [Applicability](#applicability)) |
| `resolved`      | exactly one distinct candidate-resolved element after the containment filter |
| `not-resolved`  | anything else                                                                |

**LR-19.** A `not-resolved` carries **diagnostics**: the set of distinct
candidate-resolved elements (when plural), the corroboration-disqualified
candidates, and per-candidate match circumstances (unmeasured, masked,
`match_index: null`, live multi-match). The diagnostics inform — they MUST
NOT decide — [failure attribution](../requirements/replay-sufficiency.md#failure-attribution):

- a masked entry whose pre-mask statistics were `match_count: 1` and
  `match_index: 0` points at a **consumer-supplied parameter** (the
  masked-values scope boundary), not a recording defect;
- corroboration-disqualified candidates are wrong-referent evidence;
- candidates unmeasured by design (input-time described actions) are never,
  by themselves, evidence of insufficiency.

**LR-20.** Consumers MAY refine beyond the procedure — for example, selecting
among a multi-match by the recorded `match_index` when the live match count
equals the recorded `match_count`. Such refinements are outside conformance:
no published vector's outcome depends on them.

---

## Worked Examples

**LR-21.** Non-normative illustrations, subordinate to the algorithm above:
where an example and the algorithm text disagree, the algorithm governs and
the disagreement is a specification bug.

**1. Resolved.** Desktop click; candidates `automation_id{value:"btnSave",
match_count:1, match_index:0}`, `role_name{role:"Button", name:"Save"}`
(unmeasured), `class_name{value:"Button", match_count:7}`. Live: the
AutomationId query matches one element (tag `Button` — corroborates);
`role_name` matches one element — the same element by identity;
`class_name` matches seven → non-selecting. Distinct candidate-resolved
elements: one. Outcome: **resolved**.

**2. Cross-candidate disagreement.** Extension click; `css{value:"#list >
li:nth-of-type(2)"}` resolves to one element; `text{value:"Rename"}` resolves
to a different element (a menu item elsewhere); both corroborate on
`tag: "li"`. Two distinct candidate-resolved elements, no containment
relation. Outcome: **not-resolved** (diagnostics: the two-element set) — the
procedure refuses to guess between disagreeing candidates.

**3. Corroboration-disqualified.** Extension click; the only eligible
candidate `id{value:":r5:"}` matches exactly one live element, but its tag is
`div` while the recorded `element.tag` is `button`. Verdict:
corroboration-disqualified. Outcome: **not-resolved** (diagnostics: one
disqualified candidate — wrong-referent evidence; the recorded id was a
per-load volatile identifier).

**4. No candidates.** The frozen corpus's extension v3.0.0 fixture: elements
carry the legacy `selector` only, no `locators[]`. Outcome: **no-candidates**
— governed by the static lint, not this procedure.

**5. Ordinal-only element.** Desktop click on the third of five identical
rows; every candidate is measured with `match_count: 5` and
`match_index: 2`. Every candidate is non-selecting (multi-match). Outcome:
**not-resolved** (diagnostics: consistent multi-match with recorded
ordinals). A consumer MAY apply the recorded ordinal when the live count
equals 5 — outside conformance; no vector requires it.

---

## Conformance and Vector Scope

**LR-22.** An implementation **conforms** when, for every published
conformance vector, it produces the vector's stated outcome — and, for
`resolved` vectors, the vector's ground-truth element.

**LR-26.** Vectors are inert data emitted at capture time by harnesses that
observe the acted-on element directly (the ground truth is known, never
computed by this procedure): recorded locators and element facts, a tree
snapshot of the bound scope, and the ground truth.

**LR-23.** **Vector inclusion criterion** — decidable from recorded facts
alone: the element carries at least one eligible candidate recorded
measured-unique-and-selecting (`match_count: 1`, `match_index: 0`). Element
classes outside the criterion — masked-only-unique, fully unmeasured,
ordinal-only, unbindable scope — are out of vector scope; their sufficiency
story is owned by the static lint and the capture backlog, not by resolution
vectors. Per-strategy coverage on both platforms comes from
[corpus pages](../verification/scripted-truth-corpus.md) designed so that each emitted strategy
is the measured-unique candidate in at least one vector.

---

## Value-Derived Strategies

**LR-24.** The schema annotates each locator strategy definition with
**`x-value-derived`** — an operational marker: `true` means the redaction
chokepoint masks that strategy's value in place (with `masked: true`) when the
element is sensitive. It is **not** a claim that unannotated strategies cannot
carry user-identifying content; it states what the chokepoint does today.

- Extension: `text` is value-derived. The derived `css` value is structural —
  ids, test attributes, tag names and positions — and carries no rendered
  text; an enrichment that ever embeds rendered text in a selector requires
  re-annotation.
- Desktop: no desktop strategy is masked by the chokepoint.

Absence of the annotation on a strategy definition means nothing; every
strategy definition declares it explicitly, and the contract's composition
tests enforce that.
