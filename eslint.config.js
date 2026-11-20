import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist', '**/dist-profile', '**/logs', 'playwright-report', 'test-results'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      'no-var': 'error',
      'prefer-const': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      // Імена з «_» на початку — навмисно не використані (наприклад, зайві поля при деструктуризації).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Правила, яким потрібні типи (а не лише синтаксис), — для всього коду в src/ та e2e/.
    // Головне з них — no-floating-promises: проміс, який ніхто не чекає і не ловить,
    // у Node при відхиленні завершує процес.
    files: ['shared/src/**/*.ts', 'client/src/**/*.ts', 'server/src/**/*.ts', 'e2e/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      // default, який передає значення в never, уже гарантує вичерпність — його досить.
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
    },
  },
  {
    // Спільний код не має права торкатися ні DOM, ні Node: жодних глобалів середовища.
    // (Те саме гарантує shared/tsconfig.json: "lib": ["ES2023"], "types": [].)
    files: ['shared/src/**'],
    languageOptions: { globals: {} },
    rules: { 'no-undef': 'error' },
  },
  {
    files: ['client/src/**'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: [
      'client/scripts/**',
      'client/test/**',
      'client/vite.config.js',
      'server/**',
      'shared/test/**',
    ],
    languageOptions: { globals: globals.node },
  },
);
