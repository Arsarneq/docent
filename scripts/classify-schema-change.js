/**
 * classify-schema-change.js — Mechanically classifies the change between two
 * composed platform schemas as none / patch / minor / major, per the rules in
 * docs/technical/session-format.md:
 *
 *   patch — documentation-only changes (description clarifications), and
 *           introduction of a known x- annotation
 *   minor — new OPTIONAL fields, new action types, new enum values, pure
 *           type widenings, additionalProperties relaxations
 *   major — new REQUIRED fields, removed fields, renamed fields (= remove+add),
 *           changed semantics, changed/narrowed types, removed enum values,
 *           introduced/removed/changed value constraints, required-status
 *           changes
 *
 * Design bias: a version classifier must NEVER under-report. Shipping a breaking
 * change as a "minor" silently breaks consumers; an over-eager "major" is merely
 * annoying. So anything this code cannot confidently classify as patch/minor is
 * escalated to MAJOR. Every decision is recorded in `reasons` for transparency.
 *
 * Identity/meta keys ($schema, $id, title, version) are ignored — they are not
 * part of the validation contract and `version` is the very thing we compute.
 *
 * Pure and dependency-free so it is trivially unit-testable.
 */

export const LEVELS = ['none', 'patch', 'minor', 'major'];
const RANK = { none: 0, patch: 1, minor: 2, major: 3 };

// Keys that carry identity/metadata, not contract. Differences here never drive
// a version bump on their own (a description change is handled explicitly as
// patch; the rest are ignored).
const IGNORED_KEYS = new Set(['$schema', '$id', 'title', 'version']);

// `x-`-prefixed annotations whose INTRODUCTION is known to document behaviour
// that already ships, verified outside this classifier (for `x-value-derived`,
// the per-platform drift guards pin the annotation against the real redaction
// code). Only these may classify as patch when added; an annotation kind this
// tooling has never judged escalates per the charter.
const PATCH_ON_ADD_ANNOTATIONS = new Set(['x-value-derived']);

