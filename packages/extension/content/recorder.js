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
 *   - keyboard: every key press that is not text, on the focused element or
 *     on the body when nothing is focused (a modifier alone and a key that
 *     became a field's text excepted); the click the browser derives from one
 *     is its effect
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
      // Typing a stopped recording left unwritten is no part of the next one,
      // and neither is a key press still waiting.
      if (!active) {
        editableTypedInto = null;
        forgetPendingKeys();
      }
      // A composition open when a recording ends or begins is no part of the
      // next one, and neither is a key the input method took.
      forgetComposition();
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
    if (pendingKeys.length > 0 && !writingPendingKeys) {
      if (keyEventInTask) {
        // The browser is still handling the waiting press, so this action is
        // an effect of it (a page that moves the focus from its key handler,
        // for example). An entry is complete before the press and goes out
        // ahead of it; anything else waits behind it.
        // (Nothing waits on a held action's answer: the entries, which the
        // end of typing waits on, go straight out.)
        if (action.type === 'type') return sendAction(action);
        heldBehindPendingKeys.push(action);
        return Promise.resolve();
      }
      // A later action: no text followed the waiting press, so it was a key
      // and is written first.
      resolvePendingKeys();
    }
    return sendAction(action);
  }

  // The answer to the action sent last. The worker stores one frame's actions
  // in the order sent, so once it has answered this one, every action this
  // document sent is stored.
  let lastSent = Promise.resolve();

  function sendAction(action) {
    const stamped = {
      ...action,
      context_id: tabId,
      capture_mode: 'dom',
      frame_src: frameSrc,
    };
    try {
      lastSent = chrome.runtime
        .sendMessage({ type: 'APPEND_ACTION', action: stamped })
        .catch(() => undefined);
    } catch {
      lastSent = Promise.resolve();
    }
    return lastSent;
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
      // shared field-sensitivity util, on the description it stores.
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
   * The modifier keys that do nothing pressed alone. One pressed alone is no key
   * press to write: an action states the modifiers held at it. The Meta key is
   * not among them: the system acts on its press by itself, so it is written.
   */
  const MODIFIER_KEYS = ['Shift', 'Control', 'Alt', 'AltGraph'];

  /** The `input` types that hold no entry: controls recorded by what is done to them. */
  const NON_ENTRY_INPUT_TYPES = [
    // each recorded by its click, its key or its dialog
    'button',
    'checkbox',
    'file',
    'image',
    'radio',
    'reset',
    'submit',
  ];

  /**
   * Whether typing can become the element's text: a `textarea`, an `input` that
   * holds an entry, or editable content. Only there can a typing key turn out
   * to be text, which the field's `type` records.
   *
   * @param {object|null} el — DOM-like element
   * @returns {boolean}
   */
  function mayTakeText(el) {
    if (!el) return false;
    if (el.isContentEditable === true) return true;
    if (el.tagName === 'TEXTAREA') return true;
    return el.tagName === 'INPUT' && !NON_ENTRY_INPUT_TYPES.includes(el.type);
  }

  /** The `input` types the person fills part by part: the date and time fields. */
  const PART_ENTRY_INPUT_TYPES = ['date', 'datetime-local', 'month', 'time', 'week'];

  /**
   * Whether the element takes its text part by part and holds no value until
   * the parts make one: the browser reports no text for a key typed into it
   * before that, so the keys of a whole run are known to be text only together.
   *
   * @param {object|null} el — DOM-like element
   * @returns {boolean}
   */
  function takesTextByParts(el) {
    return !!el && el.tagName === 'INPUT' && PART_ENTRY_INPUT_TYPES.includes(el.type);
  }

  /**
   * What a key press is, by its key value (#702):
   *
   *   - `modifier`: Shift, Ctrl, Alt or AltGr. Pressed alone it is no press to
   *     write: an action states the modifiers held at it;
   *   - `composed`: a key the input method takes (`Process`, an empty key
   *     value, or any key pressed while a composition is open), whose text
   *     arrives as the composition;
   *   - `character`: a key whose value is one character, or a dead key. It is
   *     text where a field takes it, which is known only after the press (the
   *     recorder's waiting presses), and a `key` everywhere else;
   *   - `named`: every other key (Enter, Backspace, F2, Meta).
   *
   * @param {string} key — the event's key value
   * @param {boolean} isComposing — whether a composition is open at the press,
   *   or the input method took the key (the browser reports key code 229)
   * @returns {'modifier'|'composed'|'character'|'named'}
   */
  function keyPressKind(key, isComposing) {
    if (MODIFIER_KEYS.includes(key)) return 'modifier';
    if (isComposing || key === '' || key === 'Process') return 'composed';
    return key === 'Dead' || [...key].length === 1 ? 'character' : 'named';
  }

  /**
   * Whether the modifiers held make a character key a shortcut that enters no
   * character: Meta, Ctrl without Alt, or Alt without Ctrl. Ctrl and Alt
   * together is AltGr, which enters characters of the layout. Alt alone reaches
   * for a menu, except on a Mac, where it is the Option key and enters
   * characters: `altEntersCharacters` says which.
   *
   * @param {{ctrl: boolean, alt: boolean, meta: boolean}} modifiers
   * @param {boolean} altEntersCharacters — whether Alt alone enters characters
   * @returns {boolean}
   */
  function isShortcut(modifiers, altEntersCharacters) {
    if (modifiers.meta) return true;
    if (modifiers.ctrl) return !modifiers.alt;
    return modifiers.alt && !altEntersCharacters;
  }

  /**
   * The `autocomplete` tokens and the name pattern of a sensitive element: a
   * copy of the shared rule's (`shared/lib/field-sensitivity.js`), which a
   * content script cannot import. A test holds the two equal.
   */
  const SENSITIVE_AUTOCOMPLETE = [
    // the payment fields
    'cc-number',
    'cc-csc',
    'cc-exp',
    'cc-exp-month',
    'cc-exp-year',
  ];
  const SENSITIVE_NAME_RE =
    /card.?number|cardnum|ccnum|credit.?card|cvv|cvc|csc|ssn|social.?security|routing|iban|sort.?code|account.?number|api.?key|secret|passw|pwd|\botp\b|tax.?id/i;

  /**
   * Whether what is typed on the element is sensitive, by the shared rule the
   * service worker applies to the element's description. The recorder applies
   * it to the element itself, before it writes a key press: a character key
   * pressed on such an element is never written under its own name, as a `key`
   * or among the keys held at a later action.
   *
   * @param {object|null} el — DOM-like element
   * @returns {boolean}
   */
  function isSensitiveElement(el) {
    if (!el) return false;
    const attribute = (name) => el.getAttribute?.(name) || '';
    if (el.type === 'password' || attribute('type').toLowerCase() === 'password') return true;
    const autocomplete = attribute('autocomplete').trim().toLowerCase();
    if (SENSITIVE_AUTOCOMPLETE.includes(autocomplete)) return true;
    return SENSITIVE_NAME_RE.test(attribute('name')) || SENSITIVE_NAME_RE.test(el.id || '');
  }

  /** The tags and roles of the controls a key presses or toggles, whatever they are named. */
  const NON_TEXT_TAGS = ['A', 'BUTTON', 'SUMMARY'];
  const NON_TEXT_ROLES = [
    'button',
    'checkbox',
    'link',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'radio',
    'switch',
    'tab',
  ];

  /**
   * Whether a key pressed on the element presses or toggles it and enters no
   * text: the rule the service worker applies to the element's description
   * (`lib/redaction-logic.js`). A test holds the two equal.
   *
   * @param {object|null} el — DOM-like element
   * @returns {boolean}
   */
  function takesNoTypedText(el) {
    if (!el) return false;
    const tag = String(el.tagName || '').toUpperCase();
    if (NON_TEXT_TAGS.includes(tag)) return true;
    const type = String(el.getAttribute?.('type') || '').toLowerCase();
    if (tag === 'INPUT' && NON_ENTRY_INPUT_TYPES.includes(type)) return true;
    return NON_TEXT_ROLES.includes(String(el.getAttribute?.('role') || '').toLowerCase());
  }

  /**
   * The name a key press is written under: the browser's key value, a space as
   * `Space`, as the schema names it (#695).
   *
   * @param {string} key — the event's key value
   * @returns {string}
   */
  function keyActionName(key) {
    return key === ' ' ? 'Space' : key;
  }

  // -- END MIRRORED CAPTURE LOGIC --

  /** The mask a sensitive entry is written as. */
  const SENSITIVE_MASK = '••••••••';

  // Whether Alt held alone with a character key enters a character: on a Mac
  // it is the Option key, which enters characters of the layout. Everywhere
  // else Alt with a character key reaches for a menu and enters none.
  const ALT_ENTERS_CHARACTERS = /mac/i.test(window.navigator.platform || '');

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
   * Write the entry a field holds as a `type`, a sensitive field's masked.
   *
   * @param {Element} el
   * @param {number} [timestamp] — the time of the key press the entry was
   *   complete at, when a key press writes it
   * @param {string} [value] — the entry as it stood at that key press
   * @returns {Promise<void>} settled once the worker has answered
   */
  function writeEntry(el, timestamp = Date.now(), value = el.value) {
    const sent = appendAction({
      type: 'type',
      timestamp,
      element: describeElement(el),
      value: isSensitiveElement(el) ? SENSITIVE_MASK : value,
    });
    markUserAction();
    fieldValueAtFocus.set(el, value);
    fieldsEditedByKey.delete(el);
    entryLastWritten.set(el, value);
    entryMadeAgain.delete(el);
    // The text being composed in the field is in the entry written: the
    // composition's end enters it again only if it is composed on from here.
    if (composition?.field === el) {
      composition.written = composition.text;
      composition.composedOn = false;
      composition.undoEnd = null;
    }
    return sent;
  }

  /**
   * Write a masked `type` for a sensitive element that holds no entry of its
   * own (a widget that is no field): what a character key pressed on it is
   * recorded as.
   *
   * @param {Element} el
   * @param {number} timestamp — the time of the key press
   * @returns {Promise<void>} settled once the worker has answered
   */
  function writeMaskedEntry(el, timestamp) {
    const sent = appendAction({
      type: 'type',
      timestamp,
      element: describeElement(el),
      value: SENSITIVE_MASK,
    });
    markUserAction();
    return sent;
  }

  // The editable content being typed into: its entry is one `type`, written
  // when the typing in it ends. Null while none has been typed into since the
  // last entry was written.
  let editableTypedInto = null;
  // What the editable content typed into held at the press of a key that
  // waits behind a dead key (`{ el, value }`), until that key's entry is
  // written. Null otherwise.
  let editableAtKeyBehind = null;
  // That text has been written, and the element holds other text since: it
  // came with or after the key behind the dead key, so no press that waited
  // with that key writes it ahead of itself.
  let editableReadAtPress = false;

  /**
   * Write the text the editable content typed into holds, as its `type`. The
   * typing in it has ended: it lost the focus, a key that is written as a
   * `key` was pressed, or the pointer was pressed. A pause between two keys
   * ends nothing: how fast a person types is no part of what they typed.
   *
   * @param {number} [timestamp] — the time of the key press that ended the
   *   typing, when a key press writes the entry
   * @returns {Promise<void>} settled once the worker has answered
   */
  const editableText = (el) => el.innerText.trim().slice(0, 500);

  function writeEditableEntry(timestamp = Date.now()) {
    const el = editableTypedInto;
    if (!el) return Promise.resolve();
    const now = editableText(el);
    // The text taken at the press of a key that waited behind a dead key is
    // what that key ended. Text the element holds beyond it came with or
    // after the key, and is the element's next entry.
    const atPress = editableAtKeyBehind?.el === el ? editableAtKeyBehind.value : null;
    editableAtKeyBehind = null;
    const value = atPress ?? now;
    if (value === now || !active) editableTypedInto = null;
    else editableReadAtPress = true;
    if (!active) return Promise.resolve();
    const sent = appendAction({
      type: 'type',
      timestamp,
      element: describeElement(el),
      value,
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
    // A key press still waiting to be known as text or as a key had no text
    // follow it: it is the key it was, and is written first.
    resolvePendingKeys();
    writeEditableEntry();
    const field = document.activeElement;
    if (field && hasUnwrittenEntry(field)) writeEntry(field);
    return lastSent.then(() => undefined);
  }

  /**
   * Whether the field holds an entry made with the keys and not yet written.
   *
   * @param {Element} el
   * @returns {boolean}
   */
  function hasUnwrittenEntry(el) {
    return (
      takesEntry(el) &&
      fieldsEditedByKey.has(el) &&
      (el.value !== fieldValueAtFocus.get(el) ||
        entryMadeAgain.has(el) ||
        composesUnwrittenText(el))
    );
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

  /** The keys that change a field's text without entering a character. */
  const EDITING_KEYS = ['Backspace', 'Delete', 'Insert', 'Clear', 'Cut', 'Paste', 'Undo', 'Redo'];

  // ─── Key presses waiting to be known as text or as a key (#702) ───────────────
  //
  // A character key pressed in a field that takes text, with no shortcut
  // modifier held, is text only if it is entered, and that is known after the
  // keydown. Until then the press waits here, in the order pressed. A shortcut
  // and every other key are written at once.
  //
  //   Made text (dropped; the field's `type` records it) by:
  //     - `input` with inputType `insertText`, anywhere in the document (a
  //       page can move the focus from its key handler, so the text can land
  //       in another field);
  //     - for a run in a date or time field, any `input` on that field;
  //     - the field holding other text when the press is resolved than it
  //       held at the press (a page that cancels the key and enters the
  //       character itself).
  //   Made the `key` it was (written with the time of the press) by whichever
  //   of these comes first:
  //     - the timer task after the press's `keypress` (the browser enters a
  //       key's text while it handles that event);
  //     - the key's release, or the release of any key;
  //     - the next key press;
  //     - a pointer action, or any other action written in a later task;
  //     - the window losing the focus, or the page being left.
  //   A stop and a step commit write them first, as the keys they were (the
  //   end of typing the worker asks for); forgotten, unwritten, when capture
  //   goes off by another route with them still waiting.
  //
  // Two kinds of press wait for more than themselves. A date or time field
  // has a value, and sends `input`, only once its parts make one: the
  // character keys typed into one wait together as a run (`byParts`). A dead
  // key enters nothing until the next key is pressed in its field (`dead`).
  // With a character key it is text or a key together with that press. A key
  // of another kind waits behind it (`behindDead`) while the browser handles
  // that key: where the bare accent is entered then (`input` with inputType
  // `insertText` in the dead key's own field), the dead key is text and only
  // the key behind it is a `key`; otherwise both are keys, in the order
  // pressed (#769). The field holding other text does not make such a dead
  // key text: the key behind it can change the field by itself. The timer and a release leave a run and a dead key with
  // nothing behind it waiting, and a press that does not belong with them
  // ends the wait.
  let pendingKeys = [];
  // The actions the browser caused while it handled a waiting press, other
  // than entries: written behind the press once it is known what it was.
  let heldBehindPendingKeys = [];
  // Set while waiting presses are being written, so that what they write goes
  // straight out.
  let writingPendingKeys = false;

  /**
   * The text an element that takes text holds: a field's value, or the text
   * of editable content. Null for any other element.
   *
   * @param {Element|null} el
   * @returns {string|null}
   */
  function textHeld(el) {
    if (!el) return null;
    if (takesEntry(el)) return el.value;
    return el.isContentEditable === true ? el.textContent : null;
  }

  /**
   * A waiting press turned out to be text of its field with no `input` saying
   * so: what the field holds is an entry the person made.
   *
   * @param {Element} field
   */
  function noteTextEntered(field) {
    if (takesEntry(field)) {
      fieldsEditedByKey.add(field);
      noteEntryMadeAgain(field);
      return;
    }
    // Editable content inside a shadow root is not taken for a host, as at
    // its `input` (which reaches this document as the shadow host's).
    if (field.getRootNode?.() !== document) return;
    const host = field.closest?.('[contenteditable=""], [contenteditable="true"]') ?? field;
    if (editableTypedInto !== host) writeEditableEntry();
    editableTypedInto = host;
  }

  /**
   * Write a key press: the entry its field held at the press first (#703),
   * then the `key`. A character key pressed on a sensitive element, other
   * than a shortcut, is never a `key`, which would name the character: the
   * element's masked `type` is written in its place (the service worker
   * stores a run of them once).
   */
  function writeKeyPress(press) {
    const { el, entry } = press;
    const time = press.action.timestamp;
    let entryWritten = false;
    if (entry && entryLastWritten.get(el) !== entry.value) {
      writeEntry(el, time, entry.value);
      entryWritten = true;
    }
    if (press.secret) {
      const sensitive = press.secret;
      if (!takesEntry(sensitive)) writeMaskedEntry(sensitive, time);
      else if (!(entryWritten && el === sensitive)) writeEntry(sensitive, time);
      return;
    }
    // The key ends the typing in editable content too: its entry stands ahead
    // of the key.
    if (!editableReadAtPress) writeEditableEntry(time);
    sendAction(press.action);
    markUserAction();
    // What the field holds after a key that can change it is an entry the
    // person made.
    if (press.edits && takesEntry(el)) fieldsEditedByKey.add(el);
    // The key is down by a written keydown from here on, and named as held.
    // The Meta key is never named: it is a modifier while it is held, which
    // `modifiers` states. (A character key pressed on a sensitive element is
    // never written as a `key`, so it does not get here.)
    const named = press.downByThis && press.key !== 'Meta';
    if (named && keysDown.get(press.code) === null) keysDown.set(press.code, press.key);
  }

  /** Send what waited behind the presses, once none is waiting. */
  function releaseHeldBehindPendingKeys() {
    if (pendingKeys.length > 0 || heldBehindPendingKeys.length === 0) return;
    const held = heldBehindPendingKeys;
    heldBehindPendingKeys = [];
    for (const action of held) sendAction(action);
  }

  /**
   * The waiting presses have had their chance to be entered by the browser.
   * Each is the key it was, unless its field holds other text than at the
   * press: then the page entered it, and it is text. `keep` names the presses
   * that go on waiting.
   */
  function resolvePendingKeys(keep = () => false) {
    if (pendingKeys.length === 0) return;
    const pending = pendingKeys;
    pendingKeys = pending.filter(keep);
    const resolved = pending.filter((press) => !pendingKeys.includes(press));
    writingPendingKeys = true;
    try {
      for (const [at, press] of resolved.entries()) {
        // A dead key with a key behind it is text only by the `input` for
        // its accent in its own field (`pendingKeysBecameText`): the key
        // behind it can change the field by itself.
        const keyBehind = press.dead && resolved.slice(at + 1).some((later) => later.behindDead);
        const fieldChanged =
          press.textAtPress !== null && textHeld(press.field) !== press.textAtPress;
        if (fieldChanged && !keyBehind) {
          noteTextEntered(press.field);
        } else {
          writeKeyPress(press);
        }
      }
    } finally {
      writingPendingKeys = false;
    }
    if (pendingKeys.length === 0) {
      editableAtKeyBehind = null;
      editableReadAtPress = false;
    }
    releaseHeldBehindPendingKeys();
  }

  /**
   * A press in a run waits for the rest of the run, and a dead key for the
   * character key after it.
   */
  const waitsForMore = (press, at, all) =>
    press.byParts || (press.dead && all.slice(at).every((later) => later.dead));

  /** The browser entered text: the waiting presses it stands for were text. */
  function pendingKeysBecameText(e) {
    const typed = e.inputType === 'insertText';
    // A dead key's character can come as a composition's text.
    const composed = e.inputType === 'insertCompositionText';
    if (pendingKeys.length === 0) return;
    const target = e.composedPath?.()[0] ?? e.target;
    const waiting = pendingKeys.length;
    const keyBehind = pendingKeys.some((press) => press.behindDead);
    pendingKeys = pendingKeys.filter((press) => {
      if (press.byParts) return press.field !== target && press.el !== e.target;
      // The key behind a dead key is no text: the text is the dead key's.
      if (press.behindDead) return true;
      // With a key behind it, a dead key is text only where the typed text
      // lands in its own field: that key's own character can land in the
      // field the focus moved to (#769).
      if (press.dead && keyBehind) return !(typed && press.field === target);
      return press.dead ? !typed && !composed : !typed;
    });
    // The text can land in another field than the one the key was pressed in
    // (the page moved the focus): what that field holds is an entry the
    // person made.
    // Text still being composed (a dead key's accent shown) may yet be given
    // up, and is not taken for entered here.
    if (pendingKeys.length < waiting && takesEntry(e.target)) {
      fieldsEditedByKey.add(e.target);
      if (typed) noteEntryMadeAgain(e.target);
    }
    // A key that waited behind a dead key waits for nothing more once the
    // dead key is known to be text.
    if (pendingKeys.length > 0 && pendingKeys.every((press) => press.behindDead)) {
      resolvePendingKeys();
    }
    releaseHeldBehindPendingKeys();
  }

  /** Capture went off: nothing that waited is written. */
  function forgetPendingKeys() {
    pendingKeys = [];
    heldBehindPendingKeys = [];
    editableAtKeyBehind = null;
    editableReadAtPress = false;
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
  // The keydown, keypress or keyup of a key press that is written, or waits to
  // be, is being dispatched. The browser derives a key's click while it
  // handles one of them (#695), and a page's own handlers run then; the flag
  // stays up until the next timer task.
  let keyEventInTask = false;
  // The physical keys whose latest keydown is written or waits to be, by `code`.
  const pressedKeysDown = new Set();
  // The physical keys that are down, by `code`, in the order they went down:
  // each with the name its `key` action carries when the keydown it is down by
  // was written, and null when that keydown was not (text typed into a field).
  // The keydown a key is down by is its
  // press, or the first of its repeats this document saw when it did not see
  // the press; later repeats change nothing.
  const keysDown = new Map();
  // The physical keys that went down while the Meta key was held, by `code`.
  const downUnderMeta = new Set();
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
  // Fields in which text was entered since their entry was last written or
  // they took the focus: what such a field holds is a new entry also where it
  // equals the one written or the value at focus (the same text typed over
  // itself, a value undone or removed and typed again).
  const entryMadeAgain = new WeakSet();

  /** Text was entered in `field`: what it holds is a new entry. */
  function noteEntryMadeAgain(field) {
    entryMadeAgain.add(field);
    entryLastWritten.delete(field);
  }

  // ─── Text composed by an input method (#744) ─────────────────────────────────
  //
  // One composition that ends with text is one act of entering text: what its
  // field holds afterwards is a new entry, as after the same text typed with
  // plain keys. A composition given up enters nothing. The keys pressed inside
  // a composition are no `key` actions (`keyPressKind`).
  //
  //   Open: from the browser's `compositionstart` on a field, or from the first
  //     composing `input` (`insertCompositionText`) where no start was seen (a
  //     recording that began inside the composition), to the `compositionend`
  //     that follows.
  //   While it is open, the text it shows is typing not yet ended: a pointer
  //     press, a step commit or a stop writes the field's entry with it, as
  //     with typed text, also where the field then holds what it held at focus.
  //   At its end the composition entered text when the text it showed last is
  //     not empty, unless an entry written while it was open held that text
  //     already and nothing was composed since. Text composed on after such a
  //     write and taken back to the text written is entered again, as plain
  //     typing writes `a`, then `ab`, then `a`.
  //   Over with no end: when the browser changes the field's text by other
  //     means than composing (the composing text removed with an editing
  //     key). Nothing was entered by it.
  //   Forgotten: when a recording ends or begins.
  //
  // The browser does not mark every composition end it sends itself as
  // trusted, so the mark cannot be asked for, and a page can send the event
  // while the person composes. The start tells the two apart: the browser's is
  // trusted, and with no start since an end, more composing text or a key
  // pressed inside the composition says the end was not the browser's. That end is then taken back,
  // and the composition goes on as if it had not come.
  //
  // The composition last opened: its field, the text it showed last, the
  // composing text an entry written during it held (undefined when none was
  // written), whether another text was composed after that write, whether an
  // end has come for it, and how to take that end back.
  let composition = null;
  // The field a key the input method took was pressed in, until the next key
  // press: text the browser inserts there in that time is the key's, also
  // with no composition around it.
  let fieldOfTakenKey = null;

  /** The browser opened a composition in a field. */
  function openComposition(field) {
    if (!takesEntry(field)) return;
    composition = {
      field,
      text: '',
      written: undefined,
      composedOn: false,
      ended: false,
      endedByEvent: false,
      undoEnd: null,
    };
  }

  /**
   * The composition in `field` goes on although a `compositionend` came for
   * it, with no start since: the end was not the browser's and is taken back.
   */
  function takeBackEnd(field) {
    if (composition?.field !== field || !composition.endedByEvent) return;
    composition.ended = false;
    composition.endedByEvent = false;
    composition.undoEnd?.();
    composition.undoEnd = null;
  }

  /** Text was composed in a field: note it for the composition's end. */
  function noteComposingText(e) {
    const field = e.target;
    if (!takesEntry(field)) return;
    if (composition?.field !== field) openComposition(field);
    takeBackEnd(field);
    // Composing text after a composition left with no end, and no start
    // since, is the composition going on too.
    composition.ended = false;
    composition.text = e.data ?? '';
    if (composition.written !== undefined && composition.text !== composition.written) {
      composition.composedOn = true;
    }
    fieldsEditedByKey.add(field);
  }

  /**
   * Whether the field shows composing text that no entry written holds yet:
   * typing not yet ended, as text typed with plain keys is.
   *
   * @param {Element} el
   * @returns {boolean}
   */
  function composesUnwrittenText(el) {
    return (
      composition?.field === el &&
      !composition.ended &&
      composition.text !== '' &&
      (composition.written === undefined || composition.composedOn)
    );
  }

  /**
   * The browser changed the field's text by other means than composing: the
   * composition is over. The browser sends no end where the composing text is
   * removed with an editing key (a dead key's accent shown, then Backspace).
   * Nothing was entered by it; what the field holds is judged as after any
   * other key.
   */
  function closeCompositionLeft(field) {
    if (composition?.field !== field || composition.ended) return;
    composition.ended = true;
  }

  /** The open composition ended: its text, if it entered any, is a new entry. */
  function endComposition(field) {
    const ended = composition;
    if (ended?.field !== field || ended.ended) return;
    ended.ended = true;
    ended.endedByEvent = true;
    if (ended.text === '') return;
    if (ended.written !== undefined && !ended.composedOn) return;
    const wasMadeAgain = entryMadeAgain.has(field);
    const hadWritten = entryLastWritten.has(field);
    const lastWritten = entryLastWritten.get(field);
    ended.undoEnd = () => {
      if (!wasMadeAgain) entryMadeAgain.delete(field);
      if (hadWritten) entryLastWritten.set(field, lastWritten);
    };
    fieldsEditedByKey.add(field);
    noteEntryMadeAgain(field);
  }

  /** Nothing of a composition or of a key the input method took is kept. */
  function forgetComposition() {
    composition = null;
    fieldOfTakenKey = null;
  }

  /**
   * The browser inserted text in a field with no waiting press to stand for
   * it: text a key the input method took entered with no composition, or text
   * pasted. What the field holds is a new entry. Text a page inserts between
   * a key the input method took and the next key press cannot be told from
   * that key's own and is taken for it.
   */
  function noteTextInserted(e) {
    const field = e.target;
    if (!takesEntry(field)) return;
    const byTakenKey = e.inputType === 'insertText' && fieldOfTakenKey === field;
    if (!byTakenKey && e.inputType !== 'insertFromPaste') return;
    fieldsEditedByKey.add(field);
    noteEntryMadeAgain(field);
  }

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
      // A right-click is the press of the right button, as on the desktop
      // (#715): the browser's menu request comes at the press or at the
      // release as the system has it, and a page can keep it from arriving.
      if (e.button === 2) writeRightClick(e);
    },
    { capture: true, passive: true },
  );

  /**
   * Write a `right_click` with the position, the modifiers and the held keys
   * of the event: the press of the right button, or a menu request that no
   * such press came before. A press picked on the body or the document
   * element is not written.
   *
   * @param {MouseEvent} e
   */
  function writeRightClick(e) {
    const el = e.target.closest(INTERACTIVE) ?? e.target;
    if (el === document.body || el === document.documentElement) return;
    resolvePendingKeys();
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
  }

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
      // A click with no pointer, sent while the browser handles a written key
      // (Enter or Space on a button, an arrow key in a radio group, Enter's
      // implicit submission), is that key's effect: the key is the record
      // (#695). It still opens a file input's dialog, and it is the moment the
      // activation happens, which a Space press reaches only at its release.
      if (e.pointerType === '' && keyEventInTask) {
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
      // A key press still waiting was no text: it is written, and named as
      // held, ahead of this action.
      resolvePendingKeys();
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

  // ─── Context menu request ─────────────────────────────────────────────────────

  document.addEventListener(
    'contextmenu',
    (e) => {
      if (!active) return;
      if (!e.isTrusted) return;
      // A menu asked for with a key (the Menu key, Shift+F10) is that key's
      // effect, sent while the browser handles the key: the key is the record.
      if (e.button !== 2 && keyEventInTask) {
        markUserAction();
        return;
      }
      // A request that carries the right button follows a press of that
      // button, which is the record, wherever and whenever it was made:
      // another button pressed in between, or a release over another
      // document, changes nothing about that. A request that carries no
      // right button (a long press on a touch screen) has no press, and is
      // written here.
      if (e.button === 2) return;
      writeRightClick(e);
    },
    { capture: true, passive: true },
  );

  // ─── Keyboard capture ─────────────────────────────────────────────────────────
  // Writes every key press that is not text as a `key`, on the focused element
  // or on the body when nothing is focused: named keys (Enter, Backspace, F2),
  // shortcuts, and character keys that entered no text. Shift, Ctrl, Alt and
  // AltGr pressed alone, and keys the input method takes, are no press to
  // write. Each press is written with the browser's own repeat flag, so a held
  // key's generated presses are told from the physical one.

  /**
   * The elements the focus passes through, outermost first: the document's
   * active element (the host of a shadow tree that holds the focus), then the
   * active element of each shadow root on the way to the element the focus
   * rests on, which is the last. A closed root is read through the
   * extension's own accessor, so a Space typed into a field inside one is
   * still seen as typed text.
   *
   * @returns {Element[]}
   */
  function focusPath() {
    const path = [];
    let el = document.activeElement;
    while (el) {
      path.push(el);
      let root = el.shadowRoot;
      if (!root) {
        try {
          root = chrome.dom?.openOrClosedShadowRoot(el) ?? null;
        } catch {
          root = null; // not an element that can host a shadow tree
        }
      }
      el = root?.activeElement ?? null;
    }
    return path;
  }

  /**
   * Mark that a written key's event is being dispatched. The browser sends a
   * derived click from inside that dispatch, as the event's default action, so
   * the mark must outlive this listener and is dropped by the next timer task.
   * A microtask would drop it too early: it runs as the listener returns,
   * ahead of the default action.
   */
  function markKeyEvent() {
    keyEventInTask = true;
    setTimeout(() => {
      keyEventInTask = false;
    }, 0);
  }

  document.addEventListener(
    'keydown',
    (e) => {
      if (!active) return;
      if (!e.isTrusted) return;
      // Every keydown restates whether this physical key's press is a written one.
      pressedKeysDown.delete(e.code);
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
      const modifiers = modifiersOf(e);
      // A key the input method takes is reported with key code 229, also where
      // the browser names it as the key it would be without the input method.
      const kind = keyPressKind(e.key, e.isComposing || e.keyCode === 229);
      // A key the input method took counts for its field until the next press.
      fieldOfTakenKey =
        kind === 'composed' && fieldInFocus && takesEntry(fieldInFocus) ? fieldInFocus : null;
      const shortcut = isShortcut(modifiers, ALT_ENTERS_CHARACTERS);
      const focused = focusPath();
      const field = focused.at(-1) ?? null;
      const byParts = takesTextByParts(field);
      // A press that enters a character where anything takes it.
      const character = kind === 'character' && !shortcut;
      // Whether the press can turn out to be text of the field, which is known
      // only after it. A space in a date or time field opens its picker and is
      // no text of the field.
      const mayBeText = character && mayTakeText(field) && !(byParts && e.key === ' ');
      // The character keys typed into a date or time field wait together.
      const inRun = mayBeText && byParts;
      // A dead key waits for the character key after it.
      const dead = mayBeText && !byParts && e.key === 'Dead';
      // A character pressed on a sensitive element is never written under its
      // own name, whether or not the element takes text.
      // The sensitive element can be the one in focus or a shadow host it
      // sits in (a widget named as a one-time code, its cells unnamed). A
      // key is written on the outermost element, so under a sensitive host
      // every character key is the host's masked entry; the element in
      // focus is exempt as a control that takes no typed text only where no
      // host above it is sensitive. A key of the numeric keypad pressed
      // with Alt alone counts as a character key here: a run of them enters
      // the character with that code, with Num Lock on or off.
      const altCode =
        modifiers.alt && !modifiers.ctrl && !modifiers.meta && /^Numpad\d$/.test(e.code);
      const sensitiveHost = focused.slice(0, -1).findLast(isSensitiveElement) ?? null;
      const sensitiveField = isSensitiveElement(field) && !takesNoTypedText(field) ? field : null;
      const secret = character || altCode ? (sensitiveField ?? sensitiveHost) : null;
      // A press before this one that still waits has had its chance: the
      // browser enters a key's text before the next key. A run goes on with
      // a press that belongs to it. A dead key waits for the next key press
      // in its field, through the modifiers and the input method's keys
      // pressed on the way: its accent goes into the character a character
      // key enters, and the browser can enter the bare accent with a key of
      // another kind, while it handles that key (#769). Once such a key
      // waits behind it, the press after that ends the wait of both.
      const keyBehindWaits = pendingKeys.some((press) => press.behindDead);
      const goesOn = inRun
        ? (press) => press.byParts && press.field === field
        : keyBehindWaits
          ? undefined
          : (press) => press.dead && press.field === field;
      resolvePendingKeys(goesOn);
      // The entry the person made in the field is complete before this press,
      // and the browser's `change` for it comes only while it handles the
      // press (Enter's submission, the blur Tab causes), or later. Noted here
      // as it stands, it is written ahead of the key (#703).
      // A key pressed inside a composition says it is still open.
      if (e.isComposing && fieldInFocus) takeBackEnd(fieldInFocus);
      const entry =
        fieldInFocus &&
        hasUnwrittenEntry(fieldInFocus) &&
        entryLastWritten.get(fieldInFocus) !== fieldInFocus.value
          ? { value: fieldInFocus.value }
          : null;
      // A key that can become the field's text (a character key that is no
      // shortcut, or a key the input method takes) is a key pressed in the
      // field. Whether it makes what the field holds a new entry is known
      // when its text arrives (`noteEntryMadeAgain`): a key the page cancels
      // enters nothing, and the entry written before it is not written again.
      // For a key the input method takes it is known at the end of the
      // composition (`endComposition`) or when its text is inserted with none
      // (`noteTextInserted`).
      const entersText = mayBeText || kind === 'composed';
      if (entersText && fieldInFocus && takesEntry(fieldInFocus)) {
        fieldsEditedByKey.add(fieldInFocus);
      }
      // No press to write: a modifier alone, and a key the input method takes.
      if (kind === 'modifier' || kind === 'composed') return;
      // A key the input method does not take: no composition is open any
      // more, also where the browser sent no end for it (a page that took
      // the composing text out). What it showed is in `entry` above.
      if (fieldInFocus) closeCompositionLeft(fieldInFocus);
      // A key pressed while the Meta key is held may never be seen released.
      if (e.metaKey && e.key !== 'Meta') downUnderMeta.add(e.code);
      const key = keyActionName(e.key);
      // Set Tab timestamp BEFORE the element is read — focus after Tab on body
      // still needs to be captured (it tells us where focus went).
      if (key === 'Tab') lastTabKeyTimestamp = Date.now();
      // With nothing focused the body is the active element, and the key is
      // written on it. A document with no body has no element to write it on.
      const el = document.activeElement;
      if (!el) return;
      const press = {
        el,
        field,
        entry,
        code: e.code,
        key,
        downByThis,
        byParts: inRun,
        dead,
        // A key that is no character key, pressed behind a dead key that
        // still waits: it is written behind the dead key, once it is known
        // what that was.
        behindDead: !mayBeText && pendingKeys.length > 0,
        secret,
        // What the field held at the press, for a press that waits.
        textAtPress: mayBeText ? textHeld(field) : null,
        // A key other than a plain character can change the field it is
        // pressed in (an editing key, a shortcut that pastes or cuts).
        edits: EDITING_KEYS.includes(key) || shortcut || modifiers.alt,
        action: {
          type: 'key',
          timestamp: Date.now(),
          key,
          modifiers,
          repeat: e.repeat,
          // The physical key, where the browser names one.
          ...(e.code ? { code: e.code } : {}),
          held_keys: heldKeys(e.code),
          element: describeElement(el),
        },
      };
      // The browser derives a click from a key press while it handles one of
      // the press's events; a press that waits is marked like one written.
      pressedKeysDown.add(e.code);
      markKeyEvent();
      if (mayBeText || press.behindDead) pendingKeys.push(press);
      else writeKeyPress(press);
      // A key behind a dead key is written once the browser and the page
      // have handled it: the editable content's text is taken here, before
      // they act, for the entry that key ends.
      if (press.behindDead && editableTypedInto && !editableAtKeyBehind) {
        editableAtKeyBehind = { el: editableTypedInto, value: editableText(editableTypedInto) };
      }
    },
    { capture: true, passive: true },
  );

  // The later events of a press. Each marks its task, because the browser
  // derives a key's click from whichever of the three it acts on: an arrow
  // key's and a link's Enter from keydown, a button's Enter from keypress, a
  // Space press from keyup. Each also settles presses that wait (see the map
  // at `pendingKeys`).
  document.addEventListener(
    'keypress',
    (e) => {
      if (!active) return;
      if (!e.isTrusted) return;
      if (pressedKeysDown.has(e.code)) markKeyEvent();
      // The browser enters a key's text while it handles this event. A press
      // still waiting once that is over entered none: the next timer task
      // comes after it, whether or not the key is released.
      if (pendingKeys.some((press) => !press.byParts)) {
        setTimeout(() => {
          if (active) resolvePendingKeys(waitsForMore);
        }, 0);
      }
    },
    { capture: true, passive: true },
  );

  document.addEventListener(
    'keyup',
    (e) => {
      if (!e.isTrusted) return;
      // A press released with no text entered was a key.
      if (active) resolvePendingKeys(waitsForMore);
      // A release ends the key's time among the held keys whether or not the
      // recording is on: a key released while it is off is not down after it.
      keysDown.delete(e.code);
      downUnderMeta.delete(e.code);
      // Some systems send the page no release for a key let go while the Meta
      // key is held: once the Meta key is released, no key pressed under it
      // is known to be down. One still held is down again by its next repeat.
      if (e.key === 'Meta') {
        for (const code of downUnderMeta) {
          keysDown.delete(code);
          pressedKeysDown.delete(code);
        }
        downUnderMeta.clear();
      }
      const pressed = pressedKeysDown.delete(e.code);
      if (active && pressed) markKeyEvent();
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
      // No text comes for a press still waiting once the window is left.
      if (active) resolvePendingKeys();
      pressedKeysDown.clear();
      keysDown.clear();
      downUnderMeta.clear();
    },
    { capture: true, passive: true },
  );

  // A page that is left takes its waiting presses with it: no text comes for
  // them, so they are written as the keys they were while the page still can.
  window.addEventListener(
    'pagehide',
    (e) => {
      if (!e.isTrusted) return;
      if (active) resolvePendingKeys();
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
        // An entry already written, ahead of the key that followed it,
        // is not written again.
        if (entryLastWritten.get(el) === el.value) return;
        // Suppress change events caused by blur from clicking a submit button within the same form.
        // When the user clicks submit, the input blurs and fires change. But the user's
        // intent is captured by the click — the type was already captured earlier (or will
        // be captured when the user explicitly tabs/clicks away without submitting).
        // Event order: mousedown(submit) → blur(input) → change(input) → click(submit)
        if (blurFollowsPressOnSubmitOf(el)) return;
        writeEntry(el);
      }
    },
    { capture: true, passive: true },
  );

  /** Whether `el` loses the focus to a press on a submit control of its own form. */
  function blurFollowsPressOnSubmitOf(el) {
    return (
      !!lastMousedownEl &&
      lastMousedownEl !== el &&
      Date.now() - lastMousedownTime < 100 &&
      pressesSubmitOfItsForm(el, lastMousedownEl)
    );
  }

  /**
   * A field loses the focus holding an entry not yet written: it is written
   * here. The browser's `change` cannot be waited for: it sends none where the
   * field holds what it held before the first edit since it took the focus,
   * which an entry made again does. Where it sends one, it comes first and
   * leaves no entry unwritten.
   */
  function writeEntryAtBlur(e) {
    if (!active || !e.isTrusted) return;
    const el = e.target;
    if (!hasUnwrittenEntry(el) || entryLastWritten.get(el) === el.value) return;
    if (blurFollowsPressOnSubmitOf(el)) return;
    writeEntry(el);
  }

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
        entryMadeAgain.delete(e.target);
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
      if (active) resolvePendingKeys();
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
      resolvePendingKeys();
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
      pendingKeysBecameText(e);
      if (e.inputType === 'insertCompositionText') {
        noteComposingText(e);
      } else {
        closeCompositionLeft(e.target);
        noteTextInserted(e);
      }
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
      if (e.target === editableTypedInto) writeEditableEntry();
      writeEntryAtBlur(e);
    },
    { capture: true, passive: true },
  );

  // The start and the end of a composition (see the map at `composition`).
  // Neither writes anything: the entry is written where plain typing's is.
  document.addEventListener(
    'compositionstart',
    (e) => {
      if (!active) return;
      if (!e.isTrusted) return;
      openComposition(e.target);
    },
    { capture: true, passive: true },
  );

  document.addEventListener(
    'compositionend',
    (e) => {
      if (!active) return;
      endComposition(e.target);
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
