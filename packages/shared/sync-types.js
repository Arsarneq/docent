/**
 * sync-types.js — Shared contracts for graded sync conflict resolution.
 *
 * This module carries no runtime logic. It defines the JSDoc typedefs that the
 * conflict-resolution feature shares across `packages/shared` and the two thin
 * platform adapters (Chrome extension + desktop). Centralizing the contracts
 * here is what makes cross-platform parity *structural* rather than duplicated:
 * both adapters persist the same `SyncState` shape and feed the shared
 * orchestrator the same `LiveState` / `SyncStore` interfaces (R16.1, R17.1).
 *
 * The two platform-specific seams are:
 *   - `SyncStore`  — durable read/write of all conflict-handling state.
 *   - `LiveState`  — synchronous live-work signals (open recording, capture
 *                    active, recordings holding Pending Actions).
 * Everything else is pure logic over the types defined below.
 *
 * Design references:
 *   - R16.1/16.3/16.4 — all detection/baseline/snapshot/resolution state is
 *     client-side, exchanged over the existing endpoints + Full_Project_Payload,
 *     with no server-side state added.
 *   - R17.1           — detection, snapshot retention, deferral, and resolution
 *     orchestration live in this shared package.
 *   - R18.3           — every recoverable copy is an allowlisted, canonicalizable
 *     projection; unrecognized top-level server fields are dropped, so a future
 *     concurrency-control token can be added without breaking clients.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

// ─── Unit reference convention ──────────────────────────────────────────────

/**
 * A `unitRef` is the stable idempotency key for a Unit (a Project or a
 * Recording) across the whole feature. It keys `reviews`, `conflicts`, and the
 * derived UI indicators, and guarantees re-detection keeps a single record per
 * Unit (R10.3).
 *
 * Convention:
 *   - Project-level unit:   `"<project_id>"`
 *   - Recording-level unit: `"<project_id>:<recording_id>"`
 *
 * `reviews` and `conflicts` are mutually exclusive for a given `unitRef`: a Unit
 * is either in Review-and-Accept, in Conflict, or in neither (NONE).
 *
 * @typedef {string} UnitRef
 */

// ─── Recoverable copies (allowlisted projections) ────────────────────────────

/**
 * A recoverable, canonicalizable copy of a project, shaped exactly like the
 * `Full_Project_Payload` project reconstruction the pull path already builds
 * (explicit field allowlist — never raw server JSON). Unrecognized top-level
 * fields are dropped so they can never affect content identity or behavior
 * (R18.3). Used for baseline `agreedState`, retained snapshots, and the local /
 * incoming versions stored on deferred items.
 *
 * @typedef {Object} ProjectCopy
 * @property {string} project_id
 * @property {string} name
 * @property {string} created_at
 * @property {object} [metadata]
 * @property {RecordingCopy[]} recordings - committed recordings, in order
 */

/**
 * A recoverable, canonicalizable copy of a recording, using the same allowlist
 * as {@link ProjectCopy}. `steps` is the FULL committed step history (the
 * append-only version records), never the Active View and never Pending Actions
 * (R8.1) — tombstones and re-records are part of the recording's identity.
 *
 * @typedef {Object} RecordingCopy
 * @property {string} recording_id
 * @property {string} name
 * @property {string} created_at
 * @property {object} [metadata]
 * @property {object[]} steps - full committed step history (versioned records)
 */

/**
 * A recoverable copy of a single Unit, at whichever granularity the Unit lives:
 * a {@link ProjectCopy} for a project-level Unit, or a {@link RecordingCopy} for
 * a recording-level Unit. Stored on Review and Conflict records so both sides of
 * a deferral stay recoverable independent of any re-fetch (R5.2, R4.6, R9.3).
 *
 * @typedef {ProjectCopy | RecordingCopy} UnitCopy
 */

// ─── Baseline (last mutually-agreed state per project) ───────────────────────

