// Canvas з урахуванням devicePixelRatio: буфер у фізичних пікселях,
// а малюємо в CSS-пікселях — інакше на retina все розмите.

import type { Arena } from '@moba-arena/shared/sim/arena.ts';

// Розмір полотна в CSS-пікселях; оновлюється при зміні розміру вікна.
export interface View {
  width: number;
  height: number;
  dpr: number;
}

export interface Fit {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

export function setupCanvas(canvas: HTMLCanvasElement): {
  ctx: CanvasRenderingContext2D;
  view: View;
} {
  // getContext може повернути null (наприклад, якщо на цьому canvas уже взято 'webgl').
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Браузер не дав 2D-контекст для canvas');
  const view: View = { width: 0, height: 0, dpr: 1 };

  // Стрілка, а не function: оголошення function «спливає» вище перевірки на null,
  // тому всередині нього tsc знову вважав би ctx можливим null.
  const resize = (): void => {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    view.width = rect.width;
    view.height = rect.height;
    view.dpr = dpr;
    // Присвоєння width/height очищує canvas і скидає трансформацію — виставляємо її заново.
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  resize();
  window.addEventListener('resize', resize);

  return { ctx, view };
}

// Вписуємо арену у вікно зі збереженням пропорцій (letterbox).
export function fitArena(view: Pick<View, 'width' | 'height'>, arena: Arena): Fit {
  const scale = Math.min(view.width / arena.width, view.height / arena.height);
  return {
    scale,
    offsetX: (view.width - arena.width * scale) / 2,
    offsetY: (view.height - arena.height * scale) / 2,
  };
}
