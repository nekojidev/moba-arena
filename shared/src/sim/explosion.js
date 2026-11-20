import { cos, sin } from './dmath.js';
import { Entity } from './entity.js';

// Вибух — одна сутність із багатьма короткоживучими частинками.
// Частинки — прості об'єкти { x, y, vx, vy, life } відносно центру вибуху.
// (Багато дрібних об'єктів, що швидко вмирають — навантаження на збирач сміття; це ще згадається в Lab 7.)
export class Explosion extends Entity {
  constructor({ pos, rng, count = 24, speed = 220, color = '#ffd27a' }) {
    super({ kind: 'explosion', pos, radius: 0 });
    this.color = color;
    this.particles = [];
    for (let i = 0; i < count; i += 1) {
      const angle = rng() * Math.PI * 2;
      const velocity = speed * (0.25 + 0.75 * rng());
      const life = 0.35 + 0.5 * rng();
      this.particles.push({
        x: 0,
        y: 0,
        vx: cos(angle) * velocity,
        vy: sin(angle) * velocity,
        life,
        maxLife: life,
      });
    }
  }

  get collidable() {
    return false;
  }

  update(dt, world) {
    let anyAlive = false;
    for (const particle of this.particles) {
      if (particle.life <= 0) continue;
      particle.life -= dt;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      if (particle.life > 0) anyAlive = true;
    }
    if (!anyAlive) world.despawn(this.id);
  }
}
