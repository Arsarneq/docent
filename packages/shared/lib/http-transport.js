/**
 * http-transport.js — Platform HTTP transport seam
 *
 * Docent's sync, dispatch, and connection-test logic live in the shared layer
 * and must issue HTTP requests to a user-configured server. WHICH mechanism
 * actually performs the request is platform-specific:
 *
 *   - **Extension** — the webview's global `fetch`. Cross-origin requests to the
 *     configured endpoint succeed because the extension declares
 *     `host_permissions: ["<all_urls>"]`, which bypasses the browser's CORS at
 *     the network layer.
 *   - **Desktop (Windows + Linux, Tauri)** — a native HTTP request issued from
 *     Rust (the `sync_http_request` command). The desktop has no
 *     `host_permissions` equivalent, so a webview `fetch` to a server that does
 *     not emit CORS headers (the reference server, and any correctly-scoped
 *     adopter backend) has its response discarded by the webview and surfaces as
 *     "could not reach the server". Issuing the request below the webview removes
 *     CORS from the path entirely, identically on WebView2 (Windows) and
 *     WebKitGTK (Linux).
 *
 * Rather than thread a transport argument through every entry point and every
 * call site (panels, auto-sync hosts, and the 792 shared tests that mock
 * `globalThis.fetch`), the shared HTTP code calls {@link httpRequest}, and each
 * platform binds its transport ONCE at startup via {@link setHttpTransport}.
 *
 * **The default IS `globalThis.fetch`, read lazily at call time.** When no
 * transport is bound (the extension, and every shared unit/property test),
 * `httpRequest` simply forwards to `globalThis.fetch`. Reading the global at
 * call time — not at module load — is deliberate: it preserves the existing test
 * architecture, which injects fetch behaviour by assigning `globalThis.fetch`
 * before driving `sync()`/`sendPayload()`/`testConnection()`.
 *
 * The contract is intentionally a strict subset of `fetch`:
 *
 *   transport(url: string, options?: {
 *     method?: string, headers?: Record<string,string>,
 *     body?: string|null, signal?: AbortSignal
 *   }) => Promise<{
 *     ok: boolean, status: number,
 *     headers: { get(name: string): string | null },
 *     json(): Promise<any>, text(): Promise<string>
 *   }>
 *
 * A bound transport need only honour the fields the shared callers use. The
 * desktop transport ignores `signal` (the native command enforces its own
 * timeout) — abort is a best-effort optimisation, never a correctness
 * requirement here.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

/**
 * The platform-bound transport, or `null` when none is bound (→ `globalThis.fetch`).
 * @type {((url: string, options?: object) => Promise<object>) | null}
 */
let boundTransport = null;

/**
 * Bind the platform HTTP transport. Called ONCE per platform at startup — the
 * desktop binds its native (Rust-backed) transport; the extension leaves it
 * unbound so requests use `globalThis.fetch` (host-permission-backed).
 *
 * @param {(url: string, options?: object) => Promise<object>} transport
 *   a `fetch`-shaped function (see the module contract above)
 * @returns {void}
 */
export function setHttpTransport(transport) {
  boundTransport = typeof transport === 'function' ? transport : null;
}

/**
 * Clear any bound transport so {@link httpRequest} falls back to
 * `globalThis.fetch`. Primarily for tests that bind a transport and want to
 * restore the default afterwards; a no-op when nothing is bound.
 *
 * @returns {void}
 */
export function resetHttpTransport() {
  boundTransport = null;
}

/**
 * Issue an HTTP request through the platform-bound transport, or
 * `globalThis.fetch` when none is bound. The shared sync / dispatch /
 * connection-test code calls this in place of `fetch`.
 *
 * @param {string} url
 * @param {object} [options] - `fetch`-shaped options (method, headers, body, signal)
 * @returns {Promise<object>} a `fetch`-shaped response (see the module contract)
 */
export function httpRequest(url, options) {
  if (boundTransport) return boundTransport(url, options);
  return globalThis.fetch(url, options);
}
