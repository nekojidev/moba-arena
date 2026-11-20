// Ігровий цикл із фіксованим кроком — без браузера: фальшиві таймери Vitest керують часом,
// а requestAnimationFrame підмінено «дисплеєм» із заданою частотою.
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import assert from 'node:assert/strict';

import { createLoop } from '../src/loop.ts';

const STEP = 1 / 60;

// «Дисплей»: кадр № k приходить у момент k·(1000 / hz) мс — саме цю позначку, як і справжній
// rAF, отримує колбек. Таймер під ним — фальшивий setTimeout, тож час іде лише тоді,
// коли тест викликає vi.advanceTimersByTime().
function installDisplay(hz) {
  const period = 1000 / hz;
  const origin = performance.now();
  const display = { frames: 0, requested: 0, cancelled: 0, hitch: 0 };
  vi.stubGlobal('requestAnimationFrame', (callback) => {
    display.requested += 1;
    const at = origin + (display.frames + 1) * period;
    return setTimeout(
      () => {
        display.frames += 1;
        callback(at + display.hitch);
      },
      Math.max(0, at - performance.now()),
    );
  });
  vi.stubGlobal('cancelAnimationFrame', (handle) => {
    display.cancelled += 1;
    clearTimeout(handle);
  });
  return display;
}

