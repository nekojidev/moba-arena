import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['**/dist', '**/logs'] },
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
    // EventTarget і CustomEvent — не DOM: вони є і в Node, тому шині подій дозволені.
    files: ['client/src/sim/**'],
    languageOptions: { globals: { EventTarget: 'readonly', CustomEvent: 'readonly' } },
    rules: { 'no-undef': 'error' },
  },
  {
    files: ['client/scripts/**', 'client/test/**', 'client/vite.config.js', 'server/**'],
    languageOptions: { globals: globals.node },
  },
];
