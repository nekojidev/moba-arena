import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CODECS, CodecError } from '../src/codec/index.ts';
import {
  dequantizeAngle,
  quantizeAngle,
  quantizePosition,
  snapshotByteLength,
} from '../src/codec/binary.ts';
import { MESSAGE, PROTOCOL_VERSION } from '../src/protocol.ts';

const { binary, json } = CODECS;

const SNAPSHOT = {
  tick: 123456,
  ack: 4242,
  self: {
    down: false,
    shield: true,
    rapid: false,
    homing: true,
    hp: 85,
    x: 812.34375,
    y: 17.5,
    vx: -311.25,
    vy: 42.125,
    angle: 1.2345,
    dashCooldown: 1.5,
    fireCooldown: 0.25,
    respawnTimer: 0,
  },
  entities: [
    {
      id: 7,
      kind: 'ship',
      x: 812.3,
      y: 17.52,
      angle: 1.2345,
      hp: 85,
      score: 310,
      down: false,
      shield: true,
      thrust: true,
    },
    {
      id: 9,
      kind: 'ship',
      x: 1599.99,
      y: 0,
      angle: -3.1415,
      hp: 0,
      score: 0,
      down: true,
      shield: false,
      thrust: false,
    },
    { id: 4000000000, kind: 'bullet', x: 400.03, y: 899.97, angle: 0.5, owner: 7, homing: true },
    { id: 12, kind: 'asteroid', x: 100, y: 200, angle: 17.25, size: 3, homing: false },
    { id: 13, kind: 'pickup', x: 5.0625, y: 6.9375, angle: 0, effect: 'rapid' },
  ],
};

test('input: бінарний кодек — 8 байтів, little-endian, точний round-trip', () => {
  const input = { seq: 0x01020304, turn: -1, thrust: 1, brake: false, dash: true, fire: true };
  const bytes = binary.encodeInput(input);
  assert.equal(bytes.byteLength, 8);
  assert.deepEqual(
    [...bytes],
    [PROTOCOL_VERSION, MESSAGE.INPUT, 0x04, 0x03, 0x02, 0x01, 0b1101, 0xff],
  );
  assert.deepEqual(binary.decodeInput(bytes), input);
  assert.deepEqual(json.decodeInput(json.encodeInput(input)), input);

  for (const turn of [-1, 0, 1]) {
    for (let buttons = 0; buttons < 16; buttons += 1) {
      const sample = {
        seq: buttons * 1000 + turn + 1,
        turn,
        thrust: buttons & 1 ? 1 : 0,
        brake: Boolean(buttons & 2),
        dash: Boolean(buttons & 4),
        fire: Boolean(buttons & 8),
      };
      assert.deepEqual(binary.decodeInput(binary.encodeInput(sample)), sample);
    }
  }
});

test('input: Buffer зі зсувом у спільному ArrayBuffer читається правильно', () => {
  const bytes = binary.encodeInput({
    seq: 77,
    turn: 1,
    thrust: 0,
    brake: true,
    dash: false,
    fire: false,
  });
  const padded = new Uint8Array(32);
  padded.set(bytes, 11);
  const slice = Buffer.from(padded.buffer, 11, 8); // як дані з сокета в Node
  assert.equal(binary.decodeInput(slice).seq, 77);
});

test('input: сміття відхиляється', () => {
  const good = binary.encodeInput({
    seq: 1,
    turn: 0,
    thrust: 0,
    brake: false,
    dash: false,
    fire: false,
  });
  const broken = (change) => {
    const copy = new Uint8Array(good);
    change(copy);
    return copy;
  };
  for (const data of [
    new Uint8Array(0),
    good.slice(0, 7),
    new Uint8Array(9),
    broken((b) => (b[0] = 99)), // версія
    broken((b) => (b[1] = MESSAGE.SNAPSHOT)), // тип
    broken((b) => (b[6] = 0xff)), // зайві біти кнопок
    broken((b) => (b[7] = 5)), // поворот поза −1…1
    'рядок',
  ]) {
    assert.throws(() => binary.decodeInput(data), CodecError);
  }
  for (const data of [
    '{',
    '{"v":1,"type":"input","seq":-1}',
    '{"v":1,"type":"input","seq":1,"turn":9}',
    '{"v":0,"type":"input"}',
  ]) {
    assert.throws(() => json.decodeInput(data), CodecError);
  }
});

