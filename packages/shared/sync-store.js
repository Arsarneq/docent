/**
 * sync-store.js — Durable, idempotent conflict-handling state store.
 *
 * Single source of truth for all conflict-handling state (baselines, retained
 * snapshots, Review-and-Accept items, and Conflicts), persisted as one
 * `SyncState` object through the injected {@link SyncStore} adapter. Keeping
 * every part in one shape, read and written only through the adapter, is what
 * lets both platforms persist identically — the extension over
 * `chrome.storage.local`, the desktop app over the Tauri `load_state` /
 * `save_state` JSON blob.
 *
 * This module carries no platform code: it works purely against the
 * `SyncStore.load()` / `SyncStore.save()` interface. `loadSyncState` always
 * returns a complete, well-formed `SyncState` — even when nothing has been
 * persisted yet, or the persisted blob is partial or malformed — by normalizing
 * the loaded value into the full shape with the `schema` version field set.
 * `saveSyncState` normalizes symmetrically so the persisted shape is always
 * complete, keeping the save/load round-trip stable.
 *
 * The idempotent record helpers (`upsertConflict`, `upsertReview`, `clearItem`,
 * `getItem`) operate on the in-memory `SyncState` produced here and are added
 * separately; they reuse the same normalized shape this module guarantees.
 *
 *   - conflict / review state is persisted durably across restarts.
 *   - all conflict-handling state is client-side, in one shared shape.
 *   - detection / snapshot / deferral / resolution state lives here.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

/**
 * The current `SyncState` shape version. Stamped onto every empty state and
 * onto any loaded state missing a usable version, so a future migration can key
 * off it without breaking existing persisted blobs (design: "state-shape
 * version, for forward migration").
 *
 * @type {number}
 */
export const SYNC_STATE_SCHEMA_VERSION = 1;

/**
 * True for a plain, non-null object value (and not an array). Used to guard the
 * untrusted-shaped persisted blob before treating any field as a keyed map.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The set of {@link import('./sync-types.js').ReconciliationSettings.connectionTest}
 * outcomes a persisted `connectionTest` may legitimately hold. Any other value
 * (including a stale string from a future shape) is normalized back to `null`,
 * the untested state, so a malformed blob can never leave Auto-Sync wrongly
 * believing a Connection_Test passed.
 *
 * @type {ReadonlyArray<('pass'|'auth'|'unreachable')>}
 */
const CONNECTION_TEST_OUTCOMES = ['pass', 'auth', 'unreachable'];

/**
 * Construct the documented empty-default {@link import('./sync-types.js').ReconciliationSettings}:
 * both reconciliation-policy toggles OFF and Auto-Sync OFF, with no recorded
 * Connection_Test outcome. This is the out-of-the-box policy that gates every
 * incoming change and deletion for review and keeps Auto-Sync disabled until a
 * Connection_Test passes.
 *
 * @returns {import('./sync-types.js').ReconciliationSettings}
 */
function createDefaultSettings() {
  return {
    autoAcceptUpdates: false,
    autoAcceptDeletions: false,
    autoSync: false,
    connectionTest: null,
    testedSettingsFingerprint: null,
  };
}

/**
 * Normalize an arbitrary (possibly partial, missing, or malformed) value into a
 * complete {@link import('./sync-types.js').ReconciliationSettings}. Each field
 * is taken from the input only when it has the expected type and is replaced
 * with its documented default otherwise, so a legacy blob omitting `settings`
 * — or a partial one — always yields a well-formed, client-local settings object.
 *
 * @param {unknown} raw
 * @returns {import('./sync-types.js').ReconciliationSettings}
 */
