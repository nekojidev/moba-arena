import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

export async function startApp(env = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'moba-arena-'));
  const config = loadConfig({
    PORT: '0',
    LOG_DIR: join(dir, 'logs'),
    CLIENT_DIST: join(dir, 'dist'),
    LOG_LEVEL: 'silent',
    ...env,
  });
  const app = await createApp(config);
  const { port } = await app.listen();
  return {
    app,
    config,
    dir,
    http: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    async stop() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// Клієнт для тестів: складає вхідні повідомлення й уміє чекати на потрібне.
export async function connect(url, options) {
  const socket = new WebSocket(url, options);
  const inbox = [];
  const waiters = [];
  const snapshots = [];
  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      snapshots.push(data);
      return;
    }
    const message = JSON.parse(data.toString());
    if (message.type === 'events' || message.type === 'snapshot') return;
    const index = waiters.findIndex((waiter) => waiter.type === message.type);
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
    else inbox.push(message);
  });
  socket.on('error', () => {});
  await once(socket, 'open');
  return {
    socket,
    snapshots,
    send: (message) => socket.send(JSON.stringify({ v: 1, ...message })),
    next(type) {
      const index = inbox.findIndex((message) => message.type === type);
      if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
      return new Promise((resolve) => waiters.push({ type, resolve }));
    },
    async closed() {
      if (socket.readyState === WebSocket.CLOSED) return { code: socket._closeCode };
      const [code, reason] = await once(socket, 'close');
      return { code, reason: reason.toString() };
    },
  };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
