import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'

/**
 * Correctness only.
 *
 * This codebase has no formatter and does not want one: lines run long on purpose, there are
 * no semicolons, and reformatting every file would bury the history that explains why things
 * are the way they are. So there are no stylistic rules here. What is left is the class of
 * mistake that is invisible in review and expensive later — a name that does not exist, a
 * duplicated object key that silently discards the first value, an effect whose dependency
 * list is wrong.
 *
 * Two rules from the first pass were removed rather than satisfied, because both were
 * reporting deliberate code:
 *
 *   - no-promise-executor-return fired on every `new Promise((r) => setTimeout(r, ms))`.
 *     The timer id is not read; the idiom is fine.
 *   - require-atomic-updates fired on assignments after an await that no second caller can
 *     reach, such as caching one session in a test file. It is noisy enough that keeping it
 *     would mean teaching people to ignore the linter.
 */
export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'server/xsd/**', '.impeccable/**'],
  },

  js.configs.recommended,

  {
    files: ['**/*.{js,jsx,mjs}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // An unused argument is often deliberate (a signature that has to match); an unused
      // variable almost never is. `_`-prefixed names opt out.
      // ignoreRestSiblings keeps the omit idiom working: `const { passwordHash, ...rest } =
      // user` names a field precisely so it is left behind, and "removing the unused
      // variable" there would put the password hash back into the response.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
    },
  },

  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  {
    files: ['src/**/*.jsx'],
    plugins: { react, 'react-hooks': reactHooks },
    rules: {
      // Without this, anything used only inside JSX reads as an unused import.
      'react/jsx-uses-vars': 'error',
      'react-hooks/rules-of-hooks': 'error',
      // A stale dependency list is how a page keeps showing a number that has changed.
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  {
    // Browser tests hand callbacks to the page, so `document` and `window` in those are the
    // page's, not this process's.
    files: ['tests/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
]