function normalizeSettings(raw) {
  const defaults = createDefaultSettings();
  if (!isPlainObject(raw)) {
    return defaults;
  }
  return {
    autoAcceptUpdates:
      typeof raw.autoAcceptUpdates === 'boolean'
        ? raw.autoAcceptUpdates
        : defaults.autoAcceptUpdates,
    autoAcceptDeletions:
      typeof raw.autoAcceptDeletions === 'boolean'
        ? raw.autoAcceptDeletions
        : defaults.autoAcceptDeletions,
    autoSync: typeof raw.autoSync === 'boolean' ? raw.autoSync : defaults.autoSync,
    connectionTest: CONNECTION_TEST_OUTCOMES.includes(raw.connectionTest)
      ? raw.connectionTest
      : defaults.connectionTest,
    testedSettingsFingerprint:
      typeof raw.testedSettingsFingerprint === 'string'
        ? raw.testedSettingsFingerprint
        : defaults.testedSettingsFingerprint,
  };
}

/**
 * Construct a fresh, empty {@link SyncState} with the current schema version and
 * every keyed map present and empty. This is the canonical "nothing persisted
 * yet" state. `dismissedIncoming` starts empty and `settings` starts at the
 * documented empty defaults.
 *
 * @returns {import('./sync-types.js').SyncState}
 */
export function createEmptySyncState() {
  return {
    schema: SYNC_STATE_SCHEMA_VERSION,
    baselines: {},
    snapshots: {},
    reviews: {},
    conflicts: {},
    dismissedIncoming: {},
    settings: createDefaultSettings(),
  };
}

/**
 * Normalize an arbitrary (possibly partial, missing, or malformed) value into a
 * complete {@link SyncState}. Each keyed map is taken from the input when it is
 * a plain object and replaced with an empty map otherwise; the schema version is
 * preserved when it is a positive number and stamped with the current version
 * otherwise. `dismissedIncoming` and `settings` (added in a later revision) are
 * normalized the same way, so a legacy persisted blob that omits them still
 * loads cleanly with `dismissedIncoming` empty and `settings` at the documented
 * defaults. Only the recognized top-level keys are kept,
 * so an unexpected blob can never smuggle extra state into the store.
 *
 * @param {unknown} raw - value returned by the adapter, or held in memory
 * @returns {import('./sync-types.js').SyncState}
 */
function normalizeSyncState(raw) {
  if (!isPlainObject(raw)) {
    return createEmptySyncState();
  }

  const schema =
    typeof raw.schema === 'number' && raw.schema > 0 ? raw.schema : SYNC_STATE_SCHEMA_VERSION;

  return {
    schema,
    baselines: isPlainObject(raw.baselines) ? raw.baselines : {},
    snapshots: isPlainObject(raw.snapshots) ? raw.snapshots : {},
    reviews: isPlainObject(raw.reviews) ? raw.reviews : {},
    conflicts: isPlainObject(raw.conflicts) ? raw.conflicts : {},
    dismissedIncoming: isPlainObject(raw.dismissedIncoming) ? raw.dismissedIncoming : {},
    settings: normalizeSettings(raw.settings),
  };
}

/**
 * Load the persisted {@link SyncState} through the adapter, normalized into the
 * full shape. Returns a fresh empty state (with the `schema` version set) when
 * the adapter has nothing persisted or returns an incomplete blob, so callers
 * always receive every keyed map.
 *
 * @param {import('./sync-types.js').SyncStore} adapter - platform persistence seam
 * @returns {Promise<import('./sync-types.js').SyncState>}
 */
export async function loadSyncState(adapter) {
  const raw = await adapter.load();
  return normalizeSyncState(raw);
}

/**
 * Persist the given {@link SyncState} durably through the adapter, normalized so
 * the written shape is always complete and carries the `schema` version field.
 * Normalizing on the way out keeps the save/load round-trip stable regardless of
 * what the caller passes.
 *
 * @param {import('./sync-types.js').SyncStore} adapter - platform persistence seam
 * @param {import('./sync-types.js').SyncState} state - state to persist
 * @returns {Promise<void>}
 */
export async function saveSyncState(adapter, state) {
  await adapter.save(normalizeSyncState(state));
}
// ─── Idempotent deferred-item record helpers ─────────────────────────────────

