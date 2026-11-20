// Бот — гравець, якого сервер не відрізняє від людини: він видає такий самий Input
// (поворот −1/0/1, кнопки) і кладе його в ту саму чергу, що й input із сокета.
// Жодного «прямого доступу» до світу в нього немає — лише читання.

import type { Input } from '@moba-arena/shared/protocol.ts';
import { shortestDelta, torusDelta } from '@moba-arena/shared/sim/arena.ts';
import { botCommand } from '@moba-arena/shared/sim/bot.ts';
import type { Ship } from '@moba-arena/shared/sim/ship.ts';
import type { World } from '@moba-arena/shared/sim/world.ts';

const TAU = Math.PI * 2;
const LOW_HP = 35;
const DANGER_RADIUS = 320;

// Те, що вміє і людина, і бот: видати наступний input (без номера — його ставить матч).
export type InputButtons = Omit<Input, 'seq'>;
export interface PlayerInput {
  nextInput(ship: Ship, world: World): InputButtons;
}

// Аналогову команду (поворот −1…1) зводимо до кнопок, як у клавіатури.
const sign = (value: number): -1 | 0 | 1 => (value > 0.15 ? 1 : value < -0.15 ? -1 : 0);

export class Bot implements PlayerInput {
  nextInput(ship: Ship, world: World): InputButtons {
    // Втеча: мало здоров'я і поруч ворожий герой — розвертаємось від нього й тиснемо газ.
    if (ship.hp <= LOW_HP) {
      for (const other of world.ofKind('ship')) {
        if (other === ship || !other.collidable) continue;
        const toOther = torusDelta(ship.pos, other.pos, world.arena);
        if (toOther.length() > DANGER_RADIUS) continue;
        const away = shortestDelta(ship.angle, toOther.angle() + Math.PI, TAU);
        return { turn: sign(away), thrust: 1, brake: false, dash: false, fire: false };
      }
    }
    // Інакше — переслідування й стрільба: те саме рішення, що й у локальній грі.
    const command = botCommand(ship, world);
    return {
      turn: sign(command.turn),
      thrust: command.thrust > 0.3 ? 1 : 0,
      brake: command.brake,
      dash: false,
      fire: command.fire,
    };
  }
}
