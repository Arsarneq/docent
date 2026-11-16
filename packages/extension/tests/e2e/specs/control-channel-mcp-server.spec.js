/**
 * Local control channel through the Reference MCP Server — end to end.
 *
 * Drives the side panel in a real browser from the Reference MCP Server
 * (`reference-implementations/mcp-server/`), run as a child process and spoken
 * to over its standard input and output as an MCP client speaks to it. Where
 * `control-channel.spec.js` plays the local process itself, frame by frame,
 * this spec runs the repository's own local process against the real panel:
 * the pairing from the displayed code, each command as a tool call with the
 * panel following it, the export written to a file with and without the
 * person's grant, the indicator's trace of it, a step recorded on a real page
 * and its export file taken back by the panel's Import, two panels with a
 * server each, a large project in one frame, a server that accepts another
 * extension, and pairing again after Turn off.
 */

import { test as base, expect, chromium } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';
import { fileURLToPath } from 'url';
import { freePort, startMcpServer } from '../helpers/mcp-stdio.js';
import { validatePayload } from '../../../../shared/lib/validate-import.js';
import validateExtension from '../../../../shared/generated/validate-extension.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, '../../..');

/** A value planted in a captured action, so a test can look for it. */
const CAPTURED = 'captured-value';

/**
 * How long a server waits in `pair`. The panel dials every 2 seconds, so a
 * pairing that works completes well inside it, and one that does not is
 * answered by the server while the test still has time to report it.
 */
const PAIR_TIMEOUT_MS = 10_000;

/** The text of the one button on the page a test records on. */
const SITE_BUTTON = 'Add to cart';

/** Put one captured action in the pending buffer, as the recorder would. */
async function captureOne(serviceWorker) {
  await serviceWorker.evaluate(async (value) => {
    await chrome.storage.local.set({
      pendingActions: [{ type: 'click', timestamp: 1, element: { text: 'Cart' }, value }],
      pendingCount: 1,
    });
  }, CAPTURED);
}

/** The panel's own Export button: click it and read the file it writes, as text. */
async function exportByButton(panelPage) {
  const [download] = await Promise.all([
    panelPage.waitForEvent('download'),
    panelPage.click('#btn-export-project'),
  ]);
  return fs.readFileSync(await download.path(), 'utf-8');
}

/** Open a panel page on the projects view. */
async function openPanel(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
  await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });
  return page;
}

const test = base.extend({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-first-run',
        '--disable-default-apps',
      ],
      acceptDownloads: true,
    });
    await use(context);
    await context.close();
  },

  serviceWorker: async ({ context }, use) => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(sw);
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(serviceWorker.url().match(/chrome-extension:\/\/([^/]+)/)?.[1]);
  },

  panelPage: async ({ context, extensionId }, use) => {
    const page = await openPanel(context, extensionId);
    await use(page);
    if (!page.isClosed()) await page.close();
  },

  /** A served page with one button, for a test that records on a real page. */
  site: async ({}, use) => {
    const web = http.createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<html><body><button id="add">${SITE_BUTTON}</button></body></html>`);
    });
    await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve));
    await use(`http://127.0.0.1:${web.address().port}/`);
    web.closeAllConnections();
    await new Promise((resolve) => web.close(resolve));
  },

  /** An empty folder of this test's own for export files. */
  exportDir: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docent-mcp-e2e-'));
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },

  /**
   * Start a Reference MCP Server for this browser's extension on a free port,
   * with this test's export folder unless `exportDir` is `null`. Every server
   * started is stopped when the test ends.
   */
  startServer: async ({ extensionId, exportDir }, use) => {
    const started = [];
    await use(async (options = {}) => {
      const port = await freePort();
      const dir = options.exportDir === undefined ? exportDir : options.exportDir;
      const server = await startMcpServer([
        '--port',
        String(port),
        '--extension-id',
        options.extensionId ?? extensionId,
        ...(dir === null ? [] : ['--export-dir', dir]),
        '--pair-timeout-ms',
        String(options.pairTimeoutMs ?? PAIR_TIMEOUT_MS),
      ]);
      started.push(server);
      return { ...server, port };
    });
    await Promise.all(started.map((server) => server.close()));
  },

  server: async ({ startServer }, use) => {
    await use(await startServer());
  },
});

/**
 * Turn the channel on from the panel and return the displayed pairing code;
 * `allowExport` ticks the export grant first.
 */