/**
 * Deep, independent copy of an allowlisted, JSON-serializable projection
 * ({@link ProjectCopy}/{@link RecordingCopy}). A JSON round-trip is sufficient
 * and deterministic here because the versions stored on a deferred item are
 * always allowlisted copies (never raw server JSON, never functions/cycles), so
 * the recorded version can never be mutated through the caller's reference
 * afterwards. Matches the clone strategy used by sync-baseline.js.
 *
 * If the value cannot be retained as a recoverable copy (e.g. it is not
 * JSON-serializable), the round-trip throws. The upsert helpers below build
 * every copy BEFORE mutating the store, so a throw here leaves the store
 * untouched — the caller (the orchestrator) treats the throw as the signal to
 * abort without having lost or half-written any version.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Split a {@link UnitRef} into its `project_id` and (optional) `recording_id`.
 *
 * The `unitRef` convention is `"<project_id>"` for a project-level Unit and
 * `"<project_id>:<recording_id>"` for a recording-level Unit. Both ids are
 * UUIDv7 strings (hex + hyphens), which never contain a colon, so splitting on
 * the FIRST colon recovers the two parts unambiguously. A `unitRef` with no
 * colon is a project-level Unit, so `recording_id` is `null`.
 *
 * @param {import('./sync-types.js').UnitRef} unitRef
 * @returns {{ project_id: string, recording_id: string|null }}
 */
function parseUnitRef(unitRef) {
  const separator = unitRef.indexOf(':');
  if (separator === -1) {
    return { project_id: unitRef, recording_id: null };
  }
  return {
    project_id: unitRef.slice(0, separator),
    recording_id: unitRef.slice(separator + 1),
  };
}

/**
 * Record (or refresh) a Conflict for a Unit, keyed by `unitRef`.
 *
 * Stores recoverable, deep-cloned copies of BOTH the local and the incoming
 * versions, so a version is never lost while the Conflict awaits resolution.
 * Idempotent: because the record is keyed by `unitRef`, re-detecting
 * the same diverged Unit across repeated sync cycles keeps exactly ONE Conflict
 * record rather than accumulating duplicates; the recoverable copies are
 * refreshed to the latest detected versions while the original `detectedAt` is
 * preserved so the "first detected" timestamp stays stable.
 *
 * Mutual exclusion: a Unit is either in Conflict, in Review-and-Accept,
 * or NONE. Recording a Conflict therefore removes any Review item for the same
 * `unitRef`.
 *
 * Atomicity: both deep copies are built BEFORE the store is mutated,
 * so if either copy cannot be retained (the clone throws), the store is left
 * entirely unchanged — no version is dropped and no prior record is disturbed.
 *
 * @param {import('./sync-types.js').SyncState} state - the loaded SyncState;
 *   its `conflicts` and `reviews` maps are mutated in place
 * @param {import('./sync-types.js').UnitRef} unitRef - the idempotency key
 * @param {import('./sync-types.js').UnitCopy} localVer - the local version to retain
 * @param {import('./sync-types.js').UnitCopy} incomingVer - the incoming version to retain
 * @param {() => number} [now=Date.now] - clock source (injectable for tests);
 *   used only to stamp `detectedAt` on a freshly-recorded conflict
 * @returns {void}
 */
export function upsertConflict(state, unitRef, localVer, incomingVer, now = Date.now) {
  // Build both recoverable copies first; a failure here throws before any
  // mutation, leaving the store unchanged.
  const local = deepCopy(localVer);
  const incoming = deepCopy(incomingVer);

  const { project_id, recording_id } = parseUnitRef(unitRef);
  const existing = state.conflicts?.[unitRef];
  const detectedAt =
    existing && existing.kind === 'conflict' ? existing.detectedAt : new Date(now()).toISOString();

  // Mutual exclusion: a Unit cannot be in Review and Conflict at once.
  if (state.reviews) delete state.reviews[unitRef];

  if (!state.conflicts) state.conflicts = {};
  state.conflicts[unitRef] = {
    kind: 'conflict',
    unitRef,
    project_id,
    recording_id,
    local,
    incoming,
    detectedAt,
  };
}

