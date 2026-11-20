// World.step і createGame: детермінізм за ПОВНИМ станом, черга появи, директор матчу, бот.
import { describe, test } from 'vitest';
import assert from 'node:assert/strict';

import { ARENA, torusDelta } from '../src/sim/arena.ts';
import { Asteroid } from '../src/sim/asteroid.ts';
import { isHoming } from '../src/sim/behaviors.ts';
import { BENCH_COMMAND, BENCH_DURATION } from '../src/sim/bench.ts';
import { botCommand } from '../src/sim/bot.ts';
import { Bullet } from '../src/sim/bullet.ts';
import { Explosion } from '../src/sim/explosion.ts';
import { createDirector, createGame } from '../src/sim/game.ts';
import { hashWorld } from '../src/sim/hash.ts';
import { Pickup, PICKUP_TTL } from '../src/sim/pickup.ts';
import { createRng } from '../src/sim/rng.ts';
import { runSelftest, SELFTEST_DT, SELFTEST_HASH, SELFTEST_STEPS } from '../src/sim/selftest.ts';
import { MAX_SPEED, NO_COMMAND, RESPAWN_DELAY, SPAWN_SHIELD, Ship } from '../src/sim/ship.ts';
import { Vector2 } from '../src/sim/vector.ts';
import { World } from '../src/sim/world.ts';

const DT = 1 / 30;
const v = (x, y) => new Vector2(x, y);

// Повний стан світу як прості дані. id видає спільний лічильник процесу, тому в двох
// світах вони різні — замінюємо кожен id на порядковий номер першої появи.
export function dumpWorld(world) {
  const order = new Map();
  const local = (id) => {
    if (id === null || id === undefined) return null;
    if (!order.has(id)) order.set(id, order.size);
    return order.get(id);
  };
  const entities = [...world].map((entity) => {
    const base = {
      id: local(entity.id),
      kind: entity.kind,
      alive: entity.alive,
      owner: local(entity.ownerId),
      pos: [entity.pos.x, entity.pos.y],
      prevPos: [entity.prevPos.x, entity.prevPos.y],
      vel: [entity.vel.x, entity.vel.y],
      angle: entity.angle,
      prevAngle: entity.prevAngle,
      radius: entity.radius,
      homing: isHoming(entity),
    };
    switch (entity.kind) {
      case 'ship':
        return {
          ...base,
          hp: entity.hp,
          team: entity.team,
          thrust: entity.thrust,
          dashCooldown: entity.dashCooldown,
          fireCooldown: entity.fireCooldown,
          respawnTimer: entity.respawnTimer,
          effects: [...entity.effects],
        };
      case 'bullet':
        return { ...base, ttl: entity.ttl, team: entity.team };
      case 'asteroid':
        return { ...base, hp: entity.hp, size: entity.size, spin: entity.spin };
      case 'pickup':
        return { ...base, ttl: entity.ttl, effect: entity.effect };
      default:
        return { ...base, particles: entity.particles.map((particle) => ({ ...particle })) };
    }
  });
  return {
    tick: world.tick,
    time: world.time,
    entities,
    score: [...world.score].map(([id, points]) => [local(id), points]),
    nextRandom: createRngProbe(world),
  };
}

// Стан генератора напряму не видно; але findSafeSpot у порожньому місці бере з нього
// рівно два числа — тож наступна «безпечна точка» однозначно каже, де зараз генератор.
// Виклик зсуває генератор, тому dumpWorld — лише в кінці прогону.
function createRngProbe(world) {
  const spot = world.findSafeSpot(0, -1e9);
  return [spot.x, spot.y];
}

const scripted = (i) => ({
  turn: i % 50 < 20 ? 1 : i % 50 < 30 ? -1 : 0,
  thrust: i % 70 < 50 ? 1 : 0,
  brake: i % 190 > 170,
  dash: i % 150 === 0,
  fire: i % 4 === 0,
});

function playGame(seed, steps, commandAt = scripted) {
  const game = createGame({ seed });
  const events = [];
  for (const type of ['fired', 'hit', 'exploded', 'pickup', 'score', 'respawned']) {
    game.world.events.on(type, () => events.push(`${game.world.tick}:${type}`));
  }
  for (let i = 0; i < steps; i += 1) game.step(DT, commandAt(i));
  return { game, events, hash: hashWorld(game.world) };
}

