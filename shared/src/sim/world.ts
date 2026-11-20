// Світ — менеджер сутностей поверх Map<id, Entity>.
//
// Чому Map, а не звичайний об'єкт:
//  • ключі-числа лишаються числами (в об'єкті вони стають рядками);
//  • гарантований порядок вставки → детермінований порядок оновлення;
//  • size, has, delete за O(1) і жодних сюрпризів із ключами на кшталт "constructor".

import type { EntityId } from '../brand.ts';
import { Bus } from '../bus.ts';
import { torusDelta, type Arena } from './arena.ts';
import type { Asteroid } from './asteroid.ts';
import type { Bullet } from './bullet.ts';
import { findCollisions, type CollisionSystem } from './collision.ts';
import { resolveCollision, type CollisionResolver } from './combat.ts';
import type { GameEvents } from './events.ts';
import type { Explosion } from './explosion.ts';
import type { Pickup } from './pickup.ts';
import { createRng, type Rng } from './rng.ts';
import { NO_COMMAND, type Command, type Ship } from './ship.ts';
import { Vector2 } from './vector.ts';

// Об'єднання всіх класів сутностей. У кожного поле kind — свій рядок-літерал, тож
// перевірка `entity.kind === 'ship'` звужує тип до Ship без жодних приведень.
export type AnyEntity = Ship | Bullet | Asteroid | Pickup | Explosion;

// «Сутність виду K»: Extract вибирає з об'єднання ті варіанти, де kind збігається з K.
// EntityOfKind<'ship'> — це Ship, EntityOfKind<'ship' | 'asteroid'> — Ship | Asteroid.
export type EntityOfKind<K extends AnyEntity['kind']> = Extract<AnyEntity, { readonly kind: K }>;

export type Inputs = ReadonlyMap<EntityId, Command | readonly Command[]>;

export interface WorldOptions {
  readonly arena: Arena;
  readonly seed?: number;
  readonly collide?: CollisionSystem;
  readonly resolve?: CollisionResolver;
  readonly cosmetics?: boolean;
}

const NO_INPUTS: Inputs = new Map();

function isOfKind<K extends AnyEntity['kind']>(
  entity: AnyEntity,
  kind: K,
): entity is EntityOfKind<K> {
  return entity.kind === kind;
}

export class World {
  #entities = new Map<EntityId, AnyEntity>();
  #spawnQueue: AnyEntity[] = [];
  #stepping = false;

  readonly arena: Arena;
  readonly rng: Rng;
  readonly collide: CollisionSystem; // системи можна підмінити — це звичайні функції
  readonly resolve: CollisionResolver;
  // cosmetics: false — не створювати сутності-прикраси (вибухи). Сервер їх не розсилає:
  // клієнт малює вибух сам, отримавши подію.
  readonly cosmetics: boolean;
  readonly score = new Map<EntityId, number>(); // id героя → очки
  // Шина подій: симуляція лише повідомляє, ЩО сталося ("fired", "hit", "exploded", …).
  // Хто слухає — звук, HUD, мережа — вона не знає й не імпортує.
  readonly events = new Bus<GameEvents>();
  time = 0;
  tick = 0;

  constructor({
    arena,
    seed = 1,
    collide = findCollisions,
    resolve = resolveCollision,
    cosmetics = true,
  }: WorldOptions) {
    this.arena = arena;
    this.cosmetics = cosmetics;
    this.rng = createRng(seed);
    this.collide = collide;
    this.resolve = resolve;
  }

  get size(): number {
    return this.#entities.size;
  }

  // Під час кроку нові сутності чекають у черзі: інакше ітерація Map відвідала б їх
  // у тому ж проході, і снаряд зробив би «зайвий» крок у момент пострілу.
  // Дженерик T: що передали, те й повернули — spawn(new Ship(…)) має тип Ship.
  spawn<T extends AnyEntity>(entity: T): T {
    if (this.#stepping) this.#spawnQueue.push(entity);
    else this.#entities.set(entity.id, entity);
    return entity;
  }

  // Відкладене видалення: лише позначка. З Map сутність прибере #sweep наприкінці кроку,
  // тож ніхто не втратить її посеред оновлення чи обробки зіткнень.
  despawn(id: EntityId): void {
    const entity = this.#entities.get(id);
    if (entity) entity.alive = false;
  }

  get(id: EntityId): AnyEntity | undefined {
    return this.#entities.get(id);
  }

  // Світ ітерується: for (const e of world) { … }
  *[Symbol.iterator](): Generator<AnyEntity> {
    yield* this.#entities.values();
  }

  // Генератор: лінива вибірка без проміжного масиву.
  *ofKind<K extends AnyEntity['kind']>(kind: K): Generator<EntityOfKind<K>> {
    for (const entity of this) {
      if (entity.alive && isOfKind(entity, kind)) yield entity;
    }
  }

  count(kind: AnyEntity['kind']): number {
    let total = 0;
    for (const entity of this) {
      if (entity.alive && entity.kind === kind) total += 1;
    }
    return total;
  }

  // Синхронно: слухачі відпрацюють ще до повернення з emit, у тому ж кроці.
  emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]): void {
    this.events.emit(type, payload);
  }

  addScore(id: EntityId, points: number): void {
    const total = (this.score.get(id) ?? 0) + points;
    this.score.set(id, total);
    this.emit('score', { id, points, total });
  }

  // Випадкова точка, поруч із якою нікого немає. Випадковість — із сіяного генератора світу.
  findSafeSpot(radius: number, margin = 140): Vector2 {
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
  step(dt: number, inputs: Inputs = NO_INPUTS): void {
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

  #flushSpawns(): void {
    for (const entity of this.#spawnQueue) this.#entities.set(entity.id, entity);
    this.#spawnQueue.length = 0;
  }

  #sweep(): void {
    for (const [id, entity] of this.#entities) {
      if (!entity.alive) this.#entities.delete(id);
    }
  }
}
