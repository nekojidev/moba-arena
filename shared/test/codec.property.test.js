// Властивості кодеків (fast-check): round-trip, довжина кадру за специфікацією, сміття на вході.
import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { CODECS, CodecError } from '../src/codec/index.ts';
import { inputSchema, snapshotSchema } from '../src/protocol.ts';
import * as arb from './arbitraries.js';

const { binary, json } = CODECS;

const ANGLE_STEP = Math.PI / 32767; // один крок i16
const POSITION_STEP = 1 / 16;

// Різниця кутів по колу: π і −π — той самий кут.
function angleDistance(a, b) {
  const tau = 2 * Math.PI;
  const diff = (((a - b) % tau) + tau) % tau;
  return Math.min(diff, tau - diff);
}

function assertAngle(actual, original, label) {
  const error = angleDistance(actual, original);
  assert.ok(
    error <= ANGLE_STEP / 2 + 1e-9,
    `${label}: кут ${original} → ${actual}, похибка ${error}`,
  );
  assert.ok(actual >= -Math.PI - 1e-12 && actual <= Math.PI + 1e-12, `${label}: кут поза [−π, π]`);
}

// decode(encode(snapshot)) проти оригіналу — з допусками квантування з PROTOCOL.md.
function assertSnapshotClose(decoded, original) {
  assert.equal(decoded.tick, original.tick);
  assert.equal(decoded.ack, original.ack);

  if (original.self === null) {
    assert.equal(decoded.self, null);
  } else {
    assert.deepEqual(Object.keys(decoded.self).sort(), Object.keys(original.self).sort());
    for (const [key, value] of Object.entries(original.self)) {
      if (key === 'angle') assertAngle(decoded.self.angle, value, 'self');
      else if (typeof value === 'number' && key !== 'hp') {
        // f32: рівно найближче float32 до оригіналу, тобто відносна похибка ≤ 2⁻²⁴.
        assert.equal(decoded.self[key], Math.fround(value), `self.${key}`);
        assert.ok(Math.abs(decoded.self[key] - value) <= Math.abs(value) * 2 ** -24 + 1e-45);
      } else assert.equal(decoded.self[key], value, `self.${key}`);
    }
  }

  assert.equal(decoded.entities.length, original.entities.length);
  decoded.entities.forEach((entity, index) => {
    const source = original.entities[index];
    assert.deepEqual(Object.keys(entity).sort(), Object.keys(source).sort());
    for (const [key, value] of Object.entries(source)) {
      const label = `entities[${index}].${key}`;
      if (key === 'x' || key === 'y') {
        assert.ok(
          Math.abs(entity[key] - value) <= POSITION_STEP / 2,
          `${label}: ${value} → ${entity[key]}`,
        );
      } else if (key === 'angle') assertAngle(entity.angle, value, label);
      else assert.equal(entity[key], value, label);
    }
  });
}

// Довжина кадру, порахована незалежно від кодека — прямо з таблиць PROTOCOL.md.
const SPEC = { header: 10, self: 32, count: 2, common: 12 };
const SPEC_TAIL = { ship: 3, bullet: 4, asteroid: 1, pickup: 1 };
const specLength = (snapshot) =>
  SPEC.header +
  SPEC.self +
  SPEC.count +
  snapshot.entities.reduce((sum, entity) => sum + SPEC.common + SPEC_TAIL[entity.kind], 0);

// Декодер або повертає значення, або кидає CodecError — будь-який інший виняток «пролітає»
// крізь catch і валить властивість.
function decodeOrCodecError(decode, data) {
  try {
    return { value: decode(data) };
  } catch (error) {
    if (error instanceof CodecError) return { error };
    throw error;
  }
}

const frame = fc.oneof(
  arb.input.map((value) => binary.encodeInput(value)),
  arb.snapshot.map((value) => binary.encodeSnapshot(value)),
);

