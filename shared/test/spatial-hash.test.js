// Просторовий хеш має бути НЕВІДРІЗНЕННИМ від наївного перебору: ті самі пари в тому
// самому порядку. Від порядку залежить результат кроку, а отже й еталонний хеш.
import { describe, expect, test } from 'vitest';
import fc from 'fast-check';

import { Asteroid } from '../src/sim/asteroid.ts';
import { findCollisions } from '../src/sim/collision.ts';
import { createGame } from '../src/sim/game.ts';
import { hashWorld } from '../src/sim/hash.ts';
import { sin } from '../src/sim/dmath.ts';
import { runSelftest, SELFTEST_DT, SELFTEST_HASH, SELFTEST_STEPS } from '../src/sim/selftest.ts';
import { Ship } from '../src/sim/ship.ts';
import { createSpatialHash, findCollisionsHashed } from '../src/sim/spatial-hash.ts';
import { Vector2 } from '../src/sim/vector.ts';
import { World } from '../src/sim/world.ts';

// Тіло довільного радіуса: голем, якому радіус виставлено вручну.
function body(world, { x, y, radius }) {
  const rock = new Asteroid({ pos: new Vector2(x, y), vel: Vector2.ZERO });
  rock.radius = radius;
  return world.spawn(rock);
}

// Пари як номери тіл у порядку обходу світу — так списки з двох систем порівнюються напряму.
function pairs(system, world) {
  const order = new Map([...world].map((entity, index) => [entity, index]));
  return [...system(world)].map(([a, b]) => [order.get(a), order.get(b)]);
}

const arenaArb = fc.record({
  width: fc.integer({ min: 200, max: 3000 }),
  height: fc.integer({ min: 200, max: 2000 }),
});

// Координата відносно розміру арени: здебільшого всередині, але часто — на самому краї
// (тіло «стирчить» через загорнутий край) і зрідка поза ареною (torusDelta це дозволяє).
const coordArb = fc.oneof(
  { arbitrary: fc.double({ min: 0, max: 1, noNaN: true }), weight: 6 },
  { arbitrary: fc.constantFrom(0, 1, 0.5), weight: 1 },
  { arbitrary: fc.double({ min: 0, max: 0.01, noNaN: true }), weight: 2 },
  { arbitrary: fc.double({ min: 0.99, max: 1, noNaN: true }), weight: 2 },
  { arbitrary: fc.double({ min: -1, max: 2, noNaN: true }), weight: 1 },
);

const radiusArb = fc.oneof(
  { arbitrary: fc.constantFrom(5, 16, 18, 28, 44), weight: 6 }, // справжні радіуси з гри
  { arbitrary: fc.double({ min: 0, max: 120, noNaN: true }), weight: 3 },
  { arbitrary: fc.double({ min: 120, max: 4000, noNaN: true }), weight: 1 }, // більший за арену
);

const bodyArb = fc.record({ u: coordArb, v: coordArb, radius: radiusArb });

const worldArb = fc.record({
  arena: arenaArb,
  bodies: fc.array(bodyArb, { maxLength: 120 }),
  cellSize: fc.constantFrom(8, 32, 64, 100, 257, 5000),
});

function build({ arena, bodies }) {
  const world = new World({ arena });
  for (const { u, v, radius } of bodies) {
    body(world, { x: u * arena.width, y: v * arena.height, radius });
  }
  return world;
}