describe('детермінізм World.step', () => {
  test('два матчі з одним seed і тими самими input — однаковий ПОВНИЙ стан', () => {
    const a = playGame(42, 900);
    const b = playGame(42, 900);
    assert.equal(a.hash, b.hash);
    assert.deepEqual(a.events, b.events, 'ті самі події на тих самих кроках');
    const dumpA = dumpWorld(a.game.world);
    const dumpB = dumpWorld(b.game.world);
    assert.deepEqual(dumpA, dumpB);
    // Запобіжник: матч справді «живий», а не два порожні світи.
    assert.equal(dumpA.tick, 900);
    assert.ok(dumpA.entities.length > 5);
    assert.ok(a.events.some((event) => event.endsWith(':hit')));
    assert.ok(new Set(dumpA.entities.map((entity) => entity.kind)).size >= 3);
  });

  test('стан збігається на КОЖНОМУ кроці, а не лише наприкінці', () => {
    const a = createGame({ seed: 5 });
    const b = createGame({ seed: 5 });
    for (let i = 0; i < 300; i += 1) {
      a.step(DT, scripted(i));
      b.step(DT, scripted(i));
      assert.equal(hashWorld(a.world), hashWorld(b.world), `крок ${i}`);
    }
    assert.deepEqual(dumpWorld(a.world), dumpWorld(b.world));
  });

  test('World.step напряму (без createGame): два однаково зібрані світи', () => {
    const build = () => {
      const world = new World({ arena: ARENA, seed: 99 });
      const one = world.spawn(new Ship({ pos: v(200, 200), angle: 0, team: 'green' }));
      const two = world.spawn(new Ship({ pos: v(600, 200), angle: Math.PI, team: 'red' }));
      const director = createDirector(world, { asteroids: 6, pickups: 3 });
      return { world, one, two, director };
    };
    const a = build();
    const b = build();
    for (let i = 0; i < 600; i += 1) {
      for (const { world, one, two, director } of [a, b]) {
        director.tick(DT);
        world.step(
          DT,
          new Map([
            [one.id, scripted(i)],
            // Мережевий гравець: 0, 1 або 2 команди за крок сервера.
            [two.id, Array.from({ length: i % 3 }, (_, k) => scripted(i * 7 + k))],
          ]),
        );
      }
    }
    assert.deepEqual(dumpWorld(a.world), dumpWorld(b.world));
    assert.equal(hashWorld(a.world), hashWorld(b.world));
  });

  test('інший seed → інший матч', () => {
    const a = playGame(1, 300);
    const b = playGame(2, 300);
    assert.notEqual(a.hash, b.hash);
    assert.notDeepEqual(dumpWorld(a.game.world), dumpWorld(b.game.world));
  });

  test('інший seed розходиться ще до першого кроку: големи стоять в інших місцях', () => {
    const rocks = (seed) =>
      [...createGame({ seed }).world.ofKind('asteroid')].map((rock) => [rock.pos.x, rock.pos.y]);
    assert.deepEqual(rocks(7), rocks(7));
    assert.notDeepEqual(rocks(7), rocks(8));
  });

  test('той самий seed, але один input відрізняється → стан розходиться', () => {
    const a = playGame(42, 300);
    const b = playGame(42, 300, (i) => (i === 10 ? { ...scripted(i), thrust: 0 } : scripted(i)));
    assert.notEqual(a.hash, b.hash);
  });

  test('хеш чутливий до одного біта позиції', () => {
    const { game } = playGame(3, 10);
    const before = hashWorld(game.world);
    game.player.pos = v(game.player.pos.x + 2 ** -40, game.player.pos.y);
    assert.notEqual(hashWorld(game.world), before);
  });

  test('хеш не враховує сутності, позначені мертвими', () => {
    const world = new World({ arena: ARENA });
    world.spawn(new Ship({ pos: v(100, 100) }));
    const before = hashWorld(world);
    const rock = world.spawn(new Asteroid({ pos: v(500, 500), vel: v(0, 0) }));
    assert.notEqual(hashWorld(world), before);
    world.despawn(rock.id);
    assert.equal(hashWorld(world), before);
    assert.match(before, /^[0-9a-f]{8}$/);
  });

  test('еталонний прогін: 600 кроків по 1/30 с, хеш закріплено', () => {
    const result = runSelftest();
    assert.equal(result.hash, SELFTEST_HASH);
    assert.equal(result.tick, SELFTEST_STEPS);
    assert.equal(SELFTEST_STEPS * SELFTEST_DT, 20);
    assert.ok(result.entities >= 2);
  });

  test('createRng: той самий seed — та сама послідовність у [0, 1)', () => {
    const a = createRng(123);
    const b = createRng(123);
    const c = createRng(124);
    const values = Array.from({ length: 1000 }, () => a());
    assert.deepEqual(
      values,
      Array.from({ length: 1000 }, () => b()),
    );
    assert.ok(values.every((value) => value >= 0 && value < 1));
    assert.notEqual(values[0], c());
    // Грубий запобіжник рівномірності: середнє близько 0.5.
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    assert.ok(Math.abs(mean - 0.5) < 0.05, `середнє ${mean}`);
  });
});

