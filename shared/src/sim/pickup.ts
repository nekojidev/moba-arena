import { Entity } from './entity.ts';
import type { Effect } from './events.ts';
import type { Vector2 } from './vector.ts';
import type { World } from './world.ts';

// Руна: стоїть на місці, бере участь у зіткненнях, але це не герой і не снаряд.
// Що саме вона дає — описано даними (`effect`), а не окремим підкласом на кожен тип.
export const PICKUP_EFFECTS: readonly Effect[] = Object.freeze([
  Object.freeze({ type: 'shield', duration: 5 }),
  Object.freeze({ type: 'rapid', duration: 6 }),
  Object.freeze({ type: 'homing', duration: 8 }),
]);

export const PICKUP_TTL = 14; // с — потім руна зникає сама

export class Pickup extends Entity {
  declare readonly kind: 'pickup';
  readonly effect: Effect;
  ttl = PICKUP_TTL;

  constructor({ pos, effect }: { readonly pos: Vector2; readonly effect: Effect }) {
    super({ kind: 'pickup', pos, radius: 18 });
    this.effect = effect;
  }

  override update(dt: number, world: World): void {
    this.ttl -= dt;
    if (this.ttl <= 0) world.despawn(this.id);
  }
}
