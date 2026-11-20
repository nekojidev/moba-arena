// Властивості симуляції (fast-check): арена, швидкість, детермінізм, математика.
import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { Bus } from '../src/bus.ts';
import { DT } from '../src/protocol.ts';
import { ARENA, shortestDelta, torusDelta, wrap } from '../src/sim/arena.ts';
import { atan2, cos, hypot, sin } from '../src/sim/dmath.ts';
import { createGame } from '../src/sim/game.ts';
import { hashWorld } from '../src/sim/hash.ts';
import { createRng } from '../src/sim/rng.ts';
import { DASH_COOLDOWN, FIRE_COOLDOWN, MAX_SPEED, integrate, stepInput } from '../src/sim/ship.ts';
import { Vector2 } from '../src/sim/vector.ts';
import * as arb from './arbitraries.js';

const EPSILON = 1e-9;
const finite = (min, max) => fc.double({ min, max, noNaN: true });

const arena = fc.oneof(
  fc.constant(ARENA),
  fc.record(
    {
      width: fc.integer({ min: 200, max: arb.MAX_ARENA }),
      height: fc.integer({ min: 200, max: arb.MAX_ARENA }),
    },
    { noNullPrototype: true },
  ),
);

// Початковий стан героя всередині арени одиничного розміру; множимо на розмір арени.
const startState = fc.record(
  {
    u: finite(0, 1).filter((value) => value < 1),
    w: finite(0, 1).filter((value) => value < 1),
    speed: finite(0, MAX_SPEED),
    heading: finite(-Math.PI, Math.PI),
    angle: finite(-Math.PI, Math.PI),
    dashCooldown: finite(0, DASH_COOLDOWN),
    fireCooldown: finite(0, FIRE_COOLDOWN),
    rapid: fc.boolean(),
  },
  { noNullPrototype: true },
);

const place = (start, { width, height }) => ({
  x: Math.min(start.u * width, width * (1 - 2 ** -52)),
  y: Math.min(start.w * height, height * (1 - 2 ** -52)),
  vx: Math.cos(start.heading) * start.speed,
  vy: Math.sin(start.heading) * start.speed,
  angle: start.angle,
  dashCooldown: start.dashCooldown,
  fireCooldown: start.fireCooldown,
  rapid: start.rapid,
});

function assertInside(state, { width, height }, step) {
  for (const key of ['x', 'y', 'vx', 'vy', 'angle', 'dashCooldown', 'fireCooldown']) {
    assert.ok(Number.isFinite(state[key]), `крок ${step}: ${key} = ${state[key]}`);
  }
  assert.ok(state.x >= 0 && state.x < width, `крок ${step}: x = ${state.x} поза [0, ${width})`);
  assert.ok(state.y >= 0 && state.y < height, `крок ${step}: y = ${state.y} поза [0, ${height})`);
  const speed = Math.hypot(state.vx, state.vy);
  assert.ok(speed <= MAX_SPEED + EPSILON, `крок ${step}: швидкість ${speed}`);
  assert.ok(state.angle >= -Math.PI && state.angle <= Math.PI, `крок ${step}: кут ${state.angle}`);
  assert.ok(state.dashCooldown >= 0 && state.dashCooldown <= DASH_COOLDOWN);
  assert.ok(state.fireCooldown >= 0 && state.fireCooldown <= FIRE_COOLDOWN);
}

