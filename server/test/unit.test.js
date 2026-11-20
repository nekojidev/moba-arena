import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { resolve, sep } from 'node:path';

import { ConfigError, loadConfig } from '../src/config.js';
import { CLOSE, parseClientMessage, serverMessage } from '../src/protocol.js';
import { Room, RoomError, RoomManager } from '../src/rooms.js';
import { resolveStaticPath } from '../src/static.js';

test('config: типові значення і значення з оточення', () => {
  const defaults = loadConfig({});
  assert.equal(defaults.port, 3000);
  assert.equal(defaults.joinTimeoutMs, 5000);
  assert.equal(defaults.heartbeatMs, 15000);
  assert.ok(Object.isFrozen(defaults));

  const custom = loadConfig({ PORT: '8080', LOG_DIR: '/var/log/arena', DEBUG_ROUTES: '1' });
  assert.equal(custom.port, 8080);
  assert.equal(custom.logDir, resolve('/var/log/arena'));
  assert.equal(custom.debugRoutes, true);
});

test('config: усі помилки одразу, зі зрозумілим текстом', () => {
  assert.throws(
    () => loadConfig({ PORT: 'abc', MAX_ROOMS: '0', DEBUG_ROUTES: 'yes', LOG_LEVEL: 'loud' }),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.problems.length, 4);
      assert.match(error.message, /PORT="abc"/);
      return true;
    },
  );
  assert.throws(() => loadConfig({ PORT: '70000' }), ConfigError);
  assert.throws(() => loadConfig({ PORT: '80.5' }), ConfigError);
});

test('protocol: коректні повідомлення проходять', () => {
  const join = parseClientMessage(Buffer.from('{"v":0,"type":"join","room":"mid","name":"Маг"}'));
  assert.deepEqual(join, { ok: true, message: { v: 0, type: 'join', room: 'mid', name: 'Маг' } });
  assert.equal(parseClientMessage('{"v":0,"type":"chat","text":"gg"}').ok, true);
  assert.equal(parseClientMessage('{"v":0,"type":"leave"}').ok, true);
  assert.deepEqual(JSON.parse(serverMessage('roster', { players: [] })), {
    v: 0,
    type: 'roster',
    players: [],
  });
});

test('protocol: кожен вид сміття відхиляється зі своїм кодом', () => {
  const code = (raw, binary) => parseClientMessage(raw, binary).code;
  assert.equal(code('not json'), CLOSE.BAD_MESSAGE);
  assert.equal(code('null'), CLOSE.BAD_MESSAGE);
  assert.equal(code('[1,2]'), CLOSE.BAD_MESSAGE);
  assert.equal(code('{"type":"chat","text":"x"}'), CLOSE.VERSION);
  assert.equal(code('{"v":1,"type":"chat","text":"x"}'), CLOSE.VERSION);
  assert.equal(code('{"v":0,"type":"teleport"}'), CLOSE.UNKNOWN_TYPE);
  assert.equal(code('{"v":0,"type":"constructor"}'), CLOSE.UNKNOWN_TYPE);
  assert.equal(code('{"v":0}'), CLOSE.UNKNOWN_TYPE);
  assert.equal(code('{"v":0,"type":"chat"}'), CLOSE.BAD_MESSAGE);
  assert.equal(code('{"v":0,"type":"chat","text":42}'), CLOSE.BAD_MESSAGE);
  assert.equal(code('{"v":0,"type":"chat","text":"   "}'), CLOSE.BAD_MESSAGE);
  assert.equal(code(`{"v":0,"type":"chat","text":"${'x'.repeat(201)}"}`), CLOSE.BAD_MESSAGE);
  assert.equal(code('{"v":0,"type":"chat","text":"x","admin":true}'), CLOSE.BAD_MESSAGE);
  assert.equal(code('{"v":0,"type":"join","room":"mid","name":"x"}'), CLOSE.BAD_MESSAGE);
  assert.equal(code(Buffer.from([1, 2, 3]), true), CLOSE.BAD_MESSAGE);
});

test('Room: EventEmitter з подіями start / join / chat / leave / empty / event', () => {
  const room = new Room({ id: 'r', name: 'R', arena: {}, maxPlayers: 2 });
  const seen = [];
  for (const type of ['start', 'join', 'chat', 'leave', 'empty']) {
    room.on(type, () => seen.push(type));
  }
  const log = [];
  room.on('event', (event) => log.push(event.type));

  room.join({ id: 'a', name: 'Анна' });
  room.join({ id: 'b', name: 'Борис' });
  assert.deepEqual(room.roster(), [
    { id: 'a', name: 'Анна' },
    { id: 'b', name: 'Борис' },
  ]);
  assert.throws(
    () => room.join({ id: 'c', name: 'Віра' }),
    (e) => e.code === 'room_full',
  );
  assert.equal(room.chat('a', 'привіт').from.name, 'Анна');
  assert.throws(() => room.chat('zzz', 'x'), RoomError);
  room.leave('a');
  room.leave('b');
  assert.equal(room.leave('b'), false);

  assert.deepEqual(seen, ['start', 'join', 'join', 'chat', 'leave', 'leave', 'empty']);
  assert.deepEqual(log, ['join', 'join', 'chat', 'leave', 'leave']);
  assert.deepEqual(JSON.parse(JSON.stringify(room)).players, 0);
});

test('RoomManager: порожня кімната видаляється; постійна — ні; є ліміт', async () => {
  const rooms = new RoomManager({ maxRooms: 3, maxPlayersPerRoom: 4, emptyTtlMs: 30 });
  const lobby = rooms.create({ id: 'lobby', name: 'Постійна', arena: {}, persistent: true });
  const temp = rooms.create({ name: 'Тимчасова', arena: {} });
  const deleted = [];
  rooms.on('deleted', (room) => deleted.push(room.id));

  temp.join({ id: 'a', name: 'Анна' });
  temp.leave('a');
  assert.equal(rooms.get(temp.id), undefined);
  assert.equal(temp.listenerCount('empty'), 0, 'слухачів прибрано');

  lobby.join({ id: 'a', name: 'Анна' });
  lobby.leave('a');
  assert.equal(rooms.get('lobby'), lobby);

  // Кімната, в яку так ніхто й не зайшов, зникає за таймером.
  const idle = rooms.create({ name: 'Нічия', arena: {} });
  await once(rooms, 'deleted');
  assert.deepEqual(deleted, [temp.id, idle.id]);

  rooms.create({ name: 'Друга', arena: {} });
  rooms.create({ name: 'Третя', arena: {} });
  assert.throws(
    () => rooms.create({ name: 'Зайва', arena: {} }),
    (e) => e.code === 'too_many_rooms',
  );
});

test('static: шляхи з .. відхиляються, навіть закодовані', () => {
  const root = resolve('/srv/dist');
  assert.equal(resolveStaticPath(root, '/'), root);
  assert.equal(resolveStaticPath(root, '/assets/main.js'), root + sep + 'assets' + sep + 'main.js');
  for (const path of [
    '/../etc/passwd',
    '/assets/../../etc/passwd',
    '/%2e%2e/%2e%2e/etc/passwd',
    '/..%2fetc%2fpasswd',
    '/assets/..\\..\\secret',
    '/%00',
    '/%E0%A4%A',
  ]) {
    assert.equal(resolveStaticPath(root, path), null, path);
  }
});
