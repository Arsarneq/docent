import js from '@eslint/js';
import prettier from 'eslint-config-prettier';

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
      'prefer-const': 'error',
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
      // ship again. See docs / the service-worker static-import guard test.
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
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        URL: 'readonly',
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
    // Reference implementations (Node.js, standard library only) — repo/testing
    // artifacts, excluded from releases but held to the same lint bar as the
    // rest of the repo.
    files: ['reference-implementations/**/*.js'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        crypto: 'readonly',
        fetch: 'readonly',
      },
    },
  },
  {
    ignores: [
      'node_modules/**',
      'packages/*/shared/**',
      'packages/shared/generated/**',
      'packages/extension/sidepanel/index.html',
      'packages/desktop/src/index.html',
      'packages/desktop/dist/**',
      'packages/desktop/src-tauri/**',
      'packages/*/tests/**',
      'coverage/**',
    ],
  },
];