function higher(a, b) {
  return RANK[a] >= RANK[b] ? a : b;
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Classify the change from `oldSchema` to `newSchema`.
 *
 * @param {object} oldSchema - the previously released composed schema
 * @param {object} newSchema - the candidate composed schema
 * @returns {{ level: 'none'|'patch'|'minor'|'major', reasons: Array<{level: string, message: string}> }}
 */
export function classifyChange(oldSchema, newSchema) {
  const reasons = [];
  const add = (level, message) => reasons.push({ level, message });

  walk(oldSchema, newSchema, '(root)', add);

  let level = 'none';
  for (const r of reasons) level = higher(level, r.level);
  return { level, reasons };
}

/**
 * Recursively compare two schema nodes, recording change reasons via `add`.
 */
function walk(oldNode, newNode, path, add) {
  if (deepEqual(oldNode, newNode)) return;

  // Type mismatch between the two nodes (e.g. object replaced by scalar) — a
  // structural change we cannot reason about safely.
  if (
    isObject(oldNode) !== isObject(newNode) ||
    Array.isArray(oldNode) !== Array.isArray(newNode)
  ) {
    add('major', `${path}: shape changed`);
    return;
  }

  if (Array.isArray(oldNode)) {
    // Generic arrays are compared by the callers that know their semantics
    // (enum, required, oneOf). A bare array here (rare) is treated as a member
    // set: additions minor, removals major.
    diffMemberSet(oldNode, newNode, path, add);
    return;
  }

  if (!isObject(oldNode)) {
    // Two differing scalars at the same path — a changed constant/keyword value.
    add(
      'major',
      `${path}: value changed (${JSON.stringify(oldNode)} → ${JSON.stringify(newNode)})`,
    );
    return;
  }

  // Both are objects. Walk the union of keys with schema-aware handling.
  const keys = new Set([...Object.keys(oldNode), ...Object.keys(newNode)]);

  for (const key of keys) {
    if (IGNORED_KEYS.has(key)) continue;

    const inOld = key in oldNode;
    const inNew = key in newNode;
    const childPath = `${path}/${key}`;
    const ov = oldNode[key];
    const nv = newNode[key];

    if (inOld && inNew && deepEqual(ov, nv)) continue;

    // `x-`-prefixed keys are contract ANNOTATIONS (metadata the tooling reads,
    // e.g. `x-value-derived`), never validation keywords — Ajv ignores them.
    // Introducing a KNOWN annotation documents behaviour that already ships →
    // patch. Everything else — changing one, removing one, or introducing a
    // kind not in the allowlist — rewrites what the contract SAYS (for
    // `x-value-derived`: which emitted values are masked in place) in ways
    // this classifier cannot judge, so per the never-under-report charter it
    // escalates to major. Checked before any recursion so object-valued
    // annotations cannot re-enter the walk.
    if (key.startsWith('x-')) {
      if (!inOld) {
        if (PATCH_ON_ADD_ANNOTATIONS.has(key)) add('patch', `${childPath}: annotation added`);
        else add('major', `${childPath}: unknown annotation added`);
      } else if (!inNew) {
        add('major', `${childPath}: annotation removed`);
      } else {
        add('major', `${childPath}: annotation changed`);
      }
      continue;
    }

    switch (key) {
      case 'description': {
        // Wording-only change anywhere → patch (per docs: description clarifications).
        if (!inOld || !inNew || ov !== nv) add('patch', `${childPath}: description changed`);
        break;
      }
      case 'required': {
        diffRequired(ov || [], nv || [], childPath, add);
        break;
      }
      case 'enum': {
        // A newly-introduced enum keyword constrains a previously-open value —
        // a tightening, not a set of "added" values; diffing against the empty
        // set would misread it as minor.
        if (!inOld) {
          add('major', `${childPath}: enum introduced on a previously unconstrained value`);
          break;
        }
        diffEnum(ov || [], nv || [], childPath, add);
        break;
      }
      case 'properties': {
        // Introduction rule again: a properties map appearing on an existing
        // node starts constraining per-key values that were previously open.
        if (!inOld) {
          add('major', `${childPath}: properties introduced on a previously open object`);
          break;
        }
        diffProperties(ov || {}, nv || {}, oldNode.required || [], newNode.required || [], childPath, add); // prettier-ignore
        break;
      }
      case '$defs': {
        diffDefs(ov || {}, nv || {}, childPath, add);
        break;
      }
      case 'oneOf':
      case 'anyOf':
      case 'allOf': {
        // Same introduction rule as enum: a union/conjunction keyword appearing
        // on an existing node adds a validation requirement that was not there.
        if (!inOld) {
          add('major', `${childPath}: ${key} constraint introduced`);
          break;
        }
        diffMemberSet(ov || [], nv || [], childPath, add);
        break;
      }
      case 'type': {
        diffType(ov, nv, childPath, add);
        break;
      }
      case 'const': {
        // The schema_version stamp const tracks `version` — the value we are
        // computing — so a change to it is not a contract change on its own.
        // (docent_format being added/removed/reshaped is still caught by the
        // surrounding property/required diffs.) Every other const IS contract.
        if (childPath.endsWith('/docent_format/properties/schema_version/const')) break;
        add('major', `${childPath}: const changed`);
        break;
      }
      case 'additionalProperties': {
        // false → true loosens (minor); true → false tightens (major).
        if (ov === false && nv === true) add('minor', `${childPath}: additionalProperties relaxed`);
        else add('major', `${childPath}: additionalProperties tightened/changed`);
        break;
      }
      case '$ref': {
        add('major', `${childPath}: $ref retargeted`);
        break;
      }
      default: {
        // Any other key: recurse into nested schema objects; otherwise treat a
        // changed/added/removed validation keyword conservatively as major
        // (covers pattern, minimum, minLength, format, etc. — all tightenings
        // in practice).
        if (isObject(ov) && isObject(nv)) {
          walk(ov, nv, childPath, add);
        } else if (!inOld) {
          add('major', `${childPath}: constraint added`);
        } else if (!inNew) {
          add('major', `${childPath}: constraint removed`);
        } else {
          add('major', `${childPath}: constraint changed`);
        }
      }
    }
  }
}

/**
 * properties diff: an added property is minor if optional, major if it appears
 * in the new `required` list; a removed property is always major; a property in
 * both is recursed.
 */
function diffProperties(oldProps, newProps, oldRequired, newRequired, path, add) {
  const newReq = new Set(newRequired);
  const keys = new Set([...Object.keys(oldProps), ...Object.keys(newProps)]);

  for (const key of keys) {
    const childPath = `${path}/${key}`;
    const inOld = key in oldProps;
    const inNew = key in newProps;

    if (inNew && !inOld) {
      if (newReq.has(key)) add('major', `${childPath}: new REQUIRED property`);
      else add('minor', `${childPath}: new optional property`);
    } else if (inOld && !inNew) {
      add('major', `${childPath}: property removed`);
    } else if (!deepEqual(oldProps[key], newProps[key])) {
      walk(oldProps[key], newProps[key], childPath, add);
    }
  }
}

/**
 * required diff: a newly-required field is major; a field that became optional
 * is also major (relaxing a guarantee changes consumer-visible semantics).
 */
function diffRequired(oldReq, newReq, path, add) {
  const o = new Set(oldReq);
  const n = new Set(newReq);
  for (const f of n) if (!o.has(f)) add('major', `${path}: "${f}" is now required`);
  for (const f of o) if (!n.has(f)) add('major', `${path}: "${f}" no longer required`);
}

/**
 * enum diff: added values are minor (more accepted), removed values are major
 * (previously-valid data now rejected).
 */
function diffEnum(oldEnum, newEnum, path, add) {
  const o = new Set(oldEnum.map((v) => JSON.stringify(v)));
  const n = new Set(newEnum.map((v) => JSON.stringify(v)));
  for (const v of n) if (!o.has(v)) add('minor', `${path}: enum value ${v} added`);
  for (const v of o) if (!n.has(v)) add('major', `${path}: enum value ${v} removed`);
}

/**
 * type diff: a pure widening of the accepted type set (e.g. "string" →
 * ["string","null"]) is minor; anything else (narrowing or a changed type) is
 * major.
 */
function diffType(oldType, newType, path, add) {
  const o = new Set(Array.isArray(oldType) ? oldType : [oldType]);
  const n = new Set(Array.isArray(newType) ? newType : [newType]);
  const oldSubsetOfNew = [...o].every((t) => n.has(t));
  const newSubsetOfOld = [...n].every((t) => o.has(t));

  if (oldSubsetOfNew && !newSubsetOfOld) add('minor', `${path}: type widened`);
  else add('major', `${path}: type changed`);
}

/**
 * $defs diff: $defs is a DEFINITION MAP, not a set of validation keywords. A new
 * definition is additive on its own (minor) — its actual contract impact is felt
 * where it is $ref'd (e.g. an `action` oneOf branch, classified there). A removed
 * definition that is still referenced would dangle, so removal is major. A
 * changed definition is recursed with full schema-aware rules.
 */
function diffDefs(oldDefs, newDefs, path, add) {
  const keys = new Set([...Object.keys(oldDefs), ...Object.keys(newDefs)]);
  for (const key of keys) {
    const childPath = `${path}/${key}`;
    const inOld = key in oldDefs;
    const inNew = key in newDefs;
    if (inNew && !inOld) add('minor', `${childPath}: definition added`);
    else if (inOld && !inNew) add('major', `${childPath}: definition removed`);
    else if (!deepEqual(oldDefs[key], newDefs[key])) {
      walk(oldDefs[key], newDefs[key], childPath, add);
    }
  }
}

/**
 * Member-set diff for unions (oneOf/anyOf) and bare arrays: a member present in
 * new but not old is an addition (minor); a member present in old but not new is
 * a removal (major). Members are compared by structural equality.
 */
function diffMemberSet(oldArr, newArr, path, add) {
  const o = oldArr.map((m) => JSON.stringify(m));
  const n = newArr.map((m) => JSON.stringify(m));
  const oSet = new Set(o);
  const nSet = new Set(n);
  for (const m of nSet) if (!oSet.has(m)) add('minor', `${path}: branch/member added`);
  for (const m of oSet) if (!nSet.has(m)) add('major', `${path}: branch/member removed`);
}
