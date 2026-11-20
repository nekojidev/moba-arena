// Система зіткнень: отримує світ, видає пари (a, b), що перетинаються.
// Вона нічого не знає про шкоду чи рахунок — лише геометрія. Тому її можна замінити
// (наприклад, на просторовий хеш у Lab 7), передавши іншу функцію в `new World({ collide })`.

import { torusDelta, type Arena } from './arena.ts';
import type { Entity } from './entity.ts';
import type { AnyEntity, World } from './world.ts';

export type CollisionPair = readonly [AnyEntity, AnyEntity];
export type CollisionSystem = (world: World) => Iterable<CollisionPair>;

export function circlesOverlap(a: Entity, b: Entity, arena: Arena): boolean {
  const reach = a.radius + b.radius;
  const delta = torusDelta(a.pos, b.pos, arena);
  return delta.x * delta.x + delta.y * delta.y < reach * reach; // без кореня
}

// Наївний перебір усіх пар: O(n²). Для сотні сутностей цього досить.
export function* findCollisions(world: World): Generator<CollisionPair> {
  const bodies: AnyEntity[] = [];
  for (const entity of world) {
    if (entity.alive && entity.collidable) bodies.push(entity);
  }
  for (const [i, a] of bodies.entries()) {
    for (const b of bodies.slice(i + 1)) {
      if (circlesOverlap(a, b, world.arena)) yield [a, b];
    }
  }
}
