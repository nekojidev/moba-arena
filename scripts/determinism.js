// Експеримент 3 (Lab 1) без браузера: та сама фізика з src/sim, запущена в Node.
// Імітуємо три «монітори» — 60 кадрів/с, 144 кадри/с і ~10 кадрів/с (CPU throttle 6×) —
// і порівнюємо позицію героя після 5 с симульованого часу тяги.
//
//   npm run determinism

import { createGame } from '../src/sim/game.js';
import { BENCH_COMMAND, BENCH_DURATION } from '../src/sim/bench.js';

const STEP = 1 / 60;

function run({ frameMs, fixed }) {
  const game = createGame({ empty: true });
  let accumulator = 0;
  let simTime = 0;
  const done = () => simTime >= BENCH_DURATION - 1e-6;

  const advance = (dt) => {
    game.step(dt, BENCH_COMMAND);
    simTime += dt;
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
  return { x: game.player.pos.x, y: game.player.pos.y, steps: game.world.tick };
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
