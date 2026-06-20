/**
 * frame-trust.js — Pure sender-trust decision for captured actions.
 *
 * The recorder is injected only into frames of tabs we are actively recording
 * (the service worker tracks those frames in an active-frame registry). An
 * `APPEND_ACTION` message must therefore come from a frame we injected into,
 * during a live recording, from our own extension — otherwise a page that can
 * reach the extension's message port could inject arbitrary actions into a
 * session (an embedded ad / analytics / third-party widget).
 *
 * Extracted from service-worker.js for unit testability, mirroring
 * navigation-logic.js: a pure predicate over plain data, with no chrome.*
 * side-effects. The service worker owns the `activeFrames` Map (and the
 * lazy-reseed escape hatch after an SW restart); this only decides trust.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

/**
 * Decide whether an APPEND_ACTION sender is a trusted, recorded frame.
 *
 * @param {object} params
 * @param {object} params.sender — chrome.runtime message sender
 * @param {string} [params.sender.id] — sending extension's id
 * @param {number} [params.sender.frameId] — frame the message came from
 * @param {object} [params.sender.tab] — tab the message came from
 * @param {number} [params.sender.tab.id] — tab id
 * @param {string} params.runtimeId — our own chrome.runtime.id
 * @param {boolean} params.liveRecording — whether a recording is active
 * @param {Map<number, Set<number>>} params.activeFrames — tabId → injected frameIds
 * @returns {boolean} true only if the message is from our own extension, during
 *   a live recording, from a frame of a tab we are actively recording.
 */
export function isTrustedActionSender({ sender, runtimeId, liveRecording, activeFrames }) {
  // Must be our own extension's content script — not another extension or a
  // page reaching the message port.
  if (!sender || sender.id !== runtimeId) return false;

  // Only ever trusted while a recording is live.
  if (liveRecording !== true) return false;

  // Must originate from a tab we are recording.
  const tabId = sender.tab?.id;
  if (tabId == null) return false;
  const frames = activeFrames.get(tabId);
  if (!frames) return false;

  // Must originate from a specific frame we injected into.
  return frames.has(sender.frameId);
}
