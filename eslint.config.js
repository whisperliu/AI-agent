// ESLint flat config (ESLint 10 + typescript-eslint 8). See docs/module-spec.md §4.2.
// Kept intentionally simple/robust: type-aware linting can be enabled later.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    // Never lint build output, deps, local runtime state, or test fixtures.
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      '.price-agent/**',
      '.pnpm-store/**',
      '.dshweb/**',
      '.dshrun/**',
      '.dshp/**',
      '.dshm/**',
      'test/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node globals for plain JS tooling (scripts, config files).
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly' },
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      // TypeScript already checks identifiers; avoid no-undef false positives.
      'no-undef': 'off',
      // Module boundaries are enforced by scripts/check-boundary.mjs (see §4.4).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': 'off',
      eqeqeq: ['error', 'always'],
    },
  },
  // Must be last: turn off stylistic rules that conflict with Prettier.
  prettier,
)
