// Арена — фіксований світ у власних одиницях, незалежний від розміру вікна.
// Краї «загорнуті»: вилетів праворуч — з'явився ліворуч (тор).

export const ARENA = Object.freeze({ width: 1600, height: 900 });

export function wrap(value, size) {
  return ((value % size) + size) % size; // коректно і для від'ємних значень
}

export function wrapShip(ship, arena) {
  return { ...ship, x: wrap(ship.x, arena.width), y: wrap(ship.y, arena.height) };
}

// Найкоротша різниця між двома координатами на торі: результат у [-size/2, size/2).
export function shortestDelta(from, to, size) {
  return wrap(to - from + size / 2, size) - size / 2;
}
