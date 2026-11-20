import { defineConfig } from 'vitest/config';

// Окремий конфіг, щоб тести не тягнули vite.config.js (проксі та middleware dev-сервера).
// Середовище node: fetch, rAF і таймери тести підміняють самі.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.{js,ts}'],
  },
});
