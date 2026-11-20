import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODECS } from '@moba-arena/shared/codec/index.js';
import { DT, TICK_MS } from '@moba-arena/shared/protocol.js';
import { stepInput } from '@moba-arena/shared/sim/ship.js';
import { Match } from '../src/match.js';
import { Room } from '../src/rooms.js';
import { connect, sleep, startApp } from './helpers.js';

const logger = { info() {}, warn() {}, error() {} };
const ARENA = { width: 1600, height: 900, asteroids: 0, pickups: 0, seed: 5 };
const input = (seq, extra = {}) => ({
  seq,
  turn: 0,
  thrust: 1,
  brake: false,
  dash: false,
  fire: false,
  ...extra,
});

function soloMatch() {
  const room = new Room({ id: 'r', name: 'R', arena: ARENA, maxPlayers: 4 });
  const match = new Match({ room, logger });
  const anna = { id: 'a', name: 'Анна' };
  const boris = { id: 'b', name: 'Борис' };
  match.addPlayer(anna);
  match.addPlayer(boris); // двоє людей → бота немає, ніхто не стріляє в спину
  const sent = [];
  match.attach('a', { codec: CODECS.json, send: (data) => (sent.push(JSON.parse(data)), true) });
  return { match, anna, boris, sent, ship: match.players.get('a').ship };
}

test('герой рухається лише від input; ack — номер останнього обробленого', () => {
  const { match, ship, sent } = soloMatch();
  const start = { ...ship.motionState() };

  match.tick(); // input не було
  assert.equal(ship.pos.x, start.x, 'без input герой стоїть');
  assert.equal(sent.at(-1).ack, 0);

  match.pushInput('a', input(1));
  match.pushInput('a', input(2)); // два input прийшли пачкою (нерівна мережа)
  match.tick();
  const snapshot = sent.findLast((message) => message.type === 'snapshot');
  assert.equal(snapshot.ack, 2);
  assert.equal(snapshot.tick, 2);

  // Сервер дійшов рівно до того стану, який клієнт порахував би сам тією ж функцією.
  let predicted = start;
  for (let i = 0; i < 2; i += 1) predicted = stepInput(predicted, input(i + 1), DT, ARENA);
  assert.equal(snapshot.self.x, predicted.x);
  assert.equal(snapshot.self.y, predicted.y);
  assert.equal(snapshot.self.vx, predicted.vx);
  assert.equal(snapshot.entities.filter((entity) => entity.kind === 'ship').length, 2);
});

test('дублікати й застарілі input ігноруються', () => {
  const { match } = soloMatch();
  assert.equal(match.pushInput('a', input(5)), true);
  assert.equal(match.pushInput('a', input(5)), false);
  assert.equal(match.pushInput('a', input(3)), false);
  assert.equal(match.pushInput('nobody', input(1)), false);
  assert.equal(match.players.get('a').queue.length, 1);
});

test('спам input не пришвидшує героя: у середньому один input за крок', () => {
  const honest = soloMatch();
  const cheater = soloMatch();
  let seq = 0;
  for (let tick = 0; tick < 60; tick += 1) {
    honest.match.pushInput('a', input(tick + 1));
    for (let i = 0; i < 10; i += 1) cheater.match.pushInput('a', input((seq += 1))); // 300 input/с
    honest.match.tick();
    cheater.match.tick();
  }
  const moved = (ctx) => ctx.match.players.get('a').processed;
  assert.equal(moved(honest), 60);
  assert.ok(moved(cheater) <= 60 + 6, `оброблено ${moved(cheater)} input за 60 кроків`);
  assert.ok(cheater.match.stats.droppedInputs > 400);
});

test('один гравець — з ботом; другий зайшов — бот пішов', () => {
  const room = new Room({ id: 'r', name: 'R', arena: ARENA, maxPlayers: 4 });
  const match = new Match({ room, logger });
  match.addPlayer({ id: 'a', name: 'Анна' });
  assert.ok(match.bot);
  match.addPlayer({ id: 'b', name: 'Борис' });
  assert.equal(match.bot, null);
  match.tick();
  assert.equal(match.world.count('ship'), 2);
  match.removePlayer('b');
  assert.ok(match.bot);
  match.tick();
  assert.equal(match.world.count('ship'), 2);
});

test('таймер: рівно 30 кроків/с без накопичення запізнень', async () => {
  const { match } = soloMatch();
  const started = performance.now();
  match.start();
  await sleep(1000);
  match.stop();
  const elapsed = performance.now() - started;
  const expected = elapsed / TICK_MS;
  const report = match.report();
  assert.ok(
    Math.abs(report.tick - expected) <= 1.5,
    `кроків ${report.tick}, очікувалось ≈${expected.toFixed(1)}`,
  );
  assert.ok(report.tickLatenessMs.avg < 5, `середнє запізнення ${report.tickLatenessMs.avg} мс`);
  assert.equal(report.overruns, 0);
});

test('по мережі: бінарний input → бінарні знімки з ack; /api/stats', async () => {
  const ctx = await startApp();
  try {
    const client = await connect(ctx.wsUrl);
    client.send({ type: 'join', room: 'mid', name: 'Анна' });
    const welcome = await client.next('welcome');
    for (let seq = 1; seq <= 10; seq += 1) {
      client.socket.send(CODECS.binary.encodeInput(input(seq, { turn: 1 })));
      await sleep(TICK_MS);
    }
    await sleep(100);
    const last = CODECS.binary.decodeSnapshot(client.snapshots.at(-1));
    assert.equal(last.ack, 10);
    assert.ok(client.snapshots.length >= 8);
    assert.ok(
      last.entities.some((entity) => entity.id === welcome.shipId && entity.kind === 'ship'),
    );
    assert.ok(Math.hypot(last.self.vx, last.self.vy) > 50, 'герой розігнався');

    client.send({ type: 'ping', t: 12345 });
    assert.equal((await client.next('pong')).t, 12345);

    const stats = await (await fetch(ctx.http + '/api/stats')).json();
    assert.equal(stats.matches[0].room, 'mid');
    assert.ok(stats.matches[0].tick > 5);
    assert.ok(stats.matches[0].bytesOut > 0);

    // Зламаний бінарний кадр — закриття з кодом, сервер живий.
    client.socket.send(new Uint8Array([1, 1, 0, 0, 0, 0, 0xff, 9]));
    assert.equal((await client.closed()).code, 4000);
    assert.equal((await fetch(ctx.http + '/health')).status, 200);
  } finally {
    await ctx.stop();
  }
});

test('JSON-кодек за прапорцем у join', async () => {
  const ctx = await startApp();
  try {
    const client = await connect(ctx.wsUrl);
    const snapshots = [];
    client.socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(data.toString());
      if (message.type === 'snapshot') snapshots.push(message);
    });
    client.send({ type: 'join', room: 'mid', name: 'Анна', codec: 'json' });
    assert.equal((await client.next('welcome')).codec, 'json');
    client.socket.send(CODECS.json.encodeInput(input(1)));
    await sleep(150);
    assert.equal(client.snapshots.length, 0, 'бінарних кадрів немає');
    assert.equal(snapshots.at(-1).ack, 1);
    client.socket.close();
  } finally {
    await ctx.stop();
  }
});
