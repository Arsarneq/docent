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

This is a solo-maintained project. I aim to acknowledge reports within a few days, but cannot guarantee fixed timelines. I will investigate and coordinate disclosure before any fix is made public.

---

## Scope

Docent has several capabilities with distinct attack surfaces:

**Interaction capture**
- The Chrome extension runs with `<all_urls>` host permissions and captures DOM events across all pages. The desktop application captures native application interactions via OS-level accessibility APIs and input hooks.
- Vulnerabilities that allow exfiltration of captured data, injection of arbitrary actions into a session, or privilege escalation are in scope.

**Data transmission**
- Both platforms can dispatch session data to a user-configured HTTP endpoint, with an optional API key sent as a Bearer token.
- Vulnerabilities that allow an attacker to redirect dispatch output, inject content into the payload, or expose the API key are in scope.

**Local data persistence**
- The desktop application persists session data to the local filesystem. The Chrome extension uses `chrome.storage.local`.
- Vulnerabilities that allow unauthorised access to persisted session data or settings are in scope.

**OS-level permissions**
- The desktop application uses OS accessibility APIs and global input hooks. On future platforms (macOS), this requires explicit user permission grants.
- Vulnerabilities that allow bypassing permission checks or escalating OS-level access are in scope.

**Out of scope**
- Vulnerabilities in the receiving endpoint (that is outside this project)
- Issues requiring physical access to the machine
- Social engineering
