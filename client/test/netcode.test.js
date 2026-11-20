// Передбачення, звірка й інтерполяція — без браузера і без мережі.
import { test } from 'vitest';
import assert from 'node:assert/strict';

import { DT, TICK_MS } from '@moba-arena/shared/protocol.ts';
import { stepInput } from '@moba-arena/shared/sim/ship.ts';
import { createInterpolator, createServerClock } from '../src/net/interpolation.ts';
import { createPredictor } from '../src/net/prediction.ts';

const ARENA = { width: 1600, height: 900 };
const START = {
  x: 800,
  y: 450,
  vx: 0,
  vy: 0,
  angle: 0,
  dashCooldown: 0,
  fireCooldown: 0,
  rapid: false,
};
const self = (state, extra = {}) => ({
  ...state,
  down: false,
  shield: false,
  homing: false,
  hp: 100,
  respawnTimer: 0,
  ...extra,
});
const command = (i) => ({
  turn: i % 40 < 20 ? 1 : 0,
  thrust: 1,
  brake: false,
  dash: i === 25,
  fire: i % 5 === 0,
});

// Маленький «сервер»: застосовує input тією ж функцією, із затримкою в `lag` кроків.
function simulate({ lag, steps, perturb = null, dropEvery = 0, bump = null }) {
  const predictor = createPredictor({ arena: ARENA, perturb });
  let server = START;
  let ack = 0;
  const inFlight = []; // input, що ще «летять» до сервера
  const corrections = [];
  predictor.reconcile(self(server), 0);

  for (let i = 1; i <= steps; i += 1) {
    const cmd = command(i);
    const { seq } = predictor.applyInput(cmd);
    if (!(dropEvery && i % dropEvery === 0)) inFlight.push({ seq, cmd, arrives: i + lag });

    while (inFlight.length > 0 && inFlight[0].arrives <= i) {
      const { seq: arrived, cmd: arrivedCommand } = inFlight.shift();
      server = stepInput(server, arrivedCommand, DT, ARENA);
      ack = arrived;
    }
    if (bump && i === bump.at) server = { ...server, vx: server.vx + bump.dv }; // «зіткнення»
    if (i > lag) corrections.push(predictor.reconcile(self(server), ack));
  }
  return { predictor, corrections, server };
}

test('детермінована симуляція: поправки нульові за будь-якої затримки', () => {
  for (const lag of [0, 1, 3, 8]) {
    const { corrections, predictor } = simulate({ lag, steps: 200 });
    assert.equal(Math.max(...corrections), 0, `затримка ${lag} кроків`);
    assert.equal(predictor.pendingCount, lag);
  }
});

test('звірка: стан сервера + повтор непідтверджених input', () => {
  const predictor = createPredictor({ arena: ARENA });
  predictor.reconcile(self(START), 0);
  const commands = [1, 2, 3, 4, 5].map(command);
  for (const cmd of commands) predictor.applyInput(cmd);
  assert.equal(predictor.pendingCount, 5);

  // Сервер обробив перші два input.
  let server = START;
  for (const cmd of commands.slice(0, 2)) server = stepInput(server, cmd, DT, ARENA);
  assert.equal(predictor.reconcile(self(server), 2), 0);
  assert.equal(predictor.pendingCount, 3);

  let expected = server;
  for (const cmd of commands.slice(2)) expected = stepInput(expected, cmd, DT, ARENA);
  assert.equal(predictor.state.x, expected.x);
  assert.equal(predictor.state.vy, expected.vy);
});