describe('World: кроки, черга появи, допоміжні методи', () => {
  test('step: час і номер кроку зростають; без input герой стоїть', () => {
    const world = new World({ arena: ARENA });
    const ship = world.spawn(new Ship({ pos: v(100, 100) }));
    world.step(0.5);
    world.step(0.25);
    assert.equal(world.tick, 2);
    assert.equal(world.time, 0.75);
    assert.deepEqual({ ...ship.pos }, { x: 100, y: 100 });
    assert.equal(ship.command, NO_COMMAND);
  });

  test('сутність, створена під час кроку, чекає в черзі і свій перший крок НЕ робить', () => {
    const world = new World({ arena: ARENA });
    const ship = world.spawn(new Ship({ pos: v(400, 400), angle: 0 }));
    const fire = { ...NO_COMMAND, fire: true };
    world.step(DT, new Map([[ship.id, fire]]));
    const [shot] = world.ofKind('bullet');
    assert.ok(shot, 'снаряд з’явився у світі наприкінці кроку');
    // Вилетів із «носа» (16 + 8 од від центру) і ще не зрушив.
    assert.ok(Math.abs(shot.pos.x - 424) < 1e-9);
    assert.equal(shot.prevPos, shot.pos);
    world.step(DT);
    assert.ok(Math.abs(shot.pos.x - (424 + 620 / 30)) < 1e-9, 'рух почався з наступного кроку');
  });

  test('масив команд: скільки input прийшло, стільки разів герой рухається; порожній — стоїть', () => {
    const thrust = { ...NO_COMMAND, thrust: 1 };
    const run = (commands) => {
      const world = new World({ arena: ARENA });
      const ship = world.spawn(new Ship({ pos: v(400, 400), angle: 0 }));
      ship.vel = v(30, 0);
      world.step(DT, new Map([[ship.id, commands]]));
      return ship;
    };
    const twice = run([thrust, thrust]);
    const single = new World({ arena: ARENA });
    const reference = single.spawn(new Ship({ pos: v(400, 400), angle: 0 }));
    reference.vel = v(30, 0);
    single.step(DT, new Map([[reference.id, thrust]]));
    single.step(DT, new Map([[reference.id, thrust]]));
    assert.deepEqual({ ...twice.pos }, { ...reference.pos });
    assert.deepEqual({ ...twice.vel }, { ...reference.vel });

    const idle = run([]);
    assert.deepEqual(
      { ...idle.pos },
      { x: 400, y: 400 },
      'без input — жодного руху, навіть за інерцією',
    );
  });

  test('despawn невідомого id — тиха відсутність дії', () => {
    const world = new World({ arena: ARENA });
    world.despawn(123456);
    assert.equal(world.size, 0);
    assert.equal(world.get(123456), undefined);
  });

  test('count і ofKind не бачать сутностей, позначених мертвими', () => {
    const world = new World({ arena: ARENA });
    const a = world.spawn(new Asteroid({ pos: v(100, 100), vel: v(0, 0) }));
    world.spawn(new Asteroid({ pos: v(900, 500), vel: v(0, 0) }));
    world.spawn(new Ship({ pos: v(500, 100) }));
    assert.equal(world.count('asteroid'), 2);
    world.despawn(a.id);
    assert.equal(world.count('asteroid'), 1);
    assert.equal(world.count('ship'), 1);
    assert.equal(world.count('bullet'), 0);
  });

  test('addScore накопичує і сповіщає подією score', () => {
    const world = new World({ arena: ARENA });
    const seen = [];
    world.events.on('score', (payload) => seen.push(payload));
    world.addScore(7, 10);
    world.addScore(7, 100);
    world.addScore(8, 1);
    assert.deepEqual(
      [...world.score],
      [
        [7, 110],
        [8, 1],
      ],
    );
    assert.deepEqual(seen.at(-2), { id: 7, points: 100, total: 110 });
  });

  test('findSafeSpot: точка в арені, далеко від усіх; мертвих і вибухи не враховує', () => {
    const world = new World({ arena: ARENA, seed: 11 });
    const rocks = [];
    for (let i = 0; i < 6; i += 1) {
      rocks.push(world.spawn(new Asteroid({ pos: v(150 + i * 250, 450), vel: v(0, 0) })));
    }
    world.spawn(new Explosion({ pos: v(800, 100), rng: world.rng }));
    for (let i = 0; i < 50; i += 1) {
      const spot = world.findSafeSpot(16, 140);
      assert.ok(spot.x >= 0 && spot.x < ARENA.width && spot.y >= 0 && spot.y < ARENA.height);
      for (const rock of rocks) {
        const distance = torusDelta(spot, rock.pos, ARENA).length();
        assert.ok(distance >= 16 + rock.radius + 140, `точка за ${distance} від голема`);
      }
    }
  });

  test('findSafeSpot: якщо місця немає — після 40 спроб повертає останню, а не зависає', () => {
    const world = new World({ arena: { width: 100, height: 100 }, seed: 1 });
    world.spawn(new Asteroid({ pos: v(50, 50), vel: v(0, 0) }));
    const reference = createRng(1);
    let last = null;
    for (let i = 0; i < 40; i += 1) last = [reference() * 100, reference() * 100];
    const spot = world.findSafeSpot(16, 1000);
    assert.deepEqual([spot.x, spot.y], last);
  });

  test('власна функція resolve отримує кожну знайдену пару', () => {
    const pairs = [];
    const world = new World({
      arena: ARENA,
      resolve: (a, b) => pairs.push([a.kind, b.kind]),
    });
    world.spawn(new Ship({ pos: v(400, 400) }));
    world.spawn(new Asteroid({ pos: v(410, 400), vel: v(0, 0) }));
    world.step(DT);
    assert.deepEqual(pairs, [['ship', 'asteroid']]);
  });
});

