// Правила гри для пари, що зіткнулася: хто кого б'є, хто відскакує, кому очки.

import type { EntityId } from '../brand.ts';
import { torusDelta, wrapVector } from './arena.ts';
import { Asteroid } from './asteroid.ts';
import type { Bullet } from './bullet.ts';
import type { Entity } from './entity.ts';
import { Explosion } from './explosion.ts';
import type { Pickup } from './pickup.ts';
import type { Ship } from './ship.ts';
import { Vector2 } from './vector.ts';
import type { AnyEntity, World } from './world.ts';

const TAU = Math.PI * 2;
const RAM_DAMAGE = 15;
const SCORE_SHIP = 100;
const SCORE_ASTEROID = 10; // × розмір

export type CollisionResolver = (a: AnyEntity, b: AnyEntity, world: World) => void;

// Порядок видів: пара завжди розглядається так, щоб «менший» вид ішов першим.
// Record<kind, number> змусить додати сюди рядок, якщо з'явиться новий вид сутності.
const ORDER: Record<AnyEntity['kind'], number> = {
  bullet: 0,
  ship: 1,
  asteroid: 2,
  pickup: 3,
  explosion: 4,
};

// Сюди потрапляє значення, якого за типами бути не може. Якщо додати новий вид сутності
// й не обробити його у switch — tsc покаже помилку саме на виклику цієї функції.
function unreachable(value: never): never {
  throw new Error(`Необроблений варіант: ${JSON.stringify(value)}`);
}

export function resolveCollision(first: AnyEntity, second: AnyEntity, world: World): void {
  // Пара могла «застаріти»: снаряд уже влучив у когось іншого на цьому ж кроці.
  if (!first.alive || !second.alive || !first.collidable || !second.collidable) return;
  const [a, b] = ORDER[first.kind] <= ORDER[second.kind] ? [first, second] : [second, first];

  switch (a.kind) {
    case 'bullet':
      if (b.kind === 'ship') bulletHitsShip(a, b, world);
      else if (b.kind === 'asteroid') bulletHitsAsteroid(a, b, world);
      return;
    case 'ship':
      if (b.kind === 'ship') bounce(a, b, world);
      else if (b.kind === 'asteroid') shipHitsAsteroid(a, b, world);
      else if (b.kind === 'pickup') shipTakesPickup(a, b, world);
      return;
    case 'asteroid':
      if (b.kind === 'asteroid') bounce(a, b, world);
      return;
    case 'pickup':
    case 'explosion':
      return; // руни між собою і вибухи ні з чим не взаємодіють
    default:
      unreachable(a);
  }
}

function bulletHitsShip(bullet: Bullet, ship: Ship, world: World): void {
  if (bullet.ownerId === ship.id) return;
  world.despawn(bullet.id);
  world.emit('hit', { targetKind: 'ship', targetId: ship.id, shielded: ship.hasEffect('shield') });
  if (ship.takeDamage(bullet.damage)) destroyShip(ship, world, bullet.ownerId);
}

function bulletHitsAsteroid(bullet: Bullet, asteroid: Asteroid, world: World): void {
  world.despawn(bullet.id);
  world.emit('hit', { targetKind: 'asteroid', targetId: asteroid.id, shielded: false });
  if (asteroid.takeDamage(bullet.damage)) destroyAsteroid(asteroid, world, bullet.ownerId);
}

function shipHitsAsteroid(ship: Ship, asteroid: Asteroid, world: World): void {
  const wasApproaching = bounce(ship, asteroid, world);
  if (wasApproaching) {
    world.emit('hit', {
      targetKind: 'ship',
      targetId: ship.id,
      shielded: ship.hasEffect('shield'),
    });
  }
  if (wasApproaching && ship.takeDamage(RAM_DAMAGE)) destroyShip(ship, world, null);
}

function shipTakesPickup(ship: Ship, pickup: Pickup, world: World): void {
  ship.applyEffect(pickup.effect);
  world.emit('pickup', { shipId: ship.id, effect: pickup.effect });
  world.despawn(pickup.id);
}

// Пружне зіткнення двох кіл: розсуваємо, щоб не перетинались, і обмінюємо імпульс
// уздовж нормалі. Маса пропорційна площі. Повертає true, якщо тіла зближувались.
function bounce(a: Entity, b: Entity, world: World): boolean {
  const delta = torusDelta(a.pos, b.pos, world.arena);
  const distance = delta.length();
  const normal = distance === 0 ? new Vector2(1, 0) : delta.scale(1 / distance);
  const overlap = a.radius + b.radius - distance;
  const massA = a.radius * a.radius;
  const massB = b.radius * b.radius;
  const total = massA + massB;

  a.pos = wrapVector(a.pos.sub(normal.scale((overlap * massB) / total)), world.arena);
  b.pos = wrapVector(b.pos.add(normal.scale((overlap * massA) / total)), world.arena);

  const closing = b.vel.sub(a.vel).dot(normal);
  if (closing >= 0) return false; // уже розлітаються

  const impulse = (-2 * closing) / (1 / massA + 1 / massB);
  a.vel = a.vel.sub(normal.scale(impulse / massA));
  b.vel = b.vel.add(normal.scale(impulse / massB));
  return true;
}

function destroyShip(ship: Ship, world: World, killerId: EntityId | null): void {
  if (world.cosmetics) {
    world.spawn(
      new Explosion({
        pos: ship.pos,
        rng: world.rng,
        count: 36,
        speed: 260,
        color: ship.team === 'green' ? '#7ef0c0' : '#ff8a7a',
      }),
    );
  }
  world.emit('exploded', { kind: 'ship', id: ship.id, killerId, x: ship.pos.x, y: ship.pos.y });
  ship.goDown(); // герой лишається у світі (його id потрібен вводу й рахунку), але «лежить» 2 с
  if (killerId !== null) world.addScore(killerId, SCORE_SHIP);
}

function destroyAsteroid(asteroid: Asteroid, world: World, killerId: EntityId): void {
  world.despawn(asteroid.id);
  world.emit('exploded', {
    kind: 'asteroid',
    id: asteroid.id,
    killerId,
    x: asteroid.pos.x,
    y: asteroid.pos.y,
    size: asteroid.size,
  });
  if (world.cosmetics) {
    world.spawn(new Explosion({ pos: asteroid.pos, rng: world.rng, count: 8 + asteroid.size * 6 }));
  }
  world.addScore(killerId, SCORE_ASTEROID * asteroid.size);

  if (asteroid.size > 1) {
    const smaller = asteroid.size === 3 ? 2 : 1;
    const direction = Vector2.fromAngle(world.rng() * TAU);
    for (const side of [1, -1]) {
      const push = direction.scale(side);
      world.spawn(
        new Asteroid({
          pos: wrapVector(asteroid.pos.add(push.scale(asteroid.radius / 2)), world.arena),
          vel: asteroid.vel.add(push.scale(70)),
          size: smaller,
          spin: (world.rng() - 0.5) * 2,
        }),
      );
    }
  }
}
