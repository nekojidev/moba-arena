import { Entity } from './entity.ts';
import type { Vector2 } from './vector.ts';
import type { World } from './world.ts';

// Перешкода, що дрейфує ареною і відбивається від усього. У грі це кам'яний голем;
// у термінах лаби — «asteroid». Три розміри: великий розпадається на менших.
export type AsteroidSize = 1 | 2 | 3;

// Record<AsteroidSize, …> вимагає запис для КОЖНОГО розміру: додаси четвертий — tsc нагадає.
const SIZES: Record<AsteroidSize, { readonly radius: number; readonly hp: number }> = {
  1: { radius: 16, hp: 20 },
  2: { radius: 28, hp: 40 },
  3: { radius: 44, hp: 80 },
};

export const ASTEROID_RADIUS: Record<AsteroidSize, number> = {
  1: SIZES[1].radius,
  2: SIZES[2].radius,
  3: SIZES[3].radius,
};

export interface AsteroidInit {
  readonly pos: Vector2;
  readonly vel: Vector2;
  readonly size?: AsteroidSize;
  readonly spin?: number;
}

export class Asteroid extends Entity {
  declare readonly kind: 'asteroid';
  readonly size: AsteroidSize;
  readonly spin: number;
  #hp: number;

  constructor({ pos, vel, size = 3, spin = 0 }: AsteroidInit) {
    super({ kind: 'asteroid', pos, vel, radius: SIZES[size].radius });
    this.size = size;
    this.spin = spin;
    this.#hp = SIZES[size].hp;
  }

  get hp(): number {
    return this.#hp;
  }

  // Повертає true, якщо голема зруйновано.
  takeDamage(amount: number): boolean {
    this.#hp = Math.max(0, this.#hp - amount);
    return this.#hp === 0;
  }

  override update(dt: number, world: World): void {
    this.angle += this.spin * dt;
    super.update(dt, world);
  }
}