// Звірка як чиста функція: (стан сервера, ack, буфер input) → передбачений стан.
// N = 10. У буфері лежать input N−2…N+4 (тобто 8…14), приходить знімок з ack = N.
function predictorWithBuffer() {
  const N = 10;
  const predictor = createPredictor({ arena: ARENA });
  predictor.reconcile(self(START), 0);
  const commands = new Map();
  for (let i = 1; i <= N + 4; i += 1) {
    const { seq } = predictor.applyInput(command(i));
    commands.set(seq, command(i));
  }
  // Попередній знімок підтвердив усе до N−3: у буфері лишилось рівно N−2…N+4.
  let acked = START;
  for (let i = 1; i <= N - 3; i += 1) acked = stepInput(acked, commands.get(i), DT, ARENA);
  predictor.reconcile(self(acked), N - 3);
  assert.equal(predictor.pendingCount, 7, 'у буфері N−2…N+4');
  // Стан сервера після input №N.
  let server = acked;
  for (let i = N - 2; i <= N; i += 1) server = stepInput(server, commands.get(i), DT, ARENA);
  return { N, predictor, commands, server };
}

const replay = (from, commands, first, last) => {
  let state = { ...from, thrust: 0, fired: false };
  for (let i = first; i <= last; i += 1) state = stepInput(state, commands.get(i), DT, ARENA);
  return state;
};

test('звірка: знімок з ack N при буфері N−2…N+4 → підтверджені викинуто, решту програно заново', () => {
  const { N, predictor, commands, server } = predictorWithBuffer();
  const before = predictor.state;

  const correction = predictor.reconcile(self(server), N);

  assert.equal(predictor.pendingCount, 4, 'лишились N+1…N+4; N−2…N викинуто');
  const expected = replay(server, commands, N + 1, N + 4);
  assert.deepEqual(predictor.state, expected, 'стан сервера + 4 непідтверджені input');
  assert.deepEqual(predictor.state, before, 'і це рівно те, що клієнт уже передбачив');
  assert.equal(correction, 0);
  assert.equal(predictor.seq, N + 4, 'лічильник seq звірка не чіпає');
});

test('звірка — чиста функція від (знімок, буфер): інший стан сервера → той самий повтор від нього', () => {
  const { N, predictor, commands, server } = predictorWithBuffer();
  // Сервер побачив зіткнення, якого клієнт не передбачав: інша швидкість і позиція.
  const bumped = { ...server, x: server.x - 30, vx: server.vx - 200, vy: server.vy + 50 };

  const correction = predictor.reconcile(self(bumped), N);

  const expected = replay(bumped, commands, N + 1, N + 4);
  assert.deepEqual(predictor.state, expected);
  assert.ok(correction > 0);
  assert.equal(correction, predictor.lastCorrection);

  // Повторний той самий знімок нічого не змінює: буфер уже без підтверджених, результат той самий.
  assert.equal(predictor.reconcile(self(bumped), N), 0);
  assert.deepEqual(predictor.state, expected);
  assert.equal(predictor.pendingCount, 4);
});

test('звірка: застарілий знімок (ack менший за вже підтверджений) буфер не відновлює', () => {
  const { N, predictor, commands, server } = predictorWithBuffer();
  predictor.reconcile(self(server), N);
  // Запізнілий знімок з ack = N−1: input №N у буфері вже немає, тож його не буде програно.
  const stale = replay(START, commands, 1, N - 1);
  predictor.reconcile(self(stale), N - 1);
  assert.equal(predictor.pendingCount, 4);
  assert.deepEqual(predictor.state, replay(stale, commands, N + 1, N + 4), 'input №N пропущено');
  assert.notDeepEqual(predictor.state, replay(server, commands, N + 1, N + 4));
});

test('звірка: ack за межами буфера (усе підтверджено) → стан сервера як є', () => {
  const { N, predictor, commands } = predictorWithBuffer();
  const server = replay(START, commands, 1, N + 4);
  assert.equal(predictor.reconcile(self(server), N + 4), 0);
  assert.equal(predictor.pendingCount, 0);
  assert.deepEqual(predictor.state, { ...server, thrust: 0, fired: false });
});

test('applyInput до першого знімка: input копляться, але стану ще немає', () => {
  const predictor = createPredictor({ arena: ARENA });
  assert.equal(predictor.state, null);
  assert.equal(predictor.pose(0.5), null);
  assert.deepEqual(predictor.applyInput(command(5)), { seq: 1, fired: false });
  assert.equal(predictor.pendingCount, 1);
  predictor.reconcile(self(START), 0);
  assert.deepEqual(predictor.state, { ...stepInput(START, command(5), DT, ARENA) });
});