describe('просторовий хеш', () => {
  test('ті самі пари в тому самому порядку, що й наївний перебір (довільні світи)', () => {
    fc.assert(
      fc.property(worldArb, (spec) => {
        const world = build(spec);
        const hashed = createSpatialHash({ cellSize: spec.cellSize });
        expect(pairs(hashed, world)).toEqual(pairs(findCollisions, world));
      }),
      { numRuns: 500 },
    );
  });

  test('щільний світ: багато пар, усі збігаються', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            x: fc.double({ min: 0, max: 400, noNaN: true }),
            y: fc.double({ min: 0, max: 300, noNaN: true }),
            radius: fc.constantFrom(5, 16, 28, 44),
          }),
          { minLength: 30, maxLength: 150 },
        ),
        (bodies) => {
          const world = new World({ arena: { width: 400, height: 300 } });
          for (const spec of bodies) body(world, spec);
          const expected = pairs(findCollisions, world);
          expect(expected.length).toBeGreaterThan(0);
          expect(pairs(findCollisionsHashed, world)).toEqual(expected);
        },
      ),
      { numRuns: 100 },
    );
  });

  test('тіла по різні боки загорнутого краю стикаються', () => {
    const world = new World({ arena: { width: 1600, height: 900 } });
    const left = body(world, { x: 3, y: 450, radius: 16 });
    const right = body(world, { x: 1590, y: 450, radius: 16 });
    const top = body(world, { x: 800, y: 2, radius: 16 });
    const bottom = body(world, { x: 800, y: 895, radius: 16 });
    const corner = body(world, { x: 1598, y: 898, radius: 16 });
    const origin = body(world, { x: 1, y: 1, radius: 16 });
    body(world, { x: 400, y: 200, radius: 16 }); // далеко від усіх
    const found = [...findCollisionsHashed(world)];
    expect(found).toEqual([
      [left, right],
      [top, bottom],
      [corner, origin],
    ]);
    expect(found).toEqual([...findCollisions(world)]);
  });

  test('мертві й неколізійні сутності не беруть участі', () => {
    const world = new World({ arena: { width: 1600, height: 900 } });
    const a = body(world, { x: 100, y: 100, radius: 20 });
    const dead = body(world, { x: 110, y: 100, radius: 20 });
    const b = body(world, { x: 120, y: 100, radius: 20 });
    const down = world.spawn(new Ship({ pos: new Vector2(105, 100) }));
    down.goDown(); // «лежить» — collidable === false
    world.despawn(dead.id);
    expect([...findCollisionsHashed(world)]).toEqual([[a, b]]);
    expect([...findCollisionsHashed(new World({ arena: world.arena }))]).toEqual([]);
  });

  // Перевірка перетину лінива: розв'язання попередньої пари зсуває тіла, і наступні пари
  // рахуються вже за новими координатами. Два однакові світи, дві системи — після кожного
  // кроку відбиток стану має збігатися біт у біт.
  test('у справжній симуляції (з відскоками) світ лишається тим самим крок за кроком', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2 ** 31 - 1 }),
        fc.integer({ min: 20, max: 60 }),
        (seed, rocks) => {
          const worlds = [findCollisions, findCollisionsHashed].map((collide) => {
            const arena = { width: 500, height: 400 };
            const world = new World({ arena, seed, collide });
            // Тісно й швидко: голем на кожному кроці б'ється з кількома сусідами.
            for (let i = 0; i < rocks; i += 1) {
              const pos = new Vector2(world.rng() * arena.width, world.rng() * arena.height);
              const vel = new Vector2((world.rng() - 0.5) * 600, (world.rng() - 0.5) * 600);
              world.spawn(new Asteroid({ pos, vel, size: i % 3 === 0 ? 3 : i % 3 === 1 ? 2 : 1 }));
            }
            for (let i = 0; i < 6; i += 1) {
              const pos = new Vector2(world.rng() * arena.width, world.rng() * arena.height);
              world.spawn(new Ship({ pos, team: i % 2 === 0 ? 'green' : 'red' }));
            }
            return world;
          });
          const [naive, hashed] = worlds;
          for (let step = 0; step < 40; step += 1) {
            naive.step(1 / 30);
            hashed.step(1 / 30);
            expect(hashWorld(hashed)).toBe(hashWorld(naive));
          }
        },
      ),
      { numRuns: 40 },
    );
  });

  test('еталонний матч на просторовому хеші дає той самий закріплений відбиток', () => {
    // Сценарій runSelftest, але системою зіткнень керуємо самі. У TS поле collide — readonly;
    // тут, у тесті, підміняємо його на вже зібраному світі, бо createGame системи не приймає.
    const run = (collide) => {
      const game = createGame({ seed: 2026 });
      game.world.collide = collide;
      for (let i = 0; i < SELFTEST_STEPS; i += 1) {
        game.step(SELFTEST_DT, {
          turn: sin(i / 23) > 0.2 ? 1 : sin(i / 23) < -0.6 ? -1 : 0,
          thrust: i % 70 < 50 ? 1 : 0,
          brake: i % 190 > 170,
          dash: i % 150 === 0,
          fire: i % 4 === 0,
        });
      }
      return hashWorld(game.world);
    };
    expect(runSelftest().hash).toBe(SELFTEST_HASH);
    expect(run(findCollisions)).toBe(SELFTEST_HASH); // сценарій тут той самий, що в selftest.ts
    expect(run(findCollisionsHashed)).toBe(SELFTEST_HASH);
  });
});
