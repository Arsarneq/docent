/**
 * service-worker-wake-unread.test.js — A worker that could not read its stored state.
 *
 * The companion of `service-worker-wake.test.js`: the shipped worker is
 * imported behind a fake `chrome` global whose first `storage.local.get`, the
 * worker's read of its stored state, fails. It has its own file because the
 * worker module holds its state at module scope, and each test file gets its
 * own instance of it.
 *
 * Uses Node.js built-in test runner.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../shared/lib/session.js';

/**
 * A fake `chrome` over `storage`, whose reads are answered by `read` (given
 * what storage held when asked). `onMessage` receives the worker's listener.
 */
function fakeChrome(storage, read, onMessage) {
  const noListener = { addListener() {} };
  const getFrom = (keys) => {
    const list = keys == null ? Object.keys(storage) : [].concat(keys);
    return structuredClone(
      Object.fromEntries(list.filter((k) => k in storage).map((k) => [k, storage[k]])),
    );
  };
  return {
    runtime: {
      id: 'test-extension',
      onInstalled: noListener,
      onMessage: { addListener: onMessage },
      getURL: (p) => p,
      sendMessage: async () => ({}),
    },
    action: { onClicked: noListener },
    storage: {
      local: {
        get: (keys) => read(getFrom(keys)),
        set: async (items) => void Object.assign(storage, structuredClone(items)),
        getBytesInUse: async () => 0,
        remove: async (keys) => [].concat(keys).forEach((k) => delete storage[k]),
      },
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      onChanged: noListener,
    },
    webNavigation: {
      onCompleted: noListener,
      onCommitted: noListener,
      onBeforeNavigate: noListener,
      getAllFrames: async () => [],
    },
    tabs: {
      onActivated: noListener,
      onCreated: noListener,
      onRemoved: noListener,
      query: async () => [],
      get: async () => ({}),
    },
    scripting: { executeScript: async () => {} },
    windows: { onFocusChanged: noListener },
    alarms: { create() {}, clear() {}, onAlarm: noListener },
    sidePanel: { open: async () => {} },
  };
}

// The class of #775, where the read of the stored state fails: a worker that
// does not know its projects answers no message as if it had none, and
// writes nothing over them.
describe('SERVICE WORKER: messages to a worker that could not read the stored state', () => {
  const earlier = createProject('Made earlier');
  const workerStorage = { projects: [earlier], activeProjectId: null, activeRecordingId: null };
  let workerOnMessage = null;
  const send = (message) => new Promise((resolve) => workerOnMessage(message, {}, resolve));
  const logged = console.error;

  before(async () => {
    let first = true;
    const read = async (value) => {
      if (!first) return value;
      first = false;
      throw new Error('storage unavailable');
    };
    globalThis.chrome = fakeChrome(workerStorage, read, (fn) => (workerOnMessage = fn));
    console.error = () => {};
    await import('../../background/service-worker.js');
    console.error = logged;
  });

  it('a_project_is_not_created_over_stored_projects_that_were_not_read', async () => {
    const response = await send({ type: 'PROJECT_CREATE', name: 'Made blind' });
    assert.equal(response.ok, false);
    assert.equal(response.error, 'Stored state could not be read');
    assert.deepEqual(
      workerStorage.projects.map((p) => p.project_id),
      [earlier.project_id],
    );
  });

  it('the_projects_are_not_listed_as_none_where_they_were_not_read', async () => {
    const response = await send({ type: 'PROJECTS_LIST' });
    assert.equal(response.ok, false);
    assert.equal(response.error, 'Stored state could not be read');
  });
});
