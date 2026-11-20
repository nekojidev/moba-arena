// integrate / stepInput: відомий вхід → значення, пораховані вручну.
// Константи: THRUST 900, DRAG 1.6, BRAKE_DRAG 5, MAX_SPEED 520, TURN_RATE 3.6,
// DASH_DISTANCE 160, DASH_COOLDOWN 2.5. Крок dt = 0.1 с — щоб числа були «круглі».
import { describe, test } from 'vitest';
import assert from 'node:assert/strict';

import { ARENA } from '../src/sim/arena.ts';
import {
  DASH_COOLDOWN,
  DASH_DISTANCE,
  FIRE_COOLDOWN,
  MAX_SPEED,
  NO_COMMAND,
  RAPID_FIRE_COOLDOWN,
  integrate,
  stepInput,
} from '../src/sim/ship.ts';

const DT = 0.1;
// dmath дає cos(0) = 1 + 4·10⁻¹⁴, тож порівнюємо з допуском, а не біт у біт.
const near = (actual, expected, eps = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} ≠ ${expected} (±${eps})`);

const REST = Object.freeze({ x: 800, y: 450, vx: 0, vy: 0, angle: 0, dashCooldown: 0 });
const cmd = (overrides) => ({ ...NO_COMMAND, ...overrides });

describe('integrate', () => {
  test('без команди і без швидкості нічого не змінюється', () => {
    assert.deepEqual(integrate(REST, NO_COMMAND, DT, ARENA), { ...REST, thrust: 0 });
  });

  test('чиста тяга зі стану спокою, один крок', () => {
    // v = 0 + 900·0.1 = 90; опір: 90·(1 − 1.6·0.1) = 75.6; x = 800 + 75.6·0.1 = 807.56
    const next = integrate(REST, cmd({ thrust: 1 }), DT, ARENA);
    near(next.vx, 75.6);
    near(next.vy, 0);
    near(next.x, 807.56);
    near(next.y, 450);
    assert.equal(next.angle, 0);
    assert.equal(next.thrust, 1);
  });

  test('напівнеявний Ейлер: позиція рухається вже з НОВОЮ швидкістю', () => {
    // Явний Ейлер дав би x = 800 (стара швидкість 0). Тут — 807.56.
    const next = integrate(REST, cmd({ thrust: 1 }), DT, ARENA);
    assert.ok(next.x > 807);
  });

  test('тяга вздовж кута погляду: π/2 — це вниз по осі y', () => {
    const next = integrate({ ...REST, angle: Math.PI / 2 }, cmd({ thrust: 1 }), DT, ARENA);
    near(next.vx, 0);
    near(next.vy, 75.6);
    near(next.y, 457.56);
  });

  test('часткова тяга (бот дає 0.7) масштабує прискорення', () => {
    // 900·0.7·0.1 = 63; 63·0.84 = 52.92
    near(integrate(REST, cmd({ thrust: 0.7 }), DT, ARENA).vx, 52.92);
  });

  test('лише опір: швидкість падає на 16 % за крок', () => {
    // 100·0.84 = 84; x = 800 + 8.4; vy: −50·0.84 = −42; y = 450 − 4.2
    const next = integrate({ ...REST, vx: 100, vy: -50 }, NO_COMMAND, DT, ARENA);
    near(next.vx, 84);
    near(next.vy, -42);
    near(next.x, 808.4);
    near(next.y, 445.8);
  });

  test('гальмо додає опір: (1 − (1.6 + 5)·0.1) = 0.34', () => {
    const next = integrate({ ...REST, vx: 100 }, cmd({ brake: true }), DT, ARENA);
    near(next.vx, 34);
    near(next.x, 803.4);
  });

  test('великий dt з гальмом: множник опору не стає від’ємним — герой просто зупиняється', () => {
    // 1 − 6.6·0.2 = −0.32 → max(0, …) = 0. Без max швидкість змінила б знак.
    const next = integrate({ ...REST, vx: 100 }, cmd({ brake: true }), 0.2, ARENA);
    assert.equal(next.vx, 0);
    assert.equal(next.x, 800);
  });

  test('обмеження швидкості: вектор стискається до MAX_SPEED, напрямок зберігається', () => {
    // (3000, 4000)·(1 − 0.016) = (2952, 3936), довжина 4920 → множник 520/4920
    const next = integrate({ ...REST, vx: 3000, vy: 4000 }, NO_COMMAND, 0.01, ARENA);
    near(next.vx, 312);
    near(next.vy, 416);
    near(Math.hypot(next.vx, next.vy), MAX_SPEED);
    near(next.x, 803.12);
    near(next.y, 454.16);
  });

  test('нижче MAX_SPEED швидкість не обрізається', () => {
    // 400·0.84 = 336 < 520 — множник обмеження не застосовується.
    near(integrate({ ...REST, vx: 400 }, NO_COMMAND, DT, ARENA).vx, 336);
  });

  test('розгін уперед упирається в MAX_SPEED', () => {
    let state = REST;
    for (let i = 0; i < 300; i += 1) state = integrate(state, cmd({ thrust: 1 }), 1 / 30, ARENA);
    near(Math.hypot(state.vx, state.vy), MAX_SPEED, 1e-6);
  });

  test('загортання на правому й лівому краї арени', () => {
    // 1599 + 84·0.1 = 1607.4 → 7.4
    near(integrate({ ...REST, x: 1599, vx: 100 }, NO_COMMAND, DT, ARENA).x, 7.4);
    // 1 − 8.4 = −7.4 → 1592.6
    near(integrate({ ...REST, x: 1, vx: -100 }, NO_COMMAND, DT, ARENA).x, 1592.6);
  });

  test('загортання на нижньому й верхньому краї арени', () => {
    near(integrate({ ...REST, y: 899, vy: 100 }, NO_COMMAND, DT, ARENA).y, 7.4);
    near(integrate({ ...REST, y: 1, vy: -100 }, NO_COMMAND, DT, ARENA).y, 892.6);
  });

  test('поворот: 3.6 рад/с; кут зводиться до [−π, π)', () => {
    near(integrate(REST, cmd({ turn: 1 }), DT, ARENA).angle, 0.36);
    near(integrate(REST, cmd({ turn: -1 }), DT, ARENA).angle, -0.36);
    near(integrate(REST, cmd({ turn: 0.5 }), DT, ARENA).angle, 0.18);
    // 3.1 + 0.36 = 3.46 > π → 3.46 − 2π
    near(integrate({ ...REST, angle: 3.1 }, cmd({ turn: 1 }), DT, ARENA).angle, 3.46 - 2 * Math.PI);
    near(
      integrate({ ...REST, angle: -3.1 }, cmd({ turn: -1 }), DT, ARENA).angle,
      -3.46 + 2 * Math.PI,
    );
  });

  test('поворот застосовується ДО тяги: прискорення йде вже в новий бік', () => {
    const next = integrate(REST, cmd({ turn: 1, thrust: 1 }), DT, ARENA);
    near(next.vx, 90 * Math.cos(0.36) * 0.84, 1e-9);
    near(next.vy, 90 * Math.sin(0.36) * 0.84, 1e-9);
  });

  test('ривок: +160 одиниць уперед миттєво, швидкість не змінюється, перезарядка 2.5 с', () => {
    const next = integrate(REST, cmd({ dash: true }), DT, ARENA);
    near(next.x, 800 + DASH_DISTANCE);
    near(next.y, 450);
    assert.equal(next.vx, 0);
    assert.equal(next.dashCooldown, DASH_COOLDOWN);
  });

  test('ривок через край арени загортається', () => {
    // 1500 + 160 = 1660 → 60
    near(integrate({ ...REST, x: 1500 }, cmd({ dash: true }), DT, ARENA).x, 60);
    // кут π: 100 − 160 = −60 → 1540
    near(integrate({ ...REST, x: 100, angle: -Math.PI }, cmd({ dash: true }), DT, ARENA).x, 1540);
  });

  test('ривок під час перезарядки не спрацьовує; перезарядка спадає на dt', () => {
    const next = integrate({ ...REST, dashCooldown: 1 }, cmd({ dash: true }), DT, ARENA);
    assert.equal(next.x, 800);
    near(next.dashCooldown, 0.9);
  });

  test('затиснутий ривок: спрацьовує на 1-му кроці й знову рівно через 2.5 с', () => {
    // dt = 0.5 — точне у двійковому поданні, тому 2.5 − 5·0.5 = 0 без похибки.
    let state = REST;
    const dashedAt = [];
    for (let step = 1; step <= 11; step += 1) {
      const before = state.x;
      state = integrate(state, cmd({ dash: true }), 0.5, ARENA);
      if (state.x !== before) dashedAt.push(step);
    }
    assert.deepEqual(dashedAt, [1, 6, 11]);
  });

  test('перезарядка без команди не йде нижче нуля', () => {
    assert.equal(integrate({ ...REST, dashCooldown: 0.05 }, NO_COMMAND, DT, ARENA).dashCooldown, 0);
  });

  test('dt = 0: стан не змінюється, але ривок (миттєвий) спрацьовує', () => {
    const moving = { ...REST, vx: 100, vy: 30 };
    assert.deepEqual(integrate(moving, cmd({ turn: 1, thrust: 1 }), 0, ARENA), {
      ...moving,
      thrust: 1,
    });
    near(integrate(moving, cmd({ dash: true }), 0, ARENA).x, 960);
  });

  test('вхідний стан і команда не мутуються', () => {
    const state = Object.freeze({ ...REST, vx: 10 });
    const command = Object.freeze(cmd({ turn: 1, thrust: 1, dash: true }));
    integrate(state, command, DT, ARENA); // заморожені об’єкти кинули б TypeError при записі
    assert.deepEqual(state, { ...REST, vx: 10 });
  });
});

describe('stepInput', () => {
  const START = Object.freeze({ ...REST, fireCooldown: 0, rapid: false });

  test('рух той самий, що в integrate; до нього додано перезарядку пострілу', () => {
    const command = cmd({ turn: -1, thrust: 1, brake: true });
    const { fireCooldown, rapid, fired, ...motion } = stepInput(START, command, DT, ARENA);
    assert.deepEqual(motion, integrate(START, command, DT, ARENA));
    assert.deepEqual(
      { fireCooldown, rapid, fired },
      { fireCooldown: 0, rapid: false, fired: false },
    );
  });

  test('постріл: fired і перезарядка 0.28 с; з руною «швидкий вогонь» — 0.1 с', () => {
    const shot = stepInput(START, cmd({ fire: true }), DT, ARENA);
    assert.equal(shot.fired, true);
    assert.equal(shot.fireCooldown, FIRE_COOLDOWN);
    const rapid = stepInput({ ...START, rapid: true }, cmd({ fire: true }), DT, ARENA);
    assert.equal(rapid.fireCooldown, RAPID_FIRE_COOLDOWN);
    assert.equal(rapid.rapid, true);
  });

  test('під час перезарядки постріл не виходить', () => {
    const next = stepInput({ ...START, fireCooldown: 0.25 }, cmd({ fire: true }), DT, ARENA);
    assert.equal(next.fired, false);
    near(next.fireCooldown, 0.15);
  });

  test('затиснутий вогонь на 30 Гц: постріл кожен 9-й крок (0.28 с → 9 кроків по 1/30)', () => {
    let state = START;
    const firedAt = [];
    for (let step = 0; step < 30; step += 1) {
      state = stepInput(state, cmd({ fire: true }), 1 / 30, ARENA);
      if (state.fired) firedAt.push(step);
    }
    assert.deepEqual(firedAt, [0, 9, 18, 27]);
  });
});
