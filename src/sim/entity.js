import { Vector2 } from './vector.js';
import { wrapVector } from './arena.js';

// База для всього, що живе у світі. Ієрархія рівно в один рівень:
// Ship, Bullet, Asteroid, Pickup, Explosion extends Entity — і не глибше.
// Усе, що не вкладається в дерево (самонаведення тощо), живе в `behaviors`.

export class Entity {
  // Приватне статичне поле: лічильник належить класу, а не екземпляру,
  // і ззовні його не прочитати й не зіпсувати (Entity.#nextId поза класом — SyntaxError).
  static #nextId = 1;

  constructor({ kind, pos, vel = Vector2.ZERO, angle = 0, radius = 1 }) {
    this.id = Entity.#nextId++;
    this.kind = kind;
    this.pos = pos;
    this.vel = vel;
    this.angle = angle;
    this.radius = radius;
    this.alive = true;

    // Композиція: список функцій (entity, dt, world) => void. Поведінка — це дані.
    this.behaviors = [];

    // Стан на початок кроку — рендер інтерполює між ним і поточним.
    this.prevPos = pos;
    this.prevAngle = angle;
  }

  // Чи бере сутність участь у зіткненнях. Підкласи перевизначають.
  get collidable() {
    return true;
  }

  savePrevious() {
    this.prevPos = this.pos; // вектори незмінні, тому посилання достатньо
    this.prevAngle = this.angle;
  }

  runBehaviors(dt, world) {
    for (const behavior of this.behaviors) behavior(this, dt, world);
  }

  move(dt, arena) {
    this.pos = wrapVector(this.pos.add(this.vel.scale(dt)), arena);
  }

  update(dt, world) {
    this.runBehaviors(dt, world);
    this.move(dt, world.arena);
  }
}
