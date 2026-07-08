# Scripted-truth capture corpus

Controlled sessions whose input is scripted, so CI can diff the produced
`.docent.json` against committed truth — plus the inert conformance vectors for
the [locator resolution procedure](../docs/locator-resolution.md). Nothing here
replays a recording or resolves a locator.

This is a repository and CI artifact only — never part of a product release.

For the full doctrine (truth derivation, the known-diffs baseline discipline,
page-authoring rules, the conformance-vector emission and hygiene locks, loud
exclusions, and how to add or retire a session), see
[docs/scripted-truth-corpus.md](../docs/scripted-truth-corpus.md).
