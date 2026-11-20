// Експеримент 3 (Lab 1): однакова «заскриптована» команда замість клавіатури,
// щоб два прогони відрізнялися лише кроком симуляції, а не руками гравця.

import type { Command } from './ship.ts';

export const BENCH_COMMAND: Command = Object.freeze({
  turn: 0.35,
  thrust: 1,
  brake: false,
  dash: false,
  fire: false,
});
export const BENCH_DURATION = 5; // секунд симульованого часу
