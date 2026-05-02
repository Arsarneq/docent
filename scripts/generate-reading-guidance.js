/**
 * generate-reading-guidance.js — Generates reading-guidance.md from session.schema.json
 *
 * Produces a short preamble explaining what the payload is, followed by the
 * JSON Schema contract verbatim. Any LLM can interpret JSON Schema directly —
 * no need to render it into a custom format.
 *
 * Usage:
 *   node scripts/generate-reading-guidance.js
 *
 * Output:
 *   packages/shared/assets/reading-guidance.md
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SCHEMA_PATH = join(ROOT, 'packages', 'shared', 'session.schema.json');
const OUTPUT_PATH = join(ROOT, 'packages', 'shared', 'assets', 'reading-guidance.md');

const schema = readFileSync(SCHEMA_PATH, 'utf8').replace(/^\uFEFF/, '');

const preamble = `# Docent — Reading Guidance

This document describes the structure and meaning of a Docent dispatch payload.

---

## What you are receiving

A project recorded in a real browser, with narration for each step.
The narration for each step was provided in natural language and then the actions were performed.
The payload contains one or more recordings, each with an ordered list of steps.
Each step pairs a natural language narration with the exact browser actions recorded.

---

## Notes

- Passwords are always captured as \`"••••••••"\`.
- \`tab_id\` values are Chrome's internal tab identifiers for the recording session — they are not persistent across browser restarts.

---

## Payload structure

\`\`\`json
${schema.trim()}
\`\`\`
`;

mkdirSync(join(ROOT, 'packages', 'shared', 'assets'), { recursive: true });
writeFileSync(OUTPUT_PATH, preamble, 'utf8');
console.log('✓ session.schema.json → packages/shared/assets/reading-guidance.md');
