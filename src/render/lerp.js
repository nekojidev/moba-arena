import { shortestDelta, wrap } from '../sim/arena.js';

const TAU = Math.PI * 2;

// Інтерполяція стану для рендера. Дві класичні пастки:
//  1) кут: між 179° і -179° треба повернути на 2°, а не на 358°;
//  2) тор: коли герой перетнув край, між x=1598 і x=3 відстань 5, а не 1595 —
//     інакше на один кадр він «промайне» через усю арену.
export function lerpShip(previous, current, alpha, arena) {
  return {
    ...current,
    x: wrap(
      previous.x + shortestDelta(previous.x, current.x, arena.width) * alpha,
      arena.width,
    ),
    y: wrap(
      previous.y + shortestDelta(previous.y, current.y, arena.height) * alpha,
      arena.height,
    ),
    angle: previous.angle + shortestDelta(previous.angle, current.angle, TAU) * alpha,
  };
}