test('predict: false — input лише нумерується й запам’ятовується; reset усе скидає', () => {
  const predictor = createPredictor({ arena: ARENA });
  predictor.reconcile(self(START), 0);
  const { seq, fired } = predictor.applyInput(command(5), { predict: false });
  assert.deepEqual({ seq, fired }, { seq: 1, fired: false });
  assert.equal(predictor.state.x, START.x, 'стан не рухався');
  predictor.reconcile(self({ ...START, x: 900 }), 0, { predict: false });
  assert.equal(predictor.state.x, 900, 'без повтору input — рівно стан сервера');
  assert.equal(predictor.pendingCount, 1);

  predictor.reset();
  assert.equal(predictor.state, null);
  assert.equal(predictor.pendingCount, 0);
  assert.equal(predictor.seq, 0);
});

test('буфер обмежено 120 input: якщо сервер мовчить, найстаріші викидаються', () => {
  const predictor = createPredictor({ arena: ARENA });
  predictor.reconcile(self(START), 0);
  for (let i = 1; i <= 150; i += 1) predictor.applyInput(command(i));
  assert.equal(predictor.pendingCount, 120);
  predictor.reconcile(self(START), 100);
  assert.equal(predictor.pendingCount, 50, 'лишились 101…150');
});

test('pose: інтерполяція між попереднім і поточним кроком, зокрема через край арени', () => {
  const predictor = createPredictor({ arena: ARENA });
  predictor.reconcile(self({ ...START, x: 1599, vx: 300 }), 0);
  predictor.applyInput({ turn: 0, thrust: 0, brake: false, dash: false, fire: false });
  const next = predictor.state.x; // 1599 + 300·(1 − 1.6/30)/30 → загорнулось за край
  assert.ok(next < 10, `x = ${next}`);
  assert.ok(Math.abs(predictor.pose(0).x - 1599) < 1e-9);
  assert.ok(Math.abs(predictor.pose(1).x - next) < 1e-9);
  const middle = predictor.pose(0.5).x;
  assert.ok(middle > 1599 || middle < next, `середина ${middle} лежить на короткому шляху`);
});

test('зіткнення на сервері → сплеск поправки, який згладжується, а не стрибає', () => {
  const { corrections } = simulate({ lag: 3, steps: 120, bump: { at: 60, dv: -400 } });
  const peak = Math.max(...corrections);
  assert.ok(peak > 5, `сплеск ${peak}`);
  assert.equal(
    corrections.slice(0, 50).every((value) => value === 0),
    true,
    'до зіткнення — нулі',
  );
  assert.equal(corrections.at(-1), 0, 'після — знову нулі');

  // Згладжування: одразу після поправки герой намальований там само, де був,
  // а за 100 мс лишається < 6 % зсуву.
  const fresh = createPredictor({ arena: ARENA });
  fresh.reconcile(self(START), 0);
  fresh.reconcile(self({ ...START, x: START.x + 40 }), 0);
  assert.ok(Math.abs(fresh.pose(1).x - START.x) < 1e-9);
  fresh.decay(0.1);
  assert.ok(Math.abs(fresh.pose(1).x - (START.x + 40)) < 40 * 0.06);
});

test('зламаний детермінізм (Math.random у кроці) → поправки на кожному знімку', () => {
  const noise = (state) => ({ ...state, vx: state.vx + (Math.random() - 0.5) * 30 });
  const { corrections } = simulate({ lag: 3, steps: 200, perturb: noise });
  const nonZero = corrections.filter((value) => value > 0.01).length;
  assert.ok(nonZero > corrections.length * 0.9, `ненульових ${nonZero} з ${corrections.length}`);
});

test('втрачений input: одна поправка, далі знову нулі', () => {
  const { corrections } = simulate({ lag: 2, steps: 100, dropEvery: 50 });
  const spikes = corrections.filter((value) => value > 0.01).length;
  assert.ok(spikes >= 1 && spikes <= 6, `сплесків ${spikes}`);
  assert.equal(corrections.at(-1), 0);
});

