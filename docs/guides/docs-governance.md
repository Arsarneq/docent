# Extending the docs governance

The docs governance is the committed data and the lints that bind code to the docs that govern it: the [area map](../../scripts/area-map.json), the [clause registry](../clause-registry.json), the [documentation map](../README.md) and the governance lints in CI. This guide is for a change that touches that binding: adding or moving a doc, adding a code file, minting a clause, editing the map or the registry, or writing a doc passage. What a pull request records about the docs it primes is stated in [CONTRIBUTING](../../.github/CONTRIBUTING.md#docs-disposition-and-change-record).

## Goals

Every change to this governance — the map, the registry, the lints, or the
doc set they bind — must preserve what the machinery exists to deliver:

- **Complete** — every tracked file resolves to an explicit governance
  decision: a governing doc set (possibly empty, where declared) or a
  recorded, justified exception; every doc stays reachable (or is an
  allowlisted non-doctrine asset), and every clause stays registered.
  Nothing falls out of governance silently.
- **Usable** — the docs serve human readers first: positive descriptions,
  precise citable clauses, and per-area charters in the
  [documentation map](../README.md); each passage takes
  the form that fits what it holds
  ([Writing docs](#writing-docs-pick-the-form-before-the-sentence)).
- **Minimal context per area** — working in one area should require reading
  that area's docs and no more; a change that drags unrelated docs onto a
  file's governing set is a defect, not a convenience.
- **No drift** — the binding stays committed, linted data: which docs a
  change primes surfaces mechanically, and whether the change diverged from
  them is a recorded human judgment — never left to memory.

A change that would drop real governance rather than trim excess is out of
scope for a cleanup — raise it as its own PR or issue, where the trade-off
is stated.

## What each kind of change keeps green

The governance binding is kept true by the governance lints in CI's `lint` job. Each is
inventoried, with its local command, in
[the lint table](ci.md#the-lint-and-freshness-gates), which
is the one home of that list. In short:

| When you                 | You                                                                                                                                    | Held by                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Add or move a doc        | Link it from the documentation map and give it a home in the area map                                                                  | `lint:links`, `lint:reachability`, `lint:area-map`                       |
| Add a code file          | Make it resolve to an area of the area map, in the same PR                                                                             | `lint:area-map`                                                          |
| Mint a clause            | Mark it with a stable id, give it a registry row, state the preamble, and keep the paths its row cites governed by its doc             | `lint:clause-registry`, `lint:clause-preamble`, `lint:clause-governance` |
| Write or change a clause | State a rule in one clause and cite that clause from any other, and keep each paragraph, list item and table row within the word limit | `lint:clause-form`                                                       |

The detail for each:

- **Adding or moving a doc:** link it from the
  [documentation map](../README.md) — every relative link must resolve
  (`lint:links`) and every tracked Markdown file must be reachable by
  following links from the root README (`lint:reachability`) — and give it a
  home in [`scripts/area-map.json`](../../scripts/area-map.json): an area's doc
  set, the repo-wide list, or a justified exception (`lint:area-map`).
- **Adding a code file:** it must resolve to an area of the same map — matched
  by an area's code patterns, naming a governing doc with a
  `// see docs/<path>.md` comment, or listed as a justified exception —
  or `lint:area-map` fails on it; extend the map in the same PR that adds the
  file. A file whose governing docs differ from what its areas supply declares
  them with a `declared-governance` entry, which overrides governance without
  granting coverage; a declaration may name an area's whole doc set with an
  `area:<name>` reference instead of repeating its docs. In a tree the map
  lists under `governance-partitions`, every file declares its governance with
  a `declared-governance` entry — including one whose declared set is exactly
  what its areas supply, which is the honest statement there and stays green.
  The map's own `description` field states the complete resolution rules.
- **Minting clauses:** a doc that states its rules as identified clauses
  keeps each of these true.
  - **The marker.** Each clause carries a stable bolded id (e.g. `**SC-2.**`);
    ids are never renumbered, and a retired id stays reserved.
  - **The registry row.** Every clause takes a row in
    [`docs/clause-registry.json`](../clause-registry.json) recording how
    it is verified — by a named existing check, an intended check, or a
    justified judgment. `lint:clause-registry` holds the doc markers and the
    registry rows in one-to-one agreement.
  - **The row's citations.** Every citation a row's `check-ref` or
    `justification` carries must resolve, or be refused as a citation that
    cannot identify what it names; the gate's own register of the surfaces it
    resolves citations against is held to the tracked tree on every run
    ([`scripts/check-clause-registry.js`](../../scripts/check-clause-registry.js)
    is that register's one home), so a stale entry reds there rather than in a
    row.
  - **The row's test cases.** A row may also name the test cases that pin its
    clause, in an opt-in field whose every entry must name a case DECLARED by
    one of the anchor-bearing files that row's `check-ref` cites, held by the
    same lint. Renaming or removing a test case a row names therefore means
    editing that row's entry in the same change. What declares a case:

    | File            | A case is                                                                                                                            |
    | --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
    | `.js` or `.mjs` | The title a bare `it`/`test` call states (a member call's title, `it.skip` or `it.only` or another object's own `it`, declares none) |
    | `.rs`           | The name an `fn` declares                                                                                                            |

  - **The preamble.** Such a document also states the canonical preamble
    verbatim — the identifier, verification, RFC 2119, keyword-placement, and
    clause-scope rules, with the prefix token and registry link computed for
    it; a document that restates rules other artifacts own opens with the
    registered qualifier instead, which the check accepts only from a document
    registered for it. A lowercase `must`, `should`, or `may` inside a clause's
    scope is either uppercased as the clause's own requirement or takes an
    allowlist entry recording why it states none. The canonical text, the
    qualifier's registrations with the reason each document takes it, and that
    allowlist live in
    [`scripts/check-clause-preamble.js`](../../scripts/check-clause-preamble.js),
    which `lint:clause-preamble` holds those documents to; any clause-bearing
    document's preamble —
    [Capture Principles](../architecture/system/capture-principles.md)
    for one — shows the text as a reader meets it.
  - **Meaning and justification.** A clause's meaning lives in the doctrine
    text; a row's justification states how compliance is verified and why no
    check decides it, never the clause's meaning.
  - **One home and unit length.** `lint:clause-form` checks the rules below as far as a check can read them. The [lint table](ci.md#the-lint-and-freshness-gates) states what it reds on, what it does not see, and where its list of admitted cases lives. What it does not see is a review judgment.
    - A rule is stated in one clause. Another clause that needs it cites that clause by its id.
    - Within a document, a departure or an open case is linked to its issue from one clause. A case that holds on two platforms is linked once in each platform's document, on that platform's exception list.
    - A sentence two platform documents both need is stated in the cross-platform clause, and each platform clause cites that clause.
    - A paragraph, a list item or a table row holds at most 150 words. A longer one is split into paragraphs or a list. The limit is on one unit, never on how much a clause or a document says.
    - A red is fixed in the clause. No entry is added to the list of admitted cases.
  - **Words before and after.** A pull request shows, for each document that holds clauses, the words it held at the base and the words it holds now ([`scripts/report-clause-doc-words.js`](../../scripts/report-clause-doc-words.js), in the `lint` job's log and summary). The numbers are shown and never a gate: how long a document should be depends on what it has to say. The pull request's reviewer reads the table and asks of each row that grew whether the added words state the change's rule or restate, explain or record something else. Growth the reviewer does not accept is a review finding, recorded with the review's other findings in the pull request's change record, and the row passes when no such finding is open.
  - **Lists.** A list inside a clause's scope — bulleted, numbered, a table's
    rows, or an inline series of three or more members of one set — states
    whether it is closed.
    - A closed list says so in the words that close it, so extending it is an
      edit to the list itself or to the artifact it points at. The words are
      one of:
      - an exactness word (`exactly`, `complete`, `closed`, `no other`);
      - a count (`three scope filters`, `one of two`);
      - the definition the clause itself states;
      - a pointer to the clause or artifact that closes it exactly.
    - An open list says that it illustrates and names what decides membership
      instead
      (`the listed classes illustrate it and do not close it; the shared detection decides`).
    - A field list in a protocol or format clause states what the
      specification defines; whether a peer may add fields is what the
      specification's tolerance statement decides, where it has one.
    - A numbered procedure, whose steps are the procedure, and a list or table
      keyed by platform, which covers each shipped platform, carry their
      closure by form.
  - **Governed paths.** Every repository path a row cites — the code that
    implements or guards the clause — must in turn be governed by the clause's
    own doc under the area map, so a change to that code cannot drift from the
    doctrine it stands on without priming the doc; `lint:clause-governance`
    holds that edge, with deliberately-open couplings recorded as a justified
    allowlist in the check. A cited governing doc is governed by itself alone,
    as it takes its own disposition line only.

## Writing docs: pick the form before the sentence

Prose is one form among several, and rarely the best one for structured
content. Before writing a passage, name what it holds and take the form that
fits:

| The passage holds                        | Write it as                           |
| ---------------------------------------- | ------------------------------------- |
| The same attributes across several items | A table                               |
| Steps in order                           | A numbered list                       |
| A flow, a lifecycle, or who calls whom   | A Mermaid diagram (GitHub renders it) |
| A quantity, or a rule with a formula     | The formula                           |
| A command, or the shape of a file        | A code block                          |
| A reason, a trade-off, or a single item  | Prose                                 |

A sentence that carries three or more parallel facts is a table or a list
waiting to be written. Clause text keeps its identifier and its RFC 2119
wording whatever form surrounds it, and a table or list inside a clause's scope
still states whether it is closed (Minting clauses, above).

Shorter is better, as long as the reader still gets what they need and gets it without effort. Before a passage is done, cut:

- what another home already states: link the home;
- what the reader does not need in order to act on the passage;
- words that carry nothing;
- how the code reaches an outcome, in a capture clause, a row of the session format and the [capture pipeline](../architecture/application/desktop/windows/capture-pipeline.md) document: these state what the person does and what the file then holds, with the reason, the values it depends on and the departures. The steps live in the code and its tests. The capture pipeline document keeps the procedures it holds until its own cut.

This list is open. A cut that takes away something the reader needs is a meaning change, not a cut. A form from the table above often says the same in fewer words than prose does.

Cutting the steps is a cut only where every outcome they produced is still stated as what the person does and what the file holds. A registry row then names as checked by no case only an outcome a clause states.

The pull request's reviewer names each touched passage that fails this, with its line, as a review finding recorded in the pull request's change record, and the rule passes when no such finding is open. For a document that holds clauses, Words before and after (above) shows the count.