/**
 * Record (or refresh) a Review-and-Accept item for a Unit, keyed by `unitRef`.
 *
 * Stores a recoverable, deep-cloned copy of ONLY the incoming version (from the
 * retained Sync_Snapshot); local data is left completely untouched, because a
 * Review item defers an incoming change without ever applying it automatically.
 * Idempotent: keyed by `unitRef`, re-detecting the same
 * changed-incoming Unit keeps exactly ONE Review record; the incoming
 * copy is refreshed to the latest detected version, the original `detectedAt` is
 * preserved, and the item is recorded as `PENDING` (the detection path always
 * produces a pending deferral — the APPLIED transition is owned by the resolution
 * workflow).
 *
 * Mutual exclusion: recording a Review item removes any Conflict for the
 * same `unitRef`, so a Unit is either in Review-and-Accept, in Conflict, or NONE.
 *
 * Atomicity: the recoverable copy is built BEFORE the store is mutated, so a
 * clone failure leaves the store unchanged.
 *
 * @param {import('./sync-types.js').SyncState} state - the loaded SyncState;
 *   its `reviews` and `conflicts` maps are mutated in place
 * @param {import('./sync-types.js').UnitRef} unitRef - the idempotency key
 * @param {import('./sync-types.js').UnitCopy} incomingVer - the incoming version to retain
 * @param {() => number} [now=Date.now] - clock source (injectable for tests);
 *   used only to stamp `detectedAt` on a freshly-recorded review
 * @returns {void}
 */
export function upsertReview(state, unitRef, incomingVer, now = Date.now) {
  // Build the recoverable copy first; a failure here throws before any mutation.
  const incoming = deepCopy(incomingVer);

  const { project_id, recording_id } = parseUnitRef(unitRef);
  const existing = state.reviews?.[unitRef];
  const detectedAt =
    existing && existing.kind === 'review' ? existing.detectedAt : new Date(now()).toISOString();

  // Mutual exclusion: a Unit cannot be in Review and Conflict at once.
  if (state.conflicts) delete state.conflicts[unitRef];

  if (!state.reviews) state.reviews = {};
  state.reviews[unitRef] = {
    kind: 'review',
    unitRef,
    project_id,
    recording_id,
    incoming,
    status: 'PENDING',
    detectedAt,
  };
}

/**
 * Clear any deferred item (Review-and-Accept or Conflict) for a Unit, returning
 * that Unit FULLY to the NONE state.
 *
 * Called when resolution of a Unit completes. Because `reviews` and
 * `conflicts` are mutually exclusive, at most one map holds a record for the
 * `unitRef`; clearing both is safe and guarantees the Unit is left in NONE so a
 * later sync cycle processes it normally rather than as a duplicate.
 *
 * It ALSO clears any recorded dismissed-incoming marker for the Unit.
 * Resolving a Unit must leave it clean: a stale dismissal would otherwise keep
 * suppressing a later, identical incoming version, so a Unit that has been
 * resolved would never re-offer that version even though the user never declined
 * it in the resolved state. Clearing the marker here makes "complete resolution"
 * return the Unit to a true NONE — its deferred item gone AND its dismissal gone
 * — so a later identical incoming version is classified afresh rather than
 * silently swallowed by a leftover dismissal.
 *
 * @param {import('./sync-types.js').SyncState} state - the loaded SyncState;
 *   its `reviews`, `conflicts`, and `dismissedIncoming` maps are mutated in place
 * @param {import('./sync-types.js').UnitRef} unitRef
 * @returns {void}
 */
export function clearItem(state, unitRef) {
  if (state.reviews) delete state.reviews[unitRef];
  if (state.conflicts) delete state.conflicts[unitRef];
  if (state.dismissedIncoming) delete state.dismissedIncoming[unitRef];
}

/**
 * Read the active deferred item for a Unit, or `null` when the Unit is in the
 * NONE state (no active Review or Conflict).
 *
 * Returning `null` for a NONE Unit is what lets the orchestrator process that
 * Unit normally instead of treating it as a duplicate of a prior record.
 * Conflicts are checked first, but the two maps are mutually exclusive, so a Unit
 * resolves to at most one item.
 *
 * @param {import('./sync-types.js').SyncState} state - the loaded SyncState
 * @param {import('./sync-types.js').UnitRef} unitRef
 * @returns {import('./sync-types.js').ConflictItem | import('./sync-types.js').ReviewItem | null}
 */
