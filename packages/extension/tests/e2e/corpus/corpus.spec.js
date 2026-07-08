/**
 * corpus.spec.js — table-driven runner for the extension leg of the
 * scripted-truth capture corpus (corpus/ at the repo root; doctrine in
 * docs/scripted-truth-corpus.md).
 *
 * One test per active extension session in corpus/manifest.json. Each test:
 *   1. launches a fresh persistent context at the FIXED corpus viewport,
 *   2. navigates to the session's start page on the fixed-port corpus server,
 *   3. flips recording on (SW injects the recorder + seeds frame trust) and
 *      waits for FRAME_READY newer than the navigation (the corpus's stable
 *      URLs make the plain per-URL wait stale on reload/revisit),
 *   4. runs the session's committed input driver (real Playwright input only —
 *      the recorder drops synthetic events),
 *   5. assembles the export envelope through the REAL shared production path
 *      (createProject/createRecording/createStep/addStepRecord → buildExport;
 *      buildExport is the panels' own single envelope builder — only the panel
 *      UI wiring is bypassed, which stays covered by the existing e2e suite),
 *   6. writes corpus/out/extension/<id>.docent.json, and
 *   7. asserts the comparator's findings for the session equal its committed
 *      known-diffs baseline entries — the produce-stage oracle. A timing flake
 *      fails the attempt and is retried; a persistent mismatch stays red. The
 *      CI `corpus:check` step re-verifies the same thing without retries.
 *
 * While a session's truth file does not exist yet (authoring), the oracle step
 * is skipped with a loud warning; the corpus hygiene test in packages/shared
 * fails if an active manifest session lacks a truth file, so nothing can ship
 * half-authored.
 */

import { test as base, expect, chromium } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'url';
import {
  installReadyProbe,
  waitForFrameReady,
  waitForFrameReadySince,
} from '../helpers/frame-ready.js';
import { getPendingActions, waitForActionsToSettle } from '../helpers/extension-fixture.js';
import { createVectorCollector, buildVectors } from '../helpers/vector-snapshot.js';
import {
  createProject,
  createRecording,
  createStep,
  addStepRecord,
} from '../../../shared/lib/session.js';
import { buildExport } from '../../../shared/lib/export-project.js';
import { composePlatform } from '../../../../../scripts/build-schemas.js';
import {
  discoverSessions,
  compareSession,
  serializeFinding,
} from '../../../../../scripts/corpus-compare.js';
import { CORPUS_ORIGIN } from '../../../../../corpus/serve.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../../..');
const extensionPath = path.resolve(__dirname, '../../..');
const manifestPath = path.join(repoRoot, 'corpus', 'manifest.json');
const outDir = path.join(repoRoot, 'corpus', 'out');
const baselinePath = path.join(repoRoot, 'corpus', 'known-diffs.extension.json');

const sessions = discoverSessions(manifestPath, 'extension');
const schema = composePlatform('extension');

// Conformance-vector production is a superset mode of the corpus run, gated so
// truth production is byte-for-byte unaffected: only when CORPUS_VECTORS is set
// does the driver receive a live snapshot collector and the run emit + check
// vectors. Committed vectors live under corpus/sessions/<id>/vectors/; produced
// ones under the gitignored corpus/out/extension-vectors/.
const vectorsMode = !!process.env.CORPUS_VECTORS;
const vectorsOutDir = path.join(outDir, 'extension-vectors');

const test = base.extend({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      headless: false, // extensions don't load headless
      viewport: { width: 1280, height: 720 }, // the corpus's fixed geometry
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-first-run',
        '--disable-default-apps',
        '--disable-popup-blocking',
      ],
    });
    await use(context);
    await context.close();
  },
  serviceWorker: async ({ context }, use) => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await installReadyProbe(sw);
    await use(sw);
  },
});

/** Navigate and wait until the recorder in the new document is live. */
async function gotoReady(page, serviceWorker, url) {
  const before = Date.now();
  await page.goto(url);
  await waitForFrameReadySince(serviceWorker, url, before);
}

