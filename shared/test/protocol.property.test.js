// Властивість 5: parseClientMessage приймає кожне коректне повідомлення клієнта
// і відхиляє кожну його «мутацію» — завжди результатом { ok: false }, ніколи винятком.
import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { CLOSE, parseClientMessage, parseServerMessage } from '../src/protocol.ts';
import * as arb from './arbitraries.js';

const OPTIONAL = new Set(['codec']);
const KNOWN_FIELDS = new Set([
  ...['v', 'type', 'room', 'name', 'codec', 'text', 't'],
  ...['seq', 'turn', 'thrust', 'brake', 'dash', 'fire'],
]);

// Значення «не того типу» для поля: число ↔ рядок, булеве → число, а ще null, масив і об'єкт.
function wrongTypes(value) {
  const other =
    typeof value === 'number' ? String(value) : typeof value === 'string' ? 12345 : Number(value);
  return [other, null, [value], { value }];
}

// Значення правильного типу, але поза дозволеним діапазоном — за схемами з protocol.ts.
const OUT_OF_RANGE = {
  join: {
    room: ['', 'x'.repeat(65)],
    name: ['', 'a', '  a  ', '   ', 'x'.repeat(17), ` ${'x'.repeat(17)} `],
    codec: ['xml', '', 'BINARY'],
  },
  chat: { text: ['', ' \n\t ', 'x'.repeat(201)] },
  ping: { t: [NaN, Infinity, -Infinity] },
  leave: {},
  input: {
    seq: [-1, 2 ** 32, 1.5, NaN, Infinity],
    turn: [2, -2, 0.5, NaN],
    thrust: [2, -1, 0.5],
  },
};

// Усі мутації одного коректного повідомлення: { label, message, code? }.
function mutations(valid, { extraKey, extraValue, badVersion }) {
  const list = [];
  for (const key of Object.keys(valid)) {
    if (!OPTIONAL.has(key)) {
      const { [key]: _dropped, ...rest } = valid;
      const code =
        key === 'v' ? CLOSE.VERSION : key === 'type' ? CLOSE.UNKNOWN_TYPE : CLOSE.BAD_MESSAGE;
      list.push({ label: `без поля ${key}`, message: rest, code });
    }
    if (key === 'v') continue;
    for (const wrong of wrongTypes(valid[key])) {
      const code = key === 'type' ? CLOSE.UNKNOWN_TYPE : CLOSE.BAD_MESSAGE;
      list.push({
        label: `${key}: ${JSON.stringify(wrong)} замість ${typeof valid[key]}`,
        message: { ...valid, [key]: wrong },
        code,
      });
    }
  }
  list.push({
    label: `зайве поле ${JSON.stringify(extraKey)}`,
    message: { ...valid, [extraKey]: extraValue },
    code: CLOSE.BAD_MESSAGE,
  });
  list.push({
    label: `версія ${JSON.stringify(badVersion)}`,
    message: { ...valid, v: badVersion },
    code: CLOSE.VERSION,
  });
  for (const [key, values] of Object.entries(OUT_OF_RANGE[valid.type])) {
    for (const value of values) {
      list.push({
        label: `${key} поза діапазоном: ${JSON.stringify(value)}`,
        message: { ...valid, [key]: value },
        code: CLOSE.BAD_MESSAGE,
      });
    }
  }
  return list;
}

const mutationSeed = fc.record(
  {
    // Ключ, якого в жодному повідомленні немає. '__proto__' через { ...obj, [key]: … }
    // стає звичайним власним полем, тож його теж можна — але «codec» дозволений у join.
    extraKey: fc.string({ minLength: 1, maxLength: 12 }).filter((key) => !KNOWN_FIELDS.has(key)),
    extraValue: fc.jsonValue(),
    badVersion: fc.oneof(
      fc.integer().filter((value) => value !== 1),
      fc.constantFrom('1', 1.5, null, true, [1]),
    ),
  },
  { noNullPrototype: true },
);

function assertRejected(result, { label, code }) {
  assert.equal(result.ok, false, `${label}: мало бути відхилено`);
  assert.equal(result.code, code, `${label}: код закриття`);
  assert.equal(typeof result.reason, 'string');
  // Причина йде в кадр закриття WebSocket: не більше 123 байтів.
  assert.ok(new TextEncoder().encode(result.reason).length <= 123, `${label}: причина задовга`);
  assert.equal('message' in result, false);
}

