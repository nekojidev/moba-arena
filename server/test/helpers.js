import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

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
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    const index = waiters.findIndex((waiter) => waiter.type === message.type);
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
    else inbox.push(message);
  });
  socket.on('error', () => {});
  await once(socket, 'open');
  return {
    socket,
    send: (message) => socket.send(JSON.stringify({ v: 0, ...message })),
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
