import { entityId, type EntityId } from '../brand.ts';
import { wrapVector, type Arena } from './arena.ts';
import { Vector2 } from './vector.ts';
import type { World } from './world.ts';

// База для всього, що живе у світі. Ієрархія рівно в один рівень:
// Ship, Bullet, Asteroid, Pickup, Explosion extends Entity — і не глибше.
// Усе, що не вкладається в дерево (самонаведення тощо), живе в `behaviors`.

export type EntityKind = 'ship' | 'bullet' | 'asteroid' | 'pickup' | 'explosion';

// Поведінка — функція; `tag` дозволяє рендеру впізнати, наприклад, самонаведення.
export interface Behavior {
  (entity: Entity, dt: number, world: World): void;
  tag?: string;
}

export interface EntityInit {
  readonly id?: EntityId | undefined;
  readonly kind: EntityKind;
  readonly pos: Vector2;
  readonly vel?: Vector2 | undefined;
  readonly angle?: number | undefined;
  readonly radius?: number | undefined;
  readonly ownerId?: EntityId | undefined;
}

export class Entity {
  // Приватне статичне поле: лічильник належить класу, а не екземпляру,
  // і ззовні його не прочитати й не зіпсувати (Entity.#nextId поза класом — SyntaxError).
  static #nextId = 1;

  readonly id: EntityId;
  readonly kind: EntityKind;
  // Хто випустив сутність (для снарядів); самонаведення не цілиться у власника.
  readonly ownerId: EntityId | null;
  pos: Vector2;
  vel: Vector2;
  angle: number;
  radius: number;
  alive = true;

  // Композиція: список функцій (entity, dt, world) => void. Поведінка — це дані.
  behaviors: Behavior[] = [];

  // Стан на початок кроку — рендер інтерполює між ним і поточним.
  prevPos: Vector2;
  prevAngle: number;

  // id можна передати явно (клієнт відтворює сутність, якій id уже видав сервер).
  constructor({ id, kind, pos, vel = Vector2.ZERO, angle = 0, radius = 1, ownerId }: EntityInit) {
    this.id = id ?? entityId(Entity.#nextId++);
    this.kind = kind;
    this.ownerId = ownerId ?? null;
    this.pos = pos;
    this.vel = vel;
    this.angle = angle;
    this.radius = radius;
    this.prevPos = pos;
    this.prevAngle = angle;
  }

  // Чи бере сутність участь у зіткненнях. Підкласи перевизначають.
  get collidable(): boolean {
    return true;
  }

  savePrevious(): void {
    this.prevPos = this.pos; // вектори незмінні, тому посилання достатньо
    this.prevAngle = this.angle;
  }

  runBehaviors(dt: number, world: World): void {
    for (const behavior of this.behaviors) behavior(this, dt, world);
  }

  move(dt: number, arena: Arena): void {
    this.pos = wrapVector(this.pos.add(this.vel.scale(dt)), arena);
  }

  update(dt: number, world: World): void {
    this.runBehaviors(dt, world);
    this.move(dt, world.arena);
  }
}