describe('властивість 5: parseClientMessage', () => {
  test('кожне коректне повідомлення приймається; результат = вхід з обрізаними пробілами', () => {
    fc.assert(
      fc.property(arb.clientMessage, ({ raw, expected }) => {
        assert.deepEqual(parseClientMessage(raw), { ok: true, message: expected });
      }),
      { numRuns: 500 },
    );
  });

  test('те саме повідомлення рядком JSON (як воно приходить із сокета)', () => {
    fc.assert(
      fc.property(arb.clientMessage, ({ raw, expected }) => {
        // JSON не зберігає знак нуля (ping.t = −0), тож очікуване теж пропускаємо крізь JSON.
        assert.deepEqual(parseClientMessage(JSON.stringify(raw)), {
          ok: true,
          message: JSON.parse(JSON.stringify(expected)),
        });
      }),
      { numRuns: 500 },
    );
  });

  test('розбір не мутує вхідний об’єкт', () => {
    fc.assert(
      fc.property(arb.clientMessage, ({ raw }) => {
        const frozen = Object.freeze({ ...raw });
        const copy = { ...frozen };
        parseClientMessage(frozen);
        assert.deepEqual({ ...frozen }, copy);
      }),
    );
  });

  test('кожна мутація коректного повідомлення відхиляється з ok: false і без винятку', () => {
    fc.assert(
      fc.property(arb.clientMessage, mutationSeed, ({ raw }, seed) => {
        const all = mutations(raw, seed);
        assert.ok(all.length >= 5);
        for (const mutation of all) {
          assertRejected(parseClientMessage(mutation.message), mutation);
        }
      }),
      { numRuns: 300 },
    );
  });

  test('ті самі мутації рядком JSON теж відхиляються', () => {
    fc.assert(
      fc.property(arb.clientMessage, mutationSeed, ({ raw }, seed) => {
        for (const mutation of mutations(raw, seed)) {
          // NaN і Infinity в JSON стають null — повідомлення однаково некоректне.
          const result = parseClientMessage(JSON.stringify(mutation.message));
          assert.equal(result.ok, false, mutation.label);
        }
      }),
      { numRuns: 300 },
    );
  });

  test('обрізаний або зіпсований текст JSON: ok: false або (рідко) інше коректне повідомлення', () => {
    fc.assert(
      fc.property(arb.clientMessage, fc.nat(), fc.string({ maxLength: 2 }), ({ raw }, at, junk) => {
        const text = JSON.stringify(raw);
        const position = at % text.length;
        const damaged = text.slice(0, position) + junk + text.slice(position + 1);
        const result = parseClientMessage(damaged);
        assert.equal(typeof result.ok, 'boolean');
        if (result.ok) assert.deepEqual(parseClientMessage(result.message).ok, true);
        assert.equal(parseClientMessage(text.slice(0, position)).ok, false, 'обрізаний JSON');
      }),
      { numRuns: 500 },
    );
  });

  test('будь-яке значення JS: розбір ніколи не кидає і завжди дає { ok }', () => {
    fc.assert(
      fc.property(fc.anything({ withBigInt: true, withDate: true, withMap: true }), (value) => {
        for (const parse of [parseClientMessage, parseServerMessage]) {
          const result = parse(value);
          assert.equal(typeof result.ok, 'boolean');
          if (!result.ok) assert.ok(Object.values(CLOSE).includes(result.code));
        }
      }),
      { numRuns: 1000 },
    );
  });

  test('будь-який об’єкт із правильними v і type, але довільними рештою полів — без винятку', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('join', 'chat', 'ping', 'leave', 'input'),
        fc.dictionary(fc.constantFrom(...KNOWN_FIELDS, 'x'), fc.anything(), {
          noNullPrototype: true,
        }),
        (type, fields) => {
          const result = parseClientMessage({ ...fields, v: 1, type });
          assert.equal(typeof result.ok, 'boolean');
        },
      ),
      { numRuns: 1000 },
    );
  });
});
