// Ігровий цикл із фіксованим кроком (Glenn Fiedler, "Fix Your Timestep!").
//
// Симуляція завжди просувається кроками рівно `step` секунд, скільки б герц не мав монітор.
// Рендер викликається раз на кадр і отримує alpha ∈ [0, 1) — частку кроку, що «залишилась»
// в акумуляторі, щоб інтерполювати між попереднім і поточним станом.
//
// Опції `scheduler` і `fixed` існують лише заради експериментів 2 і 3 з лаби.

const MAX_FRAME_DELTA = 0.25; // с; після довгого «зависання» не намагаємося наздогнати все

export function createLoop({
  step = 1 / 60,
  simulate,
  render,
  scheduler = 'raf', // 'raf' | 'interval'
  fixed = true, // false → змінний крок: simulate(dt) один раз на кадр
}) {
  // Увесь стан циклу приватний: він живе в замиканні, ззовні видно лише start/stop/stats.
  let running = false;
  let handle = 0;
  let last = 0;
  let accumulator = 0;

  let windowStart = 0;
  let windowSteps = 0;
  let windowFrames = 0;
  let windowMaxDelta = 0;

  const stats = {
    stepsPerSecond: 0,
    framesPerSecond: 0,
    frameTime: 0, // мс між двома останніми кадрами
    frameTimeMax: 0, // найдовший кадр за останню секунду, мс
    totalSteps: 0,
    totalFrames: 0,
  };

  function frame(now) {
    if (!running) return;

    const deltaMs = now - last;
    last = now;

    const dt = Math.min(deltaMs / 1000, MAX_FRAME_DELTA);

    if (fixed) {
      accumulator += dt;
      while (accumulator >= step) {
        simulate(step);
        accumulator -= step;
        windowSteps += 1;
        stats.totalSteps += 1;
      }
      render(accumulator / step);
    } else {
      if (dt > 0) {
        simulate(dt);
        windowSteps += 1;
        stats.totalSteps += 1;
      }
      render(1);
    }

    stats.frameTime = deltaMs;
    stats.totalFrames += 1;
    windowFrames += 1;
    windowMaxDelta = Math.max(windowMaxDelta, deltaMs);

    const elapsed = now - windowStart;
    if (elapsed >= 1000) {
      stats.stepsPerSecond = (windowSteps * 1000) / elapsed;
      stats.framesPerSecond = (windowFrames * 1000) / elapsed;
      stats.frameTimeMax = windowMaxDelta;
      windowStart = now;
      windowSteps = 0;
      windowFrames = 0;
      windowMaxDelta = 0;
    }

    if (scheduler === 'raf') handle = requestAnimationFrame(frame);
  }

  function start() {
    if (running) return;
    running = true;
    accumulator = 0;
    last = performance.now();
    windowStart = last;
    if (scheduler === 'raf') {
      handle = requestAnimationFrame(frame);
    } else {
      // Експеримент 2: таймер не синхронізований з дисплеєм і дрейфує.
      handle = setInterval(() => frame(performance.now()), 16);
    }
  }

  function stop() {
    running = false;
    if (scheduler === 'raf') cancelAnimationFrame(handle);
    else clearInterval(handle);
  }

  return { start, stop, stats: () => stats };
}
