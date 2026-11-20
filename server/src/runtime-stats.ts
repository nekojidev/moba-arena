// Як почувається процес: завантаженість циклу подій, пам'ять, збирання сміття.
// Усі лічильники НАКОПИЧУВАЛЬНІ (від старту): хто хоче цифру за проміжок — знімає показник
// двічі й віднімає. Так сервер не вгадує, яке вікно цікавить того, хто міряє.

import { PerformanceObserver, performance } from 'node:perf_hooks';

export interface RuntimeSnapshot {
  readonly uptimeMs: number;
  // Event loop utilization: active — скільки мс цикл подій працював, idle — чекав.
  // Частка за проміжок = Δactive / (Δactive + Δidle).
  readonly eventLoop: { readonly idleMs: number; readonly activeMs: number };
  readonly memory: { readonly rss: number; readonly heapUsed: number; readonly external: number };
  // Паузи збирача сміття: кількість, сума й найдовша.
  readonly gc: { readonly count: number; readonly totalMs: number; readonly maxMs: number };
}

export interface RuntimeStats {
  snapshot(): RuntimeSnapshot;
  close(): void;
}

export function createRuntimeStats(): RuntimeStats {
  const startedAt = performance.now();
  const gc = { count: 0, totalMs: 0, maxMs: 0 };
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gc.count += 1;
      gc.totalMs += entry.duration;
      gc.maxMs = Math.max(gc.maxMs, entry.duration);
    }
  });
  observer.observe({ entryTypes: ['gc'] });

  return {
    snapshot() {
      const { idle, active } = performance.eventLoopUtilization();
      const { rss, heapUsed, external } = process.memoryUsage();
      return {
        uptimeMs: performance.now() - startedAt,
        eventLoop: { idleMs: idle, activeMs: active },
        memory: { rss, heapUsed, external },
        gc: { ...gc },
      };
    },
    close() {
      observer.disconnect();
    },
  };
}
