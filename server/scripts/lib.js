// Спільне для дослідів: запуск сервера окремим процесом на вільному порту.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function freePort() {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  probe.close();
  await once(probe, 'close');
  return port;
}

export async function spawnServer(env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [resolve(import.meta.dirname, '../src/index.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'warn', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  let exitInfo = null;
  const exited = once(child, 'exit').then(([code, signal]) => (exitInfo = { code, signal }));

  const http = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      if ((await fetch(http + '/health')).ok) break;
    } catch {
      if (exitInfo) throw new Error(`сервер завершився з кодом ${exitInfo.code}:\n` + output);
      if (attempt > 100) throw new Error('сервер не стартував:\n' + output);
      await sleep(50);
    }
  }

  return {
    http,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    output: () => output,
    // Штатна зупинка: SIGTERM і чекаємо коду завершення.
    async stop() {
      child.kill('SIGTERM');
      return exited;
    },
  };
}
