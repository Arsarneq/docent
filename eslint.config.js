import js from '@eslint/js';
import prettier from 'eslint-config-prettier';

// Node globals every Node-run block shares; each block adds its own extras.
const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
};

export default [
  js.configs.recommended,
  prettier,
  {
    // Default config for all JS files
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-undef': 'error',
      'no-console': 'off',
      'prefer-const': ['error', { destructuring: 'all' }],
      'no-var': 'error',
    },
  },
  {
    // Browser environment (panel, adapters, content scripts)
    files: [
      'packages/*/src/**/*.js',
      'packages/extension/sidepanel/**/*.js',
      'packages/extension/content/**/*.js',
    ],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        prompt: 'readonly',
        location: 'readonly',
        Blob: 'readonly',
        URL: 'readonly',
        CSS: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        crypto: 'readonly',
        chrome: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        HTMLElement: 'readonly',
        Event: 'readonly',
        CustomEvent: 'readonly',
        MutationObserver: 'readonly',
        FileReader: 'readonly',
        DragEvent: 'readonly',
        DataTransfer: 'readonly',
      },
    },
  },
  {
    // Chrome extension background (service worker)
    files: ['packages/extension/background/**/*.js'],
    languageOptions: {
      globals: {
        chrome: 'readonly',
        console: 'readonly',
        self: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        URL: 'readonly',
        crypto: 'readonly',
        Blob: 'readonly',
      },
    },
    rules: {
      // A Manifest V3 service worker CANNOT use dynamic import() — a dynamic
      // import in the SW throws at runtime (it previously surfaced as
      // `validator is not a function` and silently aborted every Auto-Sync
      // cycle before its push). The background entry must import everything,
      // including the generated validator, STATICALLY at module scope. This
      // rule fails any dynamic import() in the background layer at lint time so
      // the "works in a Node test, dead in the MV3 SW" class of bug can never
      // ship again. Stated in the extension capture-principles doc (Architecture);
      // enforced here and by the service-worker static-import guard test.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression',
          message:
            'Dynamic import() is not supported in a Manifest V3 service worker. Import statically at module scope (e.g. the generated validator in service-worker.js).',
        },
      ],
    },
  },
  {
    // Node.js scripts
    files: ['scripts/**/*.js'],
    languageOptions: {
      globals: {
        ...nodeGlobals,
        __dirname: 'readonly',
        __filename: 'readonly',
        structuredClone: 'readonly',
      },
    },
  },
  {
    // Shared lib (isomorphic — used in both browser and Node)
    files: ['packages/shared/**/*.js'],
    languageOptions: {
      globals: {
        console: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        URL: 'readonly',
        crypto: 'readonly',
        Blob: 'readonly',
      },
    },
  },
  {
    // Capture corpus (repo/CI artifact): the page server runs under Node; the
    // session drivers run in the corpus Playwright spec's Node context.
    files: ['corpus/**/*.js'],
    languageOptions: {
      globals: {
        ...nodeGlobals,
      },
    },
  },
  {
    // Reference implementations (Node.js, standard library only) — repo/testing
    // artifacts, excluded from releases but held to the same lint bar as the
    // rest of the repo.
    files: ['reference-implementations/**/*.js'],
    languageOptions: {
      globals: {
        ...nodeGlobals,
        crypto: 'readonly',
        fetch: 'readonly',
      },
    },
  },
  {
    // Test trees under node:test and the Playwright runner — both run in Node.
    // The unit suites (shared, extension, desktop) and the Playwright specs,
    // fixtures and helpers alike import from node:* and call Node's globals.
    files: ['packages/*/tests/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        ...nodeGlobals,
        fetch: 'readonly',
        Headers: 'readonly',
        Response: 'readonly',
        performance: 'readonly',
        structuredClone: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
      },
    },
  },
  {
    // Browser-injected code in the desktop integration suite: callbacks passed
    // to page.evaluate / addInitScript / waitForFunction run in the page, so the
    // spec files carry page globals beside their Node ones.
    files: ['packages/desktop/tests/integration/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
      },
    },
  },
  {
    // Browser-injected code in the extension end-to-end suite: its page
    // callbacks also build DOM events and files to drive real input.
    files: ['packages/extension/tests/e2e/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        history: 'readonly',
        Event: 'readonly',
        MouseEvent: 'readonly',
        KeyboardEvent: 'readonly',
        DragEvent: 'readonly',
        DataTransfer: 'readonly',
        File: 'readonly',
        HTMLInputElement: 'readonly',
      },
    },
    rules: {
      // Playwright reads a fixture's dependencies from its first parameter's
      // destructuring pattern and requires one, so a fixture that depends on
      // nothing is written `async ({}, use) =>` — the empty pattern is the
      // runner's own idiom, not an empty destructuring left behind.
      'no-empty-pattern': ['error', { allowObjectPatternsAsParameters: true }],
    },
  },
  {
    // Extension-context injected code: the end-to-end suite evaluates in the
    // extension's pages and service worker, where the chrome.* API is present.
    files: ['packages/extension/tests/e2e/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        chrome: 'readonly',
      },
    },
  },
  {
    ignores: [
      'node_modules/**',
      '.claude/**',
      'packages/*/shared/**',
      'packages/shared/generated/**',
      'packages/extension/sidepanel/index.html',
      'packages/desktop/src/index.html',
      'packages/desktop/dist/**',
      'packages/desktop/src-tauri/**',
      'coverage/**',
      // Runner output under the admitted test trees (gitignored, but ESLint reads
      // no .gitignore): an HTML report's trace viewer ships bundled scripts.
      'packages/*/tests/**/playwright-report/**',
      'packages/*/tests/**/test-results/**',
      'packages/*/tests/**/coverage/**',
      'corpus/out/**',
    ],
  },
];
