// Еталонний прогін: заскриптований матч на 20 с. Той самий код запускають тест у Node
// і сторінка client/selftest.html у браузері — хеші мають збігтися.

import { sin } from './dmath.js';
import { createGame } from './game.js';
import { hashWorld } from './hash.js';

// Еталонний хеш. Має збігатися в Node і в будь-якому браузері.
export const SELFTEST_HASH = '4182399d';
export const SELFTEST_STEPS = 600;
export const SELFTEST_DT = 1 / 30;

export function runSelftest() {
  const game = createGame({ seed: 2026 });
  for (let i = 0; i < SELFTEST_STEPS; i += 1) {
    game.step(SELFTEST_DT, {
      turn: sin(i / 23) > 0.2 ? 1 : sin(i / 23) < -0.6 ? -1 : 0,
      thrust: i % 70 < 50 ? 1 : 0,
      brake: i % 190 > 170,
      dash: i % 150 === 0,
      fire: i % 4 === 0,
    });
  }
  return { hash: hashWorld(game.world), entities: game.world.size, tick: game.world.tick };
}
