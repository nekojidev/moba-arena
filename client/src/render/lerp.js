import { shortestDelta, wrap } from '../sim/arena.js';

const TAU = Math.PI * 2;

// Поза сутності для рендера: щось між станом на початок кроку і поточним. Дві класичні пастки:
//  1) кут: між 179° і -179° треба повернути на 2°, а не на 358°;
//  2) тор: коли сутність перетнула край, між x=1598 і x=3 відстань 5, а не 1595 —
//     інакше на один кадр вона «промайне» через усю арену.
export function lerpPose(entity, alpha, arena) {
  const { prevPos, pos, prevAngle, angle } = entity;
  return {
    x: wrap(prevPos.x + shortestDelta(prevPos.x, pos.x, arena.width) * alpha, arena.width),
    y: wrap(prevPos.y + shortestDelta(prevPos.y, pos.y, arena.height) * alpha, arena.height),
    angle: prevAngle + shortestDelta(prevAngle, angle, TAU) * alpha,
  };
}
