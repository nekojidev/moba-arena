// Справжній процес сервера: SIGTERM → сокети закрито, логи дописано, код завершення 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { spawnServer } from '../scripts/lib.js';

test('SIGTERM: код 0, клієнт отримує 1001, лог матчу цілий', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'moba-shutdown-'));
  try {
    const server = await spawnServer({ LOG_DIR: dir, LOG_LEVEL: 'info' });
    const socket = new WebSocket(server.wsUrl);
    await once(socket, 'open');
    socket.send(JSON.stringify({ v: 0, type: 'join', room: 'mid', name: 'Анна' }));
    socket.send(JSON.stringify({ v: 0, type: 'chat', text: 'перед зупинкою' }));
    await once(socket, 'message');
    await new Promise((resolve) => setTimeout(resolve, 100));

    const closed = once(socket, 'close');
    const exit = await server.stop();
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal((await closed)[0], 1001);

    const [file] = await readdir(dir);
    const text = await readFile(join(dir, file), 'utf8');
    assert.match(text, /перед зупинкою/);
    assert.match(server.output(), /"message":"bye"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('некоректний конфіг: процес не стартує, код 1 і зрозуміле повідомлення', async () => {
  await assert.rejects(spawnServer({ PORT: 'abc' }), /PORT="abc"/);
});
