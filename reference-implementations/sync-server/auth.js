/**
 * Optional Bearer authentication for the Reference Sync Server (Requirement 5).
 *
 * The server is open by default: when no Static_Token is configured it serves
 * every request and ignores any `Authorization` header. When a Static_Token is
 * configured it requires `Authorization: Bearer <token>` on every request —
 * protocol routes and `/__debug/*` alike (the router applies this uniformly).
 *
 * This module is intentionally a tiny, pure decision function so the auth rule
 * is readable in isolation and easy to reimplement in another language.
 */

/**
 * Evaluate the Bearer-token precondition for a request.
 *
 * @param {string|null|undefined} configuredToken
 *   The Static_Token, or null/undefined/empty when the server is open.
 * @param {import('node:http').IncomingMessage} req
 *   The incoming request; only `req.headers.authorization` is read.
 * @returns {{ ok: true } | { ok: false, status: 401 | 403 }}
 *   - no token configured           → `{ ok: true }`            (open; any header ignored — R5.4 / R5.5)
 *   - token set, header missing     → `{ ok: false, status: 401 }` (R5.2)
 *   - token set, Bearer != token    → `{ ok: false, status: 403 }` (R5.3)
 *   - token set, Bearer == token    → `{ ok: true }`            (R5.1)
 */
export function checkAuth(configuredToken, req) {
  // R5.4 / R5.5: open server — no Static_Token configured. Serve every request
  // and ignore any Authorization header that happens to be present.
  if (!configuredToken) {
    return { ok: true };
  }

  // Header names are lower-cased by Node's HTTP parser.
  const header = req?.headers?.authorization;

  // R5.2: a token is configured but the request carries no Authorization header.
  if (!header) {
    return { ok: false, status: 401 };
  }

  // Extract the credential following the `Bearer` scheme. The scheme name is
  // case-insensitive per RFC 6750; the token itself is compared exactly.
  const match = /^Bearer[ \t]+(.*)$/i.exec(header);
  const presentedToken = match ? match[1] : null;

  // R5.1: the presented Bearer token matches the configured Static_Token.
  if (presentedToken === configuredToken) {
    return { ok: true };
  }

  // R5.3: a header is present but its Bearer token does not match (this also
  // covers a malformed/non-Bearer Authorization header, which cannot match).
  return { ok: false, status: 403 };
}
