// Експеримент 3: однакова «заскриптована» команда замість клавіатури,
// щоб два прогони відрізнялися лише кроком симуляції, а не руками гравця.

export const BENCH_COMMAND = Object.freeze({ turn: 0.35, thrust: 1, brake: false, dash: false });
export const BENCH_DURATION = 5; // секунд симульованого часу
