<!-- PR title: it goes in GitHub's title field above, not in this body. Use
Conventional Commits — `type(scope): summary` (e.g. `feat(extension): add export`).
We squash-merge, so the title becomes the commit on `main` and drives release versioning.
A CI check enforces it; see .github/CONTRIBUTING.md ("Pull Request Guidelines"). -->

## Motivation

<!-- Why is this change needed? What problem does it solve? Link related issues: Closes #000, Relates to #000 -->

## Approach

<!-- How was the problem solved? Describe the solution. -->

## Testing

<!-- What is NOT covered by automated tests? -->

<!-- What manual tests were added or updated? (file path + what they verify) -->

## Behaviour Changes

<!-- Does this change what events are captured or filtered? If no, write "None." -->

## Breaking Changes

<!-- Does this change the .docent.json schema in a way its versioning rule classes as
major (docs/technical/session-format.md, SF-2 states the levels; a removed or renamed
field and a new required field are two examples), or change the dispatch payload
structure? Describe what breaks and for whom. A change that rule classes as minor,
such as a new optional field, is not breaking: name it under Approach. If nothing
breaks, write "None." -->

## Docs disposition

<!-- One line per doc that governs the code you changed — the "Docs disposition format"
check derives the set from scripts/area-map.json and its red output lists the exact
lines it expects. Write your lines flush left, since four spaces of indent where
a block starts make a line an example. Each is one of:

updated: docs/<path> — <what changed>
unaffected: docs/<path> — <why this diff cannot violate it>

A doc's line answers for every rule the doc carries. Where one clause tagged
judgment-only in docs/clause-registry.json needs a reason of its own, it may take
its own line, e.g.:

unaffected: docs/architecture/system/capture-principles.md §CP-3 — <why this diff cannot violate this rule>

A PR that changes only the governance data (scripts/area-map.json, alone or with
docs/clause-registry.json) keeps the section and writes one line here in place of
the per-doc lines:

governance-data-only: <why the documented governance goals survive this edit>

The admitted classes skip this section entirely: dependency-only PRs (lockfiles,
dependency-only manifest changes, action-pin bumps), and the release pipeline's own
regeneration PR on its automation branch. See .github/CONTRIBUTING.md ("Docs
Disposition and Change Record") for each class's admission test. -->

## Change record

<!-- A short, honest record of the work. Write these lines flush left too. Include
at least:

Intent: <one sentence — what this change sets out to do>
Outside knowledge: <sources consulted beyond this repo, or "none">
<what you verified and how — tests run, checks observed>
mutation: no per-change claim; mutation testing runs as a standing weekly job.

That mutation line is a fixed sentence to paste, not a claim to compose; see
.github/CONTRIBUTING.md ("Docs Disposition and Change Record") for the cadence it
reports and where that cadence is stated.

The classes that skip the section above skip this one too — dependency-only PRs and
the release pipeline's own regeneration PR; a governance-data-only PR keeps it. -->
