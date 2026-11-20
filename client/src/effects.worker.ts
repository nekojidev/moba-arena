// ДОСЛІД (Lab 7): оновлення частинок у Web Worker. У грі НЕ використовується —
// замір показав, що основному потоку від цього не легше (див. README).
//
// Протокол: основний потік надсилає { dt, x, y } — два Float32Array, передані як
// transferable (без копіювання: буфер «переїжджає» і в відправника стає порожнім).
// Воркер рухає частинки й повертає ті самі буфери назад.

const CAPACITY = 2048;
const vx = new Float32Array(CAPACITY);
const vy = new Float32Array(CAPACITY);
for (let i = 0; i < CAPACITY; i += 1) {
  const angle = (i / CAPACITY) * Math.PI * 2;
  vx[i] = Math.cos(angle) * 120;
  vy[i] = Math.sin(angle) * 120;
}

interface Job {
  readonly dt: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
}

self.onmessage = (event: MessageEvent<Job>) => {
  const { dt, x, y } = event.data;
  for (let i = 0; i < x.length; i += 1) {
    x[i] = (x[i] ?? 0) + (vx[i] ?? 0) * dt;
    y[i] = (y[i] ?? 0) + (vy[i] ?? 0) * dt;
  }
  self.postMessage({ x, y }, { transfer: [x.buffer, y.buffer] });
};
