/**
 * Docent — Content Script Recorder
 *
 * Observes user interactions in the active tab and writes them directly
 * to chrome.storage.local. The service worker is not involved in action
 * capture — this makes recording resilient to SW suspension.
 *
 * Every action is stamped with context_id so the receiving system knows which tab
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

  // ─── Timing Constants ───────────────────────────────────────────────────────
  // Source of truth: lib/capture-timing.js
  // Content scripts can't use ES imports, so values are duplicated here.
  const ENTER_SYNTHETIC_CLICK_WINDOW = 50;
  const SELECT_SYNTHETIC_CLICK_WINDOW = 50;
  const TAB_FOCUS_CORRELATION_WINDOW = 150;
  const CLICK_FOCUS_DEDUP_WINDOW = 100;

  let active = false;
  let tabId  = null;
  let lastUserActionTimestamp = 0;

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

  // ─── User action timestamp tracking ──────────────────────────────────────────
  // Shared signal so the service worker can correlate browser events with
  // recent in-page user actions. Written to chrome.storage.local with debouncing.

  function scheduleTimestampSync() {
    // Write immediately to ensure the service worker can read the timestamp
    // before any navigation events fire.
    chrome.storage.local.set({ lastUserActionTimestamp });
  }

  function markUserAction() {
    lastUserActionTimestamp = Date.now();
    scheduleTimestampSync();
  }

  // ─── Action writer ────────────────────────────────────────────────────────────
  // Sends actions to the service worker for serialized storage writes.
  // This ensures that clearPendingActions (which also runs in the SW) is properly
  // serialized with action appends, preventing race conditions.

  function appendAction(action) {
    const stamped = { ...action, context_id: tabId, capture_mode: 'dom', window_rect: null, frame_src: frameSrc };
    chrome.runtime.sendMessage({ type: 'APPEND_ACTION', action: stamped });
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
  let lastKeyEnterTimestamp = 0;
  let lastTabKeyTimestamp = 0;
  let lastSelectTimestamp = 0;
  let lastFileInputClickEl = null;
  let lastFileInputClickTime = 0;
  let lastMousedownTime = 0;
  let lastMousedownEl = null;

  // Track mousedown for blur-caused change suppression.
  // When clicking a different element, the sequence is:
  // mousedown → blur → change → focus → mouseup → click
  // We need to know about the mousedown BEFORE the change fires.
  document.addEventListener('mousedown', (e) => {
    if (!active) return;
    if (!e.isTrusted) return;
    lastMousedownTime = Date.now();
    lastMousedownEl = e.target;
  }, { capture: true, passive: true });

  document.addEventListener('click', (e) => {
    if (!active) return;
    if (!e.isTrusted) return;
    if (e.detail === 0 && lastKeyEnterTimestamp > 0 && Date.now() - lastKeyEnterTimestamp < ENTER_SYNTHETIC_CLICK_WINDOW) return;
    // Suppress synthetic clicks from native select confirmation (Enter/click on option)
    if (e.detail === 0 && lastSelectTimestamp > 0 && Date.now() - lastSelectTimestamp < SELECT_SYNTHETIC_CLICK_WINDOW) return;
    const el = e.target.closest(INTERACTIVE) ?? e.target;
    if (el === document.body || el === document.documentElement) return;
    lastClickedEl = e.target; // track raw target for focus deduplication
    lastClickTime = Date.now();
    // Track file input clicks for file_upload correlation
    if (el.tagName === 'INPUT' && el.type === 'file') {
      lastFileInputClickEl = el;
      lastFileInputClickTime = Date.now();
    }
    appendAction({
      type:      'click',
      timestamp: Date.now(),
      x:         e.clientX,
      y:         e.clientY,
      element:   describeElement(el),
    });
    markUserAction();
  }, { capture: true, passive: true });

  // ─── Right-click / context menu ───────────────────────────────────────────────

  document.addEventListener('contextmenu', (e) => {
    if (!active) return;
    if (!e.isTrusted) return;
    const el = e.target.closest(INTERACTIVE) ?? e.target;
    if (el === document.body || el === document.documentElement) return;
    appendAction({
      type:      'right_click',
      timestamp: Date.now(),
      x:         e.clientX,
      y:         e.clientY,
      element:   describeElement(el),
    });
    markUserAction();
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
    if (!e.isTrusted) return;
    if (!CAPTURE_KEYS.has(e.key)) return;
    // Set Tab timestamp BEFORE the body check — focus after Tab on body
    // still needs to be captured (it tells us where focus went).
    if (e.key === 'Tab') lastTabKeyTimestamp = Date.now();
    const el = document.activeElement;
    // Allow Tab even when body is focused — the user pressed Tab to navigate.
    if (!el || (el === document.body && e.key !== 'Tab')) return;
    if (e.key === 'Enter') lastKeyEnterTimestamp = Date.now();
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
      element: el === document.body ? { tag: 'BODY', id: null, name: null, role: null, type: null, text: null, selector: 'body' } : describeElement(el),
    });
    markUserAction();
  }, { capture: true, passive: true });

  // ─── Text input & file upload capture ────────────────────────────────────────

  document.addEventListener('change', (e) => {
    if (!active) return;
    if (document.visibilityState === 'hidden') return;
    const el = e.target;

    // File inputs: allow if preceded by a click on the same file input (user selected via dialog).
    // Playwright's fileChooser.setFiles() produces untrusted change events, but the preceding
    // click on the file input is trusted and already captured.
    if (el.tagName === 'INPUT' && el.type === 'file') {
      if (el === lastFileInputClickEl && Date.now() - lastFileInputClickTime < 10000) {
        const files = Array.from(el.files ?? []).map(f => ({
          name: f.name,
          size: f.size,
          mime: f.type,
        }));
        if (files.length > 0) {
          appendAction({
            type:      'file_upload',
            timestamp: Date.now(),
            element:   describeElement(el),
            files,
          });
        }
      }
      return;
    }

    if (!e.isTrusted) return;

    if (el.tagName === 'SELECT') {
      lastSelectTimestamp = Date.now();
      appendAction({
        type:      'select',
        timestamp: Date.now(),
        element:   describeElement(el),
        value:     el.options[el.selectedIndex]?.text ?? el.value,
      });
      return;
    }

    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      // Suppress change events caused by blur from clicking a submit button within the same form.
      // When the user clicks submit, the input blurs and fires change. But the user's
      // intent is captured by the click — the type was already captured earlier (or will
      // be captured when the user explicitly tabs/clicks away without submitting).
      // Event order: mousedown(submit) → blur(input) → change(input) → click(submit)
      if (lastMousedownEl && lastMousedownEl !== el && Date.now() - lastMousedownTime < 100) {
        const form = el.closest?.('form');
        if (form && form.contains(lastMousedownEl)) {
          const isSubmit = lastMousedownEl.closest?.('button[type="submit"], input[type="submit"]');
          if (isSubmit) return;
        }
      }
      const isPassword = el.type === 'password';
      appendAction({
        type:      'type',
        timestamp: Date.now(),
        element:   describeElement(el),
        value:     isPassword ? '••••••••' : el.value,
      });
      markUserAction();
    }
  }, { capture: true, passive: true });

  // ─── Focus capture ────────────────────────────────────────────────────────────
  // Records focus only when correlated with a preceding Tab key press within 200ms.
  // Click-caused focus is suppressed (click already captures the action).
  // Programmatic focus (element.focus()) is not captured.

  document.addEventListener('focusin', (e) => {
    if (!active) return;
    if (document.visibilityState === 'hidden') return;
    const el = e.target;
    const isInput = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ||
                    el.getAttribute('contenteditable') === 'true' ||
                    el.getAttribute('contenteditable') === '';
    if (!isInput) return;
    if (el.type === 'password') return;
    const capturedEl = el;
    setTimeout(() => {
      if (!active) return;
      // Only record focus if it follows a Tab key press within 200ms
      if (Date.now() - lastTabKeyTimestamp > TAB_FOCUS_CORRELATION_WINDOW) return;
      // Suppress click-caused focus on the same element (click already captures the action)
      if (capturedEl === lastClickedEl && Date.now() - lastClickTime < CLICK_FOCUS_DEDUP_WINDOW) return;
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
    if (!e.isTrusted) return;
    dragSource = e.target;
    appendAction({
      type:      'drag_start',
      timestamp: Date.now(),
      element:   describeElement(e.target),
    });
    markUserAction();
  }, { capture: true, passive: true });

  // Allow drop on any element when we have an active drag source.
  // Without this, the browser won't fire the 'drop' event (HTML5 DnD spec
  // requires dragover to be cancelled for drop to fire).
  document.addEventListener('dragover', (e) => {
    if (!active) return;
    if (!dragSource) return;
    e.preventDefault();
  }, { capture: true });

  document.addEventListener('drop', (e) => {
    if (!active) return;
    // Allow drop if we have an active drag source from a trusted dragstart,
    // even if the drop event itself is untrusted (Playwright simulation).
    if (!e.isTrusted && !dragSource) return;
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
        markUserAction();
      }
      scrollStartY = null;
      scrollStartX = null;
    }, 300);
  }, { capture: true, passive: true });

  // ─── Contenteditable capture ──────────────────────────────────────────────────
  // Captures typing in contenteditable elements via the input event.
  // Debounced at 500ms — records the final text when typing pauses.
  // Flushes immediately on blur so no input is lost when the user leaves the field.

  let contenteditableTimer = null;
  let contenteditableEl = null;

  document.addEventListener('input', (e) => {
    if (!active) return;
    if (!e.isTrusted) return;
    if (document.visibilityState === 'hidden') return;
    const el = e.target;
    if (el.getAttribute('contenteditable') !== 'true' &&
        el.getAttribute('contenteditable') !== '') return;

    contenteditableEl = el;
    clearTimeout(contenteditableTimer);
    contenteditableTimer = setTimeout(() => {
      if (!active) return;
      appendAction({
        type: 'type',
        timestamp: Date.now(),
        element: describeElement(contenteditableEl),
        value: contenteditableEl.innerText.trim().slice(0, 500),
      });
      markUserAction();
      contenteditableEl = null;
      contenteditableTimer = null;
    }, 500);
  }, { capture: true, passive: true });

  document.addEventListener('blur', (e) => {
    if (!contenteditableTimer || !contenteditableEl) return;
    if (e.target !== contenteditableEl) return;
    clearTimeout(contenteditableTimer);
    if (!active) { contenteditableEl = null; contenteditableTimer = null; return; }
    appendAction({
      type: 'type',
      timestamp: Date.now(),
      element: describeElement(contenteditableEl),
      value: contenteditableEl.innerText.trim().slice(0, 500),
    });
    markUserAction();
    contenteditableEl = null;
    contenteditableTimer = null;
  }, { capture: true, passive: true });

})();
