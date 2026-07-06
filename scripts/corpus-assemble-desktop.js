/**
 * corpus-assemble-desktop.js — assemble desktop corpus event dumps into
 * `.docent.json` envelopes through the REAL frontend pipeline.
 *
 * The desktop corpus's producer is a Rust integration test
 * (packages/desktop/src-tauri/tests/corpus_capture.rs) that drives real OS
 * input against controlled windows and serializes the captured ActionEvents —
 * with the same serde shape Tauri's emit uses — to
 * corpus/out/desktop-windows-events/<session>.events.json as
 * `{ session, max_sequence_number, events }`. This script replays each dump
 * through the real adapter (packages/desktop/src/adapter-tauri.js: the reorder
 * buffer and the redaction chokepoint via _testOnly.insertOrdered, then the
 * real commitWithCompleteness), assembles the envelope through the same shared
 * session model and buildExport the desktop panel itself uses, and writes
 * corpus/out/desktop-windows/<session>.docent.json for scripts/corpus-compare.js.
 *
 * Coverage honesty (also in corpus/README.md): this replays event ARRIVAL
 * ORDER through the real JS pipeline; it does not exercise the live Tauri
 * emit→listen bridge, the panel commit UI, persistence, or arrival timing.
 *
 * Usage: node scripts/corpus-assemble-desktop.js [eventsDir]
 *   eventsDir defaults to corpus/out/desktop-windows-events (repo-relative).
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * Install the minimal Tauri surface adapter-tauri.js dereferences at module
 * level and during commit, BEFORE the dynamic import (the
 * adapter-tauri.test.js technique). `get_max_sequence_number` answers from the
 * dump so commitWithCompleteness's completeness wait resolves against the
 * producer's own counter.
 */
function installTauriMock() {
  const state = { maxSeq: 0 };
  globalThis.window = {
    __TAURI__: {
      core: {
        invoke: async (cmd) => {
          if (cmd === 'get_max_sequence_number') return state.maxSeq;
          return undefined;
        },
      },
      event: { listen: async () => () => {} },
    },
  };
  return state;
}

async function main(argv) {
  const eventsDir = resolve(REPO_ROOT, argv[2] ?? 'corpus/out/desktop-windows-events');
  const outDir = resolve(REPO_ROOT, 'corpus/out/desktop-windows');
  if (!existsSync(eventsDir)) {
    console.error(`no events directory: ${eventsDir} — run the Rust corpus producer first`);
    return 2;
  }

  const mockState = installTauriMock();
  // Real production modules, imported AFTER the mock exists. The adapter is
  // the desktop package's own; session/export come through its synced shared
  // copy — the exact modules the desktop panel runs.
  const adapterMod = await import('../packages/desktop/src/adapter-tauri.js');
  const { default: adapter, commitWithCompleteness, _testOnly } = adapterMod;
  const { createProject, createRecording, createStep, addStepRecord } =
    await import('../packages/desktop/shared/lib/session.js');
  const { buildExport } = await import('../packages/desktop/shared/lib/export-project.js');
  const { composePlatform } = await import('./build-schemas.js');
  const schema = composePlatform('desktop-windows');

  const dumps = readdirSync(eventsDir).filter((f) => f.endsWith('.events.json'));
  if (dumps.length === 0) {
    console.error(`no *.events.json dumps in ${eventsDir}`);
    return 2;
  }
  mkdirSync(outDir, { recursive: true });

  for (const file of dumps.sort()) {
    const dump = JSON.parse(readFileSync(join(eventsDir, file), 'utf8'));
    const { session, max_sequence_number: maxSeq, events } = dump;
    if (!session || !Array.isArray(events)) {
      console.error(`${file}: malformed dump (need session + events[])`);
      return 2;
    }

    mockState.maxSeq = maxSeq ?? 0;
    adapter.clearPendingActions();
    _testOnly.resetReorderState();
    for (const event of events) {
      _testOnly.insertOrdered(structuredClone(event)); // real reorder + redaction
    }
    await commitWithCompleteness(); // real completeness wait + _seq strip
    const actions = adapter.getPendingActions();

    const project = createProject(`corpus ${session}`);
    const recording = createRecording(project, session);
    addStepRecord(recording, createStep({ narration: session, step_number: 1, actions }));
    const envelope = buildExport(project, schema);

    writeFileSync(join(outDir, `${session}.docent.json`), JSON.stringify(envelope, null, 2));
    console.log(`${session}: ${events.length} event(s) → ${actions.length} action(s)`);
  }
  return 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(2);
    },
  );
}
