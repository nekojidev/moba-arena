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
    // EventTarget і CustomEvent — не DOM: вони є і в Node, тому шині подій дозволені.
    languageOptions: { globals: { EventTarget: 'readonly', CustomEvent: 'readonly' } },
    rules: { 'no-undef': 'error' },
  },
  {
    files: ['scripts/**', 'test/**', 'vite.config.js'],
    languageOptions: { globals: globals.node },
  },
];
