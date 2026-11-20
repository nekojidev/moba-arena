// Наскрізні тести: справжній сервер + зібраний клієнт + справжній браузер.
// Playwright сам збирає клієнт, піднімає сервер на окремому порту й чекає на /health.

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 4173);
const HOST = '127.0.0.1';
const baseURL = `http://${HOST}:${PORT}`;
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: 'e2e',
  // Тести ділять один сервер і його кімнати — запускаємо по одному.
  workers: 1,
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  outputDir: 'test-results',

  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 5_000,
    navigationTimeout: 15_000,
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    // Node 26 виконує .ts напряму; сервер сам роздає client/dist.
    command: 'npm run build && node server/src/index.ts',
    url: `${baseURL}/health`,
    reuseExistingServer: !isCI,
    timeout: 120_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      PORT: String(PORT),
      HOST,
      // Журнали матчів — у тимчасову теку ОС, щоб не смітити в репозиторії.
      LOG_DIR: join(tmpdir(), 'moba-arena-e2e-logs'),
      LOG_LEVEL: 'warn',
    },
  },
});