describe('властивість 4: герой не покидає арену', () => {
  test('1000 випадкових input через stepInput: 0 ≤ x < width, 0 ≤ y < height, швидкість ≤ MAX_SPEED', () => {
    fc.assert(
      fc.property(
        arena,
        startState,
        fc.array(arb.command, { minLength: 1000, maxLength: 1000 }),
        (size, start, commands) => {
          let state = place(start, size);
          commands.forEach((command, step) => {
            state = stepInput(state, command, DT, size);
            assertInside(state, size, step);
          });
        },
      ),
      { numRuns: 50 },
    );
  });

  test('1000 кроків «найгіршої» команди з кожного кута арени (повна тяга + ривок)', () => {
    fc.assert(
      fc.property(
        arena,
        fc.constantFrom(0, 1),
        fc.constantFrom(0, 1),
        finite(-Math.PI, Math.PI),
        fc.constantFrom(-1, 0, 1),
        (size, cornerX, cornerY, angle, turn) => {
          // Найближче до краю число, що ще всередині арени.
          const edge = (corner, length) => (corner ? length * (1 - 2 ** -52) : 0);
          let state = {
            x: edge(cornerX, size.width),
            y: edge(cornerY, size.height),
            vx: 0,
            vy: 0,
            angle,
            dashCooldown: 0,
          };
          const command = { turn, thrust: 1, brake: false, dash: true, fire: false };
          for (let step = 0; step < 1000; step += 1) {
            state = integrate(state, command, DT, size);
            assertInside({ ...state, fireCooldown: 0 }, size, step);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  test('довільний крок часу (змінний dt локальної гри, до 0.25 с) арену теж не «пробиває»', () => {
    fc.assert(
      fc.property(
        startState,
        fc.array(fc.tuple(arb.command, finite(0, 0.25)), { minLength: 200, maxLength: 200 }),
        (start, steps) => {
          let state = place(start, ARENA);
          steps.forEach(([command, dt], step) => {
            state = stepInput(state, command, dt, ARENA);
            assertInside(state, ARENA, step);
          });
        },
      ),
      { numRuns: 50 },
    );
  });

  test('цілий матч: кожна сутність (герої, снаряди, големи, руни, вибухи) лишається в арені', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffffffff }),
        fc.array(arb.command, { minLength: 300, maxLength: 300 }),
        (seed, commands) => {
          const game = createGame({ seed });
          commands.forEach((command, step) => {
            game.step(DT, command);
            for (const entity of game.world) {
              const { x, y } = entity.pos;
              assert.ok(
                x >= 0 && x < ARENA.width && y >= 0 && y < ARENA.height,
                `крок ${step}: ${entity.kind} у (${x}, ${y})`,
              );
              assert.ok(Number.isFinite(entity.vel.x) && Number.isFinite(entity.vel.y));
              assert.ok(Number.isFinite(entity.angle));
            }
            for (const ship of game.world.ofKind('ship')) {
              assert.ok(ship.hp >= 0 && ship.hp <= 100);
            }
          });
        },
      ),
      { numRuns: 15 },
    );
  });
});

describe('детермінізм як властивість', () => {
  test('будь-який seed і будь-яка послідовність input: два прогони дають той самий хеш', () => {
    const play = (seed, commands) => {
      const game = createGame({ seed });
      for (const command of commands) game.step(DT, command);
      return hashWorld(game.world);
    };
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffffffff }),
        fc.array(arb.command, { minLength: 1, maxLength: 200 }),
        (seed, commands) => {
          assert.equal(play(seed, commands), play(seed, commands));
        },
      ),
      { numRuns: 25 },
    );
  });

  test('stepInput — чиста функція: той самий вхід → той самий вихід, вхід не змінено', () => {
    fc.assert(
      fc.property(startState, arb.command, (start, command) => {
        const state = Object.freeze(place(start, ARENA));
        const frozen = Object.freeze({ ...command });
        const copy = { ...state };
        assert.deepEqual(stepInput(state, frozen, DT, ARENA), stepInput(state, frozen, DT, ARENA));
        assert.deepEqual({ ...state }, copy);
      }),
    );
  });

  test('createRng: значення завжди в [0, 1), послідовність залежить лише від seed', () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const a = createRng(seed);
        const b = createRng(seed);
        for (let i = 0; i < 50; i += 1) {
          const value = a();
          assert.ok(value >= 0 && value < 1);
          assert.equal(b(), value);
        }
      }),
    );
  });
});

