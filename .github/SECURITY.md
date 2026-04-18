# Security Policy

## Supported versions

Only the latest release is actively maintained. If you find a vulnerability in an older version that also affects the latest release, it is still worth reporting.

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
- The component affected (extension, dispatch script, or session format)
- The potential impact — what could an attacker do?
- Any affected versions you are aware of

---

## What to expect

This is a solo-maintained project. I aim to acknowledge reports within a few days, but cannot guarantee fixed timelines. I will investigate and coordinate disclosure before any fix is made public.

---

## Scope

Docent has two main components with distinct attack surfaces:

**Chrome extension**
- Runs with `<all_urls>` host permissions and captures DOM events across all pages
- Vulnerabilities that allow exfiltration of captured data, injection of arbitrary actions into a session, or privilege escalation within the extension are in scope

**Dispatch script**
- Sends session data to a caller-configured HTTP endpoint
- Vulnerabilities that allow an attacker to redirect dispatch output, inject content into the payload, or expose the API key are in scope

**Out of scope**
- Vulnerabilities in the receiving endpoint (that is outside this project)
- Issues requiring physical access to the machine
- Social engineering
