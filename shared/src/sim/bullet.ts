import type { EntityId } from '../brand.ts';
import { Entity } from './entity.ts';
import type { Team } from './events.ts';
import type { Vector2 } from './vector.ts';
import type { World } from './world.ts';

export const BULLET_SPEED = 620; // од/с відносно героя
export const BULLET_TTL = 1.1; // с
export const BULLET_DAMAGE = 20;

export interface BulletInit {
  readonly pos: Vector2;
  readonly vel: Vector2;
  readonly angle: number;
  readonly ownerId: EntityId;
  readonly team: Team;
}

// Чарівний снаряд: летить прямо і зникає, коли вийшов час життя.
export class Bullet extends Entity {
  declare readonly kind: 'bullet';
  declare readonly ownerId: EntityId;
  readonly team: Team;
  ttl = BULLET_TTL;
  readonly damage = BULLET_DAMAGE;

  constructor({ pos, vel, angle, ownerId, team }: BulletInit) {
    super({ kind: 'bullet', pos, vel, angle, radius: 5, ownerId });
    this.team = team;
  }

  override update(dt: number, world: World): void {
    this.ttl -= dt;
    if (this.ttl <= 0) {
      world.despawn(this.id); // лише позначка; з Map його прибере sweep наприкінці кроку
      return;
    }
    super.update(dt, world);
  }
}