describe('геометрія тора', () => {
  const size = fc.integer({ min: 1, max: 5000 });
  const anywhere = finite(-1e7, 1e7);

  test('wrap: результат у [0, size) і відрізняється від аргументу на ціле число обертів', () => {
    fc.assert(
      fc.property(anywhere, size, (value, length) => {
        const wrapped = wrap(value, length);
        assert.ok(wrapped >= 0 && wrapped < length, `wrap(${value}, ${length}) = ${wrapped}`);
        const turns = (value - wrapped) / length;
        assert.ok(Math.abs(turns - Math.round(turns)) < 1e-6);
      }),
      { numRuns: 1000 },
    );
  });

  // Перша редакція вимагала wrap(wrap(x)) === wrap(x) і впала на контрприкладі (−5.55e-17, 1):
  // wrap дає 0.9999999999999999, а повторний wrap — 0, бо всередині рахується x + size,
  // і молодші біти x губляться. Тобто wrap зсуває навіть значення, що вже лежать у [0, size) —
  // щонайбільше на одну одиницю молодшого розряду числа 2·size (≈ 4.5e-13 для арени 1600).
  test('wrap майже ідемпотентний: повторний виклик зсуває щонайбільше на 1 ulp від 2·size', () => {
    fc.assert(
      fc.property(anywhere, size, (value, length) => {
        const once = wrap(value, length);
        const drift = Math.abs(wrap(once, length) - once);
        assert.ok(Math.min(drift, length - drift) <= length * 2 ** -51, `зсув ${drift}`);
      }),
      { numRuns: 1000 },
    );
  });

  test('відома межа: wrap змінює значення, яке вже всередині арени', () => {
    assert.equal(wrap(-5.551115123125784e-17, 1), 0.9999999999999999);
    assert.equal(wrap(0.9999999999999999, 1), 0, 'останнє число перед краєм «перестрибує» на 0');
    assert.notEqual(wrap(0.1, 1600), 0.1);
    assert.ok(Math.abs(wrap(0.1, 1600) - 0.1) < 1e-12);
    assert.equal(wrap(800, 1600), 800, 'значення, кратні кроку сітки, не змінюються');
  });

  test('shortestDelta: у [−size/2, size/2) і справді веде з from у to', () => {
    fc.assert(
      fc.property(size, finite(0, 1), finite(0, 1), (length, a, b) => {
        const from = Math.min(a, 1 - 2 ** -52) * length;
        const to = Math.min(b, 1 - 2 ** -52) * length;
        const delta = shortestDelta(from, to, length);
        assert.ok(delta >= -length / 2 && delta < length / 2, `delta = ${delta}`);
        const landed = wrap(from + delta, length);
        const miss = Math.abs(landed - to);
        assert.ok(Math.min(miss, length - miss) < 1e-6, `прийшли в ${landed}, а треба ${to}`);
      }),
      { numRuns: 500 },
    );
  });

  test('torusDelta антисиметричний (крім рівно половини арени) і не довший за пів діагоналі', () => {
    fc.assert(
      fc.property(
        arb.coordinate,
        arb.coordinate,
        arb.coordinate,
        arb.coordinate,
        (x1, y1, x2, y2) => {
          const a = { x: x1 % ARENA.width, y: y1 % ARENA.height };
          const b = { x: x2 % ARENA.width, y: y2 % ARENA.height };
          const forward = torusDelta(a, b, ARENA);
          const back = torusDelta(b, a, ARENA);
          assert.ok(forward.length() <= Math.hypot(ARENA.width, ARENA.height) / 2 + 1e-9);
          if (Math.abs(Math.abs(forward.x) - ARENA.width / 2) > 1e-6) {
            assert.ok(Math.abs(forward.x + back.x) < 1e-6);
          }
          if (Math.abs(Math.abs(forward.y) - ARENA.height / 2) > 1e-6) {
            assert.ok(Math.abs(forward.y + back.y) < 1e-6);
          }
        },
      ),
    );
  });
});

// Число, квадрат якого не зникає і не переповнюється.
const sane = fc
  .double({ min: -1e6, max: 1e6, noNaN: true })
  .filter((value) => value === 0 || Math.abs(value) >= 1e-100);

