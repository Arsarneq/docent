# Sync Resolution UI — Design Record

The shipped UI contract for surfacing and resolving sync attention: the
attention badges, the review and conflict views, and the resolution
choices. This is a design record of the presentation layer. The protocol
semantics — what becomes a review or a conflict, and what a resolution does
to the data — are owned by the [Sync Protocol](../../api/sync-protocol.md)
(classification §SP-9/§SP-11, resolution §SP-16, declining §SP-18) and are
cited here, never restated. The user-facing walkthrough is the
[extension guide's Sync section](../../user/extension.md#sync), which the
desktop guide adopts.

## One implementation

Both panels derive and render this UI from the shared
[`sync-conflict-ui.js`](../../../packages/shared/sync-conflict-ui.js) —
pure functions from the durable sync state to plain data or HTML strings —
hosted in the shared views fragment's resolution view (`#view-sync-workflow`
in [`views.html`](../../../packages/shared/views/views.html)) and wired by
each panel through the module's stable `data-action` hooks. The parity is
[Shared Core §SC-1](../../architecture/system/shared-core.md#the-parity-rule):
what follows describes the one implementation both platforms run.

## Attention badges

- Two kinds, labelled **Review** and **Conflict**, distinguished by the
  same label and style modifier wherever they appear; each badge's tooltip
  states the action it asks for.
- A recording that needs attention always shows its own badge on its row.
- A project row can carry up to three badges at once, deduplicated by kind
  and in this order: the project unit's own badge (when the project's
  name-and-metadata unit itself needs attention), one rolled-up
  recording-conflict badge (when any child recording is in conflict), and
  one rolled-up recording-review badge — conflicts, the forced choice, read
  ahead of reviews.
- Activation: an own badge opens the resolution workflow for its unit; a
  rolled-up badge opens the project so the per-recording badges become
  visible (it stands for one or more recordings, not a single resolvable
  unit).

## The review view

- Titled "Review incoming change". It shows the incoming version only —
  a review item stores only that side — summarised as the unit's name plus
  its active-view step list (for a recording) or recording count (for a
  project).
- Controls: **Accept** and **Decline**. An item already applied shows an
  "Applied" status with both controls disabled.
- What the controls do to the data is protocol territory: accepting adopts
  the incoming version; declining dismisses exactly that incoming version
  (§SP-18).

## The conflict view

- Titled "Resolve conflict". It presents **Your version** and **Incoming
  version** side by side; the absent side of a delete-vs-change conflict
  reads "Deleted (no version on this side)".
- Controls: **Keep your version** and **Keep incoming version**, one per
  side.
- The chosen side is translated into an append-only resolved state by the
  module's shared builder — the single place a keep-local/keep-incoming
  choice becomes data, so the two platforms translate it identically. The
  retention guarantees the resolved state satisfies are §SP-16's.

## Routing and the wrong-interface guard

- Opening a unit routes to the interface its stored item requires — a
  review can never open in the conflict interface or vice versa. A request
  for the wrong one is redirected to the correct view, with a notice
  announced via `role="status"`.
- A unit with no active deferral renders an empty state ("Nothing to
  resolve for this item.").
- **Back** leaves the item unresolved and keeps its badge. Which events
  clear a stored review or conflict item — resolution, acceptance, decline,
  or a reclassification on a later sync — is protocol territory (§SP-16,
  §SP-18); this view simply renders a badge for every stored item, so a
  badge persists exactly as long as its item does.
