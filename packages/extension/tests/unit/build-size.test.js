/**
 * build-size.test.js — Extension build size limits.
 *
 * These checks are REGRESSION TRIPWIRES, not capacity limits. Their job is to
 * fail loudly if the bundle unexpectedly balloons (a stray dependency, an
 * accidental import), reflecting the project's deliberate "lean, no heavy deps"
 * ethos.
 *
 * Two kinds of limit live here — do not conflate them:
 *
 *   HARD limit (external, non-negotiable): the Chrome Web Store caps an
 *   extension at 10MB ZIPPED. The "total under 1MB uncompressed" check is the
 *   guard for this — with compression on top it leaves an enormous margin, so
 *   the real platform ceiling is never actually in play.
 *
 *   SOFT limits (self-imposed guardrails): the per-type JS/CSS/HTML budgets
 *   below. They are NOT platform requirements — they are tripwires we own and
 *   may deliberately raise when a legitimate, intentional artifact grows the
 *   bundle. When raising one, update the number AND the rationale so the
 *   tripwire keeps catching *unexpected* growth.
 *   Headroom target (the per-type soft budgets; the whole-package limit above
 *   is not one): a raise sets the budget to the measured size plus 3%, rounded
 *   up to the next whole KB; its history entry records the measured size in
 *   bytes and the install layout it was measured in, the margin the new budget
 *   leaves, and the files whose size changed since the previously recorded
 *   size, with their byte deltas; a raise that departs from the 3% states why.
 *
 * JS budget history:
 *   - Originally 200KB (hand-written ES modules only).
 *   - Raised to 360KB for the generated schema validator: each platform now ships a
 *     generated Ajv-standalone validator (~109KB, eval-free, required to
 *     validate untrusted imported/synced payloads under the `script-src 'self'`
 *     CSP). This is a deliberate security artifact, not accidental bloat; the
 *     budget was raised to fit it plus normal headroom.
 *   - Raised to 480KB for the sync-conflict-resolution feature: graded conflict
 *     resolution is implemented as a set of shared `packages/shared` modules
 *     (sync-client rewrite, conflict-detector, conflict-resolution,
 *     sync-conflict-ui, sync-store, sync-baseline, sync-digest, sync-types) that
 *     sync-shared copies into the extension so both platforms get identical
 *     behavior. This ~90KB of shared logic is a deliberate feature
 *     artifact, not accidental bloat; the budget was raised to fit it plus
 *     normal headroom.
 *   - Raised to 600KB for the sync-conflict-resolution pull-first rework:
 *     the pull-first reconcile rework plus the Auto-Sync background host grew the
 *     synced shared modules and added two new ones — the shared cooldown-debounced
 *     `sync-scheduler.js` (~12KB) and `connection-test.js` (~6KB) copied into the
 *     extension by sync-shared, alongside substantial growth in `sync-client.js`,
 *     `conflict-resolution.js`, `sync-types.js`, `sync-store.js`,
 *     `conflict-detector.js`, and `sync-conflict-ui.js`, plus the auto-sync host
 *     wiring in `background/service-worker.js`. Verified the ~74KB growth (480→554KB
 *     actual) is entirely this deliberate feature code with no duplicated bundle
 *     and no new third-party dependency (the largest single file remains the
 *     generated Ajv validator). This mirrors the desktop limit raised to 520KB in
 *     this same revision; the extension's equivalent bump was outstanding. Budget
 *     raised to fit the current ~554KB plus normal headroom.
 *   - Raised to 620KB for the locators[] contract shapes (docent#174): the 11
 *     per-strategy entry schemas added to the extension schema grow the generated
 *     Ajv validator (the largest single file) by a few KB — 602KB actual at the
 *     time of the change. Deliberate schema-contract artifact, no new dependency.
 *   - Raised to 645KB for locators[] EMISSION (docent#132/#172): the measured
 *     locator-candidate builder + uniqueness-aware selector derivation live twice
 *     by necessity (content scripts cannot import modules — the parity-tested
 *     mirrored block in content/recorder.js and content/recorder-logic.js),
 *     ~11KB each including the contract-bearing doc comments — 625.5KB actual.
 *     Deliberate capture-feature artifact, no new dependency.
 *   - Raised to 660KB for the pull path's forward-compatibility projection
 *     (docent#429): `packages/shared/sync-client.js` gained the known-field
 *     envelope projection the Sync Protocol's SP-5 is delivered through, with the
 *     contract-bearing comments that keep it from being simplified back into a
 *     raw-payload validation, and `packages/shared/lib/validate-import.js` gained
 *     the clauses scoping its pull half — 3,093 B of shared code that
 *     sync-shared copies into the extension. Deliberate protocol-conformance
 *     artifact, no new dependency. The record, so the raise is auditable: the
 *     pre-change tree measured 657,829 B (642.4KB), sitting 2,651 B under the
 *     old 645KB limit; this change takes it to 660,922 B (645.4KB), which that
 *     limit would have tripped. The raise is deliberately larger than the
 *     growth — 660KB leaves 14,918 B (~14.6KB) of margin — but deliberately
 *     smaller than the margins the two preceding raises left (~18KB at the
 *     620KB raise, ~19.5KB at the 645KB raise), so the tripwire regains room to
 *     catch unexpected growth without widening the budget past what those
 *     raises set.
 *   - Raised to 674KB: measured 669,175 B (`node_modules` inside the
 *     checkout); margin 21,001 B; growth since 660,922 B at b049f56 (the
 *     header's recorded size): `background/service-worker.js` +5,474 B,
 *     `shared/views/adapter.js` +1,730 B, `lib/capture-timing.js` +607 B,
 *     `shared/sync-client.js` +410 B, others +32 B. Deliberate:
 *     `background/service-worker.js` grew with the worker introspection handle
 *     that pins the frame registry's departures and with comments aligned to
 *     the doctrine terms, `shared/views/adapter.js` with the platform-adapter
 *     seam held in both directions and the panel's caller model stated at the
 *     seam, `lib/capture-timing.js` with the derived inject-to-ready bound, and
 *     `shared/sync-client.js` with the push-scope comments and the exported
 *     envelope projection that holds the pull and push halves together; no new
 *     dependency.
 *   - Raised to 715KB for the local control channel: measured 709,975 B
 *     (`node_modules` inside the checkout); margin 22,185 B; growth since
 *     669,175 B (the header's recorded size): `sidepanel/control-channel.js`
 *     +17,639 B (new), `sidepanel/control-channel-host.js` +6,217 B (new),
 *     `sidepanel/control-commands.js` +5,022 B (new), `sidepanel/panel.js`
 *     +4,797 B (+5,400 B in this change, −603 B before it),
 *     `sidepanel/send-gate.js` +3,608 B (new), `lib/navigation-logic.js`
 *     +2,946 B, `shared/sync-types.js` +588 B, `shared/lib/http-transport.js`
 *     +294 B, `content/recorder.js` +178 B, `lib/capture-timing.js` +86 B,
 *     `shared/conflict-resolution.js` −863 B, `shared/sync-client.js` −638 B,
 *     `background/service-worker.js` −355 B, others +1,281 B. Deliberate: the
 *     three control-channel modules are the opt-in loopback channel (pairing
 *     and frame validation, the socket host, the command-to-action mapping)
 *     with the contract-bearing comments that state its bounds, and the panel
 *     grew by its binding; the rest landed earlier inside the previous budget;
 *     no new dependency.
 *   - Raised to 741KB for side panels in two windows (docent#661): measured
 *     735,856 B (`node_modules` inside the checkout); margin 22,928 B; growth
 *     since 709,975 B (the header's recorded size): `sidepanel/panel.js`
 *     +8,652 B (+6,951 B in this change, +1,701 B before it),
 *     `sidepanel/control-commands.js` +4,603 B (+1,033 B in this change,
 *     +3,570 B before it), `sidepanel/project-export.js` +2,910 B (new),
 *     `sidepanel/control-channel.js` +2,886 B, `background/service-worker.js`
 *     +2,547 B (+2,307 B in this change, +240 B before it),
 *     `lib/active-recording.js` +1,649 B (new),
 *     `sidepanel/control-channel-host.js` +1,487 B, `content/recorder.js`
 *     +1,147 B. Deliberate: the panel names the project and recording each of
 *     its messages is for and reads every answer before using it, telling a
 *     failed action and showing the view as the worker holds it; the worker
 *     finds each message's target by those ids and refuses a capture message
 *     for a recording that is no longer the active one, with the rule's text
 *     and test in `lib/active-recording.js`, shared by both; the control
 *     commands answer a refused pause, resume or create with fixed texts; the
 *     rest landed earlier inside the previous budget; no new dependency.
 *   - Raised to 764KB for the keys held at an action and the modifiers of a
 *     pointer action (docent#706, docent#239): measured 759,127 B
 *     (`node_modules` inside the checkout); margin 23,209 B; growth since
 *     735,856 B (the header's recorded size):
 *     `shared/generated/validate-extension.js` +12,459 B (+12,109 B in this
 *     change, +350 B before it), `content/recorder.js` +9,266 B (+1,206 B in
 *     this change, +8,060 B before it), `content/recorder-logic.js` +1,666 B,
 *     `lib/capture-timing.js` −120 B. Deliberate: the validator is generated
 *     from the schema, which states `held_keys` on five action types and
 *     `modifiers` on four more, and each statement is validation code per
 *     action type; the recorder keeps the written keys that are down and
 *     writes both fields; the rest landed earlier inside the previous budget;
 *     no new dependency.
 *   - Raised to 809KB for every key press that is not text (docent#702):
 *     measured 803,721 B (`node_modules` inside the checkout); margin
 *     24,695 B; growth since 759,127 B (the header's recorded size):
 *     `content/recorder.js` +25,733 B (+21,504 B in this change, +4,229 B
 *     before it), `background/service-worker.js` +6,619 B (+348 B in this
 *     change, +6,271 B before it), `lib/redaction-logic.js` +5,076 B,
 *     `content/recorder-logic.js` +4,652 B, `lib/capture-timing.js` +759 B
 *     (before this change), `shared/lib/field-sensitivity.js` +329 B,
 *     `lib/frame-trust.js` +66 B (before this change), others +1,360 B
 *     (before this change). Deliberate: the recorder holds a character key
 *     pressed in a field back until it is known whether it became text, with
 *     the map of what settles a waiting press stated beside it, and tests
 *     the element a key is pressed on with its own copy of the sensitive
 *     patterns, so that it never writes a character typed on a sensitive
 *     element under its own name; the storage chokepoint keeps the same rule
 *     as a second test; the growth before this change is the end of typing
 *     the worker asks the frames for, which landed inside the previous
 *     budget; no new dependency.
 *   - Raised to 838KB for a dead key whose accent the browser enters with
 *     the key after it (docent#769): measured 832,284 B (`node_modules`
 *     inside the checkout); margin 25,828 B; growth since 803,721 B (the
 *     header's recorded size): `content/recorder.js` +16,063 B (+4,187 B in
 *     this change, +11,876 B before it), the files synced from the shared
 *     package with the generated validator +11,161 B, `content/recorder-logic.js`
 *     +788 B, `background/service-worker.js` +442 B, `lib/redaction-logic.js`
 *     +109 B (all before this change). Deliberate: the recorder keeps a key
 *     that is no character key waiting behind a dead key until it is known
 *     whether the browser entered the accent; the growth before this change
 *     is the physical key, the input method's keys and composed text, and
 *     entries made again, which landed inside the previous budget, 319 B
 *     under it; no new dependency.
 *   - Raised to 864KB for a key held in another frame of the tab
 *     (docent#779): measured 859,045 B (`node_modules` inside the checkout);
 *     margin 25,691 B; growth since 832,284 B (the header's recorded size):
 *     `lib/held-keys-relay.js` +14,003 B (new), `background/service-worker.js`
 *     +7,909 B (+7,181 B in this change, +728 B before it),
 *     `content/recorder.js` +4,435 B, `lib/capture-timing.js` +414 B.
 *     Deliberate: each recorder reports the
 *     keys it names as held and what moves the focus, and the worker keeps
 *     which of them an action in another frame may name, asking a frame for
 *     its last report before it names one of its keys; no new dependency.
 *
 * Requires `npm run sync-shared` to have been run first.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const extensionDir = resolve(__dirname, '../..');

/**
 * Sums the sizes of the files under `dir`, optionally only those ending in one
 * of `extensions`, skipping every file that sits inside a directory named in
 * `excludeDirs`. A directory is matched by whole name among the path segments
 * below `dir`, so where the checkout itself lives never decides what counts.
 */
