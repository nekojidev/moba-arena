import { Entity } from './entity.js';

// Руна: стоїть на місці, бере участь у зіткненнях, але це не герой і не снаряд.
// Що саме вона дає — описано даними (`effect`), а не окремим підкласом на кожен тип.
export const PICKUP_EFFECTS = Object.freeze([
  Object.freeze({ type: 'shield', duration: 5 }),
  Object.freeze({ type: 'rapid', duration: 6 }),
  Object.freeze({ type: 'homing', duration: 8 }),
]);

export const PICKUP_TTL = 14; // с — потім руна зникає сама

export class Pickup extends Entity {
  constructor({ pos, effect }) {
    super({ kind: 'pickup', pos, radius: 18 });
    this.effect = effect;
    this.ttl = PICKUP_TTL;
  }

  update(dt, world) {
    this.ttl -= dt;
    if (this.ttl <= 0) world.despawn(this.id);
  }
}