test('герой «лежить»: стан сервера як є, без повтору input', () => {
  const predictor = createPredictor({ arena: ARENA });
  predictor.reconcile(self(START), 0);
  predictor.applyInput(command(1));
  predictor.reconcile(self({ ...START, x: 100, y: 100 }, { down: true }), 0);
  assert.equal(predictor.state.x, 100);
  assert.equal(predictor.lastCorrection > 220, true, 'телепорт — без згладжування');
  assert.equal(predictor.pose(1).x, 100);
});

const ship = (id, x, y, angle = 0) => ({ id, kind: 'ship', x, y, angle, hp: 100, score: 0 });

test('інтерполяція: стан між двома знімками', () => {
  const buffer = createInterpolator({ arena: ARENA });
  buffer.push({ tick: 10, entities: [ship(1, 100, 100, 0)] });
  buffer.push({ tick: 11, entities: [ship(1, 130, 100, 0.2)] });
  const middle = buffer.sample(10.5 * TICK_MS);
  assert.equal(middle.starved, false);
  assert.ok(Math.abs(middle.entities[0].x - 115) < 1e-9);
  assert.ok(Math.abs(middle.entities[0].angle - 0.1) < 1e-9);
  assert.equal(buffer.sample(10.25 * TICK_MS).entities[0].x, 107.5);
});

test('інтерполяція: край арени і перехід кута через ±π — найкоротшим шляхом', () => {
  const buffer = createInterpolator({ arena: ARENA });
  buffer.push({ tick: 1, entities: [ship(1, 1590, 450, 3.1)] });
  buffer.push({ tick: 2, entities: [ship(1, 10, 450, -3.1)] });
  const { x, angle } = buffer.sample(1.5 * TICK_MS).entities[0];
  assert.ok(x > 1599 || x < 1, `x=${x}`);
  assert.ok(Math.abs(Math.abs(angle) - Math.PI) < 0.05, `angle=${angle}`);
});

test('інтерполяція: поява, зникнення, телепорт, порожній буфер', () => {
  const buffer = createInterpolator({ arena: ARENA });
  assert.deepEqual(buffer.sample(0), { entities: [], starved: true });

  buffer.push({ tick: 1, entities: [ship(1, 100, 100), ship(2, 500, 500)] });
  buffer.push({ tick: 2, entities: [ship(1, 900, 100), ship(3, 300, 300)] });
  const ids = (time) => buffer.sample(time * TICK_MS).entities.map((entity) => entity.id);
  assert.deepEqual(ids(1.5), [1, 2], 'зниклий домальовується, новий іще не видно');
  assert.deepEqual(ids(2), [1, 3]);

  // Стрибок на 800 одиниць (респаун) не розмазується по арені.
  assert.equal(buffer.sample(1.4 * TICK_MS).entities[0].x, 100);
  assert.equal(buffer.sample(1.6 * TICK_MS).entities[0].x, 900);

  const late = buffer.sample(5 * TICK_MS);
  assert.equal(late.starved, true, 'нових знімків немає — тримаємо останній');
  assert.equal(late.entities[0].x, 900);

  assert.equal(buffer.push({ tick: 2, entities: [] }), false, 'дублікат');
  assert.equal(buffer.push({ tick: 1, entities: [] }), false, 'застарілий');
});

test('годинник сервера: розкид затримки згладжується, великий стрибок — пересинхронізація', () => {
  const clock = createServerClock();
  assert.equal(clock.ready, false);
  clock.observe(1000, 1100); // затримка 100
  assert.equal(clock.now(1100), 1000);
  clock.observe(1033, 1163); // цей знімок запізнився на 30 мс
  assert.ok(Math.abs(clock.now(1163) - 1061.5) < 0.01, 'зсув змінився лише на 5 % від 30 мс');
  clock.observe(50_000, 51_000);
  assert.equal(clock.now(51_000), 50_000);
});
