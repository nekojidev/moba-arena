// Експеримент 3 без браузера: та сама фізика з src/sim, запущена в Node.
// Імітуємо два «монітори» — 60 кадрів/с і ~10 кадрів/с (CPU throttle 6×) —
// і порівнюємо позицію героя після 5 с симульованого часу тяги.
//
//   npm run determinism

import { createShip, integrate } from '../src/sim/ship.js';
import { ARENA, wrapShip } from '../src/sim/arena.js';
import { BENCH_COMMAND, BENCH_DURATION } from '../src/sim/bench.js';

const STEP = 1 / 60;

function run({ frameMs, fixed }) {
  let ship = createShip(ARENA.width / 2, ARENA.height / 2);
  let accumulator = 0;
  let simTime = 0;
  let steps = 0;
  const done = () => simTime >= BENCH_DURATION - 1e-6;

  const advance = (dt) => {
    ship = wrapShip(integrate(ship, BENCH_COMMAND, dt), ARENA);
    simTime += dt;
    steps += 1;
  };

  while (!done()) {
    const dt = Math.min(frameMs / 1000, 0.25);
    if (fixed) {
      accumulator += dt;
      while (accumulator >= STEP && !done()) {
        advance(STEP);
        accumulator -= STEP;
      }
    } else {
      advance(dt);
    }
  }
  return { x: ship.x, y: ship.y, steps, simTime };
}

const rows = [];
for (const fixed of [false, true]) {
  for (const frameMs of [1000 / 60, 1000 / 144, 100]) {
    const r = run({ frameMs, fixed });
    rows.push({
      step: fixed ? 'fixed 1/60' : 'variable',
      'frame, ms': frameMs.toFixed(2),
      steps: r.steps,
      x: r.x.toFixed(3),
      y: r.y.toFixed(3),
    });
  }
}
console.table(rows);
