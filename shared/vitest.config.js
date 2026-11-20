import { defineConfig } from 'vitest/config';

// Тести shared — чиста логіка без DOM, тому середовище node.
// Покриття рахує v8 по всьому src; нижче порога команда `npm run coverage` падає.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.{js,ts}'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary'],
      // Поза робочим деревом пакета: звіт не потрапляє ні в git, ні під prettier/eslint.
      reportsDirectory: '../node_modules/.cache/coverage-shared',
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 85 },
    },
  },
});
