import { test } from 'vitest';
import assert from 'node:assert/strict';

import { Vector2 } from '../src/sim/vector.ts';
import { Entity } from '../src/sim/entity.ts';
import { World } from '../src/sim/world.ts';
import { Ship, MAX_HP, RESPAWN_DELAY } from '../src/sim/ship.ts';
import { Bullet, BULLET_TTL, BULLET_DAMAGE } from '../src/sim/bullet.ts';
import { Asteroid } from '../src/sim/asteroid.ts';
import { Pickup } from '../src/sim/pickup.ts';
import { Explosion } from '../src/sim/explosion.ts';
import { ARENA } from '../src/sim/arena.ts';
import { withHoming, isHoming } from '../src/sim/behaviors.ts';
import { findCollisions } from '../src/sim/collision.ts';
import { createGame } from '../src/sim/game.ts';

const STEP = 1 / 60;
const v = (x, y) => new Vector2(x, y);
const newWorld = (options) => new World({ arena: ARENA, ...options });
const fireCommand = { turn: 0, thrust: 0, brake: false, dash: false, fire: true };

test('Vector2: методи не мутують ні this, ні аргумент', () => {
  const a = v(3, 4);
  const b = v(1, 2);
  assert.deepEqual({ ...a.add(b) }, { x: 4, y: 6 });
  assert.deepEqual({ ...a.sub(b) }, { x: 2, y: 2 });
  assert.deepEqual({ ...a.scale(2) }, { x: 6, y: 8 });
  assert.equal(a.length(), 5);
  assert.equal(a.dot(b), 11);
  assert.ok(Math.abs(a.normalize().length() - 1) < 1e-12);
  const r = v(1, 0).rotate(Math.PI / 2);
  assert.ok(Math.abs(r.x) < 1e-12 && Math.abs(r.y - 1) < 1e-12);
  assert.ok(Math.abs(Vector2.fromAngle(Math.PI).x + 1) < 1e-12);
  assert.deepEqual({ ...a }, { x: 3, y: 4 });
  assert.deepEqual({ ...b }, { x: 1, y: 2 });
});

test('Entity: id унікальні й зростають; ієрархія в один рівень', () => {
  const a = new Entity({ kind: 'x', pos: v(0, 0) });
  const b = new Entity({ kind: 'x', pos: v(0, 0) });
  assert.equal(b.id, a.id + 1);
  for (const Class of [Ship, Bullet, Asteroid, Pickup, Explosion]) {
    assert.equal(Object.getPrototypeOf(Class.prototype), Entity.prototype);
  }
});

test('World: Map-сховище, ітерація, ofKind, відкладений despawn', () => {
  const world = newWorld();
  const ship = world.spawn(new Ship({ pos: v(100, 100) }));
  const rock = world.spawn(new Asteroid({ pos: v(800, 400), vel: v(0, 0) }));
  assert.equal(world.size, 2);
  assert.equal(world.get(ship.id), ship);
  assert.deepEqual([...world], [ship, rock]);
  assert.deepEqual([...world.ofKind('asteroid')], [rock]);

  world.despawn(rock.id);
  assert.equal(world.size, 2, 'до кінця кроку сутність ще в Map');
  assert.deepEqual([...world.ofKind('asteroid')], [], 'але ofKind її вже не бачить');
  world.step(STEP);
  assert.equal(world.size, 1);
  assert.equal(world.get(rock.id), undefined);
});

test('Ship.fire: снаряд із носа, успадковує швидкість, зникає за TTL', () => {
  const world = newWorld();
  const ship = world.spawn(new Ship({ pos: v(400, 400), angle: 0 }));
  ship.vel = v(50, 0);
  const bullet = ship.fire(world);
  assert.equal(bullet.ownerId, ship.id);
  assert.ok(bullet.pos.x > ship.pos.x + ship.radius);
  assert.ok(bullet.vel.x > 600);
  assert.equal(ship.fire(world), null, 'перезарядка');

  const steps = Math.ceil(BULLET_TTL / STEP) + 2;
  for (let i = 0; i < steps; i += 1) world.step(STEP);
  assert.equal(world.count('bullet'), 0);
});

test('this: відірваний метод ламається, обгортка і bind — ні', () => {
  const world = newWorld();
  const ship = world.spawn(new Ship({ pos: v(400, 400) }));
  const detached = ship.fire;
  assert.throws(() => detached(world), TypeError);
  assert.ok((() => ship.fire(world))());
  ship.fireCooldown = 0;
  assert.ok(ship.fire.bind(ship)(world));
});