describe('dmath проти Math.*', () => {
  test('sin і cos: похибка < 1e-11 для кутів у межах ±100 рад', () => {
    fc.assert(
      fc.property(finite(-100, 100), (angle) => {
        assert.ok(Math.abs(sin(angle) - Math.sin(angle)) < 1e-11, `sin(${angle})`);
        assert.ok(Math.abs(cos(angle) - Math.cos(angle)) < 1e-11, `cos(${angle})`);
      }),
      { numRuns: 2000 },
    );
  });

  test('sin² + cos² = 1 з точністю 1e-11', () => {
    fc.assert(
      fc.property(finite(-100, 100), (angle) => {
        assert.ok(Math.abs(sin(angle) ** 2 + cos(angle) ** 2 - 1) < 1e-11);
      }),
    );
  });

  test('atan2: похибка < 1e-11 по колу для будь-якого ненульового вектора', () => {
    const component = fc.oneof(finite(-1e6, 1e6), fc.constantFrom(0, 1, -1));
    fc.assert(
      fc.property(component, component, (y, x) => {
        fc.pre(x !== 0 || y !== 0);
        const diff = Math.abs(atan2(y, x) - Math.atan2(y, x));
        assert.ok(Math.min(diff, Math.abs(diff - 2 * Math.PI)) < 1e-11, `atan2(${y}, ${x})`);
        assert.ok(Math.abs(atan2(y, x)) <= Math.PI + 1e-15);
      }),
      { numRuns: 2000 },
    );
  });

  // Перша редакція брала будь-які числа з ±1e6 і впала на контрприкладі (1e-300, 0):
  // √(x² + y²) рахує x² = 1e-600 → 0 (зникнення порядку), тоді як Math.hypot масштабує.
  // Тому властивість обмежено величинами, квадрат яких подається у float64.
  test('hypot: збігається з Math.hypot до відносної похибки 1e-15 (для |x|, |y| ≥ 1e-100 або 0)', () => {
    fc.assert(
      fc.property(sane, sane, (x, y) => {
        const expected = Math.hypot(x, y);
        assert.ok(Math.abs(hypot(x, y) - expected) <= expected * 1e-15);
      }),
    );
  });

  test('відома межа: hypot губить числа, менші за ≈1e-162, і переповнюється після ≈1e154', () => {
    assert.equal(hypot(1e-300, 0), 0);
    assert.equal(Math.hypot(1e-300, 0), 1e-300);
    assert.equal(hypot(1e200, 0), Infinity);
    // Наслідок для Vector2 (контрприклад властивості normalize): x² потрапляє в денормалізовані
    // числа, довжина виходить у √2 разів більшою за справжню, і «одиничний» вектор має довжину 0.71.
    const tiny = new Vector2(-1.5717277847026288e-162, 0);
    assert.ok(Math.abs(tiny.normalize().length() - Math.SQRT1_2) < 1e-9);
    // А ще менший ненульовий вектор має довжину рівно 0 і нормалізується в нуль.
    assert.equal(new Vector2(1e-300, 0).length(), 0);
    assert.equal(new Vector2(1e-300, 0).normalize(), Vector2.ZERO);
  });
});

describe('Vector2', () => {
  const vector = fc.tuple(sane, sane).map(([x, y]) => new Vector2(x, y));

  test('rotate зберігає довжину; поворот туди й назад повертає вектор', () => {
    fc.assert(
      fc.property(vector, finite(-10, 10), (v, angle) => {
        const turned = v.rotate(angle);
        assert.ok(Math.abs(turned.length() - v.length()) <= 1e-9 * (1 + v.length()));
        const back = turned.rotate(-angle);
        assert.ok(back.sub(v).length() <= 1e-8 * (1 + v.length()));
      }),
    );
  });

  test('normalize: довжина 1 (або нуль для нульового вектора), напрямок той самий', () => {
    fc.assert(
      fc.property(vector, (v) => {
        const unit = v.normalize();
        if (v.length() === 0) {
          assert.equal(unit.length(), 0);
          return;
        }
        assert.ok(Math.abs(unit.length() - 1) < 1e-12);
        assert.ok(Math.abs(unit.dot(v) - v.length()) <= 1e-9 * (1 + v.length()));
      }),
    );
  });

  test('add/sub взаємно обернені; операції не мутують операнди', () => {
    fc.assert(
      fc.property(vector, vector, (a, b) => {
        const before = [a.x, a.y, b.x, b.y];
        const sum = a.add(b).sub(b);
        assert.ok(sum.sub(a).length() <= 1e-9 * (1 + a.length() + b.length()));
        assert.equal(a.dot(b), b.dot(a));
        assert.deepEqual([a.x, a.y, b.x, b.y], before);
      }),
    );
  });
});

describe('Bus', () => {
  test('кожен підписаний слухач отримує кожну подію рівно один раз; відписані — жодного', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ type: fc.constantFrom('a', 'b', 'c'), keep: fc.boolean() }), {
          maxLength: 20,
        }),
        fc.array(fc.constantFrom('a', 'b', 'c', 'd'), { maxLength: 30 }),
        (listeners, emitted) => {
          const bus = new Bus();
          const received = listeners.map(() => []);
          listeners.forEach(({ type, keep }, index) => {
            const off = bus.on(type, (payload) => received[index].push(payload));
            if (!keep) off();
          });
          emitted.forEach((type, number) => bus.emit(type, number));
          listeners.forEach(({ type, keep }, index) => {
            const expected = keep
              ? emitted.flatMap((sent, number) => (sent === type ? [number] : []))
              : [];
            assert.deepEqual(received[index], expected);
          });
        },
      ),
    );
  });
});
