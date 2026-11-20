// Розбір повідомлень (protocol.ts), бренди і шина подій — приклади з відомою відповіддю.
import { describe, test, vi } from 'vitest';
import assert from 'node:assert/strict';

import { entityId, seq, tick } from '../src/brand.ts';
import { Bus } from '../src/bus.ts';
import { CODECS, CodecError } from '../src/codec/index.ts';
import {
  CLOSE,
  DT,
  PROTOCOL_VERSION,
  TICK_MS,
  TICK_RATE,
  clientMessage,
  parseClientMessage,
  parseServerMessage,
  serverMessage,
} from '../src/protocol.ts';

const ROOM = {
  id: 'r1',
  name: 'Арена',
  players: 1,
  maxPlayers: 4,
  arena: { width: 1600, height: 900, asteroids: 5, pickups: 2, seed: 7 },
};

describe('parseClientMessage', () => {
  test('кожен тип повідомлення клієнта — і об’єктом, і рядком JSON', () => {
    const messages = [
      { v: 1, type: 'join', room: 'r1', name: 'Оля' },
      { v: 1, type: 'join', room: 'r1', name: 'Оля', codec: 'json' },
      { v: 1, type: 'chat', text: 'привіт' },
      { v: 1, type: 'ping', t: 1234.5 },
      { v: 1, type: 'leave' },
      { v: 1, type: 'input', seq: 9, turn: -1, thrust: 1, brake: false, dash: true, fire: false },
    ];
    for (const message of messages) {
      assert.deepEqual(parseClientMessage(message), { ok: true, message });
      assert.deepEqual(parseClientMessage(JSON.stringify(message)), { ok: true, message });
    }
  });

  test('ім’я й текст чату обрізаються по краях; кімната — ні', () => {
    const join = parseClientMessage({ v: 1, type: 'join', room: ' r 1 ', name: '  Оля \n' });
    assert.deepEqual(join.message, { v: 1, type: 'join', room: ' r 1 ', name: 'Оля' });
    const chat = parseClientMessage({ v: 1, type: 'chat', text: '\t привіт  ' });
    assert.equal(chat.message.text, 'привіт');
  });

  test('межі довжини рахуються ПІСЛЯ обрізання', () => {
    const name = (value) => parseClientMessage({ v: 1, type: 'join', room: 'r', name: value }).ok;
    assert.equal(name('ab'), true);
    assert.equal(name('a'), false);
    assert.equal(name('   a   '), false, 'пробіли не рахуються');
    assert.equal(name('x'.repeat(16)), true);
    assert.equal(name('x'.repeat(17)), false);
    assert.equal(name(`  ${'x'.repeat(16)}  `), true, '20 символів, але після обрізання — 16');

    const text = (value) => parseClientMessage({ v: 1, type: 'chat', text: value }).ok;
    assert.equal(text('x'.repeat(200)), true);
    assert.equal(text('x'.repeat(201)), false);
    assert.equal(text('   '), false);

    const room = (value) => parseClientMessage({ v: 1, type: 'join', room: value, name: 'ab' }).ok;
    assert.equal(room(''), false);
    assert.equal(room('x'.repeat(64)), true);
    assert.equal(room('x'.repeat(65)), false);
  });

  test('довжина рахується в кодових точках Unicode, а не в одиницях UTF-16 чи байтах', () => {
    const name = (value) => parseClientMessage({ v: 1, type: 'join', room: 'r', name: value }).ok;
    const emoji = '😀'; // одна кодова точка, .length === 2, 4 байти UTF-8
    assert.equal(emoji.length, 2);
    assert.equal(name(emoji), false, 'один символ — замало, хоча .length === 2');
    assert.equal(name(emoji.repeat(2)), true);
    // 16 емодзі проходять межу «16 символів»: це 32 одиниці UTF-16 і 64 байти на дроті.
    assert.equal(name(emoji.repeat(16)), true);
    assert.equal(new TextEncoder().encode(emoji.repeat(16)).length, 64);
    assert.equal(name(emoji.repeat(17)), false);
  });

  test('не JSON, не об’єкт → 4000 BAD_MESSAGE', () => {
    for (const data of ['{', '', 'null', '[]', '"рядок"', '42', null, undefined, 42, [], true]) {
      const result = parseClientMessage(data);
      assert.equal(result.ok, false, JSON.stringify(data));
      assert.equal(result.code, CLOSE.BAD_MESSAGE);
    }
    assert.equal(parseClientMessage('{').reason, 'invalid JSON');
    assert.equal(parseClientMessage('[]').reason, 'message must be an object');
  });

  test('не та версія → 4005 VERSION (перевіряється раніше за тип)', () => {
    for (const v of [0, 2, '1', null, undefined, 1.5]) {
      assert.deepEqual(parseClientMessage({ v, type: 'no-such-type' }), {
        ok: false,
        code: CLOSE.VERSION,
        reason: 'unsupported protocol version',
      });
    }
    assert.equal(parseClientMessage({ type: 'leave' }).code, CLOSE.VERSION);
  });

  test('невідомий тип → 4001 UNKNOWN_TYPE; серверні типи клієнту не дозволені', () => {
    for (const type of ['', 'welcome', 'snapshot', 'JOIN', 'toString', 'constructor', 7, null]) {
      assert.deepEqual(parseClientMessage({ v: 1, type }), {
        ok: false,
        code: CLOSE.UNKNOWN_TYPE,
        reason: 'unknown message type',
      });
    }
    assert.equal(parseClientMessage({ v: 1 }).code, CLOSE.UNKNOWN_TYPE);
  });

  test('погане поле → 4000 і назва поля в причині', () => {
    const cases = [
      [{ v: 1, type: 'join', room: 'r1' }, 'name'],
      [{ v: 1, type: 'join', room: 'r1', name: 'Оля', codec: 'xml' }, 'codec'],
      [{ v: 1, type: 'chat', text: 5 }, 'text'],
      [{ v: 1, type: 'ping', t: 'зараз' }, 't'],
      [{ v: 1, type: 'ping', t: Infinity }, 't'],
      [
        {
          v: 1,
          type: 'input',
          seq: -1,
          turn: 0,
          thrust: 0,
          brake: false,
          dash: false,
          fire: false,
        },
        'seq',
      ],
      [
        {
          v: 1,
          type: 'input',
          seq: 1,
          turn: 0.5,
          thrust: 0,
          brake: false,
          dash: false,
          fire: false,
        },
        'turn',
      ],
      [
        {
          v: 1,
          type: 'input',
          seq: 2 ** 32,
          turn: 0,
          thrust: 0,
          brake: false,
          dash: false,
          fire: false,
        },
        'seq',
      ],
    ];
    for (const [message, field] of cases) {
      assert.deepEqual(parseClientMessage(message), {
        ok: false,
        code: CLOSE.BAD_MESSAGE,
        reason: `invalid message: field "${field}"`,
      });
    }
  });

  test('зайве поле відхиляється (strictObject), причина без назви поля', () => {
    assert.deepEqual(parseClientMessage({ v: 1, type: 'leave', admin: true }), {
      ok: false,
      code: CLOSE.BAD_MESSAGE,
      reason: 'invalid message',
    });
    // __proto__ у тексті JSON — звичайний власний ключ, і він теж «зайве поле».
    assert.equal(parseClientMessage('{"v":1,"type":"leave","__proto__":{"admin":true}}').ok, false);
  });

  test('причина вміщається в кадр закриття WebSocket (≤ 123 байти)', () => {
    const result = parseClientMessage({ v: 1, type: 'input', ['x'.repeat(500)]: 1 });
    assert.equal(result.ok, false);
    assert.ok(new TextEncoder().encode(result.reason).length <= 123);
  });
});