describe('властивість 1: round-trip', () => {
  test('input, бінарний кодек: decode(encode(x)) = x точно', () => {
    fc.assert(
      fc.property(arb.input, (input) => {
        assert.deepEqual(binary.decodeInput(binary.encodeInput(input)), input);
      }),
    );
  });

  test('input, JSON-кодек: decode(encode(x)) = x точно', () => {
    fc.assert(
      fc.property(arb.input, (input) => {
        assert.deepEqual(json.decodeInput(json.encodeInput(input)), input);
      }),
    );
  });

  test('snapshot, бінарний кодек: збіг у межах квантування', () => {
    fc.assert(
      fc.property(arb.snapshot, (snapshot) => {
        assertSnapshotClose(binary.decodeSnapshot(binary.encodeSnapshot(snapshot)), snapshot);
      }),
      { numRuns: 300 },
    );
  });

  // Знайдено цією ж властивістю в першій редакції (вимагала once = twice біт у біт):
  //   контрприклад після скорочення — одна сутність з angle: 3.14159.
  // round(3.14159 / π · 32767) = 32767 → декодується як +π; а +π при повторному кодуванні
  // зводиться до [−π, π) і стає −32767 → −π. Напрямок той самий, біти — інші.
  test('snapshot, бінарний кодек: повторне кодування змінює хіба що +π на −π, далі — нерухома точка', () => {
    const seam = (value) => (value === Math.PI ? -Math.PI : value);
    const normalize = (snapshot) => ({
      ...snapshot,
      self: snapshot.self && { ...snapshot.self, angle: seam(snapshot.self.angle) },
      entities: snapshot.entities.map((entity) => ({ ...entity, angle: seam(entity.angle) })),
    });
    fc.assert(
      fc.property(arb.snapshot, (snapshot) => {
        const once = binary.decodeSnapshot(binary.encodeSnapshot(snapshot));
        const twice = binary.decodeSnapshot(binary.encodeSnapshot(once));
        const thrice = binary.decodeSnapshot(binary.encodeSnapshot(twice));
        assert.deepEqual(twice, normalize(once));
        assert.deepEqual(thrice, twice);
      }),
      { numRuns: 300 },
    );
  });

  test('відома межа: кут на шві +π після повторного кодування стає −π (той самий напрямок)', () => {
    const entity = { id: 1, kind: 'pickup', x: 0, y: 0, angle: 3.14159, effect: 'shield' };
    const once = binary.decodeSnapshot(
      binary.encodeSnapshot({ tick: 0, ack: 0, self: null, entities: [entity] }),
    );
    const twice = binary.decodeSnapshot(binary.encodeSnapshot(once));
    assert.equal(once.entities[0].angle, Math.PI);
    assert.equal(twice.entities[0].angle, -Math.PI);
    assert.ok(angleDistance(once.entities[0].angle, twice.entities[0].angle) < 1e-12);
  });

  // Перша редакція вимагала точної рівності й упала на контрприкладі self.vy = −0:
  // JSON.stringify(−0) = "0", тож знак нуля в текстовому кодеку губиться (f32 його зберігає).
  test('snapshot, JSON-кодек: decode(encode(x)) = x точно (з точністю до знака нуля)', () => {
    const unsigned = (value) =>
      JSON.parse(JSON.stringify(value), (_key, item) => (Object.is(item, -0) ? 0 : item));
    fc.assert(
      fc.property(arb.snapshot, (snapshot) => {
        assert.deepEqual(json.decodeSnapshot(json.encodeSnapshot(snapshot)), unsigned(snapshot));
      }),
    );
  });

  test('відома межа: JSON-кодек губить знак нуля, бінарний — зберігає', () => {
    const self = {
      down: false,
      shield: false,
      rapid: false,
      homing: false,
      hp: 1,
      x: 0,
      y: 0,
      vx: 0,
      vy: -0,
      angle: 0,
      dashCooldown: 0,
      fireCooldown: 0,
      respawnTimer: 0,
    };
    const snapshot = { tick: 0, ack: 0, self, entities: [] };
    assert.ok(Object.is(json.decodeSnapshot(json.encodeSnapshot(snapshot)).self.vy, 0));
    assert.ok(Object.is(binary.decodeSnapshot(binary.encodeSnapshot(snapshot)).self.vy, -0));
  });

  test('обидва кодеки дають значення, яке проходить схему Zod', () => {
    fc.assert(
      fc.property(arb.snapshot, arb.input, (snapshot, input) => {
        assert.ok(
          snapshotSchema.safeParse(binary.decodeSnapshot(binary.encodeSnapshot(snapshot))).success,
        );
        assert.ok(inputSchema.safeParse(binary.decodeInput(binary.encodeInput(input))).success);
      }),
    );
  });
});