export function getItem(state, unitRef) {
  if (!state) return null;
  const conflict = state.conflicts?.[unitRef];
  if (conflict) return conflict;
  const review = state.reviews?.[unitRef];
  if (review) return review;
  return null;
}

// ─── Decline-dismissal of a declined incoming version ───────────

/**
 * Remember that a specific incoming version was declined for a Unit, keyed by
 * `unitRef`, so a later cycle that pulls the SAME incoming version does not
 * re-offer it as a fresh Review-and-Accept item.
 *
 * Only the exact dismissed `digest` is retained per Unit: recording a new digest
 * overwrites any prior one, so the dismissal tracks the latest declined version
 * and a later, DIFFERENT incoming version is no longer suppressed and is
 * classified afresh (enforced together with {@link isDismissedIncoming}).
 * Declining keeps local data untouched and never pushes — it is purely a "do not
 * re-offer this version" marker.
 *
 * @param {import('./sync-types.js').SyncState} state - the loaded SyncState;
 *   its `dismissedIncoming` map is mutated in place
 * @param {import('./sync-types.js').UnitRef} unitRef
 * @param {string} digest - canonical content digest of the declined incoming version
 * @returns {void}
 */
export function recordDismissedIncoming(state, unitRef, digest) {
  if (!state.dismissedIncoming) state.dismissedIncoming = {};
  state.dismissedIncoming[unitRef] = digest;
}

/**
 * Report whether the given incoming `digest` is the one currently dismissed for
 * a Unit. Returns `true` only when an exact-digest match is recorded, so a
 * declined version stays suppressed while ANY different incoming version (a
 * different digest, or no recorded dismissal) is treated as not-dismissed and
 * left for the detector to classify afresh.
 *
 * @param {import('./sync-types.js').SyncState} state - the loaded SyncState
 * @param {import('./sync-types.js').UnitRef} unitRef
 * @param {string} digest - canonical content digest of the incoming version to test
 * @returns {boolean}
 */
export function isDismissedIncoming(state, unitRef, digest) {
  if (!state || !state.dismissedIncoming) return false;
  return state.dismissedIncoming[unitRef] === digest;
}

// ─── Client-local reconciliation-policy + Auto-Sync settings ───────

/**
 * Read the client-local {@link import('./sync-types.js').ReconciliationSettings},
 * normalized into the full shape. A legacy state (or one
 * built without a `settings` field) yields the documented empty defaults rather
 * than `undefined`, so callers always receive a complete, well-formed settings
 * object. The returned object is an independent copy;
 * mutating it does not change the store — use {@link setSettings} to persist a
 * change.
 *
 * @param {import('./sync-types.js').SyncState} state - the loaded SyncState
 * @returns {import('./sync-types.js').ReconciliationSettings}
 */
export function getSettings(state) {
  return normalizeSettings(state ? state.settings : undefined);
}

/**
 * Update the client-local settings by merging `partial` over the current
 * settings and writing the normalized result back onto the state. Only the keys
 * present in `partial` change; the rest are preserved from the current settings.
 * The merged result is normalized so the stored settings stay well-formed
 * (unrecognized keys are dropped and any field whose value is the wrong type
 * falls back to its default), keeping these values strictly client-local and
 * never transmitted to the Sync_Server.
 *
 * @param {import('./sync-types.js').SyncState} state - the loaded SyncState;
 *   its `settings` field is replaced in place
 * @param {Partial<import('./sync-types.js').ReconciliationSettings>} partial -
 *   the setting values to change
 * @returns {void}
 */
export function setSettings(state, partial) {
  const current = getSettings(state);
  const merged = isPlainObject(partial) ? { ...current, ...partial } : current;
  state.settings = normalizeSettings(merged);
}