describe('parseServerMessage', () => {
  test('кожен тип повідомлення сервера', () => {
    const messages = [
      {
        v: 1,
        type: 'welcome',
        playerId: 'p1',
        shipId: 7,
        room: ROOM,
        tickRate: 30,
        codec: 'binary',
      },
      {
        v: 1,
        type: 'welcome',
        playerId: 'p1',
        shipId: 7,
        room: ROOM,
        tickRate: 30,
        codec: 'json',
        version: 'abc1234',
      },
      { v: 1, type: 'shutdown', reason: 'server is restarting' },
      {
        v: 1,
        type: 'roster',
        players: [
          { id: 'p1', name: 'Оля', shipId: 7 },
          { id: 'p2', name: 'Глядач' },
        ],
      },
      { v: 1, type: 'chat', from: { id: 'p1', name: 'Оля' }, text: 'привіт', t: 1 },
      { v: 1, type: 'pong', t: 12.5 },
      {
        v: 1,
        type: 'events',
        tick: 100,
        events: [
          { type: 'fired', shipId: 7, team: 'green', homing: false },
          { type: 'hit', targetKind: 'asteroid', targetId: 12, shielded: false },
          { type: 'exploded', kind: 'asteroid', id: 12, killerId: 7, x: 1, y: 2, size: 3 },
          { type: 'exploded', kind: 'ship', id: 9, killerId: null, x: 1, y: 2 },
          { type: 'pickup', shipId: 7, effect: { type: 'rapid', duration: 6 } },
          { type: 'respawned', shipId: 9 },
        ],
      },
      { v: 1, type: 'snapshot', tick: 1, ack: 0, self: null, entities: [] },
    ];
    for (const message of messages) {
      assert.deepEqual(parseServerMessage(JSON.stringify(message)), { ok: true, message });
    }
  });

  test('клієнтські типи, чужа версія, биті поля', () => {
    assert.equal(parseServerMessage({ v: 1, type: 'join' }).code, CLOSE.UNKNOWN_TYPE);
    assert.equal(parseServerMessage({ v: 2, type: 'pong', t: 1 }).code, CLOSE.VERSION);
    assert.equal(parseServerMessage('pong').code, CLOSE.BAD_MESSAGE);
    assert.deepEqual(parseServerMessage({ v: 1, type: 'pong' }), {
      ok: false,
      code: CLOSE.BAD_MESSAGE,
      reason: 'invalid message: field "t"',
    });
    assert.equal(
      parseServerMessage({ v: 1, type: 'shutdown' }).reason,
      'invalid message: field "reason"',
    );
    const badEvent = { v: 1, type: 'events', tick: 1, events: [{ type: 'score', id: 1 }] };
    assert.equal(parseServerMessage(badEvent).reason, 'invalid message: field "events.0.type"');
    const badRoom = {
      v: 1,
      type: 'welcome',
      playerId: 'p',
      shipId: 1,
      room: { ...ROOM, arena: { ...ROOM.arena, width: 0 } },
      tickRate: 30,
      codec: 'binary',
    };
    assert.equal(parseServerMessage(badRoom).reason, 'invalid message: field "room.arena.width"');
  });

  test('знімок текстом: зайве поле в сутності відхиляється', () => {
    const entity = { id: 1, kind: 'pickup', x: 1, y: 2, angle: 0, effect: 'shield' };
    const good = { v: 1, type: 'snapshot', tick: 1, ack: 0, self: null, entities: [entity] };
    assert.equal(parseServerMessage(good).ok, true);
    const extra = { ...good, entities: [{ ...entity, hp: 5 }] };
    assert.equal(parseServerMessage(extra).ok, false);
    const unknownKind = { ...good, entities: [{ ...entity, kind: 'explosion' }] };
    assert.equal(parseServerMessage(unknownKind).ok, false);
  });
});

