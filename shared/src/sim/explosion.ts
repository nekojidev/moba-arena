import { cos, sin } from './dmath.ts';
import { Entity } from './entity.ts';
import type { Rng } from './rng.ts';
import type { Vector2 } from './vector.ts';
import type { World } from './world.ts';

export interface Particle {
  x: number;
  y: number;
  readonly vx: number;
  readonly vy: number;
  life: number;
  readonly maxLife: number;
}

export interface ExplosionInit {
  readonly pos: Vector2;
  readonly rng: Rng;
  readonly count?: number;
  readonly speed?: number;
  readonly color?: string;
}

// Вибух — одна сутність із багатьма короткоживучими частинками.
// Частинки — прості об'єкти { x, y, vx, vy, life } відносно центру вибуху.
// (Багато дрібних об'єктів, що швидко вмирають — навантаження на збирач сміття; це ще згадається в Lab 7.)
export class Explosion extends Entity {
  declare readonly kind: 'explosion';
  readonly color: string;
  readonly particles: Particle[] = [];

  constructor({ pos, rng, count = 24, speed = 220, color = '#ffd27a' }: ExplosionInit) {
    super({ kind: 'explosion', pos, radius: 0 });
    this.color = color;
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

  override get collidable(): boolean {
    return false;
  }

  override update(dt: number, world: World): void {
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
