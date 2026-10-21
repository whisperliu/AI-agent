// ESLint flat config (ESLint 10 + typescript-eslint 8). See PLAN §4.2.
// Kept intentionally simple/robust: type-aware linting can be enabled later.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    // Never lint build output, deps, or local runtime state.
    ignores: ['node_modules/**', 'dist/**', 'coverage/**', '.price-agent/**', 'test/fixtures/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      // Module boundaries are enforced structurally in P1 (see PLAN §4.4).
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