describe('serverMessage / clientMessage', () => {
  test('додають версію і дають JSON, який приймає парний розбір', () => {
    const pong = serverMessage({ type: 'pong', t: 5 });
    assert.equal(pong, '{"v":1,"type":"pong","t":5}');
    assert.deepEqual(parseServerMessage(pong).message, { v: 1, type: 'pong', t: 5 });

    const join = clientMessage({ type: 'join', room: 'r1', name: 'Оля', codec: 'binary' });
    assert.deepEqual(parseClientMessage(join).message, {
      v: PROTOCOL_VERSION,
      type: 'join',
      room: 'r1',
      name: 'Оля',
      codec: 'binary',
    });
  });

  test('константи кроку узгоджені', () => {
    assert.equal(TICK_RATE, 30);
    assert.equal(DT * TICK_RATE, 1);
    assert.equal(TICK_MS, 1000 / 30);
  });
});

describe('кодеки: спільний інтерфейс', () => {
  test('CODECS: два кодеки з однаковим набором методів', () => {
    assert.deepEqual(Object.keys(CODECS), ['binary', 'json']);
    for (const [name, codec] of Object.entries(CODECS)) {
      assert.equal(codec.name, name);
      assert.ok(Object.isFrozen(codec));
      for (const method of ['encodeInput', 'decodeInput', 'encodeSnapshot', 'decodeSnapshot']) {
        assert.equal(typeof codec[method], 'function');
      }
    }
    assert.equal(typeof CODECS.json.encodeInput({ seq: 1 }), 'string');
    assert.ok(
      CODECS.binary.encodeSnapshot({ tick: 1, ack: 0, self: null, entities: [] }) instanceof
        Uint8Array,
    );
  });

  test('JSON-кодек приймає вже розібраний об’єкт так само, як рядок', () => {
    const input = { seq: 5, turn: 1, thrust: 0, brake: true, dash: false, fire: false };
    assert.deepEqual(CODECS.json.decodeInput({ v: 1, type: 'input', ...input }), input);
    assert.throws(() => CODECS.json.decodeInput({ v: 1, type: 'input' }), CodecError);
    assert.throws(() => CODECS.json.decodeSnapshot(new Uint8Array(44)), CodecError);
    assert.throws(() => CODECS.json.decodeSnapshot(null), CodecError);
  });

  test('бінарний кодек: ArrayBuffer (браузер) і Uint8Array (Node) читаються однаково', () => {
    const input = { seq: 5, turn: 1, thrust: 0, brake: true, dash: false, fire: false };
    const bytes = CODECS.binary.encodeInput(input);
    assert.deepEqual(CODECS.binary.decodeInput(bytes.buffer), input);
    assert.deepEqual(CODECS.binary.decodeInput(new DataView(bytes.buffer)), input);
    for (const notBinary of [null, undefined, 42, {}, [1, 2, 8, 0, 0, 0, 0, 0]]) {
      assert.throws(() => CODECS.binary.decodeInput(notBinary), CodecError);
      assert.throws(() => CODECS.binary.decodeSnapshot(notBinary), CodecError);
    }
  });

  test('бінарний знімок: значення поза діапазоном у кадрі — CodecError з причиною', () => {
    const snapshot = {
      tick: 1,
      ack: 0,
      self: {
        down: false,
        shield: false,
        rapid: false,
        homing: false,
        hp: 50,
        x: 1,
        y: 2,
        vx: 3,
        vy: 4,
        angle: 0,
        dashCooldown: 0,
        fireCooldown: 0,
        respawnTimer: 0,
      },
      entities: [
        {
          id: 1,
          kind: 'ship',
          x: 1,
          y: 2,
          angle: 0,
          hp: 5,
          score: 0,
          down: false,
          shield: false,
          thrust: false,
        },
        { id: 2, kind: 'asteroid', x: 1, y: 2, angle: 0, size: 2, homing: false },
        { id: 3, kind: 'pickup', x: 1, y: 2, angle: 0, effect: 'homing' },
      ],
    };
    const good = CODECS.binary.encodeSnapshot(snapshot);
    const broken = (offset, value) => {
      const copy = new Uint8Array(good);
      copy[offset] = value;
      return copy;
    };
    const firstEntity = 44;
    const cases = [
      [broken(0, 2), /version/],
      [broken(1, 1), /type/],
      [broken(11, 101), /self state/], // hp власного героя
      [broken(15, 0x7f), /self state/], // старший байт f32 x: 0x7f80… — нескінченність або NaN
      [broken(firstEntity + 12, 101), /hp out of range/],
      [broken(firstEntity + 15 + 12, 0), /size out of range/],
      [broken(firstEntity + 15 + 12, 4), /size out of range/],
      [broken(firstEntity + 15 + 13 + 12, 3), /unknown effect/],
      [broken(firstEntity + 4, 4), /unknown entity kind/],
      [broken(42, 4), /truncated/], // лічильник каже 4 сутності, а їх 3
      [good.slice(0, good.length - 1), /truncated/],
      [good.slice(0, 43), /too short/],
    ];
    for (const [bytes, reason] of cases) {
      assert.throws(
        () => CODECS.binary.decodeSnapshot(bytes),
        (error) => error instanceof CodecError && reason.test(error.message),
        String(reason),
      );
    }
    const error = new CodecError('приклад');
    assert.equal(error.name, 'CodecError');
    assert.ok(error instanceof Error);
  });

  test('бінарний знімок: рахунок понад 65535 обрізається до 65535, а не переповнюється', () => {
    const ship = {
      id: 1,
      kind: 'ship',
      x: 1,
      y: 2,
      angle: 0,
      hp: 5,
      score: 70000,
      down: false,
      shield: false,
      thrust: false,
    };
    const bytes = CODECS.binary.encodeSnapshot({ tick: 1, ack: 0, self: null, entities: [ship] });
    assert.equal(CODECS.binary.decodeSnapshot(bytes).entities[0].score, 65535);
  });
});

