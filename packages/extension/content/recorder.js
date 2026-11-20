/**
 * Docent — Content Script Recorder
 *
 * Observes user interactions in the active tab and sends each captured
 * action to the service worker as an APPEND_ACTION message — the single
 * path a recorder-captured action takes into storage. The worker
 * validates the sender against its active-frame registry, re-stamps
 * context_id from the trusted sender — never from the message body
 * (extension capture-principles ECP-4) — applies the sensitive-value
 * redaction chokepoint, and appends to the pendingActions buffer in
 * chrome.storage.local through a serialized write queue. The buffer is
 * persisted rather than held in worker memory, so capture in progress
 * survives service-worker suspension. This recorder's only direct storage
 * write is the lastUserActionTimestamp correlation signal (extension
 * runtime ERT-3, the write-ownership contract).
 *
 * Every action carries a context_id so the receiving system knows which tab it
 * occurred on — stamped provisionally by this recorder, then re-stamped by the
 * worker from the trusted sender. Injected programmatically into all frames while
 * recording (by the service worker, on record-start and on each frame load) so
 * interactions inside iframes are also captured. Outside a recording nothing
 * is injected and nothing captures: recorder instances a prior recording left
 * in still-open documents are inactive — each deactivates in place through
 * its `recording` watch — until navigation replaces their documents
 * (extension capture-principles ECP-2).
 *
 * Captures:
 *   - clicks (interactive elements + fallback to any clicked element)
 *   - keyboard: Enter/Escape/Tab/arrow keys (CAPTURE_KEYS) on the focused
 *     element, whatever it is (Tab also with nothing focused), and Space where
 *     it is not typed text; the click the browser derives from one is its effect
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
      // Typing a stopped recording left unwritten is no part of the next one.
      if (!active) editableTypedInto = null;
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
  // serialized with action appends, preventing race conditions. The context_id
  // stamped here is provisional — the worker re-stamps it from the trusted
  // sender (extension capture-principles ECP-4).
  //
  // Returns a promise that settles once the worker has answered, which it does
  // after the action is stored or dropped: the end of typing the worker asks
  // for waits on it. It never rejects (the worker can be gone at a teardown).

  function appendAction(action) {
    const stamped = {
      ...action,
      context_id: tabId,
      capture_mode: 'dom',
      frame_src: frameSrc,
    };
    try {
      return chrome.runtime
        .sendMessage({ type: 'APPEND_ACTION', action: stamped })
        .catch(() => undefined);
    } catch {
      return Promise.resolve();
    }
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
   * The language the application declares for an element (session-format's
   * `language` row states the rule): the `lang` attribute of the nearest element
   * at or above `el` that carries one, as written, the empty value included. A
   * shadow tree's top takes its host's declaration, as HTML resolves a node's
   * language; the walk ends at the top of the element's own document.
   *
   * @param {object} el — DOM-like element
   * @returns {string|null} the attribute's value, or null when none declares one
   */
  function declaredLanguage(el) {
    let node = el;
    while (node) {
      const lang = node.getAttribute?.('lang');
      if (lang != null) return lang;
      node = node.parentElement ?? node.parentNode?.host ?? null;
    }
    return null;
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
      language: declaredLanguage(el),
      text: isPassword ? null : (el.innerText ?? el.value ?? '').trim().slice(0, 100) || null,
      selector,
      // Password value is masked at the type site; mark the element redacted.
      ...(isPassword && { redacted: true }),
      ...(locators.length > 0 && { locators }),
    };
  }

  /**
   * The keys written as a `key` action on whatever element has focus.
   */
  const CAPTURE_KEYS = [
    'Enter',
    'Escape',
    'Tab',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
  ];

  /**
   * The `input` types whose value is not free text: a Space pressed on one is a
   * key press on the control (it opens a date field's picker, for example),
   * never a character of its value.
   */
  const NON_TEXT_INPUT_TYPES = [
    'button',
    'checkbox',
    'color',
    'date',
    'datetime-local',
    'file',
    'image',
    'month',
    'number',
    'radio',
    'range',
    'reset',
    'submit',
    'time',
    'week',
  ];

  /**
   * Whether a Space pressed on the element is typed text: a `textarea`, an
   * `input` whose value is free text, or editable content. The text such a field
   * holds is recorded by its `type` action.
   *
   * @param {object} el — DOM-like element
   * @returns {boolean}
   */
  function takesTypedText(el) {
    if (el.isContentEditable === true) return true;
    if (el.tagName === 'TEXTAREA') return true;
    return el.tagName === 'INPUT' && !NON_TEXT_INPUT_TYPES.includes(el.type);
  }

  /**
   * The name a key press is written under, or null when the press is not
   * captured. The fixed set is captured on any element; Space is captured where
   * it is not typed text (#695), and named `Space` as the schema names it.
   *
   * @param {string} key — the event's key value
   * @param {object|null} el — the element the press lands on, when one has focus
   * @returns {string|null}
   */
  function capturedKeyName(key, el) {
    if (CAPTURE_KEYS.includes(key)) return key;
    if (key === ' ' && el && !takesTypedText(el)) return 'Space';
    return null;
  }

  // -- END MIRRORED CAPTURE LOGIC --

  /** The `input` types that hold no entry: controls recorded by what is done to them. */
  const NON_ENTRY_INPUT_TYPES = ['button', 'checkbox', 'file', 'image', 'radio', 'reset', 'submit'];

  /**
   * Whether the element holds an entry a `type` records: a `textarea`, or an
   * `input` other than a button, checkbox, radio button or file chooser (those
   * are recorded by their click, key or dialog).
   *
   * @param {Element} el
   * @returns {boolean}
   */
  function takesEntry(el) {
    if (el.tagName === 'TEXTAREA') return true;
    return el.tagName === 'INPUT' && !NON_ENTRY_INPUT_TYPES.includes(el.type);
  }

  /**
   * Write the entry a field holds as a `type`, a password's masked.
   *
   * @param {Element} el
   * @returns {Promise<void>} settled once the worker has answered
   */
  function writeEntry(el) {
    const isPassword = el.type === 'password';
    const sent = appendAction({
      type: 'type',
      timestamp: Date.now(),
      element: describeElement(el),
      value: isPassword ? '••••••••' : el.value,
    });
    markUserAction();
    fieldValueAtFocus.set(el, el.value);
    fieldsEditedByKey.delete(el);
    entryLastWritten.set(el, el.value);
    return sent;
  }

  // The editable content being typed into: its entry is one `type`, written
  // when the typing in it ends. Null while none has been typed into since the
  // last entry was written.
  let editableTypedInto = null;

  /**
   * Write the text the editable content typed into holds, as its `type`. The
   * typing in it has ended: it lost the focus, a key that is written as a
   * `key` was pressed, or the pointer was pressed. A pause between two keys
   * ends nothing: how fast a person types is no part of what they typed.
   *
   * @returns {Promise<void>} settled once the worker has answered
   */
  function writeEditableEntry() {
    const el = editableTypedInto;
    if (!el) return Promise.resolve();
    editableTypedInto = null;
    if (!active) return Promise.resolve();
    const sent = appendAction({
      type: 'type',
      timestamp: Date.now(),
      element: describeElement(el),
      value: el.innerText.trim().slice(0, 500),
    });
    markUserAction();
    return sent;
  }

  /**
   * End the typing in this document where nothing in the document says it has
   * ended: write the editable content typed into, and the entry made with the
   * keys in the field in focus.
   *
   * @returns {Promise<void>} settled once the worker has stored what was written
   */
  function endTyping() {
    const sent = [writeEditableEntry()];
    const field = document.activeElement;
    if (field && hasUnwrittenEntry(field)) sent.push(writeEntry(field));
    return Promise.all(sent).then(() => undefined);
  }

  /**
   * Whether the field holds an entry made with the keys and not yet written.
   *
   * @param {Element} el
   * @returns {boolean}
   */
  function hasUnwrittenEntry(el) {
    return takesEntry(el) && fieldsEditedByKey.has(el) && el.value !== fieldValueAtFocus.get(el);
  }

  /**
   * Whether a press on `pressed` is a press on a submit control of the form
   * `field` is in: the press whose `change` writes no `type` (docent#223).
   *
   * @param {Element} field
   * @param {Element} pressed
   * @returns {boolean}
   */
  function pressesSubmitOfItsForm(field, pressed) {
    const form = field.closest?.('form');
    if (!form || !form.contains(pressed)) return false;
    return !!pressed.closest?.('button[type="submit"], input[type="submit"]');
  }

  /**
   * Write the entry the typing made so far, ahead of the pointer press that
   * ends it, wherever the press is: the editable content typed into, and the
   * field in focus. A press that takes the focus from the field sends its
   * `change` next, which finds the entry written; a press that leaves the
   * focus where it is (in the field itself, or on an element that keeps the
   * focus from moving) sends none, and the entry stands ahead of the click
   * all the same. The press on a submit control of the field's own form is
   * left to the `change` rule that writes nothing for it.
   *
   * @param {Element} pressed — the element the pointer went down on
   */
  function writeEntryEndedByPointer(pressed) {
    const field = document.activeElement;
    if (field && field !== pressed && pressesSubmitOfItsForm(field, pressed)) {
      writeEditableEntry();
      return;
    }
    endTyping();
  }

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
  // A captured key's keydown, keypress or keyup is being dispatched. The
  // browser derives a key's click while it handles one of them (#695); the
  // flag stays up until the next timer task.
  let capturedKeyEventInTask = false;
  // The physical keys whose latest keydown was written, by `code`.
  const capturedKeysDown = new Set();
  // The physical keys that are down, by `code`, in the order they went down:
  // each with the name its `key` action carries when the keydown it is down by
  // was written, and null when that keydown was not (text typed into a field,
  // a key outside the captured set). The keydown a key is down by is its
  // press, or the first of its repeats this document saw when it did not see
  // the press; later repeats change nothing.
  const keysDown = new Map();
  /**
   * The names of the keys that are down by a written keydown, other than the
   * key `code` itself: what an action's `held_keys` states (#706).
   */
  const heldKeys = (code) =>
    [...keysDown].filter(([held, name]) => held !== code && name !== null).map(([, name]) => name);
  // The value each text field held when it took focus, or after the entry
  // last written for it: what a `change` is measured against, so a captured
  // key can tell an entry not yet written from one that is.
  const fieldValueAtFocus = new WeakMap();
  // The fields a key has been pressed in since their entry was last written or
  // committed: only those hold an entry the person made, as against a value the
  // page set (core CP-6).
  const fieldsEditedByKey = new WeakSet();
  // The entry last written for each field, so the same entry is not written twice.
  const entryLastWritten = new WeakMap();
  /** The modifiers held at a trusted key, mouse or drag event (#239). */
  const modifiersOf = (e) => ({
    ctrl: e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
    meta: e.metaKey,
  });
  let lastTabKeyTimestamp = 0;
  let lastSelectTimestamp = 0;
  let lastFileInputClickEl = null;
  let lastFileInputClickTime = 0;
  let lastMousedownTime = 0;
  let lastMousedownEl = null;
  // The control a label click's activation is about to click (#670).
  let labelForwardedTo = null;

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
      writeEntryEndedByPointer(e.target);
      // The press ends the typing in the tab's other documents too, which see
      // nothing of it: the worker tells them, and stores what this document
      // writes next (the click of this press) behind what they write.
      // (Sent as its own literal send, as every capture-path message is: the
      // message table in the runtime doc is checked against these sites.)
      try {
        chrome.runtime.sendMessage({ type: 'POINTER_PRESSED' }).catch(() => undefined);
      } catch {
        // Worker unavailable (a teardown): nothing to tell.
      }
    },
    { capture: true, passive: true },
  );

  /**
   * Remember a trusted click on a file input: the `file_upload` its dialog
   * leads to is written only when the input saw one.
   *
   * @param {Element} el — the clicked element
   */
  function noteFileInputClick(el) {
    if (el.tagName === 'INPUT' && el.type === 'file') {
      lastFileInputClickEl = el;
      lastFileInputClickTime = Date.now();
    }
  }

  document.addEventListener(
    'click',
    (e) => {
      if (!active) return;
      if (!e.isTrusted) return;
      // A click with no pointer, sent while the browser handles a captured key
      // (Enter or Space on a button, an arrow key in a radio group, Enter's
      // implicit submission), is that key's effect: the key is the record
      // (#695). It still opens a file input's dialog, and it is the moment the
      // activation happens, which a Space press reaches only at its release.
      if (e.pointerType === '' && capturedKeyEventInTask) {
        noteFileInputClick(e.target);
        markUserAction();
        return;
      }
      // The click a native select sends when its list closes from the keyboard
      // carries no pointer: the keys pressed inside the open list do not reach
      // the page, so the closing is not a click anyone made (#704).
      if (e.pointerType === '' && e.detail === 0 && e.target.tagName === 'SELECT') {
        markUserAction();
        return;
      }
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
      noteFileInputClick(el);
      // A label's activation sends a second click on to its control before the
      // next task: the person made one click, recorded as the first (#670). The
      // composed path finds a label in an open shadow root and one holding an
      // interactive child; a closed shadow root hides its label (ECP-12).
      const path = e.composedPath();
      if (labelForwardedTo !== null && path[0] === labelForwardedTo) {
        labelForwardedTo = null;
        return;
      }
      const label = path.find((n) => n.tagName === 'LABEL');
      if (label?.control && !path.includes(label.control)) {
        const control = label.control;
        labelForwardedTo = control;
        setTimeout(() => {
          if (labelForwardedTo === control) labelForwardedTo = null;
        }, 0);
      }
      appendAction({
        type: 'click',
        timestamp: Date.now(),
        x: e.clientX,
        y: e.clientY,
        modifiers: modifiersOf(e),
        held_keys: heldKeys(),
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
        modifiers: modifiersOf(e),
        held_keys: heldKeys(),
        element: describeElement(el),
      });
      markUserAction();
    },
    { capture: true, passive: true },
  );

  // ─── Keyboard capture ─────────────────────────────────────────────────────────
  // Captures these key presses on the focused element, whatever it is (Tab also
  // with nothing focused):
  //   Enter  — form submission, button activation
  //   Escape — modal/dialog/dropdown dismiss
  //   Tab    — focus navigation
  //   Arrow keys — list/menu/slider navigation
  //   Space  — button/checkbox activation, where it is not typed text
  // Each press is written with the browser's own repeat flag, so a held key's
  // generated presses are told from the physical one.

  /**
   * The element focus rests on, followed through shadow roots: the document's
   * active element is the host of a shadow tree that holds the focus. A closed
   * root is read through the extension's own accessor, so a Space typed into a
   * field inside one is still seen as typed text.
   *
   * @returns {Element|null}
   */
  function focusedElement() {
    let el = document.activeElement;
    while (el) {
      let root = el.shadowRoot;
      if (!root) {
        try {
          root = chrome.dom?.openOrClosedShadowRoot(el) ?? null;
        } catch {
          root = null; // not an element that can host a shadow tree
        }
      }
      const inner = root?.activeElement;
      if (!inner) break;
      el = inner;
    }
    return el;
  }

  /**
   * Mark that a captured key's event is being dispatched. The browser sends a
   * derived click from inside that dispatch, as the event's default action, so
   * the mark must outlive this listener and is dropped by the next timer task.
   * A microtask would drop it too early: it runs as the listener returns,
   * ahead of the default action.
   */
  function markCapturedKeyEvent() {
    capturedKeyEventInTask = true;
    setTimeout(() => {
      capturedKeyEventInTask = false;
    }, 0);
  }

  document.addEventListener(
    'keydown',
    (e) => {
      if (!active) return;
      if (!e.isTrusted) return;
      // Every keydown restates whether this physical key's press is a written one.
      capturedKeysDown.delete(e.code);
      // This keydown is the one the key is down by when it is the press, or the
      // first keydown of the key this document sees.
      const downByThis = !e.repeat || !keysDown.has(e.code);
      if (downByThis) {
        keysDown.delete(e.code);
        keysDown.set(e.code, null);
      }
      // A field focused before the recording began has no value noted yet: the
      // one it holds now is what the first keystroke is about to change.
      const fieldInFocus = document.activeElement;
      if (fieldInFocus && takesEntry(fieldInFocus) && !fieldValueAtFocus.has(fieldInFocus)) {
        fieldValueAtFocus.set(fieldInFocus, fieldInFocus.value);
      }
      const key = capturedKeyName(e.key, focusedElement());
      if (key === null) {
        if (fieldInFocus && takesEntry(fieldInFocus)) {
          fieldsEditedByKey.add(fieldInFocus);
          entryLastWritten.delete(fieldInFocus);
        }
        return;
      }
      // Set Tab timestamp BEFORE the body check — focus after Tab on body
      // still needs to be captured (it tells us where focus went).
      if (key === 'Tab') lastTabKeyTimestamp = Date.now();
      const el = document.activeElement;
      // Allow Tab even when body is focused — the user pressed Tab to navigate.
      if (!el || (el === document.body && key !== 'Tab')) return;
      const held = heldKeys(e.code);
      capturedKeysDown.add(e.code);
      if (downByThis) keysDown.set(e.code, key);
      markCapturedKeyEvent();
      // The entry the person made in the field is complete before this press, and
      // the browser's `change` for it comes only while it handles the press
      // (Enter's submission, the blur Tab causes): written here, the entry
      // stands ahead of the key it precedes (#703).
      if (hasUnwrittenEntry(el)) writeEntry(el);
      // The same for editable content: the key ends the typing in it.
      writeEditableEntry();
      appendAction({
        type: 'key',
        timestamp: Date.now(),
        key,
        modifiers: modifiersOf(e),
        repeat: e.repeat,
        held_keys: held,
        element: describeElement(el),
      });
      markUserAction();
    },
    { capture: true, passive: true },
  );

  // The later events of a captured press write nothing. Each marks its task,
  // because the browser derives a key's click from whichever of the three it
  // acts on: an arrow key's and a link's Enter from keydown, a button's Enter
  // from keypress, a Space press from keyup.
  document.addEventListener(
    'keypress',
    (e) => {
      if (!active) return;
      if (!e.isTrusted) return;
      if (capturedKeysDown.has(e.code)) markCapturedKeyEvent();
    },
    { capture: true, passive: true },
  );

  document.addEventListener(
    'keyup',
    (e) => {
      if (!e.isTrusted) return;
      // A release ends the key's time among the held keys whether or not the
      // recording is on: a key released while it is off is not down after it.
      keysDown.delete(e.code);
      const captured = capturedKeysDown.delete(e.code);
      if (active && captured) markCapturedKeyEvent();
    },
    { capture: true, passive: true },
  );

  // A key released while the window does not have the focus sends its keyup
  // elsewhere, so nothing is known to be down once the window loses it. A key
  // still held when the focus returns is down again by its next repeat.
  window.addEventListener(
    'blur',
    (e) => {
      if (!e.isTrusted || e.target !== window) return;
      capturedKeysDown.clear();
      keysDown.clear();
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
      // click on the file input is trusted and already recorded, as the click or as
      // the key that opened the dialog.
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

      // A checkbox or radio toggle is recorded by what the person did: the
      // click, on the control or on its label, or the key that toggled it
      // (#695); its change carries no entered value (#654).
      if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) return;

      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        fieldValueAtFocus.set(el, el.value);
        fieldsEditedByKey.delete(el);
        // An entry already written, ahead of the captured key that followed it,
        // is not written again.
        if (entryLastWritten.get(el) === el.value) return;
        // Suppress change events caused by blur from clicking a submit button within the same form.
        // When the user clicks submit, the input blurs and fires change. But the user's
        // intent is captured by the click — the type was already captured earlier (or will
        // be captured when the user explicitly tabs/clicks away without submitting).
        // Event order: mousedown(submit) → blur(input) → change(input) → click(submit)
        if (
          lastMousedownEl &&
          lastMousedownEl !== el &&
          Date.now() - lastMousedownTime < 100 &&
          pressesSubmitOfItsForm(el, lastMousedownEl)
        ) {
          return;
        }
        writeEntry(el);
      }
    },
    { capture: true, passive: true },
  );

  // ─── Focus capture ────────────────────────────────────────────────────────────
  // Records focus only when correlated with a preceding Tab key press within
  // TAB_FOCUS_CORRELATION_WINDOW.
  // Click-caused focus is suppressed (click already captures the action).
  // Programmatic focus (element.focus()) is not captured.

  document.addEventListener(
    'focusin',
    (e) => {
      if (!active) return;
      if (takesEntry(e.target)) {
        fieldValueAtFocus.set(e.target, e.target.value);
        fieldsEditedByKey.delete(e.target);
        entryLastWritten.delete(e.target);
      }
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
        // Only record focus if it follows a Tab key press within
        // TAB_FOCUS_CORRELATION_WINDOW
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
      if (!e.isTrusted) return;
      const held = heldKeys();
      // The browser sends the page no key events during a drag, so a key
      // released in that time is never seen to go up: from the start of the
      // drag nothing is known to be down.
      keysDown.clear();
      if (!active) return;
      dragSource = e.target;
      appendAction({
        type: 'drag_start',
        timestamp: Date.now(),
        modifiers: modifiersOf(e),
        held_keys: held,
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
      // No key is known to be down at the end of a drag, wherever it started:
      // the page was sent no key events while it lasted.
      keysDown.clear();
      appendAction({
        type: 'drop',
        timestamp: Date.now(),
        modifiers: modifiersOf(e),
        held_keys: heldKeys(),
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
  // Typing in editable content is noted at its `input` and written as one
  // `type` when the typing ends (`writeEditableEntry`): here when the element
  // loses the focus, which it also does when the window does.

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
      // Typing in another element ends the typing in the one before it.
      if (editableTypedInto !== el) writeEditableEntry();
      editableTypedInto = el;
    },
    { capture: true, passive: true },
  );

  document.addEventListener(
    'blur',
    (e) => {
      if (e.target !== editableTypedInto) return;
      writeEditableEntry();
    },
    { capture: true, passive: true },
  );

  // ─── The end of typing the worker asks for ───────────────────────────────────
  // Two ends of typing are not this document's to see: a step commit or a stop
  // (the entry belongs to that step and that recording, whether or not the
  // focus left the page first), and a pointer press in another frame of the
  // tab. The worker asks, and is answered once what was written is stored, so
  // a commit that waited on the answer holds the entry.

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'END_TYPING') return false;
    if (!active) {
      sendResponse({ ok: true });
      return false;
    }
    endTyping().then(() => sendResponse({ ok: true }));
    return true;
  });

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
