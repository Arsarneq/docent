/**
 * service-worker-held-keys.test.js — The worker names a key held in another
 * frame of the tab.
 *
 * The recorders report the keys they name as held (`HELD_KEY`) and their
 * pointer presses (`POINTER_PRESSED`); the worker adds to an appended action
 * the keys held in the tab's other frames (#779). This suite imports the
 * shipped worker behind a fake `chrome` global (the approach
 * `service-worker-navigation.test.js` documents) and sends it the messages
 * the frames of one tab send. What the relay itself decides is tested in
 * `held-keys-relay.test.js`.
 *
 * Uses Node.js built-in test runner.
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const RUNTIME_ID = 'test-extension';
const TAB = 7;
const TOP = 0;
const INNER = 5;

const storage = { projects: [], recording: true, pendingActions: [], pendingCount: 0 };
const listeners = {};
const listen = (name) => ({ addListener: (fn) => (listeners[name] = fn) });
const noListener = { addListener() {} };
// The worker watches storage from more than one listener.
const storageWatchers = [];

globalThis.chrome = {
  runtime: {
    id: RUNTIME_ID,
    onInstalled: noListener,
    onMessage: listen('message'),
    getURL: (p) => p,
    sendMessage: async () => ({}),
  },
  action: { onClicked: noListener },
  storage: {
    local: {
      get: async (keys) => {
        const list = keys == null ? Object.keys(storage) : [].concat(keys);
        return structuredClone(
          Object.fromEntries(list.filter((k) => k in storage).map((k) => [k, storage[k]])),
        );
      },
      set: async (items) => {
        const was = storage.recording;
        Object.assign(storage, structuredClone(items));
        if ('recording' in items && items.recording !== was) {
          const change = { recording: { oldValue: was, newValue: items.recording } };
          for (const watch of storageWatchers) watch(change, 'local');
        }
      },
      getBytesInUse: async () => 0,
      remove: async (keys) => [].concat(keys).forEach((k) => delete storage[k]),
    },
    session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: { addListener: (fn) => storageWatchers.push(fn) },
  },
  webNavigation: {
    onCompleted: noListener,
    onCommitted: noListener,
    onBeforeNavigate: listen('beforeNavigate'),
    getAllFrames: async () => [],
  },
  tabs: {
    onActivated: listen('tabActivated'),
    onCreated: noListener,
    onRemoved: listen('tabRemoved'),
    query: async () => [],
    get: async () => ({}),
    // END_TYPING, asked of one frame: answered, unless a case says otherwise.
    sendMessage: (tabId, message, { frameId } = {}) => {
      const how = endTyping.get(frameId);
      if (how === 'gone') return Promise.reject(new Error('Receiving end does not exist'));
      if (how === 'silent') return new Promise(() => {});
      return Promise.resolve(how ?? { ok: true });
    },
  },
  windows: { onFocusChanged: listen('windowFocus'), WINDOW_ID_NONE: -1 },
  scripting: { executeScript: async () => {} },
  alarms: { create() {}, clear() {}, onAlarm: noListener },
  sidePanel: { open: async () => {} },
};

// How a frame answers END_TYPING: frameId → 'gone' | 'silent' | the answer.
const endTyping = new Map();

const from = (frameId, tabId = TAB) => ({ id: RUNTIME_ID, frameId, tab: { id: tabId } });
/** A one-way message, as a recorder sends it. */
const tell = (frameId, message, tabId) =>
  void listeners.message(message, from(frameId, tabId), () => {});
const held = (frameId, report, tabId) => tell(frameId, { type: 'HELD_KEY', ...report }, tabId);
/** Append an action from a frame and give back what was stored for it. */
async function append(frameId, action, tabId) {
  await new Promise((resolve) =>
    listeners.message({ type: 'APPEND_ACTION', action }, from(frameId, tabId), resolve),
  );
  return storage.pendingActions.at(-1);
}
const click = (heldKeys = []) => ({ type: 'click', timestamp: Date.now(), held_keys: heldKeys });