test('snapshot: JSON — точний round-trip', () => {
  assert.deepEqual(json.decodeSnapshot(json.encodeSnapshot(SNAPSHOT)), SNAPSHOT);
});

test('snapshot: бінарний round-trip збігається в межах квантування', () => {
  const bytes = binary.encodeSnapshot(SNAPSHOT);
  assert.equal(bytes.byteLength, snapshotByteLength(SNAPSHOT));
  assert.equal(bytes.byteLength, 10 + 32 + 2 + 2 * 15 + 16 + 13 + 13);
  const decoded = binary.decodeSnapshot(bytes);

  assert.equal(decoded.tick, SNAPSHOT.tick);
  assert.equal(decoded.ack, SNAPSHOT.ack);

  // Власний герой: f32 — значення, що точно подаються у float32, повертаються біт у біт.
  for (const key of ['x', 'y', 'vx', 'vy', 'dashCooldown', 'fireCooldown', 'respawnTimer']) {
    assert.equal(decoded.self[key], Math.fround(SNAPSHOT.self[key]), key);
  }
  for (const key of ['down', 'shield', 'rapid', 'homing', 'hp']) {
    assert.equal(decoded.self[key], SNAPSHOT.self[key], key);
  }
  assert.ok(Math.abs(decoded.self.angle - SNAPSHOT.self.angle) <= Math.PI / 32767 / 2 + 1e-12);

  assert.equal(decoded.entities.length, SNAPSHOT.entities.length);
  decoded.entities.forEach((entity, index) => {
    const original = SNAPSHOT.entities[index];
    assert.deepEqual(Object.keys(entity).sort(), Object.keys(original).sort());
    for (const [key, value] of Object.entries(original)) {
      if (key === 'x' || key === 'y') {
        assert.equal(entity[key], quantizePosition(value), `${original.kind}.${key}`);
        assert.ok(Math.abs(entity[key] - value) <= 1 / 32);
      } else if (key === 'angle') {
        assert.equal(entity.angle, dequantizeAngle(quantizeAngle(value)));
      } else {
        assert.equal(entity[key], value, `${original.kind}.${key}`);
      }
    }
  });

  // Повторне кодування вже квантованого знімка нічого не змінює.
  assert.deepEqual(binary.decodeSnapshot(binary.encodeSnapshot(decoded)), decoded);
});

test('snapshot: без власного героя (глядач) і порожній', () => {
  const empty = { tick: 1, ack: 0, self: null, entities: [] };
  const bytes = binary.encodeSnapshot(empty);
  assert.equal(bytes.byteLength, 44);
  assert.deepEqual(binary.decodeSnapshot(bytes), empty);
});

test('кут: крок квантування і загортання', () => {
  const step = Math.PI / 32767;
  for (const angle of [0, 1, -1, 3.14159, -3.14159, 0.00004, 100, -100]) {
    const restored = dequantizeAngle(quantizeAngle(angle));
    const wrapped = Math.atan2(Math.sin(angle), Math.cos(angle));
    const error = Math.abs(Math.atan2(Math.sin(restored - wrapped), Math.cos(restored - wrapped)));
    assert.ok(error <= step / 2 + 1e-9, `${angle}: похибка ${error}`);
  }
  assert.ok(quantizeAngle(Math.PI - 1e-9) <= 32767);
  assert.ok(quantizeAngle(-Math.PI) >= -32768);
});

test('snapshot: обрізаний або чужий кадр — CodecError, а не сміття', () => {
  const bytes = binary.encodeSnapshot(SNAPSHOT);
  assert.throws(() => binary.decodeSnapshot(bytes.slice(0, 20)), CodecError);
  assert.throws(() => binary.decodeSnapshot(bytes.slice(0, bytes.length - 3)), CodecError);
  const wrongKind = new Uint8Array(bytes);
  wrongKind[44 + 4] = 200;
  assert.throws(() => binary.decodeSnapshot(wrongKind), CodecError);
});
