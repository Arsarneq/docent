/**
 * held-keys-relay.js — The keys held across the frames of a tab.
 *
 * The browser delivers a key's events to the focused document only, so the
 * recorder in one frame does not see a key that went down in another frame of
 * its tab, and an action there would not name it in `held_keys` (#779). Each
 * recorder reports the keys it names as held, their releases, and what moves
 * the focus; the service worker keeps this relay and adds to an action the
 * keys held in the tab's other frames.
 *
 * The rule, which extension capture-principles ECP-12 states in full: a key
 * is named only while its release is sure to be reported. A key stays with
 * the frame that reported it until that frame's window loses the focus; a
 * pointer press in another frame of the tab that takes the focus takes the
 * keys with it, once that frame reports the focus.
 *
 * Reports of different frames can arrive in another order than their events
 * happened in. The hand-over is decided by the pressed frame's own reports
 * (its press, then its focus), which keep their order, so it comes out the
 * same whether the other frame's blur arrives before or after them. Between
 * that blur and that focus the keys are named to nobody, and a focus that
 * never comes leaves them unnamed until the next press drops them.
 *
 * A pure module over plain data, with no chrome.* side-effects, as
 * frame-trust.js and navigation-logic.js are.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

/**
 * @typedef {object} HeldKeyReport
 * @property {'down'|'up'|'press'|'focus'|'blur'|'clear'} event
 *   `down`: the frame names a key as held. `up`: a key was released in the
 *   frame. `press`: a pointer was pressed in the frame. `focus`: the frame's
 *   window took the focus while that press was handled. `blur`: the frame's
 *   window lost the focus. `clear`: nothing is known to be down in the tab
 *   (a drag).
 * @property {string} [code] — the physical key, for `down` and `up`
 * @property {string} [key] — the name the key's `key` action carries, for `down`
 */

export function createHeldKeysRelay() {
  // tabId → { keys: Map(code → { name, frame, waitsFor }), pressed }
  // `frame` is the frame sent the key's release. `waitsFor` is the frame a
  // press named while `frame` has lost the focus: the key is unnamed until
  // that frame reports its focus. `pressed` is the frame of the tab's last
  // press whose focus has not been reported.
  const tabs = new Map();

  const tabOf = (tabId) => {
    let tab = tabs.get(tabId);
    if (!tab) {
      tab = { keys: new Map(), pressed: null };
      tabs.set(tabId, tab);
    }
    return tab;
  };

  const dropWhere = (tab, test) => {
    for (const [code, held] of tab.keys) if (test(held)) tab.keys.delete(code);
  };

  /**
   * Take one frame's report.
   *
   * @param {number} tabId
   * @param {number} frameId
   * @param {HeldKeyReport} report
   */
  function report(tabId, frameId, report) {
    if (tabId == null || frameId == null || !report || typeof report !== 'object') return;
    const { event, code, key } = report;
    if (event === 'down') {
      if (typeof code !== 'string' || typeof key !== 'string' || key === '') return;
      const tab = tabOf(tabId);
      tab.keys.delete(code);
      tab.keys.set(code, { name: key, frame: frameId, waitsFor: null });
      return;
    }
    const tab = tabs.get(tabId);
    if (!tab) return;
    if (event === 'up') {
      if (typeof code === 'string') tab.keys.delete(code);
    } else if (event === 'press') {
      // Keys that waited for the focus of an earlier press never got it.
      dropWhere(tab, (held) => held.waitsFor !== null);
      tab.pressed = frameId;
    } else if (event === 'focus') {
      if (tab.pressed !== frameId) return;
      tab.pressed = null;
      // The pressed frame has the focus: the keys that waited for it, and
      // those of a frame whose blur is still on its way, are its to release.
      for (const held of tab.keys.values()) {
        if (held.frame === frameId) continue;
        held.frame = frameId;
        held.waitsFor = null;
        held.handedOver = true;
      }
    } else if (event === 'blur') {
      const pressedElsewhere = tab.pressed !== null && tab.pressed !== frameId;
      for (const [code, held] of tab.keys) {
        if (held.frame !== frameId || held.waitsFor !== null) continue;
        if (pressedElsewhere) held.waitsFor = tab.pressed;
        else tab.keys.delete(code);
      }
      if (tab.pressed === frameId) tab.pressed = null;
    } else if (event === 'clear') {
      tabs.delete(tabId);
    }
  }

  /**
   * The names of the keys held in the tab that an action in `frameId` does
   * not know of itself, in the order they went down: those of the tab's other
   * frames, and those handed over to this frame. `exceptCode` is the key the
   * action itself is about.
   *
   * @param {number} tabId
   * @param {number} frameId
   * @param {string} [exceptCode]
   * @returns {string[]}
   */
  function heldElsewhere(tabId, frameId, exceptCode) {
    const tab = tabs.get(tabId);
    if (!tab) return [];
    const names = [];
    for (const [code, held] of tab.keys) {
      if (code === exceptCode || held.waitsFor !== null) continue;
      if (held.frame === frameId && !held.handedOver) continue;
      names.push(held.name);
    }
    return names;
  }

  /** A frame is gone: its keys, and those that waited for it, are forgotten. */
  function forgetFrame(tabId, frameId) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    dropWhere(tab, (held) => held.frame === frameId || held.waitsFor === frameId);
    if (tab.pressed === frameId) tab.pressed = null;
  }

  function forgetTab(tabId) {
    tabs.delete(tabId);
  }

  function forgetAll() {
    tabs.clear();
  }

  return { report, heldElsewhere, forgetFrame, forgetTab, forgetAll };
}