/**
 * The retained last *mutually agreed* state for one project (R1). A baseline is
 * advanced only on confirmed agreement or adoption, never on push (R1.2). It
 * stores a content digest plus a recoverable copy of the agreed project, so
 * detection and recovery never depend on re-fetching from the server.
 *
 * @typedef {Object} BaselineRecord
 * @property {string} digest - canonical content digest of the agreed project
 * @property {ProjectCopy} agreedState - recoverable copy of the agreed project
 * @property {string} agreedAt - ISO timestamp the agreement was recorded (informational)
 */

/**
 * A retained copy of pulled data. Pull lands each accepted payload here instead
 * of overwriting local data directly, guaranteeing the incoming version stays
 * recoverable through deferral and resolution (R9.1).
 *
 * @typedef {Object} SnapshotRecord
 * @property {ProjectCopy} payload - the pulled project, as an allowlisted copy
 * @property {string} pulledAt - ISO timestamp the snapshot was landed
 */

// ─── Deferred items (Review-and-Accept and Conflict) ─────────────────────────

/**
 * A Review-and-Accept item: an incoming change to a recording the user already
 * has, whose local copy is unchanged since the baseline (`changed-incoming`), or
 * a server-side deletion of a locally-unchanged Unit (`deleted-remote-review`).
 * The incoming change is never applied automatically; only `incoming` (the
 * retained snapshot) is stored — local data is left untouched (R4, R9.5).
 *
 * @typedef {Object} ReviewItem
 * @property {'review'} kind
 * @property {UnitRef} unitRef
 * @property {string} project_id
 * @property {string|null} recording_id - null for a project-level unit
 * @property {UnitCopy} incoming - recoverable incoming version (from the snapshot)
 * @property {'PENDING'|'APPLIED'} status - APPLIED once the accept is confirmed (R4.5)
 * @property {string} detectedAt - ISO timestamp the item was first recorded
 */

/**
 * A Conflict item: a Unit that diverged on both sides since the baseline
 * (`diverged`), or a delete-vs-change case (`conflict-delete-vs-change`). Holds
 * recoverable copies of BOTH the local and the incoming versions (R5.2); a
 * version is applied to the Unit only as the explicit outcome of resolution.
 *
 * @typedef {Object} ConflictItem
 * @property {'conflict'} kind
 * @property {UnitRef} unitRef
 * @property {string} project_id
 * @property {string|null} recording_id - null for a project-level unit
 * @property {UnitCopy} local - recoverable local version (R5.2)
 * @property {UnitCopy} incoming - recoverable incoming version (R5.2)
 * @property {string} detectedAt - ISO timestamp the conflict was first recorded
 */

// ─── Reconciliation policy + Auto-Sync settings (client-local) ───────────────

/**
 * Client-local reconciliation-policy and Auto-Sync settings (R22, R23). These
 * live inside {@link SyncState} so they persist through the same {@link SyncStore}
 * adapter as everything else, but they are strictly client-local: they are never
 * placed in a `Full_Project_Payload` and are never transmitted to the
 * Sync_Server (R22.3, R23.1). The setting *values* are per-client and are not
 * synced across devices.
 *
 * `autoAcceptUpdates` and `autoAcceptDeletions` are the two independent
 * reconciliation-policy toggles; both default to OFF so the out-of-the-box
 * behavior gates every incoming change and deletion for review (R22.1, R22.2).
 * They affect ONLY the local-unchanged cases (`changed-incoming` fast-forwards
 * and server-deleted-local-unchanged); they never auto-resolve a `diverged` or
 * delete-vs-change Unit (R22.6).
 *
 * `autoSync` enables automatic triggering of cycles; it defaults to OFF and may
 * be turned on only once a {@link ReconciliationSettings} `connectionTest` has
 * passed for the current server settings (R23.1, R23.2). `connectionTest` holds
 * the last Connection_Test outcome and `testedSettingsFingerprint` records the
 * fingerprint of the endpoint+apiKey that test was taken against, so changing the
 * endpoint or API key invalidates a prior pass and forces `autoSync` off until a
 * fresh test passes (R23.3).
 *
 * @typedef {Object} ReconciliationSettings
 * @property {boolean} autoAcceptUpdates - auto-apply a fast-forward `changed-incoming` update (R4.2, R22.4); default false
 * @property {boolean} autoAcceptDeletions - auto-apply a server deletion of a local-unchanged Unit (R19.4, R22.5); default false
 * @property {boolean} autoSync - run cycles on automatic triggers rather than a manual press (R23.1); default false
 * @property {('pass'|'auth'|'unreachable'|null)} connectionTest - last Connection_Test outcome for the current settings, or null when untested (R16.5, R23.2)
 * @property {string|null} testedSettingsFingerprint - fingerprint of the endpoint+apiKey the `connectionTest` was taken against, for invalidation on change (R23.3)
 */

