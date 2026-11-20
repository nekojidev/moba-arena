// Система зіткнень: отримує світ, видає пари (a, b), що перетинаються.
// Вона нічого не знає про шкоду чи рахунок — лише геометрія. Тому її можна замінити
// (наприклад, на просторовий хеш у Lab 7), передавши іншу функцію в `new World({ collide })`.

import { torusDelta } from './arena.js';

export function circlesOverlap(a, b, arena) {
  const reach = a.radius + b.radius;
  const delta = torusDelta(a.pos, b.pos, arena);
  return delta.x * delta.x + delta.y * delta.y < reach * reach; // без кореня
}

// Наївний перебір усіх пар: O(n²). Для сотні сутностей цього досить.
export function* findCollisions(world) {
  const bodies = [];
  for (const entity of world) {
    if (entity.alive && entity.collidable) bodies.push(entity);
  }
  for (let i = 0; i < bodies.length; i += 1) {
    for (let j = i + 1; j < bodies.length; j += 1) {
      if (circlesOverlap(bodies[i], bodies[j], world.arena)) yield [bodies[i], bodies[j]];
    }
  }
}
