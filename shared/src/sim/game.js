// Збирає матч: світ, двоє героїв, големи й руни. Без DOM — працює і в браузері, і в Node.

import { World } from './world.js';
import { Ship } from './ship.js';
import { Asteroid } from './asteroid.js';
import { Pickup, PICKUP_EFFECTS } from './pickup.js';
import { Vector2 } from './vector.js';
import { ARENA } from './arena.js';
import { withHoming } from './behaviors.js';
import { botCommand } from './bot.js';

const TAU = Math.PI * 2;
const ASTEROID_INTERVAL = 3; // с
const PICKUP_INTERVAL = 7; // с
const HOMING_ASTEROID_CHANCE = 0.3;

function spawnAsteroid(world) {
  const speed = 30 + world.rng() * 50;
  const asteroid = new Asteroid({
    pos: world.findSafeSpot(44),
    vel: Vector2.fromAngle(world.rng() * TAU, speed),
    size: 3,
    spin: (world.rng() - 0.5) * 1.5,
  });
  // Та сама поведінка, що й у снаряда з руною самонаведення, — лише інші параметри.
  if (world.rng() < HOMING_ASTEROID_CHANCE) {
    withHoming(asteroid, { turnRate: 0.7, kinds: ['ship'], range: 520 });
  }
  return world.spawn(asteroid);
}

function spawnPickup(world) {
  const effect = PICKUP_EFFECTS[Math.floor(world.rng() * PICKUP_EFFECTS.length)];
  return world.spawn(new Pickup({ pos: world.findSafeSpot(18, 80), effect }));
}

// «Директор» матчу: тримає на арені потрібну кількість големів і рун.
// Спільний для локальної гри й сервера; випадковість — лише з генератора світу.
export function createDirector(world, { asteroids = 5, pickups = 2 } = {}) {
  for (let i = 0; i < asteroids; i += 1) spawnAsteroid(world);
  let asteroidTimer = ASTEROID_INTERVAL;
  let pickupTimer = PICKUP_INTERVAL / 2;

  return {
    tick(dt) {
      asteroidTimer -= dt;
      if (asteroidTimer <= 0) {
        asteroidTimer = ASTEROID_INTERVAL;
        if (world.count('asteroid') < asteroids) spawnAsteroid(world);
      }
      pickupTimer -= dt;
      if (pickupTimer <= 0) {
        pickupTimer = PICKUP_INTERVAL;
        if (world.count('pickup') < pickups) spawnPickup(world);
      }
    },
  };
}

// Конфіг матчу приходить ззовні (у Lab 3 — з кімнати лобі, далі — із сервера).
// `empty: true` — порожня арена з одним героєм у центрі (бенчмарк із Lab 1).
export function createGame({
  seed = 1,
  empty = false,
  arena = ARENA,
  asteroids = 5,
  pickups = 2,
  playerName = '',
} = {}) {
  const world = new World({ arena, seed });
  const inputs = new Map();

  if (empty) {
    const player = world.spawn(
      new Ship({
        pos: new Vector2(arena.width / 2, arena.height / 2),
        team: 'green',
        name: playerName,
      }),
    );
    return {
      world,
      player,
      bot: null,
      step(dt, playerCommand) {
        inputs.set(player.id, playerCommand);
        world.step(dt, inputs);
      },
    };
  }

  const player = world.spawn(
    new Ship({
      pos: new Vector2(110, arena.height - 110),
      angle: -Math.PI / 4,
      team: 'green',
      name: playerName,
    }),
  );
  const bot = world.spawn(
    new Ship({
      pos: new Vector2(arena.width - 110, 110),
      angle: (Math.PI * 3) / 4,
      team: 'red',
      name: 'Бот',
    }),
  );
  const director = createDirector(world, { asteroids, pickups });

  function step(dt, playerCommand) {
    inputs.set(player.id, playerCommand);
    inputs.set(bot.id, botCommand(bot, world));
    director.tick(dt);
    world.step(dt, inputs);
  }

  return { world, player, bot, step };
}
