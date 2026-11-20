import { Entity } from './entity.js';

export const BULLET_SPEED = 620; // од/с відносно героя
export const BULLET_TTL = 1.1; // с
export const BULLET_DAMAGE = 20;

// Чарівний снаряд: летить прямо і зникає, коли вийшов час життя.
export class Bullet extends Entity {
  constructor({ pos, vel, angle, ownerId, team }) {
    super({ kind: 'bullet', pos, vel, angle, radius: 5 });
    this.ownerId = ownerId;
    this.team = team;
    this.ttl = BULLET_TTL;
    this.damage = BULLET_DAMAGE;
  }

  update(dt, world) {
    this.ttl -= dt;
    if (this.ttl <= 0) {
      world.despawn(this.id); // лише позначка; з Map його прибере sweep наприкінці кроку
      return;
    }
    super.update(dt, world);
  }
}
