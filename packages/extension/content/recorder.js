/**
 * Docent — Content Script Recorder
 *
 * Observes user interactions in the active tab and writes them directly
 * to chrome.storage.local. The service worker is not involved in action
 * capture — this makes recording resilient to SW suspension.
 *
 * Every action is stamped with context_id so the receiving system knows which tab
 * each action occurred on. Injected programmatically into all frames while
 * recording (by the service worker, on record-start and on each frame load) so
 * interactions inside iframes are also captured — there is no passive recorder
 * present on any page when no recording is active.
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
// Governance declared in scripts/area-map.json (see its declared-governance entry): the actions this recorder captures enter the .docent.json action stream; the per-platform schemas are authoritative for field semantics.

(function () {
  'use strict';

  // ─── Timing Constants ───────────────────────────────────────────────────────
  // Source of truth: lib/capture-timing.js
  // Content scripts can't use ES imports, so values are duplicated here.
  // The scroll handler below additionally duplicates SCROLL_DEBOUNCE (300) and
  // SCROLL_MIN_DISTANCE_PX (200) inline at its setTimeout/threshold sites.
  const ENTER_SYNTHETIC_CLICK_WINDOW = 50;
  const SELECT_SYNTHETIC_CLICK_WINDOW = 50;
  const TAB_FOCUS_CORRELATION_WINDOW = 150;
  const CLICK_FOCUS_DEDUP_WINDOW = 100;

  let active = false;
  let tabId = null;
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
    const stamped = {
      ...action,
      context_id: tabId,
      capture_mode: 'dom',
      frame_src: frameSrc,
    };
    chrome.runtime.sendMessage({ type: 'APPEND_ACTION', action: stamped });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  // -- BEGIN MIRRORED CAPTURE LOGIC (two-copy: recorder.js <-> recorder-logic.js; parity-tested) --

  /**
   * Test-hook attributes recognised for the `test_id` locator strategy, in
   * precedence order — the first attribute present on the element wins and is
   * recorded in the entry's `attribute` field. A fixed list by design; the
   * emitted entry always says which attribute matched.
   */
  const TEST_ID_ATTRS = ['data-testid', 'data-test', 'data-test-id', 'data-qa', 'data-cy'];

  /**
   * Cost cap for measuring the `text` strategy: reading `innerText` forces
   * layout per element, so when more than this many same-tag elements exist the
   * text candidate ships value-only (pair absent = not measured — the schema's
   * cheapness rule).
   */
  const TEXT_MEASURE_MAX = 100;

  /**
   * Hard cap on uniqueness probes per selector derivation. Typical pages resolve
   * in 1-3 probes; past the cap, derivation jumps straight to the positional
   * fallback path.
   */
  const MAX_UNIQUENESS_PROBES = 25;

  /**
   * Escape a string for use as a CSS identifier (e.g. in `#id` selectors),
   * per the CSSOM "serialize an identifier" algorithm — the same algorithm as
   * the browser's native CSS.escape(). Hand-rolled in BOTH copies so the two
   * files stay byte-identical and Node tests exercise the exact shipped code
   * (a digit-leading id like "123abc" must serialize as "\31 23abc"; the old
   * regex escape produced the invalid selector "#123abc", which throws).
   *
   * @param {string} value
   * @returns {string}
   */
  function cssEscape(value) {
    const s = String(value);
    const first = s.charCodeAt(0);
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code === 0x0000) {
        out += '�';
        continue;
      }
      if (
        (code >= 0x0001 && code <= 0x001f) ||
        code === 0x007f ||
        (i === 0 && code >= 0x0030 && code <= 0x0039) ||
        (i === 1 && code >= 0x0030 && code <= 0x0039 && first === 0x002d)
      ) {
        out += `\\${code.toString(16)} `;
        continue;
      }
      if (i === 0 && s.length === 1 && code === 0x002d) {
        out += `\\${s.charAt(i)}`;
        continue;
      }
      if (
        code >= 0x0080 ||
        code === 0x002d ||
        code === 0x005f ||
        (code >= 0x0030 && code <= 0x0039) ||
        (code >= 0x0041 && code <= 0x005a) ||
        (code >= 0x0061 && code <= 0x007a)
      ) {
        out += s.charAt(i);
        continue;
      }
      out += `\\${s.charAt(i)}`;
    }
    return out;
  }

  /**
   * Escape a string for use inside a double-quoted CSS attribute value,
   * e.g. `[data-testid="…"]`.
   *
   * @param {string} value
   * @returns {string}
   */
  function cssString(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ');
  }

  /**
   * The CSS type selector for an element: lower-cased for HTML-namespace
   * elements, case-preserved for foreign (e.g. SVG) elements — CSS matches
   * foreign type selectors case-sensitively, so `clipPath` must stay `clipPath`.
   *
   * @param {object} el — DOM-like element
   * @returns {string}
   */
  function tagSelectorFor(el) {
    const ns = el.namespaceURI;
    return ns && ns !== 'http://www.w3.org/1999/xhtml' ? el.tagName : el.tagName.toLowerCase();
  }

  /**
   * Docent's stated text-normalization predicate: leading/trailing whitespace
   * removed, internal whitespace runs collapsed to single spaces.
   *
   * @param {string} s
   * @returns {string}
   */
  function normalizeText(s) {
    return String(s).trim().replace(/\s+/g, ' ');
  }

  /**
   * THE single measurement path for locator match statistics and selector
   * uniqueness probes: evaluate `selector` against the element's document root
   * (standard non-piercing matching, document order) and report how many
   * elements matched and where the acted-on element sits among them.
   *
   * Returns null when not measurable: no queryable document (legacy doubles),
   * an invalid selector (querySelectorAll throws), or a zero-count result —
   * the schema's minimum for match_count is 1, and an absent pair means
   * "not measured, never a guess". Zero counts arise for shadow-tree targets,
   * which document-rooted non-piercing matching cannot see.
   *
   * @param {object|null} doc — the element's ownerDocument (or a test double)
   * @param {string} selector
   * @param {object} el — the acted-on element
   * @returns {{ match_count: number, match_index: number|null } | null}
   */
  function matchStats(doc, selector, el) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return null;
    let list;
    try {
      list = doc.querySelectorAll(selector);
    } catch {
      return null;
    }
    if (!list || list.length === 0) return null;
    const i = Array.prototype.indexOf.call(list, el);
    return { match_count: list.length, match_index: i === -1 ? null : i };
  }

  /**
   * The per-level selector segment, most-semantic first: `#id`, else
   * `tag[test-attr="value"]` for the first present test-hook attribute,
   * else the plain type selector.
   *
   * @param {object} node — DOM-like element
   * @returns {string}
   */
  function segmentFor(node) {
    if (node.id) return `#${cssEscape(node.id)}`;
    const tag = tagSelectorFor(node);
    for (const attr of TEST_ID_ATTRS) {
      const v = node.getAttribute?.(attr);
      if (v) return `${tag}[${attr}="${cssString(v)}"]`;
    }
    return tag;
  }

  /**
   * Append `:nth-of-type(n)` to a segment when the node has same-tag siblings
   * (position is meaningful only then). Id segments never take a position —
   * an id is already the strongest anchor a level can have.
   *
   * @param {object} node — DOM-like element
   * @param {string} seg — the segment from segmentFor(node)
   * @returns {string}
   */
  function withNthOfType(node, seg) {
    if (seg.startsWith('#')) return seg;
    const siblings = Array.from(node.parentElement?.children ?? []).filter(
      (c) => c.tagName === node.tagName,
    );
    return siblings.length > 1 ? `${seg}:nth-of-type(${siblings.indexOf(node) + 1})` : seg;
  }

  /**
   * Build a CSS selector for an element — uniqueness-aware (docent#172).
   *
   * Tier 1: walk up from the element toward document.body, one level at a time,
   * building a path of semantic segments (id / test-attribute / tag) and probing
   * for uniqueness after each level — stop deepening the moment the path
   * uniquely selects the element. A level with a UNIQUE id pins its subtree
   * (ancestors above it can never shrink the match set), so the walk stops
   * there; a duplicated id is walked past.
   * Tier 2: only if no semantic path was unique, refine ambiguous levels with
   * `:nth-of-type`, deepest first, probing after each — position is strictly
   * the last resort.
   * Tier 3: nothing unique (or no queryable document): the fully positional
   * path — still a faithful observation of where the element sat.
   *
   * Uniqueness means `match_count === 1 && match_index === 0`: the `list[0] ===
   * el` half is load-bearing — it makes it impossible to return a "unique"
   * selector that actually selects a DIFFERENT element (e.g. for shadow-tree
   * targets, which document-scoped matching cannot see).
   *
   * The walk is bounded by document.body; the element being body itself yields
   * the fixed name `'body'`, never an empty string.
   *
   * @param {object} el — DOM-like element
   * @returns {string} CSS selector
   */
  function selectorFor(el) {
    const doc = el.ownerDocument ?? null;
    const body = doc ? (doc.body ?? null) : null;
    if (body && el === body) return 'body';

    const isOnly = (sel) => {
      const s = matchStats(doc, sel, el);
      return !!s && s.match_count === 1 && s.match_index === 0;
    };

    const semantic = [];
    const positional = [];
    let node = el;
    let probes = 0;

    while (node && node !== body) {
      const seg = segmentFor(node);
      semantic.unshift(seg);
      positional.unshift(withNthOfType(node, seg));
      if (probes++ < MAX_UNIQUENESS_PROBES && isOnly(semantic.join(' > '))) {
        return semantic.join(' > ');
      }
      if (node.id) {
        const idStats = matchStats(doc, `#${cssEscape(node.id)}`, node);
        if (!idStats || idStats.match_count === 1) break;
      }
      node = node.parentElement;
    }

    const mixed = semantic.slice();
    for (let i = mixed.length - 1; i >= 0; i--) {
      if (positional[i] === semantic[i]) continue;
      mixed[i] = positional[i];
      if (probes++ < MAX_UNIQUENESS_PROBES && isOnly(mixed.join(' > '))) {
        return mixed.join(' > ');
      }
    }

    return positional.join(' > ');
  }

  /**
   * Build the element's locator candidates (docent#132): observed facts about
   * how the element could be addressed, each with the measured
   * match_count/match_index pair where cheap to measure (absent = not
   * measured). Entries follow the schema's declaration order; empty-valued
   * candidates are omitted.
   *
   * The `text` value is the element's rendered text only (never a form
   * control's value — not rendered text, so typed secrets cannot enter
   * locators), emitted only when non-empty and at most 100 chars normalized;
   * its statistics count same-tag elements with equal normalized text,
   * reusing the tag_name query's NodeList (zero extra queries).
   *
   * @param {object} el — DOM-like element
   * @param {string} selector — the derived CSS selector (measured as the css entry)
   * @returns {object[]} locator entries (possibly empty)
   */
  function buildLocators(el, selector) {
    const doc = el.ownerDocument ?? null;
    const locators = [];
    const add = (entry, stats) => {
      if (stats) {
        entry.match_count = stats.match_count;
        entry.match_index = stats.match_index;
      }
      locators.push(entry);
    };

    if (el.id) {
      // Attribute-equality selector, NOT getElementById: duplicate ids are
      // illegal-but-common and the whole point is counting them.
      add({ strategy: 'id', value: el.id }, matchStats(doc, `[id="${cssString(el.id)}"]`, el));
    }

    for (const attr of TEST_ID_ATTRS) {
      const v = el.getAttribute?.(attr);
      if (v) {
        add(
          { strategy: 'test_id', attribute: attr, value: v },
          matchStats(doc, `[${attr}="${cssString(v)}"]`, el),
        );
        break;
      }
    }

    const nameVal = el.getAttribute?.('name');
    if (nameVal) {
      add(
        { strategy: 'name', value: nameVal },
        matchStats(doc, `[name="${cssString(nameVal)}"]`, el),
      );
    }

    const tagSel = tagSelectorFor(el);
    let tagList = null;
    if (doc && typeof doc.querySelectorAll === 'function') {
      try {
        tagList = doc.querySelectorAll(tagSel);
      } catch {
        tagList = null;
      }
    }
    {
      let stats = null;
      if (tagList && tagList.length > 0) {
        const i = Array.prototype.indexOf.call(tagList, el);
        stats = { match_count: tagList.length, match_index: i === -1 ? null : i };
      }
      add({ strategy: 'tag_name', value: tagSel }, stats);
    }

    const rawText = el.innerText;
    if (rawText != null) {
      const textVal = normalizeText(rawText);
      if (textVal && textVal.length <= 100) {
        let stats = null;
        if (tagList && tagList.length > 0 && tagList.length <= TEXT_MEASURE_MAX) {
          const matches = [];
          for (let i = 0; i < tagList.length; i++) {
            if (normalizeText(tagList[i].innerText ?? '') === textVal) matches.push(tagList[i]);
          }
          if (matches.length > 0) {
            const idx = matches.indexOf(el);
            stats = { match_count: matches.length, match_index: idx === -1 ? null : idx };
          }
        }
        add({ strategy: 'text', value: textVal }, stats);
      }
    }

    for (const [strategy, attr] of [
      ['placeholder', 'placeholder'],
      ['title', 'title'],
      ['alt_text', 'alt'],
    ]) {
      const v = el.getAttribute?.(attr);
      if (v) add({ strategy, value: v }, matchStats(doc, `[${attr}="${cssString(v)}"]`, el));
    }

    if (selector) add({ strategy: 'css', value: selector }, matchStats(doc, selector, el));

    return locators;
  }

  /**
   * Describe a DOM element for capture output, including its locator
   * candidates. The selector is derived once and reused as the css entry.
   *
   * @param {object} el — DOM-like element
   * @returns {object} element description
   */
  function describeElement(el) {
    const isPassword = el.type === 'password';
    const selector = selectorFor(el);
    const locators = buildLocators(el, selector);
    return {
      tag: el.tagName,
      id: el.id || null,
      name: el.getAttribute?.('name') || null,
      role: el.getAttribute?.('role') || null,
      type: el.getAttribute?.('type') || null,
      // Captured so the service worker can flag sensitive payment fields via the
      // shared field-sensitivity util; the content script stays pattern-free.
      autocomplete: el.getAttribute?.('autocomplete') || null,
      text: isPassword ? null : (el.innerText ?? el.value ?? '').trim().slice(0, 100) || null,
      selector,
      // Password value is masked at the type site; mark the element redacted.
      ...(isPassword && { redacted: true }),
      ...(locators.length > 0 && { locators }),
    };
  }

  // -- END MIRRORED CAPTURE LOGIC --

  // ─── Click capture ────────────────────────────────────────────────────────────
  // Tries to find a known interactive ancestor first. Falls back to the
  // clicked element itself so custom components and web components are captured.

  const INTERACTIVE = [
    'a',
    'button',
    'label',
    'select',
    '[role="button"]',
    '[role="option"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="listitem"]',
    '[role="tab"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="treeitem"]',
    '[role="gridcell"]',
    'input[type="submit"]',
    'input[type="button"]',
    'input[type="checkbox"]',
    'input[type="radio"]',
    'input[type="reset"]',
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
  document.addEventListener(
    'mousedown',
    (e) => {
      if (!active) return;
      if (!e.isTrusted) return;
      lastMousedownTime = Date.now();
      lastMousedownEl = e.target;
    },
    { capture: true, passive: true },
  );

  document.addEventListener(
    'click',
    (e) => {
      if (!active) return;
      if (!e.isTrusted) return;
      if (
        e.detail === 0 &&
        lastKeyEnterTimestamp > 0 &&
        Date.now() - lastKeyEnterTimestamp < ENTER_SYNTHETIC_CLICK_WINDOW
      )
        return;
      // Suppress synthetic clicks from native select confirmation (Enter/click on option)
      if (
        e.detail === 0 &&
        lastSelectTimestamp > 0 &&
        Date.now() - lastSelectTimestamp < SELECT_SYNTHETIC_CLICK_WINDOW
      )
        return;
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
        type: 'click',
        timestamp: Date.now(),
        x: e.clientX,
        y: e.clientY,
        element: describeElement(el),
      });
      markUserAction();
    },
    { capture: true, passive: true },
  );

  // ─── Right-click / context menu ───────────────────────────────────────────────

  document.addEventListener(
    'contextmenu',
    (e) => {
      if (!active) return;
      if (!e.isTrusted) return;
      const el = e.target.closest(INTERACTIVE) ?? e.target;
      if (el === document.body || el === document.documentElement) return;
      appendAction({
        type: 'right_click',
        timestamp: Date.now(),
        x: e.clientX,
        y: e.clientY,
        element: describeElement(el),
      });
      markUserAction();
    },
    { capture: true, passive: true },
  );

  // ─── Keyboard capture ─────────────────────────────────────────────────────────
  // Captures meaningful key presses on interactive elements:
  //   Enter  — form submission, button activation
  //   Escape — modal/dialog/dropdown dismiss
  //   Tab    — focus navigation
  //   Arrow keys — list/menu/slider navigation

  const CAPTURE_KEYS = new Set([
    'Enter',
    'Escape',
    'Tab',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
  ]);

  document.addEventListener(
    'keydown',
    (e) => {
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
        type: 'key',
        timestamp: Date.now(),
        key: e.key,
        modifiers: {
          ctrl: e.ctrlKey,
          shift: e.shiftKey,
          alt: e.altKey,
          meta: e.metaKey,
        },
        element:
          el === document.body
            ? {
                tag: 'BODY',
                id: null,
                name: null,
                role: null,
                type: null,
                text: null,
                selector: 'body',
              }
            : describeElement(el),
      });
      markUserAction();
    },
    { capture: true, passive: true },
  );

  // ─── Text input & file upload capture ────────────────────────────────────────

  document.addEventListener(
    'change',
    (e) => {
      if (!active) return;
      if (document.visibilityState === 'hidden') return;
      const el = e.target;

      // File inputs: allow if preceded by a click on the same file input (user selected via dialog).
      // Playwright's fileChooser.setFiles() produces untrusted change events, but the preceding
      // click on the file input is trusted and already captured.
      if (el.tagName === 'INPUT' && el.type === 'file') {
        if (el === lastFileInputClickEl && Date.now() - lastFileInputClickTime < 10000) {
          const files = Array.from(el.files ?? []).map((f) => ({
            name: f.name,
            size: f.size,
            mime: f.type,
          }));
          if (files.length > 0) {
            appendAction({
              type: 'file_upload',
              timestamp: Date.now(),
              element: describeElement(el),
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
          type: 'select',
          timestamp: Date.now(),
          element: describeElement(el),
          value: el.options[el.selectedIndex]?.text ?? el.value,
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
            const isSubmit = lastMousedownEl.closest?.(
              'button[type="submit"], input[type="submit"]',
            );
            if (isSubmit) return;
          }
        }
        const isPassword = el.type === 'password';
        appendAction({
          type: 'type',
          timestamp: Date.now(),
          element: describeElement(el),
          value: isPassword ? '••••••••' : el.value,
        });
        markUserAction();
      }
    },
    { capture: true, passive: true },
  );

  // ─── Focus capture ────────────────────────────────────────────────────────────
  // Records focus only when correlated with a preceding Tab key press within 200ms.
  // Click-caused focus is suppressed (click already captures the action).
  // Programmatic focus (element.focus()) is not captured.

  document.addEventListener(
    'focusin',
    (e) => {
      if (!active) return;
      if (document.visibilityState === 'hidden') return;
      const el = e.target;
      const isInput =
        el.tagName === 'INPUT' ||
        el.tagName === 'TEXTAREA' ||
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
        if (capturedEl === lastClickedEl && Date.now() - lastClickTime < CLICK_FOCUS_DEDUP_WINDOW)
          return;
        appendAction({
          type: 'focus',
          timestamp: Date.now(),
          element: describeElement(capturedEl),
        });
      }, 50);
    },
    { capture: true, passive: true },
  );

  // ─── Drag and drop capture ────────────────────────────────────────────────────

  let dragSource = null;

  document.addEventListener(
    'dragstart',
    (e) => {
      if (!active) return;
      if (!e.isTrusted) return;
      dragSource = e.target;
      appendAction({
        type: 'drag_start',
        timestamp: Date.now(),
        element: describeElement(e.target),
      });
      markUserAction();
    },
    { capture: true, passive: true },
  );

  // Allow drop on any element when we have an active drag source.
  // Without this, the browser won't fire the 'drop' event (HTML5 DnD spec
  // requires dragover to be cancelled for drop to fire).
  document.addEventListener(
    'dragover',
    (e) => {
      if (!active) return;
      if (!dragSource) return;
      e.preventDefault();
    },
    { capture: true },
  );

  document.addEventListener(
    'drop',
    (e) => {
      if (!active) return;
      // Allow drop if we have an active drag source from a trusted dragstart,
      // even if the drop event itself is untrusted (Playwright simulation).
      if (!e.isTrusted && !dragSource) return;
      appendAction({
        type: 'drop',
        timestamp: Date.now(),
        element: describeElement(e.target),
        source_element: dragSource ? describeElement(dragSource) : null,
        x: e.clientX,
        y: e.clientY,
      });
      dragSource = null;
    },
    { capture: true, passive: true },
  );

  document.addEventListener(
    'dragend',
    () => {
      dragSource = null;
    },
    { capture: true, passive: true },
  );

  // ─── Scroll capture ───────────────────────────────────────────────────────────
  // Debounced — only records when scrolling stops, and only if the scroll
  // distance is significant (>200px) to avoid noise from minor adjustments.

  let scrollTimer = null;
  let scrollStartY = null;
  let scrollStartX = null;

  document.addEventListener(
    'scroll',
    (e) => {
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
        const deltaY = Math.abs(el.scrollTop - scrollStartY);
        const deltaX = Math.abs(el.scrollLeft - scrollStartX);
        if (deltaY > 200 || deltaX > 200) {
          appendAction({
            type: 'scroll',
            timestamp: Date.now(),
            element: el === document.documentElement ? null : describeElement(el),
            scroll_top: el.scrollTop,
            scroll_left: el.scrollLeft,
            delta_y: el.scrollTop - scrollStartY,
            delta_x: el.scrollLeft - scrollStartX,
          });
          markUserAction();
        }
        scrollStartY = null;
        scrollStartX = null;
      }, 300);
    },
    { capture: true, passive: true },
  );

  // ─── Contenteditable capture ──────────────────────────────────────────────────
  // Captures typing in contenteditable elements via the input event.
  // Debounced at 500ms — records the final text when typing pauses.
  // Flushes immediately on blur so no input is lost when the user leaves the field.

  let contenteditableTimer = null;
  let contenteditableEl = null;

  document.addEventListener(
    'input',
    (e) => {
      if (!active) return;
      if (!e.isTrusted) return;
      if (document.visibilityState === 'hidden') return;
      const el = e.target;
      if (
        el.getAttribute('contenteditable') !== 'true' &&
        el.getAttribute('contenteditable') !== ''
      )
        return;

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
    },
    { capture: true, passive: true },
  );

  document.addEventListener(
    'blur',
    (e) => {
      if (!contenteditableTimer || !contenteditableEl) return;
      if (e.target !== contenteditableEl) return;
      clearTimeout(contenteditableTimer);
      if (!active) {
        contenteditableEl = null;
        contenteditableTimer = null;
        return;
      }
      appendAction({
        type: 'type',
        timestamp: Date.now(),
        element: describeElement(contenteditableEl),
        value: contenteditableEl.innerText.trim().slice(0, 500),
      });
      markUserAction();
      contenteditableEl = null;
      contenteditableTimer = null;
    },
    { capture: true, passive: true },
  );

  // Readiness signal — reported only AFTER every listener above is attached, so a
  // reader knows the frame is actually ready to capture (unlike __docentLoaded,
  // set at the top of this IIFE before any listener exists, which would
  // under-report). The recorder runs in the content-script ISOLATED world, so a
  // window.* flag here is invisible to the page's main world; readiness is instead
  // reported to the service worker via FRAME_READY. That message also confirms —
  // more strongly than mere frame existence — that this frame's recorder is live,
  // so the SW trusts its APPEND_ACTIONs. The timestamp is stamped here, before the
  // message hop, on the same wall clock the SW uses, so the inject→ready window can
  // be measured without cross-process skew.
  try {
    chrome.runtime.sendMessage({ type: 'FRAME_READY', readyAt: Date.now(), url: location.href });
  } catch {
    // SW unavailable (e.g. during teardown) — readiness reporting is best-effort.
  }
})();
