/**
 * stub-schema.js — Minimal schema stub for unit tests that exercise
 * buildPayload / buildExport projection logic but don't care about the real
 * platform schema.
 *
 * buildPayload and buildExport derive the required `docent_format` stamp from
 * the schema's pinned consts (see lib/format-stamp.js), so any schema handed to
 * them must carry those consts. This stub provides just that — nothing more —
 * keeping `payload.schema` tiny so size/timing-sensitive tests stay meaningful.
 *
 * Tests asserting real schema content should use composePlatform() instead.
 */

export const STUB_SCHEMA = {
  $defs: {
    docent_format: {
      properties: {
        platform: { const: 'stub' },
        schema_version: { const: '0.0.0-stub' },
      },
    },
  },
};
