import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FileStorageProvider } from '../../storage/file-provider.js';
import { StorageProvider } from '../../storage/provider.js';

/**
 * Tests for the default File_Storage_Provider.
 *
 * Each test runs against a fresh temp directory created with `fs.mkdtemp` and
 * injected into the provider's constructor, so suites never collide on the
 * shared default storage dir and each starts from an empty store. The temp dir
 * is removed (recursively) after each test.
 *
 * The provider's public surface is async (`put`/`read`/`list`/`clear`), and the
 * on-disk wrapper format is `{ last_modified, payload }`, so the tests assert
 * both the returned values AND the durable persistence behavior that backs a
 * restart by constructing a second provider over the same
 * directory.
 */

/** A representative Full_Project_Payload-shaped object for a given id/name. */
function samplePayload(projectId, name) {
  return {
    docent_format: { platform: 'extension', version: 1 },
    project: {
      project_id: projectId,
      name,
      created_at: '2026-06-04T10:00:00.000Z',
    },
    recordings: [
      {
        recording_id: `${projectId}-rec-1`,
        name: 'First recording',
        steps: [{ logical_id: 'a', uuid: 'u1', text: 'hello' }],
      },
    ],
  };
}

describe('FileStorageProvider', () => {
  /** @type {string} */
  let storageDir;
  /** @type {FileStorageProvider} */
  let provider;

  beforeEach(async () => {
    storageDir = await mkdtemp(path.join(os.tmpdir(), 'docent-sync-provider-test-'));
    provider = new FileStorageProvider(storageDir);
  });

  afterEach(async () => {
    await rm(storageDir, { recursive: true, force: true });
  });

  describe('construction', () => {
    it('is a StorageProvider and exposes the injected storage dir', () => {
      assert.ok(provider instanceof StorageProvider);
      assert.equal(provider.storageDir, storageDir);
    });

    it('creates the storage directory if it does not yet exist', async () => {
      const nested = path.join(storageDir, 'a', 'b', 'c');
      const nestedProvider = new FileStorageProvider(nested);
      // No throw on construction, and the dir is usable for a write.
      const result = await nestedProvider.put(
        '0192f0a0-0000-7000-8000-000000000099',
        samplePayload('0192f0a0-0000-7000-8000-000000000099', 'Nested'),
        '2026-06-04T10:00:00.000Z',
      );
      assert.equal(result.created, true);
      assert.equal(nestedProvider.storageDir, nested);
    });
  });

  describe('put — create vs replace', () => {
    const id = '0192f0a0-0000-7000-8000-000000000001';

    it('reports created=true on first write', async () => {
      const result = await provider.put(id, samplePayload(id, 'First'), '2026-06-04T10:00:00.000Z');
      assert.deepEqual(result, { created: true });
    });

    it('reports created=false when replacing an existing project', async () => {
      await provider.put(id, samplePayload(id, 'First'), '2026-06-04T10:00:00.000Z');
      const result = await provider.put(
        id,
        samplePayload(id, 'Replaced'),
        '2026-06-04T11:00:00.000Z',
      );
      assert.deepEqual(result, { created: false });
    });

    it('replaces the stored content (read reflects the latest write)', async () => {
      await provider.put(id, samplePayload(id, 'First'), '2026-06-04T10:00:00.000Z');
      await provider.put(id, samplePayload(id, 'Replaced'), '2026-06-04T11:00:00.000Z');
      const record = await provider.read(id);
      assert.equal(record.payload.project.name, 'Replaced');
      assert.equal(record.last_modified, '2026-06-04T11:00:00.000Z');
    });
  });

  describe('read — present vs absent', () => {
    const id = '0192f0a0-0000-7000-8000-000000000002';

    it('returns the verbatim payload and last_modified for a stored project', async () => {
      const payload = samplePayload(id, 'Readable');
      await provider.put(id, payload, '2026-06-04T10:00:00.000Z');
      const record = await provider.read(id);
      assert.deepEqual(record.payload, payload);
      assert.equal(record.last_modified, '2026-06-04T10:00:00.000Z');
    });

    it('returns null for a project that is not stored', async () => {
      const record = await provider.read('0192f0a0-0000-7000-8000-00000000ffff');
      assert.equal(record, null);
    });

    it('does NOT inject last_modified into the read-back payload (verbatim)', async () => {
      const payload = samplePayload(id, 'Verbatim');
      await provider.put(id, payload, '2026-06-04T10:00:00.000Z');
      const record = await provider.read(id);
      assert.equal(Object.prototype.hasOwnProperty.call(record.payload, 'last_modified'), false);
      // The whole payload is content-equivalent to what was stored.
      assert.deepEqual(record.payload, payload);
    });

    it('persists last_modified alongside the payload, not inside it, on disk', async () => {
      const payload = samplePayload(id, 'OnDisk');
      await provider.put(id, payload, '2026-06-04T10:00:00.000Z');
      const onDisk = JSON.parse(await readFile(path.join(storageDir, `${id}.json`), 'utf8'));
      assert.equal(onDisk.last_modified, '2026-06-04T10:00:00.000Z');
      assert.equal(Object.prototype.hasOwnProperty.call(onDisk.payload, 'last_modified'), false);
      assert.deepEqual(onDisk.payload, payload);
    });
  });

  describe('list — contents and shape', () => {
    it('returns an empty array when no projects are stored', async () => {
      assert.deepEqual(await provider.list(), []);
    });

    it('returns one entry per stored project with project_id, name, last_modified', async () => {
      const id1 = '0192f0a0-0000-7000-8000-000000000010';
      const id2 = '0192f0a0-0000-7000-8000-000000000011';
      await provider.put(id1, samplePayload(id1, 'Alpha'), '2026-06-04T10:00:00.000Z');
      await provider.put(id2, samplePayload(id2, 'Beta'), '2026-06-04T11:00:00.000Z');

      const entries = await provider.list();
      assert.equal(entries.length, 2);

      const byId = new Map(entries.map((e) => [e.project_id, e]));
      assert.deepEqual(byId.get(id1), {
        project_id: id1,
        name: 'Alpha',
        last_modified: '2026-06-04T10:00:00.000Z',
      });
      assert.deepEqual(byId.get(id2), {
        project_id: id2,
        name: 'Beta',
        last_modified: '2026-06-04T11:00:00.000Z',
      });
    });

    it('exposes only the manifest fields, not the full payload', async () => {
      const id = '0192f0a0-0000-7000-8000-000000000012';
      await provider.put(id, samplePayload(id, 'Gamma'), '2026-06-04T10:00:00.000Z');
      const [entry] = await provider.list();
      assert.deepEqual(Object.keys(entry).sort(), ['last_modified', 'name', 'project_id']);
    });
  });

  describe('clear — count', () => {
    it('returns 0 and leaves an empty store when nothing is stored', async () => {
      assert.equal(await provider.clear(), 0);
      assert.deepEqual(await provider.list(), []);
    });

    it('removes every stored project and returns the count removed', async () => {
      const ids = [
        '0192f0a0-0000-7000-8000-000000000020',
        '0192f0a0-0000-7000-8000-000000000021',
        '0192f0a0-0000-7000-8000-000000000022',
      ];
      for (const id of ids) {
        await provider.put(id, samplePayload(id, `P-${id}`), '2026-06-04T10:00:00.000Z');
      }

      const removed = await provider.clear();
      assert.equal(removed, ids.length);
      assert.deepEqual(await provider.list(), []);
      // No project files remain on disk.
      const remaining = (await readdir(storageDir)).filter((f) => f.endsWith('.json'));
      assert.deepEqual(remaining, []);
    });
  });

  describe('restart reload — durability over the same temp dir', () => {
    it('reloads projects and their last_modified from a fresh provider over the same dir', async () => {
      const id1 = '0192f0a0-0000-7000-8000-000000000030';
      const id2 = '0192f0a0-0000-7000-8000-000000000031';
      await provider.put(id1, samplePayload(id1, 'Persisted One'), '2026-06-04T10:00:00.000Z');
      await provider.put(id2, samplePayload(id2, 'Persisted Two'), '2026-06-04T12:30:00.000Z');

      // Simulate a restart: a brand-new provider instance over the SAME dir.
      const reloaded = new FileStorageProvider(storageDir);

      const entries = await reloaded.list();
      assert.equal(entries.length, 2);
      const byId = new Map(entries.map((e) => [e.project_id, e]));
      assert.equal(byId.get(id1).name, 'Persisted One');
      assert.equal(byId.get(id1).last_modified, '2026-06-04T10:00:00.000Z');
      assert.equal(byId.get(id2).name, 'Persisted Two');
      assert.equal(byId.get(id2).last_modified, '2026-06-04T12:30:00.000Z');

      // A single read after restart returns the verbatim payload + timestamp.
      const record = await reloaded.read(id1);
      assert.deepEqual(record.payload, samplePayload(id1, 'Persisted One'));
      assert.equal(record.last_modified, '2026-06-04T10:00:00.000Z');
    });
  });

  describe('hostile project_id rejection', () => {
    const hostileIds = [
      ['empty string', ''],
      ['forward-slash traversal', '../escape'],
      ['back-slash traversal', '..\\escape'],
      ['embedded ..', 'a..b'],
      ['single dot segment', '.'],
      ['double dot segment', '..'],
      ['nested path', 'sub/dir/id'],
      ['NUL byte', 'id\0name'],
    ];

    for (const [label, id] of hostileIds) {
      it(`read() rejects a hostile project_id (${label})`, async () => {
        await assert.rejects(() => provider.read(id), /Invalid project_id/);
      });

      it(`put() rejects a hostile project_id (${label})`, async () => {
        await assert.rejects(
          () => provider.put(id, samplePayload('safe', 'X'), '2026-06-04T10:00:00.000Z'),
          /Invalid project_id/,
        );
      });
    }

    it('read() rejects a non-string project_id', async () => {
      await assert.rejects(() => provider.read(undefined), /Invalid project_id/);
      await assert.rejects(() => provider.read(42), /Invalid project_id/);
    });

    it('does not write anything to disk when a hostile id is rejected', async () => {
      await assert.rejects(
        () => provider.put('../escape', samplePayload('x', 'X'), '2026-06-04T10:00:00.000Z'),
        /Invalid project_id/,
      );
      const files = (await readdir(storageDir)).filter((f) => f.endsWith('.json'));
      assert.deepEqual(files, []);
    });
  });
});
