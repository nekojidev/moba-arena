// Генератори fast-check для Input, Snapshot і повідомлень клієнта.
// Межі взято з protocol.ts (схеми Zod) і PROTOCOL.md, а не з кодека, який перевіряється.
import fc from 'fast-check';

import { EFFECTS, PROTOCOL_VERSION } from '../src/protocol.ts';
import { DASH_COOLDOWN, FIRE_COOLDOWN, MAX_HP, MAX_SPEED, RESPAWN_DELAY } from '../src/sim/ship.ts';

export const U32_MAX = 0xffffffff;
// PROTOCOL.md: «Арена не ширша за 3000 одиниць» — на цьому тримається u16 для позицій.
export const MAX_ARENA = 3000;

export const u32 = fc.integer({ min: 0, max: U32_MAX });
// fast-check 4 за замовчуванням інколи дає об'єкти без прототипа (__proto__: null).
// Повідомлення протоколу — звичайні об'єкти, тож тут це вимкнено.
const record = (model) => fc.record(model, { noNullPrototype: true });
const finite = (min, max) => fc.double({ min, max, noNaN: true });
// Координата всередині арени: [0, MAX_ARENA).
export const coordinate = finite(0, MAX_ARENA).filter((value) => value < MAX_ARENA);
// Кут: і вже зведений, і «накручений» на кілька обертів, і рівно на шві ±π.
export const angle = fc.oneof(
  finite(-Math.PI, Math.PI),
  finite(-50, 50),
  fc.constantFrom(0, Math.PI, -Math.PI, Math.PI / 2, 3.14159, -3.14159),
);

// --- Input -----------------------------------------------------------------------------------

export const input = record({
  seq: u32,
  turn: fc.constantFrom(-1, 0, 1),
  thrust: fc.constantFrom(0, 1),
  brake: fc.boolean(),
  dash: fc.boolean(),
  fire: fc.boolean(),
});

// --- Snapshot --------------------------------------------------------------------------------

const hp = fc.integer({ min: 0, max: MAX_HP });

export const selfState = record({
  down: fc.boolean(),
  shield: fc.boolean(),
  rapid: fc.boolean(),
  homing: fc.boolean(),
  hp,
  x: coordinate,
  y: coordinate,
  // Запас ×2: після зіткнення швидкість на мить буває вищою за MAX_SPEED.
  vx: finite(-2 * MAX_SPEED, 2 * MAX_SPEED),
  vy: finite(-2 * MAX_SPEED, 2 * MAX_SPEED),
  angle,
  dashCooldown: finite(0, DASH_COOLDOWN),
  fireCooldown: finite(0, FIRE_COOLDOWN),
  respawnTimer: finite(0, RESPAWN_DELAY),
});

const placed = { id: u32, x: coordinate, y: coordinate, angle };

export const shipEntity = record({
  kind: fc.constant('ship'),
  ...placed,
  hp,
  score: fc.integer({ min: 0, max: 65535 }),
  down: fc.boolean(),
  shield: fc.boolean(),
  thrust: fc.boolean(),
});
export const bulletEntity = record({
  kind: fc.constant('bullet'),
  ...placed,
  owner: u32,
  homing: fc.boolean(),
});
export const asteroidEntity = record({
  kind: fc.constant('asteroid'),
  ...placed,
  size: fc.constantFrom(1, 2, 3),
  homing: fc.boolean(),
});
export const pickupEntity = record({
  kind: fc.constant('pickup'),
  ...placed,
  effect: fc.constantFrom(...EFFECTS),
});
export const snapshotEntity = fc.oneof(shipEntity, bulletEntity, asteroidEntity, pickupEntity);

export const snapshot = record({
  tick: u32,
  ack: u32,
  self: fc.option(selfState, { nil: null }),
  entities: fc.array(snapshotEntity, { maxLength: 40 }),
});

// --- команда героя (ширша за мережевий Input: бот дає дробові turn і thrust) ------------------

export const command = record({
  turn: fc.oneof(fc.constantFrom(-1, 0, 1), finite(-1, 1)),
  thrust: fc.oneof(fc.constantFrom(0, 1), finite(0, 1)),
  brake: fc.boolean(),
  dash: fc.boolean(),
  fire: fc.boolean(),
});

// --- повідомлення клієнта ---------------------------------------------------------------------

const anyChar = fc.oneof(
  fc.string({ unit: 'grapheme', minLength: 1, maxLength: 1 }),
  fc.string({ minLength: 1, maxLength: 1 }),
);
// Рядок без пробільних символів на краях. Довжину Zod 4 рахує в КОДОВИХ ТОЧКАХ Unicode,
// а не в одиницях UTF-16 (text.length): один емодзі — це 1, хоча '😀'.length === 2.
// Перша редакція генератора рахувала через .length, і властивість 5 упала на імені '𐀀'
// (length 2, але одна кодова точка → коротше за мінімум 2).
export const codePoints = (text) => [...text].length;
const trimmed = (min, max) =>
  fc
    .array(anyChar, { minLength: 1, maxLength: max })
    .map((chars) => chars.join(''))
    .filter((text) => text.trim() === text && codePoints(text) >= min && codePoints(text) <= max);
const padding = fc
  .array(fc.constantFrom(' ', '\t', '\n', ' '), { maxLength: 4 })
  .map((chars) => chars.join(''));
// { raw, clean }: raw — як надіслав клієнт (із пробілами по краях), clean — після trim.
const padded = (min, max) =>
  fc.tuple(padding, trimmed(min, max), padding).map(([left, clean, right]) => ({
    raw: left + clean + right,
    clean,
  }));

const v = PROTOCOL_VERSION;

// Кожен генератор дає { raw, expected }: що надіслано і що має повернути розбір.
export const clientMessage = fc.oneof(
  record({
    room: fc
      .string({ unit: 'grapheme', minLength: 1, maxLength: 64 })
      .filter((text) => codePoints(text) <= 64),
    name: padded(2, 16),
    codec: fc.constantFrom(undefined, 'binary', 'json'),
  }).map(({ room, name, codec }) => {
    const extra = codec === undefined ? {} : { codec };
    return {
      raw: { v, type: 'join', room, name: name.raw, ...extra },
      expected: { v, type: 'join', room, name: name.clean, ...extra },
    };
  }),
  padded(1, 200).map((text) => ({
    raw: { v, type: 'chat', text: text.raw },
    expected: { v, type: 'chat', text: text.clean },
  })),
  fc.double({ noNaN: true, noDefaultInfinity: true }).map((t) => {
    const message = { v, type: 'ping', t };
    return { raw: message, expected: message };
  }),
  fc.constant({ raw: { v, type: 'leave' }, expected: { v, type: 'leave' } }),
  input.map((fields) => {
    const message = { v, type: 'input', ...fields };
    return { raw: message, expected: message };
  }),
);