function recorder() {
  const log = { steps: [], alphas: [], order: [] };
  return {
    log,
    simulate(dt) {
      log.steps.push(dt);
      log.order.push('s');
    },
    render(alpha) {
      log.alphas.push(alpha);
      log.order.push('r');
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Запускає цикл на «дисплеї» hz герц і проганяє ms мілісекунд.
function run(hz, ms, options = {}) {
  const display = installDisplay(hz);
  const { log, simulate, render } = recorder();
  const loop = createLoop({ simulate, render, ...options });
  loop.start();
  vi.advanceTimersByTime(ms);
  return { display, log, loop };
}

describe('createLoop: фіксований крок, планувальник rAF', () => {
  test('1000 мс кадрів 60 Гц → рівно 60 кроків симуляції по 1/60 с', () => {
    const { display, log, loop } = run(60, 1000);
    assert.equal(display.frames, 60);
    assert.equal(log.steps.length, 60);
    assert.ok(
      log.steps.every((dt) => dt === STEP),
      'кожен крок — рівно 1/60, а не «скільки вийшло»',
    );
    assert.equal(log.alphas.length, 60, 'рендер — раз на кадр');
    assert.equal(loop.stats().totalSteps, 60);
    assert.equal(loop.stats().totalFrames, 60);
    loop.stop();
  });

  test('144 Гц і 30 Гц: за ту саму секунду — ті самі 60 кроків, різна лише кількість кадрів', () => {
    const fast = run(144, 1000);
    fast.loop.stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.useFakeTimers();
    const slow = run(30, 1000);
    slow.loop.stop();

    assert.equal(fast.display.frames, 144);
    assert.equal(slow.display.frames, 30);
    assert.equal(fast.log.steps.length, 60);
    assert.equal(slow.log.steps.length, 60);
    assert.equal(fast.log.alphas.length, 144);
    assert.equal(slow.log.alphas.length, 30);
  });

  test('10 секунд на 60, 75, 120, 144 і 240 Гц: кроків завжди 600 (±1 через округлення суми)', () => {
    for (const hz of [60, 75, 120, 144, 240]) {
      const { log, loop } = run(hz, 10_000);
      loop.stop();
      assert.ok(Math.abs(log.steps.length - 600) <= 1, `${hz} Гц: ${log.steps.length} кроків`);
      vi.unstubAllGlobals();
      vi.useRealTimers();
      vi.useFakeTimers();
    }
  });

  test('alpha завжди в [0, 1)', () => {
    for (const hz of [30, 60, 144]) {
      const { log, loop } = run(hz, 2000);
      loop.stop();
      assert.ok(log.alphas.length > 0);
      for (const alpha of log.alphas) {
        assert.ok(alpha >= 0 && alpha < 1, `${hz} Гц: alpha = ${alpha}`);
      }
      vi.unstubAllGlobals();
      vi.useRealTimers();
      vi.useFakeTimers();
    }
  });

  test('144 Гц: більшість кадрів обходиться без кроку симуляції, alpha росте між кроками', () => {
    const { log, loop } = run(144, 1000);
    loop.stop();
    // 144 кадри, 60 кроків: щонайменше 84 кадри — лише рендер.
    const framesWithoutStep = stepsPerFrame(log.order).filter((count) => count === 0).length;
    assert.equal(framesWithoutStep, 84);
    assert.ok(new Set(log.alphas.map((alpha) => alpha.toFixed(3))).size > 10, 'alpha не константа');
  });

  // Кроків за кадр: рядок 'ssrsr' → [2, 1].
  const stepsPerFrame = (order) =>
    order
      .join('')
      .split('r')
      .slice(0, -1)
      .map((steps) => steps.length);

  // Перша редакція чекала рівно 'ssr' на кожен кадр і впала: вийшло 'ssrssrsrsssr…'.
  // Період кадру (33.33… мс) — рівно два кроки, але сума dt у float64 часом на 1 ulp менша
  // за 2·step: тоді кадр робить один крок (alpha ≈ 0.9999999), а наступний — три.
  test('30 Гц: у середньому два кроки на кадр, але окремі кадри роблять 1 або 3 — похибка суми dt', () => {
    const { log, loop } = run(30, 500);
    loop.stop();
    const perFrame = stepsPerFrame(log.order);
    assert.equal(perFrame.length, 15);
    assert.equal(log.steps.length, 30, 'сума за пів секунди точна');
    assert.ok(
      perFrame.every((count) => count >= 1 && count <= 3),
      perFrame.join(''),
    );
    assert.ok(perFrame.includes(1) && perFrame.includes(3), `відома межа: ${perFrame.join('')}`);
    // Після «недобраного» кадру alpha майже 1, тобто картинка однаково стоїть на місці наступного кроку.
    perFrame.forEach((count, frame) => {
      if (count === 1) assert.ok(log.alphas[frame] > 0.999999, `alpha = ${log.alphas[frame]}`);
    });
  });

  test('60 Гц: кадр робить 0, 1 або 2 кроки; відставання ніколи не перевищує одного кроку', () => {
    const { log, loop } = run(60, 2000);
    loop.stop();
    const perFrame = stepsPerFrame(log.order);
    assert.ok(
      perFrame.every((count) => count <= 2),
      perFrame.join(''),
    );
    let done = 0;
    perFrame.forEach((count, frame) => {
      done += count;
      assert.ok(frame + 1 - done <= 1, `після кадру ${frame + 1} виконано ${done} кроків`);
    });
    assert.equal(done, 120);
  });

  test('довге «зависання» (5 с між кадрами) обрізається до 250 мс — без спіралі смерті', () => {
    const { display, log, loop } = run(60, 500);
    const before = log.steps.length;
    assert.equal(before, 30);

    display.hitch = 5000; // наступний кадр прийде з позначкою часу на 5 с пізніше
    vi.advanceTimersByTime(17);
    const burst = log.steps.length - before;
    // 0.25 с / (1/60 с) = 15 кроків (а не 300); ще один — це звичайний крок цього кадру.
    assert.ok(burst >= 15 && burst <= 16, `після зависання виконано ${burst} кроків`);
    assert.equal(loop.stats().frameTime > 5000, true, 'статистика показує справжню довжину кадру');

    // Далі цикл іде у звичайному темпі: борг не накопичився.
    const afterHitch = log.steps.length;
    vi.advanceTimersByTime(1000);
    assert.equal(log.steps.length - afterHitch, 60);
    assert.ok(log.alphas.every((alpha) => alpha >= 0 && alpha < 1));
    loop.stop();
  });

  test('stop() зупиняє: скасовує замовлений кадр, далі жодного simulate/render', () => {
    const { display, log, loop } = run(60, 500);
    const steps = log.steps.length;
    const frames = log.alphas.length;
    loop.stop();
    assert.equal(display.cancelled, 1);
    vi.advanceTimersByTime(5000);
    assert.equal(log.steps.length, steps);
    assert.equal(log.alphas.length, frames);
    assert.equal(vi.getTimerCount(), 0, 'жодного таймера не лишилось');
  });

  test('кадр, що «проскочив» після stop(), нічого не робить', () => {
    // Браузер може викликати вже поставлений у чергу колбек; cancel тут навмисно не працює.
    const pending = [];
    vi.stubGlobal('requestAnimationFrame', (callback) => pending.push(callback));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const { log, simulate, render } = recorder();
    const loop = createLoop({ simulate, render });
    loop.start();
    loop.stop();
    pending[0](performance.now() + 100);
    assert.deepEqual(log.order, []);
    assert.equal(pending.length, 1, 'новий кадр не замовлено');
  });

  test('start() двічі — один цикл, а не два; після stop() цикл можна запустити знову', () => {
    const display = installDisplay(60);
    const { log, simulate, render } = recorder();
    const loop = createLoop({ simulate, render });
    loop.start();
    loop.start();
    assert.equal(display.requested, 1);
    vi.advanceTimersByTime(1000);
    assert.equal(log.steps.length, 60);

    loop.stop();
    vi.advanceTimersByTime(3000); // пауза: вкладка у фоні
    loop.start();
    vi.advanceTimersByTime(17);
    // Пауза не перетворилась на «борг»: start() скидає акумулятор і точку відліку.
    assert.ok(log.steps.length - 60 <= 2, `після паузи виконано ${log.steps.length - 60} кроків`);
    loop.stop();
  });

  test('власний крок: step = 1/30 → 30 кроків за секунду на дисплеї 60 Гц', () => {
    const { log, loop } = run(60, 1000, { step: 1 / 30 });
    loop.stop();
    assert.equal(log.steps.length, 30);
    assert.ok(log.steps.every((dt) => dt === 1 / 30));
    // Кожен другий кадр — посередині між кроками.
    assert.ok(log.alphas.some((alpha) => Math.abs(alpha - 0.5) < 1e-6));
  });

  test('статистика: раз на секунду — кроки/с, кадри/с і найдовший кадр', () => {
    const { loop } = run(144, 999);
    assert.equal(loop.stats().stepsPerSecond, 0, 'перше вікно ще не закрилось');
    vi.advanceTimersByTime(1);
    const stats = loop.stats();
    assert.ok(Math.abs(stats.stepsPerSecond - 60) < 1e-6, `кроків/с: ${stats.stepsPerSecond}`);
    assert.ok(Math.abs(stats.framesPerSecond - 144) < 1e-6, `кадрів/с: ${stats.framesPerSecond}`);
    assert.ok(Math.abs(stats.frameTime - 1000 / 144) < 1e-6);
    assert.ok(Math.abs(stats.frameTimeMax - 1000 / 144) < 1e-6);
    assert.equal(
      loop.stats(),
      stats,
      'stats() повертає той самий об’єкт — його не треба копіювати',
    );
    loop.stop();
  });
});

describe('createLoop: змінний крок (fixed: false)', () => {
  test('simulate(dt) раз на кадр із реальним dt; render(1)', () => {
    const { log, loop } = run(144, 1000, { fixed: false });
    loop.stop();
    assert.equal(
      log.steps.length,
      144,
      'кроків стільки ж, скільки кадрів, — залежить від монітора',
    );
    for (const dt of log.steps) assert.ok(Math.abs(dt - 1 / 144) < 1e-9);
    assert.ok(log.alphas.every((alpha) => alpha === 1));
    const total = log.steps.reduce((sum, dt) => sum + dt, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, 'сума dt = секунда');
  });

  test('зависання теж обрізається до 0.25 с; кадр із нульовим dt симуляцію не викликає', () => {
    const pending = [];
    vi.stubGlobal('requestAnimationFrame', (callback) => pending.push(callback));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const { log, simulate, render } = recorder();
    const loop = createLoop({ simulate, render, fixed: false });
    loop.start();
    const start = performance.now();
    pending.at(-1)(start); // dt = 0
    assert.deepEqual(log.order, ['r']);
    pending.at(-1)(start + 9000);
    assert.deepEqual(log.steps, [0.25]);
    loop.stop();
  });
});

describe('createLoop: планувальник interval', () => {
  test('setInterval(16 мс): 62 кадри за секунду, 59 кроків — таймер не збігається з 60 Гц', () => {
    const raf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    const { log, simulate, render } = recorder();
    const loop = createLoop({ simulate, render, scheduler: 'interval' });
    loop.start();
    vi.advanceTimersByTime(1000);

    // 1000 / 16 = 62.5 → 62 спрацювання; 62·16 = 992 мс → floor(992 / 16.667) = 59 кроків.
    assert.equal(log.alphas.length, 62);
    assert.equal(log.steps.length, 59);
    assert.ok(log.alphas.every((alpha) => alpha >= 0 && alpha < 1));
    assert.equal(raf.mock.calls.length, 0, 'rAF у цьому режимі не використовується');

    loop.stop();
    assert.equal(vi.getTimerCount(), 0, 'stop() прибрав інтервал');
    vi.advanceTimersByTime(1000);
    assert.equal(log.alphas.length, 62);
  });

  test('interval + змінний крок: dt кожного кадру — 16 мс', () => {
    const { log, simulate, render } = recorder();
    const loop = createLoop({ simulate, render, scheduler: 'interval', fixed: false });
    loop.start();
    vi.advanceTimersByTime(160);
    loop.stop();
    assert.equal(log.steps.length, 10);
    assert.ok(log.steps.every((dt) => Math.abs(dt - 0.016) < 1e-12));
  });
});
