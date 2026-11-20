// Поведінки — композиція замість спадкування.
// Поведінка — це функція (entity, dt, world) => void, яку кладуть у entity.behaviors.
// Вона не знає, до чого її причепили: до снаряда, голема чи чогось, чого ще не існує.

import { shortestDelta, torusDelta } from './arena.ts';
import type { Behavior, Entity, EntityKind } from './entity.ts';
import type { AnyEntity } from './world.ts';

const TAU = Math.PI * 2;

export interface HomingOptions {
  readonly turnRate: number;
  readonly kinds: readonly EntityKind[];
  readonly range?: number;
  readonly faceVelocity?: boolean;
}

// Самонаведення: повертає вектор швидкості в бік найближчої цілі, не змінюючи його довжину.
// Параметри замкнені в стрілковій функції — у неї немає власного this, і він їй не потрібен.
export function homing({
  turnRate,
  kinds,
  range = 600,
  faceVelocity = false,
}: HomingOptions): Behavior {
  return (entity, dt, world) => {
    let target: AnyEntity | null = null;
    let best = range;
    for (const kind of kinds) {
      for (const candidate of world.ofKind(kind)) {
        if (candidate === entity || candidate.id === entity.ownerId) continue;
        if (!candidate.collidable) continue;
        const distance = torusDelta(entity.pos, candidate.pos, world.arena).length();
        if (distance < best) {
          best = distance;
          target = candidate;
        }
      }
    }
    if (!target || entity.vel.length() === 0) return;

    const desired = torusDelta(entity.pos, target.pos, world.arena).angle();
    const diff = shortestDelta(entity.vel.angle(), desired, TAU);
    const maxTurn = turnRate * dt;
    entity.vel = entity.vel.rotate(Math.max(-maxTurn, Math.min(maxTurn, diff)));
    if (faceVelocity) entity.angle = entity.vel.angle();
  };
}

// Рендеру досить знати, чи є серед поведінок позначена 'homing'. Тому приймаємо будь-що
// з таким списком: і справжню сутність, і «картку» зі знімка на клієнті.
export function isHoming(entity: {
  readonly behaviors: readonly { readonly tag?: string }[];
}): boolean {
  return entity.behaviors.some((behavior) => behavior.tag === 'homing');
}

export function withHoming<T extends Entity>(entity: T, options: HomingOptions): T {
  const behavior = homing(options);
  behavior.tag = 'homing';
  entity.behaviors.push(behavior);
  return entity;
}
