/**
 * tauri-bridge.js — the single access point to the Tauri API (S13).
 *
 * The app ships with `withGlobalTauri: false` (SECURITY_BACKLOG S13), so the
 * Tauri API is NOT exposed on `window.__TAURI__` at runtime. Reaching it through
 * an explicit ESM import — rather than a global an injected script could grab —
 * is the whole point: combined with the strict `script-src 'self'` CSP, there is
 * no ambient handle to `invoke` (and therefore no ambient handle to
 * `load_state` / `save_state` / `export_file` / `sync_http_request`) for a
 * webview foothold to abuse.
 *
 * Why a bridge instead of importing `@tauri-apps/api` directly in each module:
 *
 *   1. **Bundling is scoped to this one file.** `@tauri-apps/api/*` are bare
 *      module specifiers a browser cannot resolve. The desktop dist build runs
 *      esbuild over THIS file only (`build-desktop-dist.js`), inlining the API
 *      into a self-contained `tauri-bridge.js`. Every other source file imports
 *      `invoke`/`listen` from here as a plain relative module, so the rest of the
 *      dist stays unbundled — keeping the per-file Playwright V8-coverage mapping
 *      (`tests/integration/coverage-fixture.js`) intact.
 *
 *   2. **Tests need no rewrite.** The unit + integration suites inject a fake
 *      `window.__TAURI__`. This bridge PREFERS that injected global when present,
 *      so the existing test doubles keep working unchanged. In production the
 *      global is absent (`withGlobalTauri: false`), so the bridge falls back to
 *      the bundled ESM API. An injected `window.__TAURI__` in production would
 *      only let an attacker shim their OWN calls (the real API is reached via the
 *      bundled closure, never published to `window`), so this preference does not
 *      weaken the S13 property.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { invoke as esmInvoke } from '@tauri-apps/api/core';
import { listen as esmListen } from '@tauri-apps/api/event';

/**
 * Invoke a Tauri command. Prefers an injected `window.__TAURI__.core.invoke`
 * (test doubles) and otherwise uses the bundled ESM `invoke`.
 *
 * @param {...unknown} args - forwarded to the underlying `invoke`
 * @returns {Promise<unknown>}
 */
export function invoke(...args) {
  const globalInvoke = globalThis.window?.__TAURI__?.core?.invoke;
  return (globalInvoke ?? esmInvoke)(...args);
}

/**
 * Subscribe to a Tauri event. Prefers an injected `window.__TAURI__.event.listen`
 * (test doubles) and otherwise uses the bundled ESM `listen`.
 *
 * @param {...unknown} args - forwarded to the underlying `listen`
 * @returns {Promise<unknown>}
 */
export function listen(...args) {
  const globalListen = globalThis.window?.__TAURI__?.event?.listen;
  return (globalListen ?? esmListen)(...args);
}