function getDirSize(dir, extensions = null, excludeDirs = []) {
  let total = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const fullPath = join(entry.parentPath || entry.path, entry.name);
        const dirSegments = relative(dir, fullPath).split(sep).slice(0, -1);
        if (dirSegments.some((segment) => excludeDirs.includes(segment))) continue;
        if (extensions && !extensions.some((ext) => entry.name.endsWith(ext))) continue;
        try {
          total += statSync(fullPath).size;
        } catch {
          /* skip inaccessible files */
        }
      }
    }
  } catch {
    /* directory doesn't exist */
  }
  return total;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

const extensionExcludes = ['node_modules', 'tests', '.git', 'coverage'];

const JS_BUDGET_KB = 864;

/** The headroom rule's figures for a measured size: the next budget and its margin. */
function nextBudget(bytes) {
  const kb = Math.ceil((bytes * 1.03) / 1024);
  return `${bytes} B measured; the headroom rule's next budget is ${kb}KB, leaving ${kb * 1024 - bytes} B`;
}

describe('Build size: Extension', () => {
  it(`total JS size is under ${JS_BUDGET_KB}KB (uncompressed)`, () => {
    const size = getDirSize(extensionDir, ['.js'], extensionExcludes);
    assert.ok(size > 0, 'No JS files found — has sync-shared been run?');
    assert.ok(
      size < JS_BUDGET_KB * 1024,
      `Extension JS is ${formatSize(size)} (${nextBudget(size)}; soft limit: ${JS_BUDGET_KB}KB). This is a regression tripwire, not a platform limit — if the growth is an intentional artifact, raise the limit AND its rationale in this file's header; otherwise check for an accidental large dependency.`,
    );
  });

  it('total CSS size is under 50KB', () => {
    const size = getDirSize(extensionDir, ['.css'], extensionExcludes);
    assert.ok(size > 0, 'No CSS files found — has sync-shared been run?');
    assert.ok(size < 50 * 1024, `Extension CSS is ${formatSize(size)} (limit: 50KB).`);
  });

  it('total HTML size is under 100KB', () => {
    const size = getDirSize(extensionDir, ['.html'], extensionExcludes);
    assert.ok(size > 0, 'No HTML files found — has sync-shared been run?');
    assert.ok(size < 100 * 1024, `Extension HTML is ${formatSize(size)} (limit: 100KB).`);
  });

  it('total extension size (shipped files) is under 1MB uncompressed', () => {
    const size = getDirSize(extensionDir, null, extensionExcludes);
    assert.ok(size > 0, 'Extension directory appears empty');
    assert.ok(
      size < 1024 * 1024,
      `Extension total is ${formatSize(size)} (limit: 1MB uncompressed). This guards the HARD external limit: Chrome Web Store caps extensions at 10MB zipped, so 1MB uncompressed leaves a large margin after compression.`,
    );
  });
});
