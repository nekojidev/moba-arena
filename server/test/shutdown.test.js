// Справжній процес сервера: штатна зупинка за сигналом і гучне падіння на невідомій помилці.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { spawnServer } from '../scripts/lib.js';

test('SIGTERM: shutdown → 1001, код 0, лог матчу цілий, значно швидше за 10 с', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'moba-shutdown-'));
  try {
    const server = await spawnServer({ LOG_DIR: dir, LOG_LEVEL: 'info' });
    const socket = new WebSocket(server.wsUrl);
    await once(socket, 'open');
    socket.send(JSON.stringify({ v: 1, type: 'join', room: 'mid', name: 'Анна' }));
    socket.send(JSON.stringify({ v: 1, type: 'chat', text: 'перед зупинкою' }));
    await once(socket, 'message');
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Усе, що прийшло текстом, і момент закриття — в один список, щоб перевірити порядок.
    const timeline = [];
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(data.toString());
      if (message.type === 'shutdown') timeline.push(message);
    });
    const closed = once(socket, 'close').then(([code]) => {
      timeline.push({ type: 'close', code });
      return code;
    });

    const startedAt = performance.now();
    const exit = await server.stop();
    const tookMs = performance.now() - startedAt;
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(await closed, 1001);
    assert.ok(tookMs < 3000, `зупинка тривала ${tookMs.toFixed(0)} мс`);

    // Спершу повідомлення shutdown, і лише потім — закриття сокета.
    assert.deepEqual(
      timeline.map((entry) => entry.type),
      ['shutdown', 'close'],
    );
    assert.equal(timeline[0].v, 1);
    assert.equal(typeof timeline[0].reason, 'string');

    const [file] = await readdir(dir);
    const text = await readFile(join(dir, file), 'utf8');
    assert.match(text, /перед зупинкою/);

    // Лог — JSON-рядки pino: є «bye», а тексту чату й оточення в ньому немає.
    const logs = server.logs();
    const bye = logs.find((record) => record.msg === 'bye');
    assert.ok(bye, server.output());
    assert.equal(bye.level, 'info');
    assert.ok(bye.tookMs < 3000);
    assert.ok(logs.some((record) => record.msg === 'shutting down' && record.signal === 'SIGTERM'));
    const left = logs.find((record) => record.msg === 'player left');
    assert.equal(left.roomId, 'mid');
    assert.equal(typeof left.playerId, 'string');
    assert.equal(left.code, 1001);
    assert.doesNotMatch(server.output(), /перед зупинкою/, 'текст чату не потрапляє в лог');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('другий сигнал під час зупинки не починає її вдруге', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'moba-shutdown-'));
  try {
    const server = await spawnServer({ LOG_DIR: dir, LOG_LEVEL: 'info' });
    // Клієнт, який не відповідає на закриття: зупинка чекає на нього близько секунди,
    // і другий сигнал гарантовано приходить посеред неї.
    const socket = new WebSocket(server.wsUrl);
    socket.on('error', () => {});
    await once(socket, 'open');
    socket.send(JSON.stringify({ v: 1, type: 'join', room: 'mid', name: 'Глухий' }));
    await once(socket, 'message');
    socket.pause();

    server.signal('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Поки сокети закриваються, порт іще слухає: готовність — 503, а процес живий — 200.
    const ready = await fetch(server.http + '/ready');
    assert.equal(ready.status, 503);
    assert.equal((await ready.json()).status, 'shutting_down');
    const health = await fetch(server.http + '/health');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ready, false);

    server.signal('SIGTERM');
    server.signal('SIGINT');
    const startedAt = performance.now();
    const exit = await server.exited;
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.ok(performance.now() - startedAt < 5000);
    socket.terminate();

    const logs = server.logs();
    assert.equal(logs.filter((record) => record.msg === 'shutting down').length, 1);
    assert.equal(logs.filter((record) => record.msg === 'bye').length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const [kind, message] of [
  ['exception', 'uncaught exception'],
  ['rejection', 'unhandled rejection'],
]) {
  test(`невідома помилка (${kind}): запис fatal зі стеком і код завершення 1`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'moba-crash-'));
    try {
      const server = await spawnServer({ LOG_DIR: dir, DEBUG_ROUTES: '1' });
      const response = await fetch(`${server.http}/api/debug/crash?kind=${kind}`, {
        method: 'POST',
      });
      assert.equal(response.status, 202);
      const exit = await server.exited;
      assert.deepEqual(exit, { code: 1, signal: null });

      const fatal = server.logs().find((record) => record.level === 'fatal');
      assert.ok(fatal, server.output());
      assert.equal(fatal.msg, message);
      assert.match(fatal.error, new RegExp(`debug crash: ${kind}`));
      assert.match(fatal.error, /\n\s+at /, 'у записі є стек');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('маршрут падіння без DEBUG_ROUTES не існує', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'moba-crash-'));
  try {
    const server = await spawnServer({ LOG_DIR: dir });
    const response = await fetch(`${server.http}/api/debug/crash`, { method: 'POST' });
    assert.equal(response.status, 404);
    assert.deepEqual(await server.stop(), { code: 0, signal: null });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('некоректний конфіг: процес не стартує, код 1 і зрозуміле повідомлення', async () => {
  await assert.rejects(spawnServer({ PORT: 'abc' }), /PORT="abc"/);
});
