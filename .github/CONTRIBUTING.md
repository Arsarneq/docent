# Contributing to Docent

Thank you for wanting to contribute. Docent is open source under GPL-3.0.

## Before You Start

1. **Sign the CLA.** All contributors must sign the Contributor License Agreement.
   When you open a pull request, the CLA Assistant bot will prompt you automatically.
   Simply post the comment it requests and you're done.

2. **Check for existing issues.** Your idea or bug may already be tracked.
   If not, open an issue before starting significant work so we can discuss approach.

## Development Setup

```bash
git clone https://github.com/Arsarneq/docent.git
cd docent

# Sync shared code into the extension package
npm run dev:extension

# Install test dependencies
cd packages/extension && npm install

# Load the extension in Chrome
# 1. Open chrome://extensions
# 2. Enable "Developer mode"
# 3. Click "Load unpacked" → select the packages/extension/ folder
```

## Project Structure

```
packages/
  shared/           Shared code — session model, UUID v7, dispatch logic
  extension/        Chrome Extension (Manifest V3)
    background/     Service worker — message routing, navigation and tab lifecycle capture
    content/        Content script — DOM event capture
    sidepanel/      Side panel UI — narration, step list, export, dispatch
docs/               Session format specification
scripts/            Build and sync scripts
```

Shared code lives in `packages/shared/` and is copied into each platform package
by `npm run sync-shared`. After editing shared code, re-run the sync before
loading the extension.

## Coding Conventions

- Plain ES modules — no bundler, no transpilation
- `camelCase` for variables and functions
- `UPPER_SNAKE_CASE` for message type constants
- JSDoc comments on all exported functions
- No external runtime dependencies in the extension

## Pull Request Guidelines

- One logical change per PR
- Include a clear description of what changed and why
- Reference the related issue if one exists
- All new functions should have JSDoc comments

## Licence

By contributing you agree that your contributions will be licensed under GPL-3.0,
consistent with the project licence. See [CLA.md](../CLA.md) for full terms.