describe('бренди', () => {
  test('у рантаймі бренд — це те саме число', () => {
    assert.equal(entityId(7), 7);
    assert.equal(tick(8), 8);
    assert.equal(seq(9), 9);
    assert.equal(typeof entityId(7), 'number');
  });
});

describe('Bus', () => {
  test('emit викликає слухачів синхронно, у порядку підписки, з тими самими даними', () => {
    const bus = new Bus();
    const calls = [];
    const payload = { shipId: 1 };
    bus.on('fired', (data) => calls.push(['a', data]));
    bus.on('fired', (data) => calls.push(['b', data]));
    bus.on('hit', () => calls.push(['інша подія']));
    bus.emit('fired', payload);
    assert.deepEqual(calls, [
      ['a', payload],
      ['b', payload],
    ]);
    assert.equal(calls[0][1], payload, 'той самий об’єкт, не копія');
  });

  test('emit без слухачів — нічого не робить', () => {
    const bus = new Bus();
    bus.emit('fired', {});
    const off = bus.on('fired', () => {});
    off();
    bus.emit('fired', {});
  });

  test('on повертає відписку; повторна відписка безпечна', () => {
    const bus = new Bus();
    const handler = vi.fn();
    const off = bus.on('score', handler);
    bus.emit('score', 1);
    off();
    off();
    bus.emit('score', 2);
    assert.deepEqual(handler.mock.calls, [[1]]);
  });

  test('той самий слухач, підписаний двічі, викликається один раз (Set)', () => {
    const bus = new Bus();
    const handler = vi.fn();
    bus.on('score', handler);
    bus.on('score', handler);
    bus.emit('score', 1);
    assert.equal(handler.mock.calls.length, 1);
  });

  test('{ signal }: abort() відписує; уже скасований сигнал — підписки немає', () => {
    const bus = new Bus();
    const handler = vi.fn();
    const controller = new AbortController();
    bus.on('score', handler, { signal: controller.signal });
    bus.emit('score', 1);
    controller.abort();
    bus.emit('score', 2);
    assert.equal(handler.mock.calls.length, 1);

    const late = vi.fn();
    const off = bus.on('score', late, { signal: controller.signal });
    bus.emit('score', 3);
    assert.equal(late.mock.calls.length, 0);
    off(); // порожня функція, але викликати її можна
  });

  test('слухач, що відписує іншого під час emit: цей emit ще доходить до всіх', () => {
    const bus = new Bus();
    const calls = [];
    const offs = [];
    offs.push(
      bus.on('score', () => {
        calls.push('a');
        offs[1]();
      }),
    );
    offs.push(bus.on('score', () => calls.push('b')));
    bus.emit('score', 1);
    assert.deepEqual(calls, ['a', 'b'], 'emit ітерує копію списку');
    bus.emit('score', 2);
    assert.deepEqual(calls, ['a', 'b', 'a']);
  });

  test('слухач, доданий під час emit, отримає лише наступну подію', () => {
    const bus = new Bus();
    const late = vi.fn();
    bus.on('score', () => bus.on('score', late));
    bus.emit('score', 1);
    assert.equal(late.mock.calls.length, 0);
    bus.emit('score', 2);
    assert.equal(late.mock.calls.length, 1);
  });

  test('виняток у слухачі перериває emit — наступні слухачі подію не отримують', () => {
    const bus = new Bus();
    const after = vi.fn();
    bus.on('score', () => {
      throw new Error('зламаний слухач');
    });
    bus.on('score', after);
    assert.throws(() => bus.emit('score', 1), /зламаний слухач/);
    assert.equal(after.mock.calls.length, 0);
  });
});