// ─── The single durable store shape ──────────────────────────────────────────

/**
 * The single source of truth for all conflict-handling state, persisted as one
 * object through the {@link SyncStore} adapter. Keeping every part in one shape
 * is what lets both platforms persist identically (R10, R17). All maps are keyed
 * by stable ids: `baselines` and `snapshots` by `project_id`; `reviews`,
 * `conflicts`, and `dismissedIncoming` by {@link UnitRef}. `reviews` and
 * `conflicts` are mutually exclusive for any given `unitRef`.
 *
 * `dismissedIncoming` and `settings` were added in Revision R1 and are
 * forward-compatible: a pre-R1 persisted blob omits them, so the store
 * normalizes both to their empty defaults on load (R10.1). `settings` is
 * client-local and is never placed in a `Full_Project_Payload` (R22.3, R23.1).
 *
 * @typedef {Object} SyncState
 * @property {number} schema - state-shape version, for forward migration (starts at 1)
 * @property {Object<string, BaselineRecord>} baselines - per-`project_id` last-agreed state (R1)
 * @property {Object<string, SnapshotRecord>} snapshots - per-`project_id` retained pulled data (R9.1)
 * @property {Object<UnitRef, ReviewItem>} reviews - per-`unitRef` Review-and-Accept items (R4)
 * @property {Object<UnitRef, ConflictItem>} conflicts - per-`unitRef` Conflict items (R5)
 * @property {Object<UnitRef, string>} dismissedIncoming - per-`unitRef` digest of the last declined incoming version, so the same incoming version is not re-offered as a Review (R4.9, R4.10)
 * @property {ReconciliationSettings} settings - client-local reconciliation-policy and Auto-Sync settings (R22, R23); never transmitted to the server (R22.3, R23.1)
 */

// ─── Classification (Conflict_Detector output) ───────────────────────────────

