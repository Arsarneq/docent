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
 * happened in, and a busy page sends its reports late. Three things keep a
 * late report from naming a released key:
 *
 * - The hand-over is decided by the pressed frame's own reports (its press,
 *   then its focus), which keep their order. Where the other frame's blur
 *   arrives ahead of that focus, the keys are named to nobody in between,
 *   and a focus that never comes leaves them unnamed until the next press
 *   drops them. A blur that arrives ahead of the press itself forgets them.
 * - An action is given its keys through a watch, opened as the action
 *   arrives and taken when it is stored, which is after the tab's other
 *   frames have answered the press (the worker's press hold). A key another
 *   frame reports released in that time is not named: whether the release
 *   came before the action is not known.
 * - The worker forgets the keys a frame reported when that frame does not
 *   answer (`forgetFrame`), handed over or not.
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
 * @property {'down'|'up'|'press'|'focus'|'blur'|'clear'|'metaup'} event
 *   `down`: the frame names a key as held. `up`: a key was released in the
 *   frame. `press`: a pointer was pressed in the frame. `focus`: the frame's
 *   window took the focus while that press was handled. `blur`: the frame's
 *   window lost the focus. `clear`: nothing is known to be down in the tab
 *   (a drag). `metaup`: the Meta key was released in the frame, after which
 *   no key that went down under it is known to be down.
 * @property {string} [code] — the physical key, for `down` and `up`
 * @property {string} [key] — the name the key's `key` action carries, for `down`
 * @property {boolean} [underMeta] — the key went down while the Meta key was held, for `down`
 */

export function createHeldKeysRelay() {
  // tabId → { keys: Map(code → held), pressed, watches }
  // held: { name, frame, origin, waitsFor, handedOver, underMeta }. `frame` is
  // the frame sent the key's release, `origin` the frame that reported the
  // key down. `waitsFor` is the frame a press named while `frame` has lost
  // the focus: the key is unnamed until that frame reports its focus.
  // `pressed` is the frame of the tab's last press whose focus has not been
  // reported. `watches` are the open watches of the tab's actions.
  const tabs = new Map();

  const tabOf = (tabId) => {
    let tab = tabs.get(tabId);
    if (!tab) {
      tab = { keys: new Map(), pressed: null, watches: new Set() };
      tabs.set(tabId, tab);
    }
    return tab;
  };

  /**
   * A key is no longer known to be down, or is named to nobody: the open
   * watches lose it, save those of the frames given (the frame whose own
   * report said so, which came after its action).
   */
  const unname = (tab, code, ...exceptFrames) => {
    for (const watch of tab.watches) {
      if (!exceptFrames.includes(watch.frame)) watch.names.delete(code);
    }
  };

  const drop = (tab, code, byFrame) => {
    tab.keys.delete(code);
    unname(tab, code, byFrame);
  };

  const dropWhere = (tab, test, byFrame) => {
    for (const [code, held] of tab.keys) if (test(held)) drop(tab, code, byFrame);
  };

  const dropTab = (tabId, byFrame) => {
    const tab = tabs.get(tabId);
    if (!tab) return;
    dropWhere(tab, () => true, byFrame);
    tab.pressed = null;
    // A tab with an open watch stays, for the watch to be taken from.
    if (tab.watches.size === 0) tabs.delete(tabId);
  };

  const namedTo = (held, frameId) =>
    held.waitsFor === null && !(held.frame === frameId && !held.handedOver);

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
      if (typeof code !== 'string' || code === '') return;
      if (typeof key !== 'string' || key === '') return;
      const tab = tabOf(tabId);
      tab.keys.delete(code);
      tab.keys.set(code, {
        name: key,
        frame: frameId,
        origin: frameId,
        waitsFor: null,
        handedOver: false,
        underMeta: report.underMeta === true,
      });
      return;
    }
    const tab = tabs.get(tabId);
    if (!tab) return;
    if (event === 'up') {
      if (typeof code === 'string') drop(tab, code, frameId);
    } else if (event === 'metaup') {
      dropWhere(tab, (held) => held.underMeta, frameId);
    } else if (event === 'press') {
      // Keys that waited for the focus of an earlier press never got it.
      dropWhere(tab, (held) => held.waitsFor !== null, frameId);
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
        if (pressedElsewhere) {
          held.waitsFor = tab.pressed;
          // An action the pressed frame made at its press came before this
          // blur, which the press caused: its watch keeps the key.
          unname(tab, code, frameId, tab.pressed);
        } else {
          drop(tab, code, frameId);
        }
      }
      if (tab.pressed === frameId) tab.pressed = null;
    } else if (event === 'clear') {
      dropTab(tabId, frameId);
    }
  }

  /**
   * Open a watch for an action of `frameId` that is stored later: the keys
   * held in the tab that the action does not know of itself (those of the
   * tab's other frames, and those handed over to this frame), as they stand
   * now, less those that stop being known to be down before the watch is
   * taken other than by this frame's own later reports. `exceptCode` is the
   * key the action itself is about.
   *
   * @param {number} tabId
   * @param {number} frameId
   * @param {string} [exceptCode]
   * @returns {{ take: () => string[] }} `take` gives the names in the order
   *   the keys went down, and ends the watch
   */
  function watch(tabId, frameId, exceptCode) {
    const tab = tabs.get(tabId);
    const names = new Map();
    if (!tab) return { take: () => [] };
    for (const [code, held] of tab.keys) {
      if (code !== exceptCode && namedTo(held, frameId)) names.set(code, held.name);
    }
    const open = { frame: frameId, names };
    tab.watches.add(open);
    return {
      take() {
        tab.watches.delete(open);
        if (tab.keys.size === 0 && tab.watches.size === 0 && tabs.get(tabId) === tab) {
          tabs.delete(tabId);
        }
        return [...names.values()];
      },
    };
  }

  /** The keys a watch opened and taken now gives. */
  function heldElsewhere(tabId, frameId, exceptCode) {
    return watch(tabId, frameId, exceptCode).take();
  }

  /**
   * A frame is gone, or does not answer: the keys it holds, those it first
   * reported, and those that waited for it are forgotten.
   */
  function forgetFrame(tabId, frameId) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    dropWhere(
      tab,
      (held) => held.frame === frameId || held.origin === frameId || held.waitsFor === frameId,
    );
    if (tab.pressed === frameId) tab.pressed = null;
  }

  function forgetTab(tabId) {
    dropTab(tabId);
  }

  function forgetAll() {
    for (const tabId of [...tabs.keys()]) dropTab(tabId);
  }

  return { report, watch, heldElsewhere, forgetFrame, forgetTab, forgetAll };
}
