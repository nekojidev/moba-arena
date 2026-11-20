// Малювання зі спрайтшитів. atlas.json описує, де на якому аркуші лежить кадр:
//   "hero-green": { "sheet": "heroes", "x": 0, "y": 0, "w": 192, "h": 192, "radius": 32 }
// radius — радіус тіла на картинці в пікселях аркуша; за ним кадр масштабується
// до радіуса сутності у світі.
//
// Якщо аркуша чи кадра немає (404, битий файл) — draw повертає false,
// і викликач малює запасний векторний варіант. Гра не падає через картинку.

export function createSprites(atlas, sheets) {
  const frames = atlas?.frames ?? {};

  return {
    has(name) {
      const frame = frames[name];
      return Boolean(frame && sheets[frame.sheet]);
    },

    // Малює кадр із центром у (0, 0) поточної системи координат.
    draw(ctx, name, radius) {
      const frame = frames[name];
      const sheet = frame && sheets[frame.sheet];
      if (!sheet) return false;
      const scale = radius / frame.radius;
      const width = frame.w * scale;
      const height = frame.h * scale;
      // drawImage з дев'ятьма аргументами: прямокутник-джерело на аркуші → прямокутник на canvas.
      ctx.drawImage(
        sheet,
        frame.x,
        frame.y,
        frame.w,
        frame.h,
        -width / 2,
        -height / 2,
        width,
        height,
      );
      return true;
    },
  };
}

// Порожній набір: усе малюється вектором.
export const NO_SPRITES = createSprites(null, {});
