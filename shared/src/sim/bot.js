// Простий супротивник: повертається до найближчої цілі, підлітає і стріляє.
// Бот видає таку саму команду-дані, як і клавіатура, — світ не розрізняє, хто керує героєм.

import { NO_COMMAND } from './ship.js';
import { shortestDelta, torusDelta } from './arena.js';

const TAU = Math.PI * 2;

export function botCommand(bot, world) {
  if (bot.isDown) return NO_COMMAND;

  let target = null;
  let best = Infinity;
  for (const kind of ['ship', 'asteroid']) {
    for (const candidate of world.ofKind(kind)) {
      if (candidate === bot || !candidate.collidable) continue;
      // Герой цікавіший за голема: «зменшуємо» відстань до нього.
      const weight = kind === 'ship' ? 0.5 : 1;
      const distance = torusDelta(bot.pos, candidate.pos, world.arena).length() * weight;
      if (distance < best) {
        best = distance;
        target = candidate;
      }
    }
  }
  if (!target) return NO_COMMAND;

  const toTarget = torusDelta(bot.pos, target.pos, world.arena);
  const distance = toTarget.length();
  const diff = shortestDelta(bot.angle, toTarget.angle(), TAU);

  return {
    turn: Math.max(-1, Math.min(1, diff * 2.5)),
    thrust: distance > 280 && Math.abs(diff) < 1 ? 0.7 : 0,
    brake: distance < 180,
    dash: false,
    fire: Math.abs(diff) < 0.12 && distance < 460,
  };
}