for (const session of sessions) {
  const testFn = session.status === 'active' ? test : test.skip;
  testFn(session.id, async ({ context, serviceWorker }) => {
    const page = context.pages()[0] ?? (await context.newPage());
    const startUrl = `${CORPUS_ORIGIN}/${session.id}/${session.page}`;

    // Land on the start page first, then flip recording: the SW's
    // storage.onChanged hook injects the recorder into open tabs and seeds the
    // frame-trust registry; readiness is then observed via FRAME_READY.
    const beforeInject = Date.now();
    await page.goto(startUrl);
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ recording: true, pendingActions: [], pendingCount: 0 });
    });
    await waitForFrameReadySince(serviceWorker, startUrl, beforeInject);

    const driver = await import(
      `file://${path.join(repoRoot, 'corpus', 'sessions', session.id, session.script)}`
    );
    // In vectors mode the driver marks its non-mutating vector-carrying actions;
    // in truth mode `vector` is null and every `vector?.mark(...)` is a no-op.
    const collector = vectorsMode ? createVectorCollector(page) : null;
    await driver.default({
      page,
      context,
      serviceWorker,
      origin: CORPUS_ORIGIN,
      sessionUrl: (file) => `${CORPUS_ORIGIN}/${session.id}/${file}`,
      gotoReady: (p, url) => gotoReady(p, serviceWorker, url),
      frameReady: (url) => waitForFrameReady(serviceWorker, url),
      frameReadySince: (url, since) => waitForFrameReadySince(serviceWorker, url, since),
      vector: collector,
    });

    await waitForActionsToSettle(serviceWorker, page);
    const actions = await getPendingActions(serviceWorker);
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ recording: false });
    });

    if (vectorsMode && collector && collector.marks.length > 0) {
      const produced = buildVectors(session.id, collector.marks, actions);
      const producedDir = path.join(vectorsOutDir, session.id);
      fs.mkdirSync(producedDir, { recursive: true });
      const committedDir = path.join(repoRoot, 'corpus', 'sessions', session.id, 'vectors');
      for (const vector of produced) {
        const key = vector.vector_id.slice(session.id.length + 1);
        fs.writeFileSync(
          path.join(producedDir, `${key}.vector.json`),
          JSON.stringify(vector, null, 2) + '\n',
        );
        const committedPath = path.join(committedDir, `${key}.vector.json`);
        if (fs.existsSync(committedPath)) {
          const committed = JSON.parse(fs.readFileSync(committedPath, 'utf8'));
          expect(
            isDeepStrictEqual(committed, vector),
            `produced vector ${key} does not match its committed file`,
          ).toBe(true);
        } else {
          console.warn(`corpus vectors: no committed ${session.id}/${key} yet — produced only`);
        }
      }
    }

    // Assemble through the real shared production path; fixture-style naming
    // so a bootstrap-copied truth needs only review, not renaming.
    const project = createProject(`corpus ${session.id}`);
    const recording = createRecording(project, session.id);
    addStepRecord(recording, createStep({ narration: session.id, step_number: 1, actions }));
    const envelope = buildExport(project, schema);

    fs.mkdirSync(path.join(outDir, 'extension'), { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'extension', `${session.id}.docent.json`),
      JSON.stringify(envelope, null, 2),
    );

    // Produce-stage oracle: the comparator itself, against the committed
    // known-diffs baseline. Retries absorb timing flakes; truth mismatches
    // beyond the baseline stay red.
    const truthPath = path.join(repoRoot, 'corpus', 'sessions', session.id, session.truth ?? 'truth.docent.json'); // prettier-ignore
    if (!fs.existsSync(truthPath)) {
      console.warn(`corpus: no truth for ${session.id} yet — produced only (authoring mode)`);
      return;
    }
    const { findings } = compareSession(
      { ...session, truthPath, overridesPath: session.overridesPath },
      outDir,
    );
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    expect(findings.map(serializeFinding).sort()).toEqual(baseline[session.id] ?? []);
  });
}
