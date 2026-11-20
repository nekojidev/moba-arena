import { test } from 'vitest';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { connect, sleep, startApp } from './helpers.js';
import { CLOSE } from '@moba-arena/shared/protocol.ts';
import { readEvents, listReplays } from '../src/log/replay.ts';

test('два клієнти заходять в одну кімнату: бачать одне одного й чат', async () => {
  const ctx = await startApp();
  try {
    const anna = await connect(ctx.wsUrl);
    anna.send({ type: 'join', room: 'mid', name: 'Анна' });
    const welcome = await anna.next('welcome');
    assert.equal(welcome.room.id, 'mid');
    assert.deepEqual((await anna.next('roster')).players, [
      { id: welcome.playerId, name: 'Анна', shipId: welcome.shipId },
    ]);
    assert.equal(welcome.tickRate, 30);
    assert.equal(welcome.codec, 'binary');

    const boris = await connect(ctx.wsUrl);
    boris.send({ type: 'join', room: 'mid', name: 'Борис' });
    const names = (message) => message.players.map((player) => player.name);
    assert.deepEqual(names(await boris.next('roster')), ['Анна', 'Борис']);
    assert.deepEqual(names(await anna.next('roster')), ['Анна', 'Борис']);

    boris.send({ type: 'chat', text: '  привіт!  ' });
    for (const client of [anna, boris]) {
      const chat = await client.next('chat');
      assert.equal(chat.text, 'привіт!');
      assert.equal(chat.from.name, 'Борис');
    }

    const rooms = await (await fetch(ctx.http + '/api/rooms')).json();
    assert.equal(rooms.rooms[0].players, 2);

    boris.send({ type: 'leave' });
    assert.equal((await boris.closed()).code, CLOSE.NORMAL);
    assert.deepEqual(names(await anna.next('roster')), ['Анна']);
    anna.socket.close();
  } finally {
    await ctx.stop();
  }
});

test('погані повідомлення закривають сокет із кодом', async () => {
  const ctx = await startApp({ MAX_PAYLOAD_BYTES: '256', MAX_PLAYERS_PER_ROOM: '1' });
  try {
    const cases = [
      [(c) => c.socket.send('not json'), CLOSE.BAD_MESSAGE],
      [(c) => c.send({ type: 'teleport' }), CLOSE.UNKNOWN_TYPE],
      [(c) => c.socket.send('{"v":7,"type":"leave"}'), CLOSE.VERSION],
      [(c) => c.send({ type: 'chat', text: 'я ще не зайшов' }), CLOSE.BAD_MESSAGE],
      [(c) => c.send({ type: 'join', room: 'mid', name: 'x', extra: 1 }), CLOSE.BAD_MESSAGE],
      [(c) => c.send({ type: 'join', room: 'nowhere', name: 'Анна' }), CLOSE.JOIN_REJECTED],
      [(c) => c.send({ type: 'chat', text: 'x'.repeat(300) }), CLOSE.TOO_BIG],
      [(c) => c.socket.send(Buffer.from([0, 1, 2])), CLOSE.BAD_MESSAGE],
    ];
    for (const [act, expected] of cases) {
      const client = await connect(ctx.wsUrl);
      act(client);
      assert.equal((await client.closed()).code, expected);
    }

    // Заповнена кімната (ліміт 1 гравець).
    const first = await connect(ctx.wsUrl);
    first.send({ type: 'join', room: 'mid', name: 'Анна' });
    await first.next('roster');
    const second = await connect(ctx.wsUrl);
    second.send({ type: 'join', room: 'mid', name: 'Борис' });
    assert.equal((await second.closed()).code, CLOSE.JOIN_REJECTED);

    // Сервер пережив усе це і працює далі.
    first.send({ type: 'chat', text: 'живий' });
    assert.equal((await first.next('chat')).text, 'живий');
    // Завелике повідомлення закриває сама бібліотека (1009), тому воно не в нашому лічильнику.
    assert.equal(ctx.app.ws.stats.rejected, cases.length);
    first.socket.close();
  } finally {
    await ctx.stop();
  }
});

test('join треба надіслати вчасно', async () => {
  const ctx = await startApp({ JOIN_TIMEOUT_MS: '60' });
  try {
    const silent = await connect(ctx.wsUrl);
    const started = Date.now();
    assert.equal((await silent.closed()).code, CLOSE.JOIN_TIMEOUT);
    assert.ok(Date.now() - started >= 50);

    const quick = await connect(ctx.wsUrl);
    quick.send({ type: 'join', room: 'mid', name: 'Анна' });
    await quick.next('roster');
    await sleep(120);
    assert.equal(quick.socket.readyState, 1, 'хто зайшов — того таймер не чіпає');
    quick.socket.close();
  } finally {
    await ctx.stop();
  }
});

test('ліміт повідомлень за секунду (token bucket)', async () => {
  const ctx = await startApp({ RATE_LIMIT_PER_SECOND: '5' });
  try {
    const client = await connect(ctx.wsUrl);
    client.send({ type: 'join', room: 'mid', name: 'Спамер' });
    await client.next('roster');
    for (let i = 0; i < 10; i += 1) client.send({ type: 'chat', text: `спам ${i}` });
    assert.equal((await client.closed()).code, CLOSE.RATE_LIMIT);

    // Той, хто пише в межах ліміту, не страждає: відро наповнюється.
    const polite = await connect(ctx.wsUrl);
    polite.send({ type: 'join', room: 'mid', name: 'Чемний' });
    await polite.next('roster');
    for (let i = 0; i < 8; i += 1) {
      polite.send({ type: 'chat', text: `повідомлення ${i}` });
      await sleep(250);
    }
    assert.equal(polite.socket.readyState, 1);
    polite.socket.close();
  } finally {
    await ctx.stop();
  }
});