describe('SERVICE WORKER: a key held in another frame of the tab', () => {
  before(async () => {
    await import('../../background/service-worker.js');
    // Let the worker read its stored state: capture is on.
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  beforeEach(async () => {
    // A stop and a start empty the registry and the relay; the frames then
    // report themselves ready, as their recorders do.
    await globalThis.chrome.storage.local.set({ recording: false });
    await globalThis.chrome.storage.local.set({ recording: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    storage.pendingActions = [];
    endTyping.clear();
    tell(TOP, { type: 'FRAME_READY' });
    tell(INNER, { type: 'FRAME_READY' });
    tell(TOP, { type: 'FRAME_READY' }, TAB + 1);
  });

  it('regression_779_an_action_names_the_key_held_in_another_frame_ahead_of_its_own', async () => {
    held(TOP, { event: 'down', code: 'Escape', key: 'Escape' });
    const stored = await append(INNER, click(['F2']));
    assert.deepEqual(stored.held_keys, ['Escape', 'F2']);
  });

  it('regression_779_the_frame_that_reported_the_key_is_not_given_it_twice', async () => {
    held(TOP, { event: 'down', code: 'Escape', key: 'Escape' });
    const stored = await append(TOP, click(['Escape']));
    assert.deepEqual(stored.held_keys, ['Escape']);
  });

  it('regression_779_another_tab_is_not_given_the_key', async () => {
    held(TOP, { event: 'down', code: 'Escape', key: 'Escape' });
    const stored = await append(TOP, click(), TAB + 1);
    assert.deepEqual(stored.held_keys, []);
  });

  it('regression_779_a_key_action_does_not_name_its_own_key', async () => {
    held(TOP, { event: 'down', code: 'Escape', key: 'Escape' });
    held(TOP, { event: 'down', code: 'F2', key: 'F2' });
    const stored = await append(INNER, {
      type: 'key',
      key: 'Escape',
      code: 'Escape',
      timestamp: Date.now(),
      held_keys: [],
    });
    assert.deepEqual(stored.held_keys, ['F2']);
  });

  it('regression_779_an_action_with_no_held_keys_field_is_left_as_it_is', async () => {
    held(TOP, { event: 'down', code: 'Escape', key: 'Escape' });
    const stored = await append(INNER, { type: 'type', value: 'x', timestamp: Date.now() });
    assert.equal('held_keys' in stored, false);
  });

  it('regression_779_a_release_the_action_s_own_frame_reports_afterwards_leaves_the_key_named', async () => {
    held(TOP, { event: 'down', code: 'Escape', key: 'Escape' });
    tell(INNER, { type: 'POINTER_PRESSED' });
    held(TOP, { event: 'blur' });
    held(INNER, { event: 'focus' });
    const appended = append(INNER, click());
    held(INNER, { event: 'up', code: 'Escape' });
    assert.deepEqual((await appended).held_keys, ['Escape']);
    assert.deepEqual((await append(INNER, click())).held_keys, []);
  });

  it('regression_779_a_release_another_frame_reports_before_the_action_is_stored_unnames_the_key', async () => {
    // The other frame's page was busy: its report of a release made before
    // the click arrives after the click's.
    held(TOP, { event: 'down', code: 'Escape', key: 'Escape' });
    tell(INNER, { type: 'POINTER_PRESSED' });
    held(INNER, { event: 'focus' });
    const appended = append(INNER, click());
    held(TOP, { event: 'up', code: 'Escape' });
    held(TOP, { event: 'blur' });
    assert.deepEqual((await appended).held_keys, []);
  });

  it('regression_779_the_keys_of_a_frame_that_does_not_answer_the_press_are_forgotten', async () => {
    held(TOP, { event: 'down', code: 'Escape', key: 'Escape' });
    endTyping.set(TOP, 'silent');
    tell(INNER, { type: 'POINTER_PRESSED' });
    held(INNER, { event: 'focus' });
    assert.deepEqual((await append(INNER, click())).held_keys, []);
    endTyping.delete(TOP);
    assert.deepEqual((await append(INNER, click())).held_keys, []);
  });

  it('regression_779_the_keys_of_a_frame_that_is_gone_at_the_press_are_forgotten', async () => {
    held(INNER, { event: 'down', code: 'Escape', key: 'Escape' });
    endTyping.set(INNER, 'gone');
    tell(TOP, { type: 'POINTER_PRESSED' });
    assert.deepEqual((await append(TOP, click())).held_keys, []);
  });

  it('regression_779_a_press_hands_the_key_to_the_frame_it_gave_the_focus', async () => {
    held(TOP, { event: 'down', code: 'Escape', key: 'Escape' });
    tell(INNER, { type: 'POINTER_PRESSED' });
    held(TOP, { event: 'blur' });
    held(INNER, { event: 'focus' });
    assert.deepEqual((await append(INNER, click())).held_keys, ['Escape']);
    held(INNER, { event: 'up', code: 'Escape' });
    assert.deepEqual((await append(INNER, click())).held_keys, []);
  });

  it('regression_779_an_action_with_no_press_before_it_asks_the_frame_that_holds_the_key', async () => {
    // A busy frame reports late a keydown made before the focus left it; the
    // key's release went to the frame that has the focus. Asked, the busy
    // frame names its blur as its last report, and the action waits for it.
    tell(INNER, { type: 'POINTER_PRESSED' });
    held(INNER, { event: 'focus' });
    await append(INNER, click());
    held(TOP, { event: 'down', code: 'Escape', key: 'Escape', recorder: 'r1', seq: 1 });
    endTyping.set(TOP, { ok: true, heldReports: { recorder: 'r1', seq: 2 } });
    const key = { type: 'key', key: 'F2', code: 'F2', timestamp: Date.now(), held_keys: [] };
    const appended = append(INNER, key);
    // What the frame appends next is stored behind it.
    const next = append(INNER, { ...key, key: 'F3', code: 'F3' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    held(TOP, { event: 'blur', recorder: 'r1', seq: 2 });
    await Promise.all([appended, next]);
    assert.deepEqual(
      storage.pendingActions.slice(-2).map((a) => [a.key, a.held_keys]),
      [
        ['F2', []],
        ['F3', []],
      ],
    );
  });

  it('regression_779_an_action_with_no_press_before_it_names_no_key_of_a_frame_that_is_gone', async () => {
    held(INNER, { event: 'down', code: 'Escape', key: 'Escape' });
    endTyping.set(INNER, 'gone');
    const stored = await append(TOP, {
      type: 'key',
      key: 'F2',
      code: 'F2',
      timestamp: Date.now(),
      held_keys: [],
    });
    assert.deepEqual(stored.held_keys, []);
  });

  it('regression_779_the_press_waits_for_the_report_a_frame_names_as_its_last', async () => {
    held(TOP, { event: 'down', code: 'Escape', key: 'Escape', recorder: 'r1', seq: 1 });
    // The frame's answer overtakes its report of the release.
    endTyping.set(TOP, { ok: true, heldReports: { recorder: 'r1', seq: 2 } });
    tell(INNER, { type: 'POINTER_PRESSED' });
    held(INNER, { event: 'focus' });
    const appended = append(INNER, click());
    await new Promise((resolve) => setTimeout(resolve, 20));
    held(TOP, { event: 'up', code: 'Escape', recorder: 'r1', seq: 2 });
    assert.deepEqual((await appended).held_keys, []);
  });

  it('regression_779_a_frame_whose_last_report_does_not_arrive_has_its_keys_forgotten', async () => {
    held(TOP, { event: 'down', code: 'Escape', key: 'Escape', recorder: 'r1', seq: 1 });
    endTyping.set(TOP, { ok: true, heldReports: { recorder: 'r1', seq: 2 } });
    tell(INNER, { type: 'POINTER_PRESSED' });
    held(INNER, { event: 'focus' });
    assert.deepEqual((await append(INNER, click())).held_keys, []);
  });

  it('regression_779_another_tab_or_window_taking_the_focus_forgets_the_keys', async () => {
    held(TOP, { event: 'down', code: 'Escape', key: 'Escape' });
    listeners.tabActivated({ tabId: TAB + 1, windowId: 1 });
    assert.deepEqual((await append(INNER, click())).held_keys, []);
    held(TOP, { event: 'down', code: 'Escape', key: 'Escape' });
    listeners.windowFocus(-1);
    assert.deepEqual((await append(INNER, click())).held_keys, []);
  });

  it('regression_779_a_blur_with_no_press_forgets_the_key', async () => {
    held(TOP, { event: 'down', code: 'Escape', key: 'Escape' });
    held(TOP, { event: 'blur' });
    assert.deepEqual((await append(INNER, click())).held_keys, []);
  });

  it('regression_779_a_report_from_a_frame_that_is_not_registered_is_dropped', async () => {
    held(99, { event: 'down', code: 'Escape', key: 'Escape' });
    listeners.message(
      { type: 'HELD_KEY', event: 'down', code: 'F2', key: 'F2' },
      { id: 'another-extension', frameId: TOP, tab: { id: TAB } },
      () => {},
    );
    assert.deepEqual((await append(INNER, click())).held_keys, []);
  });

  it('regression_779_a_frame_that_navigates_takes_its_keys_with_it', async () => {
    held(INNER, { event: 'down', code: 'Escape', key: 'Escape' });
    listeners.beforeNavigate({ tabId: TAB, frameId: INNER });
    assert.deepEqual((await append(TOP, click())).held_keys, []);
  });

  it('regression_779_a_main_frame_that_navigates_takes_the_tab_s_keys_with_it', async () => {
    held(INNER, { event: 'down', code: 'Escape', key: 'Escape' });
    listeners.beforeNavigate({ tabId: TAB, frameId: TOP });
    assert.deepEqual((await append(TOP, click())).held_keys, []);
  });

  it('regression_779_a_stop_of_the_recording_forgets_the_keys', async () => {
    held(TOP, { event: 'down', code: 'Escape', key: 'Escape' });
    await globalThis.chrome.storage.local.set({ recording: false });
    await globalThis.chrome.storage.local.set({ recording: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    tell(TOP, { type: 'FRAME_READY' });
    tell(INNER, { type: 'FRAME_READY' });
    assert.deepEqual((await append(INNER, click())).held_keys, []);
  });
});
