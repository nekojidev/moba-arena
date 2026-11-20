// Косметичні частинки на клієнті (вибухи). До симуляції не належать: сервер надсилає
// лише подію «тут вибухнуло», а як це виглядає — справа клієнта. Тому тут можна Math.random().
//
// Частинки — найчисленніші короткоживучі об'єкти гри, тому вони лежать не окремими
// об'єктами, а в заздалегідь виділених типізованих масивах («структура масивів»):
// x усіх частинок підряд, y підряд і так далі. Це і є пул: вибух не створює нічого нового,
// він лише займає вільні комірки, а згасла частинка звільняє свою.

const CAPACITY = 2048;

export interface ExplodeOptions {
  readonly count?: number;
  readonly speed?: number;
  readonly color?: string;
}

export interface Effects {
  explode(x: number, y: number, options?: ExplodeOptions): void;
  update(seconds: number): void;
  draw(ctx: CanvasRenderingContext2D): void;
  readonly count: number;
}

export function createEffects(): Effects {
  const x = new Float32Array(CAPACITY);
  const y = new Float32Array(CAPACITY);
  const vx = new Float32Array(CAPACITY);
  const vy = new Float32Array(CAPACITY);
  const life = new Float32Array(CAPACITY);
  const maxLife = new Float32Array(CAPACITY);
  const colorIndex = new Uint8Array(CAPACITY);
  const colors: string[] = []; // палітра: частинка зберігає номер кольору, а не рядок
  let count = 0; // живі частинки займають комірки 0…count−1

  return {
    get count() {
      return count;
    },

    explode(cx, cy, { count: amount = 24, speed = 220, color = '#ffd27a' } = {}) {
      let palette = colors.indexOf(color);
      if (palette < 0) palette = colors.push(color) - 1;
      for (let n = 0; n < amount && count < CAPACITY; n += 1) {
        const angle = Math.random() * Math.PI * 2;
        const velocity = speed * (0.25 + 0.75 * Math.random());
        const lifetime = 0.35 + 0.5 * Math.random();
        const i = count;
        x[i] = cx;
        y[i] = cy;
        vx[i] = Math.cos(angle) * velocity;
        vy[i] = Math.sin(angle) * velocity;
        life[i] = lifetime;
        maxLife[i] = lifetime;
        colorIndex[i] = palette;
        count += 1;
      }
    },

    update(seconds) {
      // Згаслу частинку замінюємо останньою живою — масив лишається щільним без зсувів.
      // Читання з типізованого масиву за межами дає undefined, тому «?? 0» — для tsc;
      // індекси тут завжди в межах.
      for (let i = count - 1; i >= 0; i -= 1) {
        const left = (life[i] ?? 0) - seconds;
        if (left <= 0) {
          const last = count - 1;
          x[i] = x[last] ?? 0;
          y[i] = y[last] ?? 0;
          vx[i] = vx[last] ?? 0;
          vy[i] = vy[last] ?? 0;
          life[i] = life[last] ?? 0;
          maxLife[i] = maxLife[last] ?? 0;
          colorIndex[i] = colorIndex[last] ?? 0;
          count = last;
          continue;
        }
        life[i] = left;
        x[i] = (x[i] ?? 0) + (vx[i] ?? 0) * seconds;
        y[i] = (y[i] ?? 0) + (vy[i] ?? 0) * seconds;
      }
    },

    draw(ctx) {
      if (count === 0) return;
      ctx.save();
      let palette = -1;
      for (let i = 0; i < count; i += 1) {
        ctx.globalAlpha = (life[i] ?? 0) / (maxLife[i] ?? 1);
        // Колір міняємо лише коли він інший, ніж у попередньої частинки.
        const index = colorIndex[i] ?? 0;
        if (index !== palette) {
          palette = index;
          ctx.fillStyle = colors[index] ?? '#ffd27a';
        }
        ctx.beginPath();
        ctx.arc(x[i] ?? 0, y[i] ?? 0, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    },
  };
}
