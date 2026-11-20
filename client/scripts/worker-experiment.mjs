/* global window -- колбеки page.evaluate() виконуються в браузері */
// Запускає дослід із Web Worker (client/worker-bench.html) у Chromium і друкує результат.
//   node client/scripts/worker-experiment.mjs
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = 4322;
const preview = spawn(
  'npx',
  ['vite', 'preview', '--port', String(PORT), '--strictPort', '--outDir', 'dist-profile'],
  {
    cwd: ROOT,
    stdio: 'ignore',
  },
);
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (let attempt = 0; ; attempt += 1) {
    try {
      await page.goto(`http://localhost:${PORT}/worker-bench.html`);
      break;
    } catch (error) {
      if (attempt > 40) throw error;
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  await page.waitForFunction(() => window.__workerBench !== undefined, null, { timeout: 60_000 });
  const runs = [await page.evaluate(() => window.__workerBench)];
  for (let i = 0; i < 2; i += 1) {
    await page.reload();
    await page.waitForFunction(() => window.__workerBench !== undefined, null, { timeout: 60_000 });
    runs.push(await page.evaluate(() => window.__workerBench));
  }
  console.table(runs);
} finally {
  await browser.close();
  preview.kill();
}
