/**
 * tests/unit/export-file.test.js: naming and writing the export file, held to
 * the one folder the server writes into.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { exportFileName, openExportFolder, writeExportFile } from '../../export-file.js';

let root;
let folder;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'docent-mcp-export-')));
  folder = path.join(root, 'exports');
  fs.mkdirSync(folder);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('exportFileName', () => {
  it('is the project name, the time and the export extension', () => {
    assert.equal(exportFileName('Checkout', 1700000000000), 'Checkout_1700000000000.docent.json');
  });

  it('replaces a space with an underscore, as the Export button does', () => {
    assert.equal(exportFileName('My first project', 5), 'My_first_project_5.docent.json');
  });

  for (const [label, name, expected] of [
    ['a path separator', 'a/b', 'a_b_5.docent.json'],
    ['a Windows path separator', 'a\\b', 'a_b_5.docent.json'],
    ['a parent folder', '../../etc/passwd', '______etc_passwd_5.docent.json'],
    ['a leading dot', '.hidden', '_hidden_5.docent.json'],
    ['a dot, so no part before one can be a device name', 'nul.x', 'nul_x_5.docent.json'],
    ['a NUL', 'a\u0000b', 'a_b_5.docent.json'],
    ['a drive letter', 'C:evil', 'C_evil_5.docent.json'],
    ['a character outside ASCII', 'Kørsel 2', 'K_rsel_2_5.docent.json'],
  ]) {
    it(`replaces ${label}`, () => {
      const made = exportFileName(name, 5);
      assert.equal(made, expected);
      assert.equal(path.basename(made), made);
      assert.equal(path.win32.basename(made), made);
    });
  }

  it('keeps no dot of the project name: the first dot begins the extension', () => {
    assert.equal(exportFileName('..', 5), '___5.docent.json');
    assert.equal(exportFileName('a.b.c', 5).indexOf('.'), 'a_b_c_5'.length);
  });

  it('bounds the name part', () => {
    const made = exportFileName('n'.repeat(500), 5);
    assert.equal(made, `${'n'.repeat(100)}_5.docent.json`);
  });

  it('names an empty project name', () => {
    assert.equal(exportFileName('', 5), 'project_5.docent.json');
  });
});

describe('openExportFolder', () => {
  it('answers with the real path of an existing folder', () => {
    const link = path.join(root, 'link');
    fs.symlinkSync(folder, link);
    assert.deepEqual(openExportFolder(link), { ok: true, dir: folder });
  });

  it('refuses a path that does not exist', () => {
    assert.deepEqual(openExportFolder(path.join(root, 'absent')), { ok: false });
  });

  it('refuses a file', () => {
    const file = path.join(root, 'file');
    fs.writeFileSync(file, '');
    assert.deepEqual(openExportFolder(file), { ok: false });
  });
});

describe('writeExportFile', () => {
  const document = { docent_format: { platform: 'extension' }, recordings: [{ steps: [] }] };

  it('writes the document with a two-space indent and returns its path and size', async () => {
    const written = await writeExportFile({
      dir: folder,
      projectName: 'Demo',
      document,
      time: 42,
    });
    const expectedPath = path.join(folder, 'Demo_42.docent.json');
    const text = JSON.stringify(document, null, 2);
    assert.deepEqual(written, { ok: true, path: expectedPath, bytes: Buffer.byteLength(text) });
    assert.equal(fs.readFileSync(expectedPath, 'utf8'), text);
    assert.equal(fs.statSync(expectedPath).size, written.bytes);
  });

  it('counts the size in bytes, not characters', async () => {
    const written = await writeExportFile({
      dir: folder,
      projectName: 'Demo',
      document: { name: 'Kørsel' },
      time: 1,
    });
    assert.equal(written.bytes, fs.statSync(written.path).size);
    assert.ok(written.bytes > JSON.stringify({ name: 'Kørsel' }, null, 2).length);
  });

  it('keeps a hostile project name inside the folder', async () => {
    const written = await writeExportFile({
      dir: folder,
      projectName: '../../outside',
      document,
      time: 7,
    });
    assert.equal(written.ok, true);
    assert.equal(path.dirname(written.path), folder);
    assert.deepEqual(fs.readdirSync(root), ['exports']);
  });

  it('never writes over an existing file: it takes the next free name', async () => {
    const first = path.join(folder, 'Demo_42.docent.json');
    fs.writeFileSync(first, 'kept');
    const written = await writeExportFile({ dir: folder, projectName: 'Demo', document, time: 42 });
    assert.equal(written.path, path.join(folder, 'Demo_42_2.docent.json'));
    assert.equal(fs.readFileSync(first, 'utf8'), 'kept');
  });

  it('does not write through a symbolic link that holds the name', async () => {
    const target = path.join(root, 'target.json');
    fs.symlinkSync(target, path.join(folder, 'Demo_42.docent.json'));
    const written = await writeExportFile({ dir: folder, projectName: 'Demo', document, time: 42 });
    assert.equal(written.path, path.join(folder, 'Demo_42_2.docent.json'));
    assert.equal(fs.existsSync(target), false);
  });

  it('creates the file for its owner alone', { skip: process.platform === 'win32' }, async () => {
    const written = await writeExportFile({ dir: folder, projectName: 'Demo', document, time: 1 });
    assert.equal(fs.statSync(written.path).mode & 0o777, 0o600);
  });

  it('removes the file it created when the write fails part-way', async () => {
    const open = async (file, flags, mode) => {
      const handle = await fs.promises.open(file, flags, mode);
      return {
        writeFile: async (text) => {
          await handle.writeFile(text.slice(0, 10));
          throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
        },
        close: () => handle.close(),
      };
    };
    assert.deepEqual(
      await writeExportFile({ dir: folder, projectName: 'Demo', document, time: 1, open }),
      { ok: false },
    );
    assert.deepEqual(fs.readdirSync(folder), []);
  });

  it('answers a folder that is gone with a failure, not a throw', async () => {
    fs.rmSync(folder, { recursive: true });
    assert.deepEqual(
      await writeExportFile({ dir: folder, projectName: 'Demo', document, time: 1 }),
      { ok: false },
    );
  });
});
