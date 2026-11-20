import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.browser,
    },
    rules: {
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    // Симуляція не має права торкатися DOM: жодних браузерних глобалів.
    files: ['src/sim/**'],
    languageOptions: { globals: {} },
    rules: { 'no-undef': 'error' },
  },
  {
    files: ['scripts/**', 'test/**'],
    languageOptions: { globals: globals.node },
  },
];
