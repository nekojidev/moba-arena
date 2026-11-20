// Клієнтська обгортка сокета проти справжнього сервера (у Node є глобальний WebSocket).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createConnection } from '../../client/src/net/connection.ts';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { sleep, startApp } from './helpers.js';

function collect(connection, type) {
  const items = [];
  connection.on(type, (detail) => items.push(detail));
  return items;
}

async function until(condition, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('умова не настала вчасно');
    await sleep(10);
  }
}

test('черга: надіслане до відкриття сокета доходить після join', async () => {
  const ctx = await startApp();
  try {
    const connection = createConnection({
      url: ctx.wsUrl,
      hello: () => ({ type: 'join', room: 'mid', name: 'Анна' }),
    });
    const chats = collect(connection, 'chat');
    const rosters = collect(connection, 'roster');

    // Сокет іще в стані CONNECTING — обидва повідомлення стають у чергу.
    assert.equal(connection.send({ type: 'chat', text: 'перше' }), false);
    assert.equal(connection.send({ type: 'chat', text: 'друге' }), false);
    assert.equal(connection.queued, 2);

    await until(() => chats.length === 2);
    assert.deepEqual(
      chats.map((chat) => chat.text),
      ['перше', 'друге'],
    );
    assert.equal(rosters[0].players[0].name, 'Анна');
    assert.equal(connection.queued, 0);
    assert.equal(connection.last('roster'), rosters.at(-1));
    assert.equal(connection.send({ type: 'chat', text: 'третє' }), true);
    await until(() => chats.length === 3);
    connection.close();
  } finally {
    await ctx.stop();
  }
});

test('перепідключення: сервер упав і піднявся — клієнт сам повертається в кімнату', async () => {
  const first = await startApp();
  const port = first.app.server.address().port;
  const connection = createConnection({
    url: first.wsUrl,
    hello: () => ({ type: 'join', room: 'mid', name: 'Анна' }),
    baseMs: 40,
    maxMs: 200,
  });
  const statuses = collect(connection, 'status');
  const welcomes = collect(connection, 'welcome');
  const chats = collect(connection, 'chat');

  await until(() => welcomes.length === 1);
  await first.app.close(); // сервер зупинився: сокет закрито з кодом 1001

  await until(() => statuses.some((entry) => entry.status === 'waiting'));
  connection.send({ type: 'chat', text: 'написано без зв’язку' });
  assert.equal(connection.queued, 1);
  await sleep(250); // кілька невдалих спроб із дедалі довшою паузою

  const second = await createApp(
    loadConfig({ PORT: String(port), LOG_DIR: first.config.logDir, LOG_LEVEL: 'silent' }),
  );
  await second.listen();
  try {
    await until(() => welcomes.length === 2);
    await until(() => chats.length === 1);
    assert.equal(chats[0].text, 'написано без зв’язку');
    assert.notEqual(welcomes[0].playerId, welcomes[1].playerId);

    const waits = statuses.filter((entry) => entry.status === 'waiting');
    assert.ok(waits.length >= 2, `спроб: ${waits.length}`);
    assert.deepEqual(
      waits.slice(0, 3).map((entry) => entry.attempt),
      [1, 2, 3].slice(0, Math.min(3, waits.length)),
    );
    for (const [index, entry] of waits.entries()) {
      const ceiling = Math.min(200, 40 * 2 ** index);
      assert.ok(
        entry.waitMs >= ceiling / 2 && entry.waitMs <= ceiling,
        `пауза ${index + 1}: ${entry.waitMs}`,
      );
    }
    assert.equal(connection.status, 'open');
    connection.close();
  } finally {
    await second.close();
    await first.stop().catch(() => {});
  }
});

test('відмова сервера (кімнати немає) — без повторних спроб', async () => {
  const ctx = await startApp();
  try {
    const connection = createConnection({
      url: ctx.wsUrl,
      hello: () => ({ type: 'join', room: 'nowhere', name: 'Анна' }),
      baseMs: 20,
    });
    const statuses = collect(connection, 'status');
    await until(() => connection.status === 'closed');
    await sleep(100);
    const closed = statuses.at(-1);
    assert.equal(closed.code, 4004);
    assert.equal(closed.fatal, true);
    assert.match(closed.reason, /кімната/);
    assert.equal(statuses.filter((entry) => entry.status === 'waiting').length, 0);
    assert.equal(connection.send({ type: 'chat', text: 'x' }), false);
  } finally {
    await ctx.stop();
  }
});