describe('сутності у світі', () => {
  test('герой: відродження рівно через 2 с, щит на 1.5 с, подія respawned', () => {
    const world = new World({ arena: ARENA, seed: 4 });
    const ship = world.spawn(new Ship({ pos: v(400, 400) }));
    const respawned = [];
    world.events.on('respawned', (payload) => respawned.push({ ...payload, tick: world.tick }));
    ship.takeDamage(100);
    ship.goDown();
    assert.equal(ship.fire(world), null, 'лежачий не стріляє');

    for (let i = 0; i < RESPAWN_DELAY * 30 - 1; i += 1) world.step(DT);
    assert.equal(ship.isDown, true);
    world.step(DT);
    assert.equal(ship.isDown, false, '60 кроків по 1/30 с = 2 с (із запасом 1e-9 на похибку суми)');
    assert.deepEqual(respawned, [{ shipId: ship.id, tick: 59 }]);
    assert.equal(ship.hp, 100);
    assert.equal(ship.prevPos, ship.pos, 'без інтерполяції «перельоту» з місця загибелі');

    let shielded = 0;
    while (ship.hasEffect('shield')) {
      world.step(DT);
      shielded += 1;
    }
    assert.ok(Math.abs(shielded * DT - SPAWN_SHIELD) <= DT, `щит тримався ${shielded} кроків`);
  });

  test('ефект руни спливає сам; швидкий вогонь скорочує перезарядку', () => {
    const world = new World({ arena: ARENA });
    const ship = world.spawn(new Ship({ pos: v(400, 400), angle: 0 }));
    ship.applyEffect({ type: 'rapid', duration: 1 });
    assert.equal(ship.motionState().rapid, true);
    ship.fire(world);
    assert.equal(ship.fireCooldown, 0.1);
    // dt = 0.5 точне у двійковому поданні: 1 − 0.5 − 0.5 = 0 без похибки округлення.
    world.step(0.5);
    assert.equal(ship.hasEffect('rapid'), true);
    world.step(0.5);
    assert.equal(ship.hasEffect('rapid'), false);
    assert.equal(ship.motionState().rapid, false);
  });

  test('руна самонаведення: снаряд героя позначений homing і повертає за ціллю', () => {
    const world = new World({ arena: ARENA });
    const ship = world.spawn(new Ship({ pos: v(400, 400), angle: 0 }));
    world.spawn(new Asteroid({ pos: v(700, 600), vel: v(0, 0), size: 3 }));
    const fired = [];
    world.events.on('fired', (payload) => fired.push(payload));
    const plain = ship.fire(world);
    ship.fireCooldown = 0;
    ship.applyEffect({ type: 'homing', duration: 8 });
    const seeker = ship.fire(world);
    assert.equal(isHoming(plain), false);
    assert.equal(isHoming(seeker), true);
    assert.deepEqual(
      fired.map((event) => event.homing),
      [false, true],
    );
    for (let i = 0; i < 6; i += 1) world.step(DT);
    assert.equal(plain.vel.y, 0);
    assert.ok(seeker.vel.y > 0, 'повернув униз, до голема');
    assert.ok(Math.abs(seeker.angle - seeker.vel.angle()) < 1e-12, 'ніс дивиться за швидкістю');
  });

  test('самонаведення: не цілиться у власника, у лежачого і за межі радіуса', () => {
    const world = new World({ arena: ARENA });
    const owner = world.spawn(new Ship({ pos: v(400, 500), angle: 0 }));
    const downed = world.spawn(new Ship({ pos: v(500, 300), team: 'red' }));
    downed.goDown();
    world.spawn(new Asteroid({ pos: v(1300, 850), vel: v(0, 0), size: 3 })); // далі за 600
    owner.applyEffect({ type: 'homing', duration: 8 });
    const seeker = owner.fire(world);
    world.step(DT);
    assert.equal(seeker.vel.y, 0, 'жодної придатної цілі — летить прямо');
  });

  test('снаряд на останньому кроці життя не рухається і зникає', () => {
    const world = new World({ arena: ARENA });
    const shot = world.spawn(
      new Bullet({ pos: v(100, 100), vel: v(300, 0), angle: 0, ownerId: 0, team: 'green' }),
    );
    shot.ttl = DT / 2;
    world.step(DT);
    assert.equal(shot.alive, false);
    assert.deepEqual({ ...shot.pos }, { x: 100, y: 100 });
    assert.equal(world.size, 0);
  });

  test('руна стоїть на місці й зникає сама через 14 с', () => {
    const world = new World({ arena: ARENA });
    const rune = world.spawn(
      new Pickup({ pos: v(100, 100), effect: { type: 'shield', duration: 5 } }),
    );
    for (let i = 0; i < PICKUP_TTL * 2 - 1; i += 1) world.step(0.5);
    assert.equal(rune.alive, true);
    assert.deepEqual({ ...rune.pos }, { x: 100, y: 100 });
    world.step(0.5);
    assert.equal(world.size, 0);
  });

  test('голем обертається зі швидкістю spin і дрейфує через край арени', () => {
    const world = new World({ arena: ARENA });
    const rock = world.spawn(new Asteroid({ pos: v(1590, 890), vel: v(40, 40), size: 2, spin: 2 }));
    world.step(0.5);
    assert.equal(rock.angle, 1);
    assert.deepEqual({ ...rock.pos }, { x: 10, y: 10 });
    assert.deepEqual({ ...rock.prevPos }, { x: 1590, y: 890 });
    assert.equal(rock.prevAngle, 0);
    assert.equal(rock.hp, 40);
    assert.equal(new Asteroid({ pos: v(0, 0), vel: v(0, 0) }).size, 3, 'розмір за замовчуванням');
  });

  test('вибух: частинки розлітаються від центру і всі гаснуть менш ніж за секунду', () => {
    const world = new World({ arena: ARENA });
    const boom = world.spawn(new Explosion({ pos: v(400, 400), rng: createRng(9) }));
    assert.equal(boom.particles.length, 24);
    assert.equal(boom.collidable, false);
    world.step(DT);
    assert.ok(boom.particles.every((particle) => Math.hypot(particle.x, particle.y) > 0));
    assert.ok(boom.particles.every((particle) => particle.life < particle.maxLife));
    let steps = 1;
    while (boom.alive && steps < 100) {
      world.step(DT);
      steps += 1;
    }
    assert.ok(steps * DT > 0.35 && steps * DT < 0.9, `вибух жив ${steps} кроків`);
    assert.equal(world.size, 0);
  });
});

