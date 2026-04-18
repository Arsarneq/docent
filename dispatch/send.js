/**
 * Docent — Dispatch Script
 *
 * Reads a .docent.json project export, extracts the active steps,
 * and sends them along with a reading guide to a configured HTTP endpoint.
 *
 * Usage:
 *   node dispatch/send.js <session-file> [--endpoint <url>] [--guidance <file>] [--recording <name>]
 *
 * Environment variables:
 *   DOCENT_ENDPOINT_URL      — endpoint URL (overridden by --endpoint flag)
 *   DOCENT_ENDPOINT_API_KEY  — API key for the endpoint (optional)
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import fs   from 'fs';
import path from 'path';
import { parseArgs } from 'util';

// ─── Args ─────────────────────────────────────────────────────────────────────

const { values, positionals } = parseArgs({
  args:           process.argv.slice(2),
  allowPositionals: true,
  options: {
    endpoint:   { type: 'string' },
    guidance:   { type: 'string' },
    recording:  { type: 'string' },   // optional: send only one recording by name
    dry_run:    { type: 'boolean', default: false },
  },
});

const sessionFile  = positionals[0];
const endpointUrl  = values.endpoint  ?? process.env.DOCENT_ENDPOINT_URL;
const guidanceFile = values.guidance ?? path.join(import.meta.dirname, 'reading-guidance.md');
const dryRun       = values.dry_run;
const filterName   = values['recording'];

if (!sessionFile) {
  console.error('Usage: node dispatch/send.js <session-file> [--endpoint <url>] [--recording <name>]');
  process.exit(1);
}

// ─── Load export ──────────────────────────────────────────────────────────────

const exportData = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
const { project, recordings } = exportData;

if (!project || !Array.isArray(recordings)) {
  console.error('Invalid .docent.json file — missing project or recordings.');
  process.exit(1);
}

// Filter to a specific recording if requested
let selectedRecordings = recordings;
if (filterName) {
  selectedRecordings = recordings.filter(r => r.name === filterName);
  if (!selectedRecordings.length) {
    console.error(`No recording named "${filterName}" found. Available: ${recordings.map(r => r.name).join(', ')}`);
    process.exit(1);
  }
}

// Validate that there are active steps to send
const totalSteps = selectedRecordings.reduce((n, r) => n + (r.activeSteps?.length ?? 0), 0);
if (totalSteps === 0) {
  console.error('No active steps found in the selected recordings. Nothing to dispatch.');
  process.exit(1);
}

// ─── Load reading guidance ────────────────────────────────────────────────────

let guidance = '';
if (fs.existsSync(guidanceFile)) {
  guidance = fs.readFileSync(guidanceFile, 'utf8');
} else {
  console.warn(`[Docent] No reading guidance found at ${guidanceFile}. Sending without it.`);
}

// ─── Build payload ────────────────────────────────────────────────────────────

const payload = {
  reading_guidance: guidance,
  project: {
    project_id: project.project_id,
    name:       project.name,
    created_at: project.created_at,
  },
  recordings: selectedRecordings.map(r => ({
    recording_id: r.recording_id,
    name:         r.name,
    created_at:   r.created_at,
    steps:        (r.activeSteps ?? []).map(step => ({
      logical_id:  step.logical_id,
      step_number: step.step_number,
      narration:   step.narration,
      actions:     step.actions,
    })),
  })),
};

// ─── Dry run ──────────────────────────────────────────────────────────────────

if (dryRun) {
  console.log('[Docent] Dry run — payload that would be sent:\n');
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

// ─── Send ─────────────────────────────────────────────────────────────────────

if (!endpointUrl) {
  console.error('[Docent] No endpoint URL configured. Set DOCENT_ENDPOINT_URL or use --endpoint <url>.');
  process.exit(1);
}

const headers = { 'Content-Type': 'application/json' };
if (process.env.DOCENT_ENDPOINT_API_KEY) {
  headers['Authorization'] = `Bearer ${process.env.DOCENT_ENDPOINT_API_KEY}`;
}

const recordingNames = selectedRecordings.map(r => r.name).join(', ');
console.log(`[Docent] Sending project "${project.name}" — ${selectedRecordings.length} recording(s) [${recordingNames}] (${totalSteps} steps total) to ${endpointUrl}`);

let response;
try {
  response = await fetch(endpointUrl, {
    method:  'POST',
    headers,
    body:    JSON.stringify(payload),
  });
} catch (err) {
  console.error(`[Docent] Network error: ${err.message}`);
  process.exit(1);
}

if (!response.ok) {
  const body = await response.text();
  console.error(`[Docent] Endpoint responded with ${response.status}:\n${body}`);
  process.exit(1);
}

let result;
try {
  result = await response.json();
} catch {
  console.error('[Docent] Endpoint returned non-JSON response.');
  process.exit(1);
}
console.log('[Docent] Endpoint response:');
console.log(JSON.stringify(result, null, 2));
