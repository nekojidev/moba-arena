// Штучна «погана мережа» прямо в клієнті: затримка, розкид і втрата пакетів.
// На localhost усе приходить за мілісекунду — без цього модуля мережевий код не перевірити.
//
//   latencyMs — додана затримка «туди й назад» (половина в кожен бік)
//   jitterMs  — розкид цієї затримки: ± jitterMs у сумі
//   dropRate  — частка втрачених ігрових повідомлень (0…1)
//
// Math.random() тут доречний: це мережа, а не симуляція.

export const PRESETS = [
  { name: 'без затримки', latencyMs: 0, jitterMs: 0, dropRate: 0 },
  { name: '100 мс', latencyMs: 100, jitterMs: 0, dropRate: 0 },
  { name: '100 ± 30 мс, втрати 2 %', latencyMs: 100, jitterMs: 30, dropRate: 0.02 },
  { name: '250 ± 50 мс, втрати 5 %', latencyMs: 250, jitterMs: 50, dropRate: 0.05 },
];

export function createInjector(initial = {}) {
  const settings = { latencyMs: 0, jitterMs: 0, dropRate: 0, ...initial };
  const lastDelivery = { up: 0, down: 0 };
  const stats = { dropped: 0 };

  return {
    settings,
    stats,

    get active() {
      return settings.latencyMs > 0 || settings.jitterMs > 0 || settings.dropRate > 0;
    },

    // direction: 'up' (клієнт → сервер) або 'down'. droppable: false — для керувальних
    // повідомлень (чат, ping): їх затримуємо, але не губимо.
    pass(direction, deliver, { droppable = true } = {}) {
      if (droppable && settings.dropRate > 0 && Math.random() < settings.dropRate) {
        stats.dropped += 1;
        return;
      }
      if (settings.latencyMs === 0 && settings.jitterMs === 0) {
        deliver();
        return;
      }
      const oneWay = settings.latencyMs / 2 + ((Math.random() * 2 - 1) * settings.jitterMs) / 2;
      const now = performance.now();
      // WebSocket іде поверх TCP: пакети не обганяють один одного. Запізнілий затримує
      // всіх, хто за ним (head-of-line blocking) — відтворюємо і це.
      const at = Math.max(now + Math.max(0, oneWay), lastDelivery[direction]);
      lastDelivery[direction] = at;
      setTimeout(deliver, at - now);
    },
  };
}