async function turnOn(panelPage, port, { allowExport = false } = {}) {
  await panelPage.click('#btn-control-channel');
  await panelPage.fill('#control-channel-port', String(port));
  if (allowExport) await panelPage.check('#control-channel-allow-export');
  await panelPage.click('#btn-control-channel-on');
  await expect(panelPage.locator('#control-channel-indicator')).toBeVisible();
  return panelPage.locator('#control-channel-code').innerText();
}

/** Turn the channel on and give the displayed code to the server's `pair`. */
async function pair(panelPage, server, options) {
  const code = await turnOn(panelPage, server.port, options);
  const paired = await server.callTool('pair', { code });
  expect(paired.structuredContent).toEqual({ ok: true });
  await expect(panelPage.locator('#control-channel-indicator-text')).toContainText(
    'A local program is connected',
  );
  return code;
}

/**
 * The server wrote the pairing code nowhere: neither as the panel displays
 * it, in groups, nor as the 16 characters it is read as.
 */
function expectCodeNotWritten(server, code) {
  for (const form of [code, code.replaceAll('-', '')]) {
    expect(server.stdout().includes(form)).toBe(false);
    expect(server.stderr().includes(form)).toBe(false);
  }
}

/** Call a tool and return the one object its result carries. */
async function call(server, name, args) {
  const result = await server.callTool(name, args);
  // The object is carried twice, and a failed call is marked exactly then.
  expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  expect(result.isError === true).toBe(result.structuredContent.ok === false);
  return result.structuredContent;
}

/** Create a project and a recording, and commit one step with a captured action. */
async function recordOneStep(server, serviceWorker, projectName, narration = 'Open it') {
  expect((await call(server, 'project_create', { name: projectName })).ok).toBe(true);
  expect((await call(server, 'recording_create', { name: 'Flow' })).ok).toBe(true);
  await captureOne(serviceWorker);
  await expect.poll(async () => (await call(server, 'status')).pending_actions).toBe(1);
  expect((await call(server, 'step_commit', { narration })).ok).toBe(true);
}

/** The files in an export folder. */
function filesIn(dir) {
  return fs.readdirSync(dir);
}

