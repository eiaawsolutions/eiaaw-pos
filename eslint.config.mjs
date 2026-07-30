import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.d.ts',
      'packages/shared/dist/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
      },
    },
    rules: {
      // Unused code is either a mistake or dead weight; the underscore escape
      // hatch covers deliberately-ignored callback parameters.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],

      // `any` disables the type system exactly where this codebase most needs
      // it — request bodies and money. Warn now, tighten once the DTO layer
      // lands and the remaining uses are deliberate.
      '@typescript-eslint/no-explicit-any': 'warn',

      // Money is integer sen. A float creeping into a total is a silent
      // rounding defect, and `==` between a string and a number is how a
      // tampered payload slips past a comparison.
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      // Real bug sources rather than style.
      'no-console': 'off', // the worker and bootstrap legitimately log
      'no-debugger': 'error',
      'no-alert': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      'no-return-await': 'error',
      'require-atomic-updates': 'error',
      'no-unsafe-optional-chaining': 'error',
      'no-constant-binary-expression': 'error',
      'no-promise-executor-return': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      'no-unmodified-loop-condition': 'error',
    },
  },

  // CommonJS config files at the edges of the build.
  {
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { module: 'writable', require: 'readonly', exports: 'writable' },
    },
  },

  // The browser bundle has a different global surface than Node.
  //
  // react-hooks is not cosmetic here: the terminal's barcode-scanner effect
  // closes over `products`, and its payment modal starts an interval it never
  // clears. Both are exactly what exhaustive-deps and the rules-of-hooks
  // checks are for.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        crypto: 'readonly',
        HTMLElement: 'readonly',
        KeyboardEvent: 'readonly',
        RequestInit: 'readonly',
        React: 'readonly',
      },
    },
  },

  // Tests assert on shapes the type system cannot always express, and fixtures
  // are intentionally partial.
  {
    files: ['**/*.test.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // Must stay last: turns off every rule that fights the formatter.
  prettier,
);
