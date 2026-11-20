# Sync Resolution UI — Design Record

The shipped UI contract for surfacing and resolving sync attention: the attention badges, the review and conflict views, and the resolution choices. This is a design record of the presentation layer. The [Sync Protocol](../../api/sync-protocol.md) owns the protocol semantics, cited here and never restated: what becomes a review or a conflict, and what a resolution does to the data (classification §SP-9/§SP-11, resolution §SP-16, declining §SP-18). The user-facing walkthrough is the [extension guide's Sync section](../../user/extension.md#sync), which the desktop guide adopts.

## One implementation

Both panels derive and render this UI from the shared [`sync-conflict-ui.js`](../../../packages/shared/sync-conflict-ui.js): pure functions from the durable sync state to plain data or HTML strings. The shared views fragment's resolution view (`#view-sync-workflow` in [`views.html`](../../../packages/shared/views/views.html)) hosts this UI, and each panel wires it through the module's stable `data-action` hooks. The parity is [Shared Core §SC-1](../../architecture/system/shared-core.md#the-parity-rule): what follows describes the one implementation both platforms run.

## Attention badges

- Two kinds, labeled **Review** and **Conflict**, distinguished by the same label and style modifier wherever they appear. Each badge's tooltip states the action it asks for.
- A recording that needs attention always shows its own badge on its row.
- A project row can carry up to three badges at once, deduplicated by kind, in this order (conflicts, the forced choice, read ahead of reviews):
  1. the project unit's own badge, when the project's name-and-metadata unit itself needs attention;
  2. one rolled-up recording-conflict badge, when any child recording is in conflict;
  3. one rolled-up recording-review badge.
- Activation: an own badge opens the resolution workflow for its unit. A rolled-up badge opens the project so the per-recording badges become visible (it stands for one or more recordings, not a single resolvable unit).

## The review view

- Titled "Review incoming change". It shows the incoming version only (a review item stores only that side), summarized as the unit's name plus its active-view step list (for a recording) or recording count (for a project).
- Controls: **Accept** and **Decline**. The renderer can show an "Applied" status with both controls disabled, but the shipped panels never reach it: accepting clears the stored item and both panels leave the view.
- What the controls do to the data is protocol territory: accepting adopts the incoming version; declining dismisses exactly that incoming version (§SP-18).

## The conflict view

- Titled "Resolve conflict". It presents **Your version** and **Incoming version** side by side. The absent side of a delete-vs-change conflict reads "Deleted (no version on this side)".
- Controls: **Keep your version** and **Keep incoming version**, one per side.
- The module's shared builder translates the chosen side into an append-only resolved state. It is the single place a keep-local/keep-incoming choice becomes data, so the two platforms translate it identically. The retention guarantees the resolved state satisfies are §SP-16's.

## Routing and the wrong-interface guard

- Opening a unit routes to the interface its stored item requires: a review can never open in the conflict interface or vice versa. The renderer redirects a request for the wrong one to the correct view, with a notice announced via `role="status"`. The shipped panels never make such a request (each opens the stored item's own interface), so the redirect is a capability of the renderer, not a behavior a user meets.
- A unit with no active deferral renders an empty state ("Nothing to resolve for this item."). The desktop shows it; the extension panel returns to its sync views instead.
- **Back** leaves the item unresolved and keeps its badge. Which events clear a stored review or conflict item (resolution, acceptance, decline, or a reclassification on a later sync) is protocol territory: classification and supersession §SP-9/§SP-11; resolution and declining §SP-16/§SP-18. This view renders a badge for every stored item, so a badge persists exactly as long as its item does.