describe('властивість 2: довжина кадру = специфікація', () => {
  test('input — завжди 8 байтів', () => {
    fc.assert(
      fc.property(arb.input, (input) => {
        assert.equal(binary.encodeInput(input).byteLength, 8);
      }),
    );
  });

  test('snapshot — 10 + 32 + 2 + Σ(12 + хвіст виду)', () => {
    fc.assert(
      fc.property(arb.snapshot, (snapshot) => {
        const bytes = binary.encodeSnapshot(snapshot);
        assert.equal(bytes.byteLength, specLength(snapshot));
        assert.equal(bytes[0], 1, 'версія');
        assert.equal(bytes[1], 2, 'тип');
        // Лічильник сутностей — u16 little-endian одразу після блоку власного героя.
        assert.equal(bytes[42] | (bytes[43] << 8), snapshot.entities.length);
      }),
    );
  });

  test('snapshot без власного героя: 32 байти блоку — нулі', () => {
    fc.assert(
      fc.property(arb.snapshot, (snapshot) => {
        const bytes = binary.encodeSnapshot({ ...snapshot, self: null });
        assert.ok(bytes.subarray(10, 42).every((byte) => byte === 0));
      }),
    );
  });
});

describe('властивість 3: сміття на вході — значення або CodecError, нічого іншого', () => {
  const decoders = [binary.decodeInput, binary.decodeSnapshot];

  // Якщо декодер таки щось повернув — це має бути коректне значення, а не «напівсміття».
  function assertWellFormed(decode, result) {
    if (!('value' in result)) return;
    const schema = decode === binary.decodeInput ? inputSchema : snapshotSchema;
    const parsed = schema.safeParse(result.value);
    assert.ok(
      parsed.success,
      `декодер повернув значення поза схемою: ${JSON.stringify(result.value)}`,
    );
  }

  test('довільні байти', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        for (const decode of decoders) assertWellFormed(decode, decodeOrCodecError(decode, bytes));
      }),
      { numRuns: 1000 },
    );
  });

  test('довільні байти з правильним заголовком (версія і тип) — щоб пройти далі першої перевірки', () => {
    fc.assert(
      fc.property(fc.constantFrom(1, 2), fc.uint8Array({ maxLength: 300 }), (type, tail) => {
        const bytes = Uint8Array.of(1, type, ...tail);
        for (const decode of decoders) assertWellFormed(decode, decodeOrCodecError(decode, bytes));
      }),
      { numRuns: 1000 },
    );
  });

  test('справжній кадр, обрізаний у довільному місці', () => {
    fc.assert(
      fc.property(frame, fc.nat(), (bytes, cut) => {
        const truncated = bytes.slice(0, cut % (bytes.length + 1));
        for (const decode of decoders) {
          assertWellFormed(decode, decodeOrCodecError(decode, truncated));
        }
      }),
      { numRuns: 500 },
    );
  });

  test('обрізаний знімок ніколи не декодується «успішно»', () => {
    fc.assert(
      fc.property(arb.snapshot, fc.nat(), (snapshot, cut) => {
        const bytes = binary.encodeSnapshot(snapshot);
        const truncated = bytes.slice(0, cut % bytes.length); // строго коротший
        assert.ok('error' in decodeOrCodecError(binary.decodeSnapshot, truncated));
      }),
      { numRuns: 300 },
    );
  });

  test('справжній кадр із перевернутими бітами', () => {
    fc.assert(
      fc.property(frame, fc.array(fc.nat(), { minLength: 1, maxLength: 8 }), (bytes, flips) => {
        const damaged = new Uint8Array(bytes);
        for (const flip of flips) {
          const bit = flip % (damaged.length * 8);
          damaged[bit >> 3] ^= 1 << (bit & 7);
        }
        for (const decode of decoders)
          assertWellFormed(decode, decodeOrCodecError(decode, damaged));
      }),
      { numRuns: 1000 },
    );
  });

  test('справжній кадр із довільним «хвостом» після нього', () => {
    fc.assert(
      fc.property(frame, fc.uint8Array({ minLength: 1, maxLength: 40 }), (bytes, tail) => {
        const longer = Uint8Array.of(...bytes, ...tail);
        for (const decode of decoders) assertWellFormed(decode, decodeOrCodecError(decode, longer));
      }),
      { numRuns: 300 },
    );
  });

  test('не байти взагалі (будь-яке значення JS)', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        for (const decode of decoders) decodeOrCodecError(decode, value);
      }),
    );
  });

  test('JSON-кодек: довільний рядок, довільний JSON, зіпсований справжній текст', () => {
    const jsonDecoders = [json.decodeInput, json.decodeSnapshot];
    const text = fc.oneof(
      fc.string(),
      fc.json(),
      fc.tuple(arb.snapshot, fc.nat(), fc.string({ maxLength: 3 })).map(([snapshot, at, junk]) => {
        const encoded = json.encodeSnapshot(snapshot);
        const position = at % encoded.length;
        return encoded.slice(0, position) + junk + encoded.slice(position + 1);
      }),
    );
    fc.assert(
      fc.property(fc.oneof(text, fc.anything()), (value) => {
        for (const decode of jsonDecoders) decodeOrCodecError(decode, value);
      }),
      { numRuns: 500 },
    );
  });
});