describe('createGame і директор матчу', () => {
  test('звичайний матч: двоє героїв у протилежних кутах, 5 големів, жодної руни на старті', () => {
    const { world, player, bot } = createGame({ seed: 1, playerName: 'Оля' });
    assert.equal(player.name, 'Оля');
    assert.equal(player.team, 'green');
    assert.equal(bot.team, 'red');
    assert.deepEqual({ ...player.pos }, { x: 110, y: 790 });
    assert.deepEqual({ ...bot.pos }, { x: 1490, y: 110 });
    assert.equal(world.count('asteroid'), 5);
    assert.equal(world.count('pickup'), 0);
    assert.equal(world.arena, ARENA);
  });

  test('empty: true — один герой у центрі, без бота й големів (бенчмарк)', () => {
    const arena = { width: 400, height: 300 };
    const game = createGame({ empty: true, arena, playerName: 'Тест' });
    assert.equal(game.bot, null);
    assert.equal(game.world.size, 1);
    assert.deepEqual({ ...game.player.pos }, { x: 200, y: 150 });
    assert.equal(game.player.name, 'Тест');

    const steps = BENCH_DURATION * 60;
    for (let i = 0; i < steps; i += 1) game.step(1 / 60, BENCH_COMMAND);
    assert.equal(game.world.tick, steps);
    assert.equal(game.world.size, 1, 'нічого не з’явилось');
    const speed = game.player.vel.length();
    assert.ok(speed > 400 && speed <= MAX_SPEED + 1e-9, `швидкість ${speed}`);
    const { x, y } = game.player.pos;
    assert.ok(x >= 0 && x < arena.width && y >= 0 && y < arena.height);
  });

  test('кількість големів і рун задається конфігом', () => {
    const { world } = createGame({ seed: 3, asteroids: 9, pickups: 0 });
    assert.equal(world.count('asteroid'), 9);
    const none = createGame({ seed: 3, asteroids: 0 });
    assert.equal(none.world.count('asteroid'), 0);
  });

  test('директор: руна з’являється через 3.5 с, далі кожні 7 с, не більше ліміту', () => {
    const world = new World({ arena: ARENA, seed: 6 });
    const director = createDirector(world, { asteroids: 0, pickups: 2 });
    const tick = (seconds) => {
      for (let i = 0; i < seconds * 2; i += 1) director.tick(0.5);
    };
    tick(3);
    assert.equal(world.count('pickup'), 0);
    tick(0.5);
    assert.equal(world.count('pickup'), 1);
    tick(7);
    assert.equal(world.count('pickup'), 2);
    tick(14);
    assert.equal(world.count('pickup'), 2, 'ліміт');
    for (const rune of world.ofKind('pickup')) {
      assert.ok(['shield', 'rapid', 'homing'].includes(rune.effect.type));
    }
  });

  test('директор: зруйнованого голема замінює новий не частіше ніж раз на 3 с', () => {
    const world = new World({ arena: ARENA, seed: 6 });
    const director = createDirector(world, { asteroids: 3, pickups: 0 });
    assert.equal(world.count('asteroid'), 3);
    for (const rock of [...world.ofKind('asteroid')].slice(0, 2)) world.despawn(rock.id);
    world.step(0.5);
    assert.equal(world.count('asteroid'), 1);
    for (let i = 0; i < 6; i += 1) director.tick(0.5);
    assert.equal(world.count('asteroid'), 2);
    for (let i = 0; i < 6; i += 1) director.tick(0.5);
    assert.equal(world.count('asteroid'), 3);
    for (let i = 0; i < 12; i += 1) director.tick(0.5);
    assert.equal(world.count('asteroid'), 3, 'понад ліміт не додає');
  });

  test('директор без аргументів: 5 големів; частина з них самонавідні (seed фіксує які)', () => {
    const world = new World({ arena: ARENA, seed: 2026 });
    createDirector(world);
    assert.equal(world.count('asteroid'), 5);
    const flags = (seed) => {
      const w = new World({ arena: ARENA, seed });
      createDirector(w, { asteroids: 40 });
      return [...w.ofKind('asteroid')].map(isHoming);
    };
    assert.deepEqual(flags(1), flags(1));
    const share = flags(1).filter(Boolean).length / 40;
    assert.ok(share > 0.05 && share < 0.6, `самонавідних ${share * 100} % (очікувано ≈ 30 %)`);
  });
});

