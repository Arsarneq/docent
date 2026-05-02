# Contributing to Docent

Thank you for wanting to contribute. Docent is open source under GPL-3.0.

## Before You Start

1. **Sign the CLA.** All contributors must sign the Contributor License Agreement.
   When you open a pull request, the CLA Assistant bot will prompt you automatically.
   Simply post the comment it requests and you're done.

2. **Check for existing issues.** Your idea or bug may already be tracked.
   If not, open an issue before starting significant work so we can discuss approach.

## Development Setup

### Chrome Extension

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

### Desktop Application (Windows)

Prerequisites: [Rust toolchain](https://rustup.rs/) (stable), Node.js 20+.

```bash
git clone https://github.com/Arsarneq/docent.git
cd docent

# Sync shared code into all platform packages
npm run sync-shared

# Build the Tauri application
cargo build --manifest-path packages/desktop/src-tauri/Cargo.toml

# Run the application
cargo run --manifest-path packages/desktop/src-tauri/Cargo.toml
```

## Project Structure

```
packages/
  shared/           Shared code — session model, UUID v7, dispatch logic, view rendering
    lib/            Session model, UUID v7 generation
    views/          Shared HTML structure, CSS, rendering functions
    tests/          Shared module tests
  extension/        Chrome Extension (Manifest V3)
    background/     Service worker — message routing, navigation and context lifecycle capture
    content/        Content script — DOM event capture
    sidepanel/      Side panel UI — narration, step list, export, dispatch
    tests/          Extension tests
  desktop/          Tauri v2 Desktop Application (Windows)
    src/            JavaScript frontend — panel, adapters, persistence
    src-tauri/      Rust backend — capture layer, Tauri commands
    tests/          Desktop JavaScript tests
scripts/            Build, sync, and automation scripts
```

Shared code lives in `packages/shared/` and is copied into each platform package
by `npm run sync-shared`. After editing shared code, re-run the sync before
loading the extension or building the desktop app.

## Running Tests

```bash
# Extension tests (syncs shared code first)
npm run test:extension

# Desktop JavaScript tests
npm run test:desktop

# Desktop Rust tests
npm run test:desktop:rust

# Shared module tests
npm run test:shared
```

## Coding Conventions

### JavaScript

- Plain ES modules — no bundler, no transpilation
- `camelCase` for variables and functions
- `UPPER_SNAKE_CASE` for message type constants
- JSDoc comments on all exported functions
- No external runtime dependencies in the extension

### Rust

- Follow standard Rust conventions (`rustfmt`, `clippy`)
- `snake_case` for functions and variables, `CamelCase` for types
- Use `thiserror` for error types
- Platform-specific code behind `#[cfg(target_os = "...")]` conditional compilation
- Property-based tests use `proptest`

## Pull Request Guidelines

- One logical change per PR
- Include a clear description of what changed and why
- Reference the related issue if one exists
- All new functions should have JSDoc comments (JavaScript) or doc comments (Rust)

## Licence

By contributing you agree that your contributions will be licensed under GPL-3.0,
consistent with the project licence. See [CLA.md](../CLA.md) for full terms.