test('heartbeat: два пропущені pong — розрив; живий клієнт лишається', async () => {
  const ctx = await startApp({ HEARTBEAT_MS: '40' });
  try {
    const dead = await connect(ctx.wsUrl, { autoPong: false }); // не відповідає на ping
    const alive = await connect(ctx.wsUrl);
    for (const [client, name] of [
      [dead, 'Привид'],
      [alive, 'Живий'],
    ]) {
      client.send({ type: 'join', room: 'mid', name });
    }
    const { code } = await dead.closed();
    assert.equal(code, 1006, 'terminate() — обрив без рукостискання закриття');
    await sleep(150);
    assert.equal(alive.socket.readyState, 1);
    assert.equal(ctx.app.rooms.get('mid').size, 1, 'привида прибрано з кімнати');
    alive.socket.close();
  } finally {
    await ctx.stop();
  }
});

test('повільному клієнту некритичне не шлемо', async () => {
  const ctx = await startApp({ SLOW_CLIENT_BYTES: '1024' });
  try {
    const slow = await connect(ctx.wsUrl);
    const fast = await connect(ctx.wsUrl);
    slow.send({ type: 'join', room: 'mid', name: 'Повільний' });
    await slow.next('roster'); // власний вхід
    fast.send({ type: 'join', room: 'mid', name: 'Швидкий' });
    await fast.next('roster');
    await slow.next('roster'); // вхід швидкого

    // Імітуємо клієнта, що не встигає читати: у його сокета «виріс» буфер відправки.
    const { stateOf } = ctx.app.ws; // стан з'єднання лежить у WeakMap, а не на сокеті
    const serverSide = [...ctx.app.ws.wss.clients].find(
      (ws) => stateOf(ws)?.player?.name === 'Повільний',
    );
    Object.defineProperty(serverSide, 'bufferedAmount', { get: () => 5000 });

    fast.send({ type: 'chat', text: 'це дійде лише швидкому' });
    assert.equal((await fast.next('chat')).text, 'це дійде лише швидкому');
    await sleep(50);
    // Крім чату, повільному не йдуть і знімки стану — вони теж некритичні.
    assert.ok(stateOf(serverSide).dropped >= 1);
    assert.equal(ctx.app.ws.stats.dropped, stateOf(serverSide).dropped);

    // Критичне (roster) повільному все одно йде.
    fast.socket.close();
    assert.deepEqual(
      (await slow.next('roster')).players.map((p) => p.name),
      ['Повільний'],
    );
    slow.socket.close();
  } finally {
    await ctx.stop();
  }
});

test('лог матчу: події → NDJSON-файл; повтор читається потоком', async () => {
  const ctx = await startApp();
  try {
    const anna = await connect(ctx.wsUrl);
    anna.send({ type: 'join', room: 'river', name: 'Анна' });
    await anna.next('roster');
    anna.send({ type: 'chat', text: 'перший' });
    anna.send({ type: 'chat', text: 'другий "з лапками" і\nпереносом' });
    await anna.next('chat');
    await anna.next('chat');
    assert.equal(ctx.app.logs.activeCount, 1);
    anna.socket.close();
    await once(ctx.app.rooms.get('river'), 'empty');
    await sleep(50); // pipeline дописує й закриває файл

    assert.equal(ctx.app.logs.activeCount, 0);
    const [replay] = await listReplays(ctx.config.logDir);
    assert.match(replay.id, /^river-/);

    const text = await readFile(`${ctx.config.logDir}/${replay.id}.ndjson`, 'utf8');
    assert.equal(text.trim().split('\n').length, 4, 'один JSON на рядок');

    const events = [];
    for await (const event of readEvents(`${ctx.config.logDir}/${replay.id}.ndjson`))
      events.push(event);
    assert.deepEqual(
      events.map((event) => event.type),
      ['join', 'chat', 'chat', 'leave'],
    );
    assert.equal(events[2].text, 'другий "з лапками" і\nпереносом');

    // HTTP: список і потокова віддача.
    const list = await (await fetch(ctx.http + '/api/replays')).json();
    assert.equal(list.replays[0].id, replay.id);
    const response = await fetch(`${ctx.http}/api/replays/${replay.id}`);
    assert.equal(response.headers.get('content-type'), 'application/x-ndjson');
    assert.equal(await response.text(), text);
    assert.equal((await fetch(`${ctx.http}/api/replays/nope`)).status, 404);
    assert.equal((await fetch(`${ctx.http}/api/replays/..%2Fsecret`)).status, 404);
  } finally {
    await ctx.stop();
  }
});

test('штатна зупинка: сокети закриті з кодом 1001, лог дописано', async () => {
  const ctx = await startApp();
  const client = await connect(ctx.wsUrl);
  client.send({ type: 'join', room: 'mid', name: 'Анна' });
  await client.next('roster');
  client.send({ type: 'chat', text: 'останнє слово' });
  await client.next('chat');

  const closing = client.closed();
  await ctx.app.close();
  assert.equal((await closing).code, CLOSE.GOING_AWAY);
  assert.equal(ctx.app.server.listening, false);

  const [replay] = await listReplays(ctx.config.logDir);
  const text = await readFile(`${ctx.config.logDir}/${replay.id}.ndjson`, 'utf8');
  assert.match(text, /останнє слово/);
  await ctx.stop().catch(() => {});
});
