/**
 * Docent — Content Script Recorder
 *
 * Observes user interactions in the active tab and writes them directly
 * to chrome.storage.local. The service worker is not involved in action
 * capture — this makes recording resilient to SW suspension.
 *
 * Every action is stamped with tab_id so the receiving system knows which tab
 * each action occurred on. Runs in all frames (all_frames: true) so
 * interactions inside iframes are also captured.
 *
 * Captures:
 *   - clicks (interactive elements + fallback to any clicked element)
 *   - keyboard: Enter/Escape/Tab/arrow keys on interactive elements
 *   - text input (value on change)
 *   - file uploads
 *   - select changes
 *   - drag and drop (dragstart + drop)
 *   - right-click / context menu
 *   - focus (on inputs, to capture autocomplete triggers)
 *   - scroll (debounced, significant scrolls only)
 *   - in-page navigations (pushState, replaceState, popstate)
 *
 * Cross-document navigations, tab lifecycle events (open/close/switch),
 * back/forward, and reload are captured by the service worker via
 * webNavigation and tabs APIs.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

(function () {
  'use strict';

  let active = false;
  let tabId  = null;

  // Guard against double-injection — if already loaded, skip re-initialisation
  if (window.__docentLoaded) return;
  window.__docentLoaded = true;

  // Whether this script is running inside an iframe
  const isIframe = window !== window.top;
  // Capture iframe src for context
  const frameSrc = isIframe ? location.href : null;

  // ─── Activation ─────────────────────────────────────────────────────────────

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.recording) {
      active = changes.recording.newValue === true;
    }
  });

  chrome.storage.local.get('recording', ({ recording }) => {
    active = recording === true;
  });

  // Content scripts can't use chrome.tabs.getCurrent() reliably —
  // ask the SW for our tab ID via a one-time message instead.
  chrome.runtime.sendMessage({ type: 'GET_TAB_ID' }, (response) => {
    tabId = response?.tabId ?? null;
  });

  // ─── Action writer ────────────────────────────────────────────────────────────
  // Writes actions directly to chrome.storage.local (available in content scripts).
  // Uses a serialised queue to prevent race conditions on rapid actions.

  let writeQueue = Promise.resolve();

  function appendAction(action) {
    const stamped = { ...action, tab_id: tabId, frame_src: frameSrc };
    writeQueue = writeQueue.then(() =>
      chrome.storage.local.get('pendingActions').then(({ pendingActions }) => {
        const updated = [...(pendingActions ?? []), stamped];
        return chrome.storage.local.set({
          pendingActions: updated,
          pendingCount:   updated.length,
        });
      })
    );
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  function selectorFor(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;

    const parts = [];
    let node  = el;
    let depth = 0;

    while (node && node !== document.body && depth < 3) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const siblings = Array.from(node.parentElement?.children ?? [])
        .filter(c => c.tagName === node.tagName);
      if (siblings.length > 1) {
        part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = node.parentElement;
      depth++;
    }

    return parts.join(' > ');
  }

  function describeElement(el) {
    const isPassword = el.type === 'password';
    return {
      tag:      el.tagName,
      id:       el.id || null,
      name:     el.getAttribute('name') || null,
      role:     el.getAttribute('role') || null,
      type:     el.getAttribute('type') || null,
      text:     isPassword ? null : (el.innerText ?? el.value ?? '').trim().slice(0, 100) || null,
      selector: selectorFor(el),
    };
  }

  // ─── Click capture ────────────────────────────────────────────────────────────
  // Tries to find a known interactive ancestor first. Falls back to the
  // clicked element itself so custom components and web components are captured.

  const INTERACTIVE = [
    'a', 'button', 'label', 'select',
    '[role="button"]', '[role="option"]', '[role="menuitem"]', '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]', '[role="listitem"]', '[role="tab"]', '[role="checkbox"]',
    '[role="radio"]', '[role="switch"]', '[role="treeitem"]', '[role="gridcell"]',
    'input[type="submit"]', 'input[type="button"]', 'input[type="checkbox"]',
    'input[type="radio"]', 'input[type="reset"]',
  ].join(', ');

  let lastClickedEl = null;
  let lastClickTime = 0;

  document.addEventListener('click', (e) => {
    if (!active) return;
    const el = e.target.closest(INTERACTIVE) ?? e.target;
    if (el === document.body || el === document.documentElement) return;
    lastClickedEl = e.target; // track raw target for focus deduplication
    lastClickTime = Date.now();
    appendAction({
      type:      'click',
      timestamp: Date.now(),
      x:         e.clientX,
      y:         e.clientY,
      element:   describeElement(el),
    });
  }, { capture: true, passive: true });

  // ─── Right-click / context menu ───────────────────────────────────────────────

  document.addEventListener('contextmenu', (e) => {
    if (!active) return;
    const el = e.target.closest(INTERACTIVE) ?? e.target;
    if (el === document.body || el === document.documentElement) return;
    appendAction({
      type:      'right_click',
      timestamp: Date.now(),
      x:         e.clientX,
      y:         e.clientY,
      element:   describeElement(el),
    });
  }, { capture: true, passive: true });

  // ─── Keyboard capture ─────────────────────────────────────────────────────────
  // Captures meaningful key presses on interactive elements:
  //   Enter  — form submission, button activation
  //   Escape — modal/dialog/dropdown dismiss
  //   Tab    — focus navigation
  //   Arrow keys — list/menu/slider navigation

  const CAPTURE_KEYS = new Set(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

  document.addEventListener('keydown', (e) => {
    if (!active) return;
    if (!CAPTURE_KEYS.has(e.key)) return;
    const el = document.activeElement;
    if (!el || el === document.body) return;
    appendAction({
      type:      'key',
      timestamp: Date.now(),
      key:       e.key,
      modifiers: {
        ctrl:  e.ctrlKey,
        shift: e.shiftKey,
        alt:   e.altKey,
        meta:  e.metaKey,
      },
      element: describeElement(el),
    });
  }, { capture: true, passive: true });

  // ─── Text input & file upload capture ────────────────────────────────────────

  document.addEventListener('change', (e) => {
    if (!active) return;
    const el = e.target;

    if (el.tagName === 'SELECT') {
      appendAction({
        type:      'select',
        timestamp: Date.now(),
        element:   describeElement(el),
        value:     el.options[el.selectedIndex]?.text ?? el.value,
      });
      return;
    }

    if (el.tagName === 'INPUT' && el.type === 'file') {
      const files = Array.from(el.files ?? []).map(f => ({
        name: f.name,
        size: f.size,
        mime: f.type,
      }));
      appendAction({
        type:      'file_upload',
        timestamp: Date.now(),
        element:   describeElement(el),
        files,
      });
      return;
    }

    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const isPassword = el.type === 'password';
      appendAction({
        type:      'type',
        timestamp: Date.now(),
        element:   describeElement(el),
        value:     isPassword ? '••••••••' : el.value,
      });
    }
  }, { capture: true, passive: true });

  // ─── Focus capture ────────────────────────────────────────────────────────────
  // Records focus only when NOT caused by a click on the same element.
  // focusin fires before click, so we defer 50ms to let the click register first.
  // Focus from Tab navigation or programmatic focus is kept.

  document.addEventListener('focusin', (e) => {
    if (!active) return;
    const el = e.target;
    const isInput = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ||
                    el.getAttribute('contenteditable') === 'true' ||
                    el.getAttribute('contenteditable') === '';
    if (!isInput) return;
    if (el.type === 'password') return;
    const capturedEl = el;
    setTimeout(() => {
      if (!active) return;
      if (capturedEl === lastClickedEl && Date.now() - lastClickTime < 150) return;
      appendAction({
        type:      'focus',
        timestamp: Date.now(),
        element:   describeElement(capturedEl),
      });
    }, 50);
  }, { capture: true, passive: true });

  // ─── Drag and drop capture ────────────────────────────────────────────────────

  let dragSource = null;

  document.addEventListener('dragstart', (e) => {
    if (!active) return;
    dragSource = e.target;
    appendAction({
      type:      'drag_start',
      timestamp: Date.now(),
      element:   describeElement(e.target),
    });
  }, { capture: true, passive: true });

  document.addEventListener('drop', (e) => {
    if (!active) return;
    appendAction({
      type:        'drop',
      timestamp:   Date.now(),
      element:     describeElement(e.target),
      source_element: dragSource ? describeElement(dragSource) : null,
      x:           e.clientX,
      y:           e.clientY,
    });
    dragSource = null;
  }, { capture: true, passive: true });

  document.addEventListener('dragend', () => {
    dragSource = null;
  }, { capture: true, passive: true });

  // ─── Scroll capture ───────────────────────────────────────────────────────────
  // Debounced — only records when scrolling stops, and only if the scroll
  // distance is significant (>200px) to avoid noise from minor adjustments.

  let scrollTimer   = null;
  let scrollStartY  = null;
  let scrollStartX  = null;

  document.addEventListener('scroll', (e) => {
    if (!active) {
      // Reset baseline if recording is paused mid-scroll
      scrollStartY = null;
      scrollStartX = null;
      return;
    }
    const el = e.target === document ? document.documentElement : e.target;

    if (scrollStartY === null) {
      scrollStartY = el.scrollTop;
      scrollStartX = el.scrollLeft;
    }

    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const deltaY = Math.abs(el.scrollTop  - scrollStartY);
      const deltaX = Math.abs(el.scrollLeft - scrollStartX);
      if (deltaY > 200 || deltaX > 200) {
        appendAction({
          type:       'scroll',
          timestamp:  Date.now(),
          element:    el === document.documentElement ? null : describeElement(el),
          scroll_top: el.scrollTop,
          scroll_left: el.scrollLeft,
          delta_y:    el.scrollTop  - scrollStartY,
          delta_x:    el.scrollLeft - scrollStartX,
        });
      }
      scrollStartY = null;
      scrollStartX = null;
    }, 300);
  }, { capture: true, passive: true });

  // ─── In-page navigation capture ───────────────────────────────────────────────
  // Handles SPA pushState/replaceState/popstate navigations.
  // Cross-document navigations are handled by the SW via webNavigation.onCommitted.
  // Skip navigation capture inside iframes — the SW handles those via webNavigation.

  if (!isIframe) {
    let lastNavUrl = null;

    function sendNavigate(url) {
      if (!active) return;
      const normalised = url.replace(/\/$/, '');
      if (normalised === lastNavUrl) return;
      lastNavUrl = normalised;
      appendAction({ type: 'navigate', nav_type: 'spa', timestamp: Date.now(), url });
    }

    window.addEventListener('load', () => sendNavigate(location.href));

    if (window.navigation) {
      window.navigation.addEventListener('navigatesuccess', () => {
        if (window.navigation.currentEntry?.sameDocument === false) return;
        sendNavigate(location.href);
      });
    } else {
      const originalPush    = history.pushState.bind(history);
      const originalReplace = history.replaceState.bind(history);
      history.pushState = function (...args) {
        originalPush(...args);
        sendNavigate(location.href);
      };
      history.replaceState = function (...args) {
        originalReplace(...args);
        sendNavigate(location.href);
      };
      window.addEventListener('popstate', () => sendNavigate(location.href));
    }
  }

})();
