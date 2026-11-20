import { Entity } from './entity.js';

// Перешкода, що дрейфує ареною і відбивається від усього. У грі це кам'яний голем;
// у термінах лаби — «asteroid». Три розміри: великий розпадається на менших.
const SIZES = {
  1: { radius: 16, hp: 20 },
  2: { radius: 28, hp: 40 },
  3: { radius: 44, hp: 80 },
};

export class Asteroid extends Entity {
  #hp;

  constructor({ pos, vel, size = 3, spin = 0 }) {
    super({ kind: 'asteroid', pos, vel, radius: SIZES[size].radius });
    this.size = size;
    this.spin = spin;
    this.#hp = SIZES[size].hp;
  }

  get hp() {
    return this.#hp;
  }

  // Повертає true, якщо голема зруйновано.
  takeDamage(amount) {
    this.#hp = Math.max(0, this.#hp - amount);
    return this.#hp === 0;
  }

  update(dt, world) {
    this.angle += this.spin * dt;
    super.update(dt, world);
  }
}
