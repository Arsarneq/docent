// sync_http.rs — Native HTTP transport for sync / dispatch / connection-test (S20).
//
// The desktop frontend cannot reach a sync/dispatch server through the webview's
// `fetch`: the request is cross-origin and the server (the reference server, and
// any correctly-scoped adopter backend) emits no CORS headers, so WebView2 /
// WebKitGTK discard the response and the client reports "could not reach the
// server". Issuing the request HERE, from Rust, removes CORS from the path
// entirely — identically on Windows and Linux. See SECURITY_BACKLOG S20.
//
// This is the SINGLE outbound-HTTP chokepoint exposed to the frontend (the
// `sync_http_request` command). It is deliberately a narrow, purpose-built
// command rather than the general `tauri-plugin-http` `fetch` granted to JS, so
// the only outbound primitive the webview can reach is this one, which:
//   - enforces the same transport policy as the CSP `connect-src` and S11:
//     `https://` to any host, plaintext `http://` only to loopback, and never a
//     link-local / cloud-metadata address (169.254.0.0/16); and
//   - applies its own request timeout (the webview `signal` is not plumbed
//     through `invoke`, so the timeout lives here).
//
// Paired with `withGlobalTauri: false` (S13): this primitive is reachable only
// via an explicit ESM `invoke('sync_http_request', …)`, not a `window.__TAURI__`
// global an injected script could trivially grab.

use std::collections::HashMap;
use std::net::IpAddr;
use std::time::Duration;

/// Per-request timeout for the native transport. Mirrors the dispatch path's
/// 30s per-attempt webview timeout, which cannot be enforced via the webview
/// `AbortSignal` once the request is issued from Rust.
const REQUEST_TIMEOUT_SECS: u64 = 30;

/// A `fetch`-shaped response returned to the frontend transport adapter. Header
/// names are lower-cased so the JS side's case-insensitive `headers.get(name)`
/// matches without further normalisation.
#[derive(serde::Serialize)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

/// Strip surrounding brackets from an IPv6 host as it appears in a URL
/// (`[::1]` → `::1`) so it can be parsed as an `IpAddr`. Non-bracketed hosts
/// pass through unchanged.
fn unbracket(host: &str) -> &str {
    host.strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host)
}

/// True for loopback hosts: `localhost`, `127.0.0.0/8`, and `::1`.
fn is_loopback_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    match unbracket(host).parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => v4.is_loopback(), // 127.0.0.0/8
        Ok(IpAddr::V6(v6)) => v6.is_loopback(), // ::1
        Err(_) => false,
    }
}

/// True for the IPv4 link-local / cloud-metadata range 169.254.0.0/16 — never a
/// legitimate sync/dispatch target, and a classic SSRF pivot (S11).
fn is_link_local_host(host: &str) -> bool {
    matches!(unbracket(host).parse::<IpAddr>(), Ok(IpAddr::V4(v4)) if v4.is_link_local())
}

/// Validate and parse a sync/dispatch target URL, enforcing the same transport
/// policy as the webview `connect-src` CSP and S11. Returns the parsed URL on
/// success, or an actionable error string. This is the security-critical core
/// and is unit-tested directly.
///
/// Policy:
///   - scheme must be `http` or `https`;
///   - the link-local / cloud-metadata range (169.254.0.0/16) is always rejected;
///   - plaintext `http://` is permitted only for loopback hosts (local dev);
///     every other host must use `https://`.
pub fn validate_sync_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed =
        reqwest::Url::parse(url).map_err(|_| "Sync server URL is not a valid URL".to_string())?;

    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("Sync server URL must use http:// or https://".to_string());
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| "Sync server URL must have a host".to_string())?;

    if is_link_local_host(host) {
        return Err("Sync server URL must not target a link-local address (169.254.0.0/16)"
            .to_string());
    }

    if scheme == "http" && !is_loopback_host(host) {
        return Err(
            "Plaintext http:// is allowed only for localhost; use https:// otherwise".to_string(),
        );
    }

    Ok(parsed)
}

/// Core logic for `sync_http_request` — issues the validated request and maps
/// the response into the `fetch`-shaped [`HttpResponse`]. Async so it runs on
/// Tauri's runtime; not unit-tested (network I/O) — the URL policy it depends on
/// is covered by [`validate_sync_url`]'s tests, and the round trip by the
/// JS-level integration/e2e suites.
async fn sync_http_request_impl(
    method: String,
    url: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<HttpResponse, String> {
    let parsed = validate_sync_url(&url)?;

    let http_method = reqwest::Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|_| format!("Invalid HTTP method: {method}"))?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let mut request = client.request(http_method, parsed);
    for (name, value) in headers {
        request = request.header(name, value);
    }
    if let Some(body) = body {
        request = request.body(body);
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = response.status().as_u16();
    let mut header_map = HashMap::new();
    for (name, value) in response.headers().iter() {
        if let Ok(value_str) = value.to_str() {
            header_map.insert(name.as_str().to_ascii_lowercase(), value_str.to_string());
        }
    }

    let body_text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {e}"))?;

    Ok(HttpResponse {
        status,
        headers: header_map,
        body: body_text,
    })
}

/// Issue a native HTTP request on behalf of the shared sync / dispatch /
/// connection-test code (S20). The frontend transport adapter calls this via
/// `invoke('sync_http_request', { method, url, headers, body })` and adapts the
/// result back into a `fetch`-shaped response.
#[tauri::command]
pub async fn sync_http_request(
    method: String,
    url: String,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
) -> Result<HttpResponse, String> {
    sync_http_request_impl(method, url, headers.unwrap_or_default(), body).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_https_to_any_host() {
        assert!(validate_sync_url("https://sync.example.com/projects").is_ok());
        assert!(validate_sync_url("https://example.com:8443").is_ok());
    }

    #[test]
    fn accepts_http_to_loopback() {
        assert!(validate_sync_url("http://localhost:3000/projects").is_ok());
        assert!(validate_sync_url("http://127.0.0.1:3000").is_ok());
        assert!(validate_sync_url("http://[::1]:3000/projects").is_ok());
        // 127.0.0.0/8 is all loopback.
        assert!(validate_sync_url("http://127.7.7.7:3000").is_ok());
    }

    #[test]
    fn rejects_http_to_non_loopback() {
        let err = validate_sync_url("http://sync.example.com/projects").unwrap_err();
        assert!(err.contains("https://"), "got: {err}");
    }

    #[test]
    fn rejects_link_local_metadata_address() {
        // 169.254.169.254 is the cloud-metadata endpoint — rejected on either scheme.
        assert!(validate_sync_url("http://169.254.169.254/latest/meta-data").is_err());
        assert!(validate_sync_url("https://169.254.169.254/").is_err());
    }

    #[test]
    fn rejects_non_http_schemes() {
        assert!(validate_sync_url("ftp://example.com").is_err());
        assert!(validate_sync_url("file:///etc/passwd").is_err());
        assert!(validate_sync_url("not a url").is_err());
    }

    #[test]
    fn rejects_url_without_host() {
        // No authority component → no host.
        assert!(validate_sync_url("http:///projects").is_err());
    }
}