describe('межі формату, які властивості обходять генератором (значення поза PROTOCOL.md)', () => {
  const at = (x) => ({ id: 1, kind: 'pickup', x, y: 0, angle: 0, effect: 'shield' });
  const roundTrip = (snapshot) => binary.decodeSnapshot(binary.encodeSnapshot(snapshot));
  const decodedX = (x) =>
    roundTrip({ tick: 0, ack: 0, self: null, entities: [at(x)] }).entities[0].x;

  test('позиція чужої сутності ≥ 4096 або від’ємна мовчки «загортається» в u16', () => {
    assert.equal(decodedX(4095.9375), 4095.9375, 'найбільше значення, що вміщається');
    assert.equal(decodedX(4096), 0);
    assert.equal(decodedX(5000), 904);
    assert.equal(decodedX(-1), 4095);
  });

  test('власний герой: число поза діапазоном f32 кодується, але свій же декодер його відхиляє', () => {
    const self = {
      down: false,
      shield: false,
      rapid: false,
      homing: false,
      hp: 1,
      x: 1e39,
      y: 0,
      vx: 0,
      vy: 0,
      angle: 0,
      dashCooldown: 0,
      fireCooldown: 0,
      respawnTimer: 0,
    };
    const snapshot = { tick: 0, ack: 0, self, entities: [] };
    assert.ok(snapshotSchema.safeParse(snapshot).success, 'за схемою Zod знімок коректний');
    assert.throws(() => roundTrip(snapshot), CodecError);
  });

  test('зайві байти після знімка ігноруються (для input зайвий байт — помилка)', () => {
    const snapshot = { tick: 5, ack: 1, self: null, entities: [at(10)] };
    const bytes = binary.encodeSnapshot(snapshot);
    const longer = Uint8Array.of(...bytes, 1, 2, 3);
    assert.deepEqual(binary.decodeSnapshot(longer), binary.decodeSnapshot(bytes));
    const input = binary.encodeInput({
      seq: 1,
      turn: 0,
      thrust: 0,
      brake: false,
      dash: false,
      fire: false,
    });
    assert.throws(() => binary.decodeInput(Uint8Array.of(...input, 0)), CodecError);
  });
});
