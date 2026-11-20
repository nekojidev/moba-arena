// Світ — менеджер сутностей поверх Map<id, Entity>.
//
// Чому Map, а не звичайний об'єкт:
//  • ключі-числа лишаються числами (в об'єкті вони стають рядками);
//  • гарантований порядок вставки → детермінований порядок оновлення;
//  • size, has, delete за O(1) і жодних сюрпризів із ключами на кшталт "constructor".

import { NO_COMMAND } from './ship.js';
import { Vector2 } from './vector.js';
import { torusDelta } from './arena.js';
import { createRng } from './rng.js';
import { findCollisions } from './collision.js';
import { resolveCollision } from './combat.js';

const NO_INPUTS = new Map();

export class World {
  #entities = new Map();
  #spawnQueue = [];
  #stepping = false;

  // cosmetics: false — не створювати сутності-прикраси (вибухи). Сервер їх не розсилає:
  // клієнт малює вибух сам, отримавши подію.
  constructor({
    arena,
    seed = 1,
    collide = findCollisions,
    resolve = resolveCollision,
    cosmetics = true,
  }) {
    this.arena = arena;
    this.cosmetics = cosmetics;
    this.rng = createRng(seed);
    this.collide = collide; // системи можна підмінити — це звичайні функції
    this.resolve = resolve;
    this.score = new Map(); // id героя → очки
    // Шина подій: симуляція лише повідомляє, ЩО сталося ("fired", "hit", "exploded", …).
    // Хто слухає — звук, HUD, мережа — вона не знає й не імпортує.
    // EventTarget і CustomEvent є і в браузері, і в Node, тож sim лишається без DOM.
    this.events = new EventTarget();
    this.time = 0;
    this.tick = 0;
  }

  get size() {
    return this.#entities.size;
  }

  // Під час кроку нові сутності чекають у черзі: інакше ітерація Map відвідала б їх
  // у тому ж проході, і снаряд зробив би «зайвий» крок у момент пострілу.
  spawn(entity) {
    if (this.#stepping) this.#spawnQueue.push(entity);
    else this.#entities.set(entity.id, entity);
    return entity;
  }

  // Відкладене видалення: лише позначка. З Map сутність прибере #sweep наприкінці кроку,
  // тож ніхто не втратить її посеред оновлення чи обробки зіткнень.
  despawn(id) {
    const entity = this.#entities.get(id);
    if (entity) entity.alive = false;
  }

  get(id) {
    return this.#entities.get(id);
  }

  // Світ ітерується: for (const e of world) { … }
  *[Symbol.iterator]() {
    yield* this.#entities.values();
  }

  // Генератор: лінива вибірка без проміжного масиву.
  *ofKind(kind) {
    for (const entity of this) {
      if (entity.alive && entity.kind === kind) yield entity;
    }
  }

  count(kind) {
    let total = 0;
    for (const entity of this.ofKind(kind)) total += 1; // eslint-disable-line no-unused-vars
    return total;
  }

  // dispatchEvent синхронний: слухачі відпрацюють ще до повернення з emit, у тому ж кроці.
  emit(type, detail) {
    this.events.dispatchEvent(new CustomEvent(type, { detail }));
  }

  addScore(id, points) {
    const total = (this.score.get(id) ?? 0) + points;
    this.score.set(id, total);
    this.emit('score', { id, points, total });
  }

  // Випадкова точка, поруч із якою нікого немає. Випадковість — із сіяного генератора світу.
  findSafeSpot(radius, margin = 140) {
    let spot = new Vector2(this.arena.width / 2, this.arena.height / 2);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      spot = new Vector2(this.rng() * this.arena.width, this.rng() * this.arena.height);
      let safe = true;
      for (const entity of this) {
        if (!entity.alive || !entity.collidable) continue;
        const distance = torusDelta(spot, entity.pos, this.arena).length();
        if (distance < radius + entity.radius + margin) {
          safe = false;
          break;
        }
      }
      if (safe) break;
    }
    return spot;
  }

  // Один крок симуляції: оновити всіх → знайти й розв'язати зіткнення → прибрати мертвих.
  // inputs: Map<id героя, команда>.
  step(dt, inputs = NO_INPUTS) {
    this.#stepping = true;

    for (const entity of this) {
      if (!entity.alive) continue;
      if (entity.kind === 'ship') entity.command = inputs.get(entity.id) ?? NO_COMMAND;
      entity.savePrevious();
      entity.update(dt, this);
    }
    this.#flushSpawns();

    for (const [a, b] of this.collide(this)) this.resolve(a, b, this);

    this.#flushSpawns();
    this.#sweep();
    this.#stepping = false;

    this.time += dt;
    this.tick += 1;
  }

  #flushSpawns() {
    for (const entity of this.#spawnQueue) this.#entities.set(entity.id, entity);
    this.#spawnQueue.length = 0;
  }

  #sweep() {
    for (const [id, entity] of this.#entities) {
      if (!entity.alive) this.#entities.delete(id);
    }
  }
}
