// Canvas з урахуванням devicePixelRatio: буфер у фізичних пікселях,
// а малюємо в CSS-пікселях — інакше на retina все розмите.

export function setupCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const view = { width: 0, height: 0, dpr: 1 };

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    view.width = rect.width;
    view.height = rect.height;
    view.dpr = dpr;
    // Присвоєння width/height очищує canvas і скидає трансформацію — виставляємо її заново.
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  resize();
  window.addEventListener('resize', resize);

  return { ctx, view };
}

// Вписуємо арену у вікно зі збереженням пропорцій (letterbox).
export function fitArena(view, arena) {
  const scale = Math.min(view.width / arena.width, view.height / arena.height);
  return {
    scale,
    offsetX: (view.width - arena.width * scale) / 2,
    offsetY: (view.height - arena.height * scale) / 2,
  };
}
