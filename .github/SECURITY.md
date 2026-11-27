# Security Policy

## Supported versions

Only the latest release of each platform (Chrome extension, desktop application) is actively maintained. If you find a vulnerability in an older version that also affects the latest release, it is still worth reporting.

---

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Use GitHub's private vulnerability reporting instead:

1. Go to the **Security** tab of this repository
2. Click **Report a vulnerability**
3. Fill in the details and submit

This keeps the report private until a fix is in place.

---

## What to include

A useful report covers:

- A clear description of the vulnerability
- Steps to reproduce it
- The platform and component affected
- The potential impact — what could an attacker do?
- Any affected versions you are aware of

---

## What to expect

This is a solo-maintained project. I aim to acknowledge reports within a few days, but cannot guarantee fixed timelines. I will investigate and coordinate disclosure before any fix is made public. Please give me a reasonable opportunity to investigate and ship a fix before disclosing the issue publicly.

---

## Safe harbor

I consider security research and disclosure conducted in good faith under this policy to be authorised. I will not pursue or support legal action against researchers who act in good faith, follow this policy, avoid privacy violations and service disruption, and give me reasonable time to address an issue before disclosing it publicly. If you are unsure whether something is acceptable, ask first.

---

## Scope

Docent has several capabilities with distinct attack surfaces:

### Interaction capture

- The Chrome extension runs with `<all_urls>` host permissions; the recorder is injected by the service worker only during an active recording, rather than running as a persistent content script. The desktop application captures native application interactions via OS-level accessibility APIs and input hooks.
- Sensitive field values and credentials are redacted at capture time on both platforms before data is persisted.
- Vulnerabilities that allow exfiltration of captured data, bypassing or weakening sensitive-value redaction, injection of arbitrary actions into a session, or privilege escalation are in scope.

### Data transmission

- Both platforms can dispatch session data to a user-configured HTTP endpoint and sync session data with a user-configured sync server, each with an optional API key sent as a Bearer token.
- Vulnerabilities that allow an attacker to redirect dispatch or sync traffic, inject content into a payload, or expose an API key are in scope.

### Local data persistence

- The desktop application persists session data to the local filesystem. The Chrome extension uses `chrome.storage.local`.
- The extension encrypts stored dispatch/sync API keys at rest — see [Protecting stored credentials](#protecting-stored-credentials).
- Vulnerabilities that allow unauthorised access to persisted session data or settings are in scope.

### Local control channel

- The Chrome extension's side panel can open one WebSocket to a port on the loopback address, through which a local process runs a closed set of the panel's actions once the pairing has proven, in both directions, that each side holds a one-time pairing code. It is off until a person turns it on, and it ends when the panel closes. The specification requires the local process to hold the loopback address and port the panel dials itself and alone; what a process the connection passes through can do when it does not is among the things the specification says the channel does not defend against. Captured data crosses only as the export of the open project that a person allowed when turning the channel on, and the panel shows each one — see the [Local Control Channel](../docs/api/control-channel.md#threat-model) specification.
- Vulnerabilities that allow the channel to be used without a person turning it on, pairing without the code, a connection to anything but the loopback address, a command outside the closed set, an export the person did not allow or the panel did not show, or captured data crossing the channel in any other frame are in scope.

### OS-level permissions

- The desktop application uses OS accessibility APIs and global input hooks. On future platforms (Linux — see [#84](https://github.com/Arsarneq/docent/issues/84)), this may require explicit user permission grants.
- Vulnerabilities that allow bypassing permission checks or escalating OS-level access are in scope.

### Reference implementations

- The [reference implementations](../reference-implementations/README.md) in this repository are the sync server, the control client and the MCP server.
- A vulnerability that reproduces in a reference implementation's code as it stands on `main`, run as its README documents, is in scope, even when you found it on a deployment of your own. Test only against a deployment you run. Examples for the sync server: a request served without the configured token, a project id that escapes the storage directory, or one project's data returned for another. Please name the commit you tested.
- A behavior a reference implementation's README documents is not a flaw in itself: the sync server running open when no token is configured, and its `/__debug/` endpoints.

### Out of scope

- Vulnerabilities in a user's own receiving endpoint or sync server, other than in a reference implementation's code (see above)
- How a user configures, exposes or hosts their own deployment of a reference implementation
- Issues requiring physical access to the machine
- Social engineering

---

## Protecting stored credentials

The Chrome extension encrypts the API keys it stores — the bearer credentials for a configured dispatch endpoint and sync server — at rest. Before a key is written to `chrome.storage.local`, it is encrypted with AES-GCM (Web Crypto), so the on-disk storage holds only ciphertext. The AES key itself lives in `chrome.storage.session`, which the browser keeps in memory and clears on restart — it never touches disk.

This protects against at-rest exposure: another local user, backup or forensic tooling, or a copied profile reading the on-disk storage finds only ciphertext, useless without the in-memory key. It does not protect against code running as the extension itself, which can read the session key and decrypt — the same access it would have had over a plaintext key; narrowing that surface is a separate concern.

Because the AES key is ephemeral, a stored key cannot be decrypted after a browser restart. The extension treats an undecryptable value as "no key configured" and prompts you to re-enter it. This is intentional — the cost of keeping the key off disk — not a fault. With Auto-sync on against a server that requires the key, the first background cycle after the restart fails authentication, turns Auto-sync off, and asks for a fresh connection test once the key is re-entered.