/**
 * The exhaustive set of classifications the Conflict_Detector may assign to a
 * Unit. Listed in evaluation precedence (R2.9): a locked recording is never
 * touched; then content equality; then the deletion cases (a side absent but
 * present in the baseline, R19); then `brand-new`; then the local-counterpart
 * change cases (`changed-incoming` / `changed-local-outgoing`); then `diverged`
 * last (including the no-baseline local≠incoming case, R2.7).
 *
 * The detector emits the bare `ClassKind`; the policy settings (Auto-Accept-*)
 * are applied by the orchestrator, not here, so classification stays pure and
 * settings-independent (R2.11).
 *
 *   - `'locked-skipped'`            recording open in the Recording_View; excluded this cycle (R6.3)
 *   - `'already-converged'`         local and incoming present and equal, regardless of baseline (R2.2)
 *   - `'deleted-local-clean'`       absent locally, present in baseline, incoming == baseline → propagate deletion (R19.1)
 *   - `'deleted-both'`              absent locally and on server, present in baseline → agreed deletion (R19.7)
 *   - `'deleted-remote-review'`     absent on server, present in baseline, local == baseline → review or auto-apply the delete (R19.3, R19.4)
 *   - `'conflict-delete-vs-change'` deleted on one side, changed on the other (R19.2, R19.5)
 *   - `'changed-incoming'`          local == baseline, incoming differs → Review-and-Accept or fast-forward auto-apply (R2.4)
 *   - `'changed-local-outgoing'`    incoming == baseline, local differs → routine automatic push (R2.5, R21)
 *   - `'diverged'`                  local and incoming differ and both differ from baseline, or differ with no baseline → Conflict (R2.6, R2.7, R18.1)
 *   - `'brand-new'`                 no local counterpart and no baseline counterpart → auto-add (R2.3)
 *
 * @typedef {('already-converged'|'brand-new'|'changed-local-outgoing'|'changed-incoming'|'diverged'|'locked-skipped'|'deleted-local-clean'|'deleted-remote-review'|'deleted-both'|'conflict-delete-vs-change')} ClassKind
 */

/**
 * The result of classifying one Unit against its baseline. Pure data: produced
 * by `classifyProject` with no I/O and no user-input hook (R2.9, R10.2). The
 * three digests are carried so downstream phases need not recompute them.
 *
 * @typedef {Object} UnitClassification
 * @property {UnitRef} unitRef
 * @property {string} project_id
 * @property {string|null} recording_id - null for a project-level unit
 * @property {ClassKind} kind
 * @property {string|null} digestLocal - digest of the local version, or null if absent
 * @property {string|null} digestIncoming - digest of the incoming version, or null if absent
 * @property {string|null} digestBaseline - digest from the baseline, or null if none (R1.6)
 */

// ─── Sync cycle result (extended) ────────────────────────────────────────────

/**
 * Why a sync cycle halted, or `null` when it ran to completion.
 *
 *   - `'auth'`                          server returned 401/403 (R14.3–14.5)
 *   - `'capture-active'`                capture is running; no cycle starts (R7.1)
 *   - `'pending-actions-unprotected'`   a recording holding Pending Actions was
 *                                       neither locked nor capture-halted (R8.4)
 *   - `'internal-error'`                detection threw internally, or a version
 *                                       could not be retained while recording a
 *                                       Conflict — the entire sync aborts/blocks
 *                                       with ALL durable state preserved, never
 *                                       half-written (R5.3, R16.2)
 *
 * @typedef {('auth'|'capture-active'|'pending-actions-unprotected'|'internal-error'|null)} HaltReason
 */

/**
 * The result of a sync cycle. Extends the original shape (`pushed`, `pulled`,
 * `errors`, `mismatched`, `halted`) with the deferral sets, the auto-applied
 * sets, and a halt reason so the UI can report Review and Conflict counts and
 * auto-applied update/deletion counts alongside the existing counts (R13.2) and
 * explain why a cycle stopped.
 *
 * `autoAppliedUpdates` and `autoAppliedDeletions` were added in Revision R1: a
 * `changed-incoming` fast-forward applied because Auto-Accept-Updates is ON
 * (R4.2, R22.4) lands in `autoAppliedUpdates`, and a server deletion applied
 * because Auto-Accept-Deletions is ON (R19.4, R22.5) lands in
 * `autoAppliedDeletions`. Both are automatic outcomes for the
 * automatic/user-gated boundary (R15.1, R22.7).
 *
 * @typedef {Object} SyncResult
 * @property {string[]} pushed - project_ids successfully pushed
 * @property {string[]} pulled - project_ids successfully pulled
 * @property {import('./sync-client.js').SyncError[]} errors - non-fatal per-project errors (incl. schema-invalid, R14.2)
 * @property {import('./sync-client.js').SyncError[]} mismatched - projects skipped for a docent_format mismatch (R14.1)
 * @property {UnitRef[]} review - unitRefs newly in, or kept in, Review-and-Accept
 * @property {UnitRef[]} conflicts - unitRefs newly in, or kept in, Conflict
 * @property {UnitRef[]} autoAppliedUpdates - unitRefs auto-applied as fast-forward updates (R4.2, R22.4)
 * @property {UnitRef[]} autoAppliedDeletions - unitRefs auto-applied as deletions (R19.4, R22.5)
 * @property {boolean} halted - true on auth failure, capture-active, a pending-actions safety halt, or an internal detection/abort failure
 * @property {HaltReason} haltReason - why the cycle halted, or null when it completed
 */

