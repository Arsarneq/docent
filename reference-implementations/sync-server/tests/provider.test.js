import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StorageProvider } from '../storage/provider.js';

test('StorageProvider is constructable as an abstract base', () => {
  const provider = new StorageProvider();
  assert.ok(provider instanceof StorageProvider);
});

test('list() rejects with "not implemented" on the base class', async () => {
  const provider = new StorageProvider();
  await assert.rejects(() => provider.list(), /not implemented/);
});

test('read(id) rejects with "not implemented" on the base class', async () => {
  const provider = new StorageProvider();
  await assert.rejects(() => provider.read('any-id'), /not implemented/);
});

test('put(id, payload, lastModified) rejects with "not implemented" on the base class', async () => {
  const provider = new StorageProvider();
  await assert.rejects(
    () => provider.put('any-id', {}, '2026-06-04T10:00:00.000Z'),
    /not implemented/,
  );
});

test('clear() rejects with "not implemented" on the base class', async () => {
  const provider = new StorageProvider();
  await assert.rejects(() => provider.clear(), /not implemented/);
});

test('a concrete subclass can override every method', async () => {
  class InMemoryProvider extends StorageProvider {
    async list() {
      return [];
    }

    async read(_id) {
      return null;
    }

    async put(_id, _payload, _lastModified) {
      return { created: true };
    }

    async clear() {
      return 0;
    }
  }

  const provider = new InMemoryProvider();
  assert.deepEqual(await provider.list(), []);
  assert.equal(await provider.read('missing'), null);
  assert.deepEqual(await provider.put('id', {}, 'ts'), { created: true });
  assert.equal(await provider.clear(), 0);
});
