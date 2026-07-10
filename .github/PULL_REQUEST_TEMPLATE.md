<!-- PR title: use Conventional Commits — `type(scope): summary` (e.g. `feat(extension): add export`).
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

<!-- Does this change the .docent.json schema (add/remove/rename fields) or the dispatch payload structure? If no, write "None." -->

## Docs disposition

<!-- One line per doc that governs the code you changed — the "Docs disposition format"
     check derives the set from scripts/area-map.json and its red output lists the exact
     lines it expects. Each line is one of:
       updated: docs/<path> — <what changed>
       unaffected: docs/<path> — <why this diff cannot violate it>
     Docs whose rules carry clause ids also take one line per clause tagged judgment-only
     in docs/clause-registry.json, e.g.:
       unaffected: docs/architecture/system/capture-principles.md §CP-3 — <why>
     Dependency-only PRs (lockfiles, dependency bumps, action-pin bumps) skip this section. -->

## Change record

<!-- A short, honest record of the work. Include at least:
       Intent: <one sentence — what this change sets out to do>
       Outside knowledge: <sources consulted beyond this repo, or "none">
       <what you verified and how — tests run, checks observed>
       mutation: no per-change claim; mutation testing runs as a standing weekly job.
     Dependency-only PRs skip this section too. -->
