// Арена — фіксований світ у власних одиницях, незалежний від розміру вікна.
// Краї «загорнуті»: вилетів праворуч — з'явився ліворуч (тор).

import { Vector2 } from './vector.ts';

export interface Arena {
  readonly width: number;
  readonly height: number;
}

// Те, що має координати. Vector2 і запис зі знімка підходять однаково — типізація структурна.
export interface Point {
  readonly x: number;
  readonly y: number;
}

export const ARENA: Arena = Object.freeze({ width: 1600, height: 900 });

export function wrap(value: number, size: number): number {
  return ((value % size) + size) % size; // коректно і для від'ємних значень
}

export function wrapVector(vector: Point, arena: Arena): Vector2 {
  return new Vector2(wrap(vector.x, arena.width), wrap(vector.y, arena.height));
}

// Найкоротша різниця між двома координатами на торі: результат у [-size/2, size/2).
export function shortestDelta(from: number, to: number, size: number): number {
  return wrap(to - from + size / 2, size) - size / 2;
}

// Найкоротший вектор від точки до точки з урахуванням загортання країв.
export function torusDelta(from: Point, to: Point, arena: Arena): Vector2 {
  return new Vector2(
    shortestDelta(from.x, to.x, arena.width),
    shortestDelta(from.y, to.y, arena.height),
  );
}