test.describe('Local control channel through the Reference MCP Server', () => {
  test('offers the tool list and pairs with the code the panel displays', async ({
    panelPage,
    server,
  }) => {
    expect((await server.listTools()).map((tool) => tool.name)).toEqual([
      'pair',
      'status',
      'project_create',
      'recording_create',
      'recording_pause',
      'recording_resume',
      'step_commit',
      'project_export',
    ]);

    // Nothing is paired yet: the command is answered without a panel.
    expect((await call(server, 'status')).code).toBe('not-paired');

    const code = await pair(panelPage, server);
    // The spent code is no longer shown.
    await expect(panelPage.locator('#control-channel-code')).toBeHidden();

    expect(await call(server, 'status')).toEqual({
      ok: true,
      project: null,
      recording: null,
      capturing: false,
      pending_actions: 0,
      steps: 0,
      export_allowed: false,
      notices: [],
    });

    // One panel at a time: a second pairing is refused by the server itself.
    expect((await call(server, 'pair', { code })).code).toBe('already-paired');
    // The code crossed standard input only; the server wrote it nowhere.
    expectCodeNotWritten(server, code);
    expect(server.stderr()).toBe('');
  });

  test('structures a recording through the tools, and the panel follows each one', async ({
    panelPage,
    server,
    serviceWorker,
  }) => {
    await pair(panelPage, server);

    // The panel's own refusal comes back as the panel worded it.
    expect(await call(server, 'recording_create', { name: 'Early' })).toEqual({
      ok: false,
      error: 'No open project',
    });

    const created = await call(server, 'project_create', { name: 'Checkout' });
    expect(created.project.name).toBe('Checkout');
    await expect(panelPage.locator('#view-project')).toBeVisible();
    await expect(panelPage.locator('#project-title')).toHaveText('Checkout');

    const recording = await call(server, 'recording_create', { name: 'Happy path' });
    expect(recording.recording.name).toBe('Happy path');
    await expect(panelPage.locator('#view-recording')).toBeVisible();
    await expect(panelPage.locator('#recording-badge')).toContainText('Recording');

    await captureOne(serviceWorker);
    await expect.poll(async () => (await call(server, 'status')).pending_actions).toBe(1);

    const committed = await call(server, 'step_commit', { narration: 'Open the cart' });
    expect(committed).toEqual({
      ok: true,
      step: { logical_id: committed.step.logical_id, step_number: 1, actions: 1 },
      steps: 1,
    });
    await expect(panelPage.locator('.step-item')).toHaveCount(1);
    await expect(panelPage.locator('.step-narration')).toContainText('Open the cart');

    expect(await call(server, 'recording_pause')).toEqual({ ok: true, capturing: false });
    await expect(panelPage.locator('#recording-badge')).toContainText('Paused');
    expect((await call(server, 'recording_resume')).capturing).toBe(true);
    await expect(panelPage.locator('#recording-badge')).toContainText('Recording');

    const status = await call(server, 'status');
    expect(status.project.name).toBe('Checkout');
    expect(status.recording.name).toBe('Happy path');
    expect(status.steps).toBe(1);
    // Captured data crossed in no tool result.
    expect(server.stdout().includes(CAPTURED)).toBe(false);
  });

  test('without the grant, the panel refuses the export and no file is written', async ({
    panelPage,
    server,
    serviceWorker,
    exportDir,
  }) => {
    await pair(panelPage, server);
    await expect(panelPage.locator('#control-channel-export')).toBeHidden();
    await recordOneStep(server, serviceWorker, 'Private');

    expect(await call(server, 'project_export')).toEqual({
      ok: false,
      error: 'Export was not allowed when local control was turned on',
    });
    expect(filesIn(exportDir)).toEqual([]);
    expect(server.stdout().includes(CAPTURED)).toBe(false);
    await expect(panelPage.locator('#control-channel-export')).toBeHidden();
  });

  test('a server started without an export folder asks the panel for no export', async ({
    panelPage,
    startServer,
    serviceWorker,
  }) => {
    const server = await startServer({ exportDir: null });
    await pair(panelPage, server, { allowExport: true });
    await recordOneStep(server, serviceWorker, 'Checkout');

    expect((await call(server, 'project_export')).code).toBe('no-export-folder');
    // The panel counted no export: it was never asked for one.
    await expect(panelPage.locator('#control-channel-export')).toContainText('Export is allowed');
    await expect(panelPage.locator('#control-channel-export')).not.toContainText('1 export');
  });

  test('with the grant, writes the document of the Export button to the folder, and the panel imports it', async ({
    context,
    panelPage,
    server,
    site,
    exportDir,
  }) => {
    await pair(panelPage, server, { allowExport: true });
    await expect(panelPage.locator('#control-channel-export')).toContainText('Export is allowed');
    expect((await call(server, 'status')).export_allowed).toBe(true);

    // Record for real: a page open before the recording starts, and a click on
    // it once capture runs. The click is repeated until the recorder, injected
    // when the recording starts, has reported one.
    const sitePage = await context.newPage();
    await sitePage.goto(site);
    expect((await call(server, 'project_create', { name: 'Checkout: happy/path' })).ok).toBe(true);
    expect((await call(server, 'recording_create', { name: 'Flow' })).ok).toBe(true);
    await expect
      .poll(async () => {
        await sitePage.click('#add');
        return (await call(server, 'status')).pending_actions;
      })
      .toBeGreaterThan(0);
    expect((await call(server, 'step_commit', { narration: 'Add it' })).ok).toBe(true);

    const exported = await call(server, 'project_export');
    expect(exported).toEqual({
      ok: true,
      project: exported.project,
      path: exported.path,
      bytes: exported.bytes,
    });
    expect(exported.project.name).toBe('Checkout: happy/path');
    await expect(panelPage.locator('#control-channel-export')).toContainText(
      '"Checkout: happy/path"',
    );
    await expect(panelPage.locator('#control-channel-export')).toContainText('1 export');

    // One file, in the folder itself, named from the project without the
    // characters that separate folders.
    expect(filesIn(exportDir)).toEqual([path.basename(exported.path)]);
    expect(path.dirname(exported.path)).toBe(fs.realpathSync(exportDir));
    expect(path.basename(exported.path)).toMatch(/^Checkout__happy_path_\d+\.docent\.json$/);
    const text = fs.readFileSync(exported.path, 'utf-8');
    expect(Buffer.byteLength(text)).toBe(exported.bytes);

    // The same document the panel's own Export button writes, in its form.
    await panelPage.click('#bc-project');
    await expect(panelPage.locator('#view-project')).toBeVisible();
    expect(text).toBe(await exportByButton(panelPage));
    const document = JSON.parse(text);
    // The file holds the format: the validator the panel's Import loads
    // accepts it.
    expect(validatePayload(validateExtension, document)).toEqual({ valid: true, errors: [] });
    const clicks = document.recordings[0].steps[0].actions.filter(
      (action) => action.type === 'click',
    );
    expect(clicks.length).toBeGreaterThan(0);
    expect(clicks[0].element.text).toBe(SITE_BUTTON);
    // The document went to the file and stayed out of the tool results.
    expect(server.stdout().includes(SITE_BUTTON)).toBe(false);

    // The panel's Import takes the file back: beside the project it came from, it arrives as a copy.
    await panelPage.click('#bc-projects');
    await expect(panelPage.locator('#view-projects')).toBeVisible();
    const [fileChooser] = await Promise.all([
      panelPage.waitForEvent('filechooser'),
      panelPage.click('#btn-import-project'),
    ]);
    await fileChooser.setFiles(exported.path);
    await expect(
      panelPage.locator('#view-projects .card-item-name', {
        hasText: 'Checkout: happy/path (copy)',
      }),
    ).toHaveCount(1);
    await sitePage.close();
  });

  test('two panels with a server each export their own projects', async ({
    context,
    extensionId,
    panelPage,
    startServer,
    serviceWorker,
    exportDir,
  }) => {
    const otherPanel = await openPanel(context, extensionId);
    const first = await startServer();
    const second = await startServer();
    await pair(panelPage, first, { allowExport: true });
    await pair(otherPanel, second, { allowExport: true });

    await recordOneStep(first, serviceWorker, 'First');
    await recordOneStep(second, serviceWorker, 'Second');

    const fromFirst = await call(first, 'project_export');
    const fromSecond = await call(second, 'project_export');
    expect(fromFirst.project.name).toBe('First');
    expect(fromSecond.project.name).toBe('Second');
    expect(JSON.parse(fs.readFileSync(fromFirst.path, 'utf-8')).project.name).toBe('First');
    expect(JSON.parse(fs.readFileSync(fromSecond.path, 'utf-8')).project.name).toBe('Second');
    expect(filesIn(exportDir)).toHaveLength(2);
    await expect(panelPage.locator('#control-channel-export')).toContainText('"First"');
    await expect(otherPanel.locator('#control-channel-export')).toContainText('"Second"');
    await otherPanel.close();
  });

  test('a project larger than the inbound frame cap of the panel is written whole', async ({
    panelPage,
    server,
    serviceWorker,
  }) => {
    await pair(panelPage, server, { allowExport: true });
    expect((await call(server, 'project_create', { name: 'Large' })).ok).toBe(true);
    expect((await call(server, 'recording_create', { name: 'Flow' })).ok).toBe(true);
    const narration = 'n'.repeat(9000);
    for (let step = 1; step <= 3; step++) {
      await captureOne(serviceWorker);
      await expect.poll(async () => (await call(server, 'status')).pending_actions).toBe(1);
      expect((await call(server, 'step_commit', { narration })).ok).toBe(true);
    }

    const exported = await call(server, 'project_export');
    expect(exported.ok).toBe(true);
    expect(exported.bytes).toBeGreaterThan(16384 * 1.5);
    const document = JSON.parse(fs.readFileSync(exported.path, 'utf-8'));
    expect(document.recordings[0].steps).toHaveLength(3);
    // The channel is still in step: the next call gets its own answer.
    expect((await call(server, 'status')).steps).toBe(3);
  });

  test('a server that accepts another extension never pairs with this one', async ({
    panelPage,
    startServer,
  }) => {
    const server = await startServer({
      extensionId: 'abcdefghijklmnopabcdefghijklmnop',
      pairTimeoutMs: 5000,
    });
    const code = await turnOn(panelPage, server.port);
    // The panel dials every 2 seconds; the browser states its origin, and the
    // server answers none of those connections.
    expect((await call(server, 'pair', { code })).code).toBe('pairing-timeout');
    await expect(panelPage.locator('#control-channel-indicator-text')).not.toContainText(
      'A local program is connected',
    );
    expectCodeNotWritten(server, code);
  });

  test('after Turn off, a command names how the channel ended and a new code pairs again', async ({
    panelPage,
    server,
  }) => {
    const firstCode = await pair(panelPage, server);
    await panelPage.click('#btn-control-channel-off');
    await expect(panelPage.locator('#control-channel-indicator')).toBeHidden();

    await expect.poll(async () => (await call(server, 'status')).code).toBe('disconnected');

    // A command after the channel ended reaches no panel.
    expect((await call(server, 'project_create', { name: 'Too late' })).code).toBe('disconnected');

    // Turning on again shows a new code, and the same server pairs with it.
    expect(await pair(panelPage, server)).not.toBe(firstCode);
    expect((await call(server, 'project_create', { name: 'Again' })).project.name).toBe('Again');
    await expect(panelPage.locator('#project-title')).toHaveText('Again');
  });
});
