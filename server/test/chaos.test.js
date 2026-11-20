// Хаос-сценарії (scripts/chaos.js) у скороченому вигляді: тут перевіряються ІНВАРІАНТИ,
// а не числа. Повні заміри з таблицями — `npm run chaos -w server`.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { TICK_MS } from '@moba-arena/shared/protocol.ts';
import { floodScenario, killScenario, vanishScenario } from '../scripts/chaos.js';

test('клієнт зник: сервер прибирає його у вікні heartbeat, матч іде далі', async () => {
  const result = await vanishScenario({ heartbeatMs: 300, others: 2 });

  assert.equal(result.playersBefore, 4);
  assert.equal(result.playersAfter, 2, 'обох зниклих прибрано з кімнати');
  assert.equal(result.connections, 2, 'і з’єднань їхніх теж немає');
  // Знищений сокет ОС закриває сама — сервер бачить це одразу, без heartbeat.
  assert.ok(result.destroyedMs < 1000, `знищений сокет: ${result.destroyedMs} мс`);
  // Завислого прибирає heartbeat: не раніше двох пропущених pong і не пізніше трьох періодів
  // (плюс запас на опитування /metrics).
  assert.ok(result.frozenMs >= 300, `завислий: ${result.frozenMs} мс`);
  assert.ok(result.frozenMs <= result.heartbeatWindowMs + 500, `завислий: ${result.frozenMs} мс`);
  assert.equal(result.heartbeatLost, 1, 'лічильник heartbeat_lost');
  assert.equal(result.logLines.length, 1);
  assert.equal(result.logLines[0].roomId, 'mid');
  assert.ok(result.logLines[0].playerId);

  assert.equal(result.matches, 1, 'матч не зупинився');
  assert.ok(result.ticksPerSecond >= 25, `кроків за секунду: ${result.ticksPerSecond}`);
  assert.equal(result.othersClosed, 0);
  for (const frames of result.othersFramesPerSecond) {
    assert.ok(frames >= 25, `решта гравців отримує знімки: ${frames}/с`);
  }
}, 20_000);

test('сервер убито SIGKILL і піднято знову: клієнти самі повертаються в кімнату', async () => {
  const result = await killScenario({ clients: 3, restartDelayMs: 300, baseMs: 50, maxMs: 400 });

  assert.deepEqual(result.exit, { code: null, signal: 'SIGKILL' });
  assert.deepEqual(result.statuses, ['open', 'open', 'open']);
  assert.equal(result.playersAfter, 3);
  assert.equal(result.newPlayerIds, true, 'це нові гравці нового процесу');
  for (const attempts of result.attempts) assert.ok(attempts >= 1, 'була хоча б одна пауза');
  // Паузи ростуть (backoff), але не вище стелі.
  for (const waits of result.waits) {
    for (const [index, waitMs] of waits.entries()) {
      const ceiling = Math.min(400, 50 * 2 ** index);
      assert.ok(
        waitMs >= ceiling / 2 - 1 && waitMs <= ceiling + 1,
        `пауза ${index + 1}: ${waitMs}`,
      );
    }
  }
  assert.ok(result.recoverMaxMs >= result.restartDelayMs);
  // Сервер уже працює — клієнт повертається не пізніше, ніж за одну найдовшу паузу (+ запас).
  assert.ok(result.afterUpMaxMs <= 400 + 1000, `після підняття: ${result.afterUpMaxMs} мс`);
  assert.ok(result.tickAfter < result.tickBefore, 'матч новий: кроки почалися з нуля');
}, 30_000);

test('потік сміття в кімнаті A: нападника закрито, пораховано й записано; кімната B іде в темпі', async () => {
  const result = await floodScenario({ phaseSeconds: 2, rate: 1000, playersB: 3, playersA: 1 });
  const { flood, during } = result;

  // Потік справді був.
  assert.ok(flood.framesSent >= 1000, `надіслано ${flood.framesSent} кадрів`);
  assert.ok(flood.connections >= 10);
  // Кожне з'єднання нападника закрив сервер, і лише «поганими» кодами 4000 / 4001 / 4005.
  const codes = Object.keys(flood.closeCodes).map(Number);
  assert.ok(codes.length > 0);
  for (const code of codes) assert.ok([4000, 4001, 4005].includes(code), `код ${code}`);
  assert.ok(flood.closeMaxMs < 1000, `найдовше закриття: ${flood.closeMaxMs} мс`);

  // Пораховано в метриках і записано в лог — по одному разу на з'єднання, з roomId і playerId.
  const closed = Object.values(flood.closeCodes).reduce((sum, count) => sum + count, 0);
  assert.ok(
    Math.abs(result.rejectionsTotal - closed) <= 1,
    `${result.rejectionsTotal} / ${closed}`,
  );
  assert.ok(result.rejections.bad_message > 0);
  assert.equal(result.loggedCloses, result.rejectionsTotal);
  assert.equal(result.loggedWithIds, result.loggedCloses);

  // Кімната B: усі на місці, темп 30 кроків/с тримається, крок уміщається в бюджет.
  assert.equal(result.playersInB, 3);
  assert.equal(result.closedPlayers, 0, 'чесних гравців не зачепило');
  assert.ok(
    during.ticksPerSecond >= 27,
    `кроків за секунду під час потоку: ${during.ticksPerSecond}`,
  );
  assert.ok(during.tickP99 < TICK_MS, `p99 кроку під час потоку: ${during.tickP99} мс`);
  assert.ok(during.lateP99 < TICK_MS, `p99 запізнення під час потоку: ${during.lateP99} мс`);
}, 40_000);
