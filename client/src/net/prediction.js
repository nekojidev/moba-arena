// Передбачення власного героя і звірка зі знімком сервера.
//
// Ідея: не чекати відповіді сервера, а одразу застосувати input у себе — тією самою
// функцією stepInput, якою рахує сервер. Кожен input пам'ятаємо, доки сервер його не
// підтвердить. Коли приходить знімок («ось твій стан після input №ack»):
//   1) викидаємо з буфера все, що ≤ ack;
//   2) стаємо у стан сервера;
//   3) заново програємо input, які сервер ще не бачив.
// Якщо симуляція детермінована, результат збігається з тим, що ми вже намалювали,
// і поправка дорівнює нулю. Ненульова поправка — це або зіткнення, якого клієнт
// не передбачав, або втрачений input, або порушений детермінізм.

import { DT } from '@moba-arena/shared/protocol.js';
import { shortestDelta, wrap } from '@moba-arena/shared/sim/arena.js';
import { stepInput } from '@moba-arena/shared/sim/ship.js';

const TAU = Math.PI * 2;
const SMOOTHING_TAU = 0.035; // с; за 100 мс від видимої похибки лишається ≈ 5 %
const SNAP_DISTANCE = 220; // більша розбіжність — це телепорт (респаун), її не згладжуємо

function motion(self) {
  const { x, y, vx, vy, angle, dashCooldown, fireCooldown, rapid } = self;
  return { x, y, vx, vy, angle, dashCooldown, fireCooldown, rapid, thrust: 0 };
}

export function createPredictor({ arena, dt = DT, perturb = null }) {
  let seq = 0;
  let state = null; // передбачений стан на поточний крок
  let previous = null; // на попередній — рендер інтерполює між ними
  let pending = []; // [{ seq, command }] — надіслано, але ще не підтверджено
  const offset = { x: 0, y: 0, angle: 0 }; // видима похибка, що згасає
  let lastCorrection = 0;

  // perturb — лише для досліду з навмисно зламаним детермінізмом (?chaos=random).
  const step = (from, command) => {
    const next = stepInput(from, command, dt, arena);
    return perturb ? perturb(next) : next;
  };

  return {
    get state() {
      return state;
    },
    get pendingCount() {
      return pending.length;
    },
    get lastCorrection() {
      return lastCorrection;
    },
    get seq() {
      return seq;
    },

    reset() {
      seq = 0;
      state = null;
      previous = null;
      pending = [];
      offset.x = offset.y = offset.angle = 0;
    },

    // Новий input: номер, запис у буфер і (якщо стан уже відомий) миттєвий крок.
    applyInput(command, { predict = true } = {}) {
      seq += 1;
      pending.push({ seq, command });
      if (pending.length > 120) pending.shift(); // сервер мовчить 4 с — далі не копимо
      let fired = false;
      if (predict && state) {
        previous = state;
        state = step(state, command);
        fired = state.fired;
      }
      return { seq, fired };
    },

    // Знімок сервера. Повертає величину поправки в одиницях арени.
    reconcile(self, ack, { predict = true } = {}) {
      pending = pending.filter((entry) => entry.seq > ack);
      const before = state;

      let next = motion(self);
      // Поки герой «лежить», сервер його не рухає — програвати нічого.
      if (predict && !self.down) {
        for (const entry of pending) next = step(next, entry.command);
      }

      lastCorrection = 0;
      if (before) {
        const dx = shortestDelta(next.x, before.x, arena.width);
        const dy = shortestDelta(next.y, before.y, arena.height);
        lastCorrection = Math.hypot(dx, dy);
        if (lastCorrection > SNAP_DISTANCE) {
          offset.x = offset.y = offset.angle = 0;
        } else {
          // Малюємо там, де малювали, і плавно з'їжджаємо до правильного місця.
          offset.x += dx;
          offset.y += dy;
          offset.angle += shortestDelta(next.angle, before.angle, TAU);
        }
        if (previous) {
          previous = {
            ...previous,
            x: wrap(previous.x - dx, arena.width),
            y: wrap(previous.y - dy, arena.height),
          };
        }
      }
      state = next;
      previous ??= next;
      return lastCorrection;
    },

    // Викликається щокадру: видима похибка експоненційно згасає.
    decay(seconds) {
      const keep = Math.exp(-seconds / SMOOTHING_TAU);
      offset.x *= keep;
      offset.y *= keep;
      offset.angle *= keep;
    },

    // Де малювати героя: між попереднім і поточним кроком + залишок похибки.
    pose(alpha) {
      if (!state) return null;
      const from = previous ?? state;
      return {
        x: wrap(
          from.x + shortestDelta(from.x, state.x, arena.width) * alpha + offset.x,
          arena.width,
        ),
        y: wrap(
          from.y + shortestDelta(from.y, state.y, arena.height) * alpha + offset.y,
          arena.height,
        ),
        angle: from.angle + shortestDelta(from.angle, state.angle, TAU) * alpha + offset.angle,
      };
    },
  };
}