// ─── Platform-provided adapters (the only platform-specific seams) ────────────

/**
 * `SyncStore` — durable persistence of the entire {@link SyncState}, provided by
 * each platform. The extension backs it with `chrome.storage.local`; desktop
 * backs it with the Tauri `load_state` / `save_state` JSON blob. The shared code
 * reads and writes only through this interface, so persistence is the only thing
 * that differs between platforms (R10.1, R16.1, R17.1).
 *
 * @typedef {Object} SyncStore
 * @property {() => Promise<SyncState>} load
 *   Load the persisted SyncState. Returns a fresh empty state (with the `schema`
 *   version set) when nothing has been persisted yet.
 * @property {(state: SyncState) => Promise<void>} save
 *   Persist the given SyncState durably so it survives application restarts.
 */

/**
 * `LiveState` — synchronous answers about what the user is doing *right now*,
 * provided by each platform. These drive the two-tier live-work protection:
 * a recording open in the Recording_View is locked and excluded from the merge,
 * and while capture is active sync halts entirely. The signals are synchronous
 * so the orchestrator can apply them as hard pre-flight gates rather than
 * advisory checks (R6, R7, R8, R15.4, R15.5).
 *
 * Extension backing: panel state + `chrome.storage.local`
 * (`recording`, `activeRecordingId`, `pendingCount`).
 * Desktop backing: panel state (`isRecording`, `activeRecording`, `pendingCount`).
 *
 * @typedef {Object} LiveState
 * @property {() => boolean} isCaptureActive
 *   True while capture is running; when true, no sync cycle starts (R7).
 * @property {() => Set<string>} getLockedRecordingIds
 *   The set of `recording_id`s currently open in the Recording_View; each is a
 *   Locked_Recording excluded from the inbound merge (R6).
 * @property {() => Set<string>} recordingsWithPendingActions
 *   The set of `recording_id`s that hold uncommitted Pending Actions; each must
 *   be protected by the lock exclusion or the capture halt (R8).
 */

/**
 * `SyncTrigger` — the platform mechanism that invokes a sync cycle automatically
 * while Auto-Sync is active (R23). It is pure plumbing: it decides *when* to run
 * a cycle, never *whether* to proceed — every cycle it starts calls the same
 * shared `sync()` and passes through the identical live-work gates as a manual
 * cycle (R15.3, R23.13). Backed by `chrome.alarms` + event hooks on the
 * extension and a timer + event hooks on desktop (R23.13).
 *
 * Implementations wire local data events (step commit, recording close,
 * project/recording create/delete) and a ~60s backstop interval, debounced
 * through the existing dispatch-cooldown so a burst yields at most one cycle per
 * window and cycles never overlap (R23.7, R23.8, R23.14).
 *
 * @typedef {Object} SyncTrigger
 * @property {(runCycle: () => Promise<void>) => void} start
 *   Begin firing `runCycle` on local data events and the periodic backstop,
 *   cooldown-debounced, when Auto-Sync becomes active (R23.7, R23.8).
 * @property {() => void} stop
 *   Tear the trigger down on disable, on a server-settings change, or on a
 *   401/403 auto-disable (R23.3, R23.11).
 */

export default undefined; // module exists only for the JSDoc type definitions
