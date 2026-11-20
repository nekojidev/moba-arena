// Правила гри для пари, що зіткнулася: хто кого б'є, хто відскакує, кому очки.
// Диспетчеризація за парою `kind` — таблиця замість ланцюжка instanceof.

import { Vector2 } from './vector.js';
import { torusDelta, wrapVector } from './arena.js';
import { Asteroid } from './asteroid.js';
import { Explosion } from './explosion.js';

const TAU = Math.PI * 2;
const ORDER = ['bullet', 'ship', 'asteroid', 'pickup'];
const RAM_DAMAGE = 15;
const SCORE_SHIP = 100;
const SCORE_ASTEROID = 10; // × розмір

export function resolveCollision(a, b, world) {
  // Пара могла «застаріти»: снаряд уже влучив у когось іншого на цьому ж кроці.
  if (!a.alive || !b.alive || !a.collidable || !b.collidable) return;
  if (ORDER.indexOf(a.kind) > ORDER.indexOf(b.kind)) [a, b] = [b, a];
  HANDLERS[`${a.kind}:${b.kind}`]?.(a, b, world);
}

const HANDLERS = {
  'bullet:ship'(bullet, ship, world) {
    if (bullet.ownerId === ship.id) return;
    world.despawn(bullet.id);
    world.emit('hit', {
      targetKind: 'ship',
      targetId: ship.id,
      shielded: ship.hasEffect('shield'),
    });
    if (ship.takeDamage(bullet.damage)) destroyShip(ship, world, bullet.ownerId);
  },

  'bullet:asteroid'(bullet, asteroid, world) {
    world.despawn(bullet.id);
    world.emit('hit', { targetKind: 'asteroid', targetId: asteroid.id, shielded: false });
    if (asteroid.takeDamage(bullet.damage)) destroyAsteroid(asteroid, world, bullet.ownerId);
  },

  'ship:ship': bounce,
  'asteroid:asteroid': bounce,

  'ship:asteroid'(ship, asteroid, world) {
    const wasApproaching = bounce(ship, asteroid, world);
    if (wasApproaching) {
      world.emit('hit', {
        targetKind: 'ship',
        targetId: ship.id,
        shielded: ship.hasEffect('shield'),
      });
    }
    if (wasApproaching && ship.takeDamage(RAM_DAMAGE)) destroyShip(ship, world, null);
  },

  'ship:pickup'(ship, pickup, world) {
    ship.applyEffect(pickup.effect);
    world.emit('pickup', { shipId: ship.id, effect: pickup.effect });
    world.despawn(pickup.id);
  },
};

// Пружне зіткнення двох кіл: розсуваємо, щоб не перетинались, і обмінюємо імпульс
// уздовж нормалі. Маса пропорційна площі. Повертає true, якщо тіла зближувались.
function bounce(a, b, world) {
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

function destroyShip(ship, world, killerId) {
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

function destroyAsteroid(asteroid, world, killerId) {
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
    const direction = Vector2.fromAngle(world.rng() * TAU);
    for (const side of [1, -1]) {
      const push = direction.scale(side);
      world.spawn(
        new Asteroid({
          pos: wrapVector(asteroid.pos.add(push.scale(asteroid.radius / 2)), world.arena),
          vel: asteroid.vel.add(push.scale(70)),
          size: asteroid.size - 1,
          spin: (world.rng() - 0.5) * 2,
        }),
      );
    }
  }
}