describe('бот', () => {
  const setup = () => {
    const world = new World({ arena: ARENA });
    const bot = world.spawn(new Ship({ pos: v(800, 450), angle: 0, team: 'red' }));
    return { world, bot };
  };

  test('без цілей і коли лежить — порожня команда', () => {
    const { world, bot } = setup();
    assert.equal(botCommand(bot, world), NO_COMMAND);
    world.spawn(new Ship({ pos: v(900, 450) }));
    bot.goDown();
    assert.equal(botCommand(bot, world), NO_COMMAND);
  });

  test('ціль прямо по курсу й близько: стріляє, гальмує, не розганяється', () => {
    const { world, bot } = setup();
    world.spawn(new Ship({ pos: v(900, 450) }));
    assert.deepEqual(botCommand(bot, world), {
      turn: 0,
      thrust: 0,
      brake: true,
      dash: false,
      fire: true,
    });
  });

  test('ціль далеко по курсу: розгін 0.7, без вогню', () => {
    const { world, bot } = setup();
    world.spawn(new Ship({ pos: v(1400, 450) }));
    const command = botCommand(bot, world);
    assert.deepEqual(command, { turn: 0, thrust: 0.7, brake: false, dash: false, fire: false });
  });

  test('ціль збоку: повертає в її бік (turn обмежено −1…1), не стріляє', () => {
    const { world, bot } = setup();
    const target = world.spawn(new Ship({ pos: v(800, 750) })); // унизу: кут +π/2
    assert.equal(botCommand(bot, world).turn, 1);
    assert.equal(botCommand(bot, world).fire, false);
    assert.equal(botCommand(bot, world).thrust, 0, 'спершу довернутись');
    target.pos = v(800, 150); // угорі
    assert.equal(botCommand(bot, world).turn, -1);
  });

  test('герой цікавіший за голема: вага 0.5 до відстані', () => {
    const { world, bot } = setup();
    world.spawn(new Asteroid({ pos: v(800, 250), vel: v(0, 0) })); // 200 од угорі
    const hero = world.spawn(new Ship({ pos: v(800, 750) })); // 300 од унизу → «150»
    assert.equal(botCommand(bot, world).turn, 1, 'обрав героя внизу');
    hero.goDown();
    assert.equal(botCommand(bot, world).turn, -1, 'герой лежить — лишився голем');
  });

  test('ціль через край арени: бот летить коротким шляхом', () => {
    const world = new World({ arena: ARENA });
    const bot = world.spawn(new Ship({ pos: v(1500, 450), angle: 0, team: 'red' }));
    world.spawn(new Ship({ pos: v(100, 450) })); // праворуч через край — 200 од
    const command = botCommand(bot, world);
    assert.equal(command.turn, 0);
    assert.equal(command.fire, true);
  });
});
