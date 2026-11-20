import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist', '**/logs'] },
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
