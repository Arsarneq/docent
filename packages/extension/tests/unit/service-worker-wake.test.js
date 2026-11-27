/**
 * service-worker-wake.test.js — The worker's first messages after a wake.
 *
 * The browser stops the service worker when it is idle and starts it again
 * for the next message. The worker then reads its projects from storage, and
 * the message that woke it is delivered before that read has finished. This
 * suite imports the shipped worker behind a fake `chrome` global whose
 * `storage.local.get` answers late (the approach
 * `service-worker-navigation.test.js` documents), and sends messages through
 * the `onMessage` listener the worker registers before the read is answered.
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
    alarms: { create() {}, clear() {}, onAlarm: noListener },
    sidePanel: { open: async () => {} },
  };
}

// Regression: #775 — a project created by the message that woke the worker
// was gone a moment later ("Create failed: Project not found"), and the
// Projects list read empty until the next view: the message was handled
// before the stored projects had been read, and the read then replaced what
// the message had done.
// https://github.com/Arsarneq/docent/issues/775
describe('SERVICE WORKER: messages that arrive before the stored state is read', () => {
  const earlier = createProject('Made earlier');
  const workerStorage = {
    projects: [earlier],
    activeProjectId: null,
    activeRecordingId: null,
    pendingActions: [],
    pendingCount: 0,
  };
  let workerOnMessage = null;
  const send = (message) => new Promise((resolve) => workerOnMessage(message, {}, resolve));

  let listedAtWake;
  let created;

  before(async () => {
    // Storage answers a read after a pause, with what it held when asked, as
    // a read that crosses to the browser's storage does.
    const late = (value) => new Promise((resolve) => setTimeout(() => resolve(value), 20));
    globalThis.chrome = fakeChrome(workerStorage, late, (fn) => (workerOnMessage = fn));
    await import('../../background/service-worker.js');
    // The messages that woke the worker: sent at once, before the read of
    // the stored state has been answered.
    const listing = send({ type: 'PROJECTS_LIST' });
    const creating = send({ type: 'PROJECT_CREATE', name: 'Made at the wake' });
    [listedAtWake, created] = await Promise.all([listing, creating]);
  });

  it('regression_775_the_projects_listed_at_a_wake_are_the_stored_projects', () => {
    assert.equal(listedAtWake.ok, true);
    assert.deepEqual(
      listedAtWake.projects.map((p) => p.project_id),
      [earlier.project_id],
    );
  });

  it('regression_775_a_project_created_at_a_wake_is_stored_beside_the_earlier_ones', () => {
    assert.equal(created.ok, true);
    assert.deepEqual(
      workerStorage.projects.map((p) => p.project_id),
      [earlier.project_id, created.project.project_id],
    );
    assert.equal(workerStorage.activeProjectId, created.project.project_id);
  });

  it('regression_775_a_recording_can_be_created_in_a_project_created_at_a_wake', async () => {
    const response = await send({
      type: 'RECORDING_CREATE',
      project_id: created.project.project_id,
      name: 'First recording',
    });
    assert.equal(response.ok, true, response.error);
    const stored = workerStorage.projects.find((p) => p.project_id === created.project.project_id);
    assert.equal(stored.recordings.length, 1);
  });
});