test('Колізії та шкода: #hp приватне, снаряд ранить, герой гине й відроджується', () => {
  const world = newWorld();
  const shooter = world.spawn(new Ship({ pos: v(300, 400), angle: 0, team: 'green' }));
  const victim = world.spawn(new Ship({ pos: v(420, 400), angle: Math.PI, team: 'red' }));
  assert.equal(victim.hp, MAX_HP);
  assert.throws(() => {
    victim.hp = 1;
  }, TypeError);
  assert.equal(Object.keys(victim).includes('hp'), false);

  const inputs = new Map([[shooter.id, fireCommand]]);
  let steps = 0;
  while (!victim.isDown && steps < 600) {
    world.step(STEP, inputs);
    steps += 1;
  }
  assert.ok(victim.isDown, 'жертва мала загинути');
  assert.equal(world.score.get(shooter.id), 100);
  assert.equal(world.count('explosion'), 1);
  assert.equal(victim.hp, 0);

  const respawnSteps = Math.round(RESPAWN_DELAY / STEP) + 1;
  for (let i = 0; i < respawnSteps; i += 1) world.step(STEP);
  assert.equal(victim.isDown, false);
  assert.equal(victim.hp, MAX_HP);
  assert.ok(victim.hasEffect('shield'));
});

test('Снаряд руйнує голема: уламки, очки', () => {
  const world = newWorld();
  const ship = world.spawn(new Ship({ pos: v(300, 400), angle: 0 }));
  const rock = world.spawn(new Asteroid({ pos: v(420, 400), vel: v(0, 0), size: 2 }));
  assert.equal(rock.takeDamage(BULLET_DAMAGE), false);
  const inputs = new Map([[ship.id, fireCommand]]);
  for (let i = 0; i < 120 && rock.alive; i += 1) world.step(STEP, inputs);
  assert.equal(rock.alive, false);
  assert.equal(world.score.get(ship.id), 20);
  assert.equal([...world.ofKind('asteroid')].filter((a) => a.size === 1).length, 2);
});

test('Pickup: стоїть, колізиться, дає ефект і зникає', () => {
  const world = newWorld();
  const ship = world.spawn(new Ship({ pos: v(400, 400) }));
  const rune = world.spawn(
    new Pickup({ pos: v(410, 400), effect: { type: 'rapid', duration: 6 } }),
  );
  world.step(STEP);
  assert.ok(ship.hasEffect('rapid'));
  assert.equal(world.get(rune.id), undefined);
});

test('Композиція: одна поведінка homing працює і на снаряді, і на големі', () => {
  for (const make of [
    () => new Bullet({ pos: v(200, 400), vel: v(300, 0), angle: 0, ownerId: -1, team: 'green' }),
    () => new Asteroid({ pos: v(200, 400), vel: v(300, 0), size: 1 }),
  ]) {
    const world = newWorld();
    world.spawn(new Ship({ pos: v(400, 700) })); // ціль унизу-праворуч
    const plain = world.spawn(make());
    const seeker = world.spawn(withHoming(make(), { turnRate: 3, kinds: ['ship'] }));
    assert.equal(isHoming(plain), false);
    assert.equal(isHoming(seeker), true);
    for (let i = 0; i < 20; i += 1) world.step(STEP);
    assert.equal(plain.vel.y, 0, 'звичайна сутність летить прямо');
    assert.ok(seeker.vel.y > 50, 'самонавідна повертає до цілі');
    assert.ok(Math.abs(seeker.vel.length() - 300) < 1e-6, 'швидкість за модулем не змінюється');
  }
});

test('Система зіткнень замінна: World приймає іншу функцію collide', () => {
  let calls = 0;
  const world = newWorld({
    collide: function* counting(w) {
      calls += 1;
      yield* findCollisions(w);
    },
  });
  world.spawn(new Ship({ pos: v(400, 400) }));
  world.step(STEP);
  assert.equal(calls, 1);
});

test('Детермінізм: два матчі з однаковим seed збігаються до біта', () => {
  const snapshot = () => {
    const game = createGame({ seed: 7 });
    for (let i = 0; i < 1800; i += 1) {
      game.step(STEP, {
        turn: Math.sin(i / 40) > 0 ? 1 : -0.4,
        thrust: i % 90 < 60 ? 1 : 0,
        brake: false,
        dash: i % 200 === 0,
        fire: i % 3 === 0,
      });
    }
    return {
      player: [game.player.pos.x, game.player.pos.y, game.player.hp],
      bot: [game.bot.pos.x, game.bot.pos.y, game.bot.hp],
      kinds: [...game.world].map((e) => `${e.kind}@${e.pos.x},${e.pos.y}`),
      score: [game.world.score.get(game.player.id), game.world.score.get(game.bot.id)],
    };
  };
  assert.deepEqual(snapshot(), snapshot());
});
