// Косметичні частинки на клієнті (вибухи). До симуляції не належать: сервер надсилає
// лише подію «тут вибухнуло», а як це виглядає — справа клієнта. Тому тут можна Math.random().

interface Particle {
  x: number;
  y: number;
  readonly vx: number;
  readonly vy: number;
  life: number;
  readonly maxLife: number;
  readonly color: string;
}

export interface ExplodeOptions {
  readonly count?: number;
  readonly speed?: number;
  readonly color?: string;
}

export interface Effects {
  explode(x: number, y: number, options?: ExplodeOptions): void;
  update(seconds: number): void;
  draw(ctx: CanvasRenderingContext2D): void;
}

export function createEffects(): Effects {
  const particles: Particle[] = [];

  return {
    explode(x, y, { count = 24, speed = 220, color = '#ffd27a' } = {}) {
      for (let i = 0; i < count; i += 1) {
        const angle = Math.random() * Math.PI * 2;
        const velocity = speed * (0.25 + 0.75 * Math.random());
        const life = 0.35 + 0.5 * Math.random();
        particles.push({
          x,
          y,
          vx: Math.cos(angle) * velocity,
          vy: Math.sin(angle) * velocity,
          life,
          maxLife: life,
          color,
        });
      }
    },

    update(seconds) {
      for (let i = particles.length - 1; i >= 0; i -= 1) {
        const particle = particles[i];
        if (!particle) continue;
        particle.life -= seconds;
        if (particle.life <= 0) {
          particles.splice(i, 1);
          continue;
        }
        particle.x += particle.vx * seconds;
        particle.y += particle.vy * seconds;
      }
    },

    draw(ctx) {
      ctx.save();
      for (const particle of particles) {
        ctx.globalAlpha = particle.life / particle.maxLife;
        ctx.fillStyle = particle.color;
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    },
  };
}
