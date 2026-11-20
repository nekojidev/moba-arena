// Наївний перебір пар проти просторового хеша.
//
//   npm run bench:collision -w server
//
// Два заміри:
//  1. Лише пошук пар на «застиглому» світі з рівно n тіл (герої, снаряди, големи, руни
//     в пропорції справжнього матчу, випадкові позиції на арені 1600×900).
//  2. Повний крок матчу (Match.tick без мережі) з P заскриптованими гравцями — те, що
//     сервер справді виконує 30 разів/с. Тут видно, яку ЧАСТКУ кроку займають зіткнення.

import { findCollisions } from '@moba-arena/shared/sim/collision.ts';
import { Asteroid } from '@moba-arena/shared/sim/asteroid.ts';
import { Bullet } from '@moba-arena/shared/sim/bullet.ts';
import { Pickup, PICKUP_EFFECTS } from '@moba-arena/shared/sim/pickup.ts';
import { createRng } from '@moba-arena/shared/sim/rng.ts';
import { Ship } from '@moba-arena/shared/sim/ship.ts';
import { findCollisionsHashed } from '@moba-arena/shared/sim/spatial-hash.ts';
import { Vector2 } from '@moba-arena/shared/sim/vector.ts';
import { World } from '@moba-arena/shared/sim/world.ts';
import { Match } from '../src/match.ts';
import { Room } from '../src/rooms.ts';
import { scriptedButtons } from './lib.js';

const ARENA = { width: 1600, height: 900 };
const SYSTEMS = { naive: findCollisions, hash: findCollisionsHashed };
const logger = { debug() {}, info() {}, warn() {}, error() {} };

// --- 1. лише пошук пар ---------------------------------------------------------------------

// Пропорції — як у матчі під навантаженням: на героя припадає 3–4 снаряди в польоті.
function staticWorld(n, seed) {
  const rng = createRng(seed);
  const world = new World({ arena: ARENA, seed });
  const spot = () => new Vector2(rng() * ARENA.width, rng() * ARENA.height);
  const ships = Math.max(2, Math.round(n * 0.2));
  const rocks = Math.max(2, Math.round(n * 0.06));
  const runes = n >= 20 ? 2 : 0;
  for (let i = 0; i < ships; i += 1) world.spawn(new Ship({ pos: spot() }));
  for (let i = 0; i < rocks; i += 1) {
    world.spawn(new Asteroid({ pos: spot(), vel: Vector2.ZERO, size: (i % 3) + 1 }));
  }
  for (let i = 0; i < runes; i += 1) {
    world.spawn(new Pickup({ pos: spot(), effect: PICKUP_EFFECTS[i % PICKUP_EFFECTS.length] }));
  }
  const [owner] = world;
  while (world.size < n) {
    world.spawn(
      new Bullet({ pos: spot(), vel: Vector2.ZERO, angle: 0, ownerId: owner.id, team: 'green' }),
    );
  }
  return world;
}

function countPairs(system, world) {
  let pairs = 0;
  for (const _pair of system(world)) pairs += 1;
  return pairs;
}

// Медіана з кількох серій; у кожній серії — стільки викликів, щоб вона тривала ≥ 150 мс.
function microseconds(run) {
  for (let i = 0; i < 200; i += 1) run(); // прогрів JIT
  const series = [];
  for (let s = 0; s < 7; s += 1) {
    let calls = 0;
    const started = performance.now();
    let elapsed = 0;
    while (elapsed < 150) {
      for (let i = 0; i < 20; i += 1) run();
      calls += 20;
      elapsed = performance.now() - started;
    }
    series.push((elapsed / calls) * 1000);
  }
  series.sort((a, b) => a - b);
  return series[3];
}

console.log('1. Пошук пар на застиглому світі (мкс на один виклик, медіана з 7 серій)\n');
console.log('  тіл |  пар | наївний, мкс | хеш, мкс | хеш швидший у');
console.log('------+------+--------------+----------+--------------');
for (const n of [20, 100, 300, 600]) {
  const world = staticWorld(n, 7);
  const pairs = countPairs(findCollisions, world);
  if (countPairs(findCollisionsHashed, world) !== pairs) throw new Error('системи розійшлися');
  const naive = microseconds(() => countPairs(findCollisions, world));
  const hash = microseconds(() => countPairs(findCollisionsHashed, world));
  console.log(
    `${String(n).padStart(5)} | ${String(pairs).padStart(4)} | ${naive.toFixed(1).padStart(12)} | ` +
      `${hash.toFixed(1).padStart(8)} | ${(naive / hash).toFixed(2).padStart(8)}×`,
  );
}

// --- 2. повний крок матчу ------------------------------------------------------------------

function runMatch(players, collide, { warmup = 300, ticks = 900 } = {}) {
  const room = new Room({
    id: 'bench',
    name: 'bench',
    arena: { ...ARENA, asteroids: 5, pickups: 2, seed: 1 },
    maxPlayers: 256,
  });
  const match = new Match({ room, logger, collide });
  for (let i = 0; i < players; i += 1) match.addPlayer({ id: `p${i}`, name: `Гравець ${i}` });

  // Час самих зіткнень усередині кроку: обгортаємо систему й міряємо її ітерацію.
  // (Сюди потрапляє і resolveCollision — він виконується між yield; для обох систем однаково.)
  let entities = 0;
  let total = 0;
  const durations = [];
  for (let step = 1; step <= warmup + ticks; step += 1) {
    for (let i = 0; i < players; i += 1) {
      match.pushInput(`p${i}`, { seq: step, ...scriptedButtons(step, i) });
    }
    const started = performance.now();
    match.tick();
    const elapsed = performance.now() - started;
    if (step > warmup) {
      total += elapsed;
      durations.push(elapsed);
      entities += match.world.size;
    }
  }
  durations.sort((a, b) => a - b);
  return {
    entities: entities / ticks,
    avg: total / ticks,
    p99: durations[Math.ceil(durations.length * 0.99) - 1],
  };
}

console.log('\n2. Повний крок матчу без мережі (Match.tick, 900 кроків після 300 прогрівних)\n');
console.log('гравців | сутностей | наївний: сер. / p99, мс | хеш: сер. / p99, мс | крок швидший у');
console.log('--------+-----------+-------------------------+---------------------+---------------');
for (const players of [4, 8, 20, 32, 64, 128, 192]) {
  const naive = runMatch(players, SYSTEMS.naive);
  const hash = runMatch(players, SYSTEMS.hash);
  const cell = (r) => `${r.avg.toFixed(3)} / ${r.p99.toFixed(3)}`;
  console.log(
    `${String(players).padStart(7)} | ${naive.entities.toFixed(0).padStart(9)} | ` +
      `${cell(naive).padStart(23)} | ${cell(hash).padStart(19)} | ${(naive.avg / hash.avg).toFixed(2).padStart(9)}×`,
  );
}
