// Статистика кроку (p50/p99), лічильники процесу і вибір системи зіткнень.
import { describe, expect, test } from 'vitest';
import { findCollisions } from '@moba-arena/shared/sim/collision.ts';
import { hashWorld } from '@moba-arena/shared/sim/hash.ts';
import { findCollisionsHashed } from '@moba-arena/shared/sim/spatial-hash.ts';
import { loadConfig } from '../src/config.ts';
import { Match, percentile, summarize } from '../src/match.ts';
import { Room } from '../src/rooms.ts';
import { createRuntimeStats } from '../src/runtime-stats.ts';
import { connect, sleep, startApp } from './helpers.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function newMatch(options = {}) {
  const room = new Room({
    id: 'stats',
    name: 'stats',
    arena: { width: 900, height: 600, asteroids: 8, pickups: 2, seed: 11 },
    maxPlayers: 64,
  });
  return new Match({ room, logger, ...options });
}

describe('статистика кроку', () => {
  test('percentile: найближчий ранг, без інтерполяції', () => {
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1); // 1…100
    expect(percentile(hundred, 0.5)).toBe(50);
    expect(percentile(hundred, 0.99)).toBe(99);
    expect(percentile(hundred, 1)).toBe(100);
    expect(percentile(hundred, 0)).toBe(1);
    expect(percentile([7], 0.99)).toBe(7);
    expect(percentile([], 0.99)).toBe(0);
    // 600 кроків (20 с): p99 — 594-те значення за зростанням.
    const window = Array.from({ length: 600 }, (_, i) => i + 1);
    expect(percentile(window, 0.99)).toBe(594);
  });

  test('summarize: avg/p50/p99/max; порядок на вході не важливий; порожній список — нулі', () => {
    const values = [5, 1, 3, 2, 4, 100];
    expect(summarize(values)).toEqual({ avg: 19.167, p50: 3, p99: 100, max: 100 });
    expect(values).toEqual([5, 1, 3, 2, 4, 100]); // вхід не відсортовано «на місці»
    expect(summarize([])).toEqual({ avg: 0, p50: 0, p99: 0, max: 0 });
  });

  test('Match.report(window): типове вікно — 300 кроків, пам’ять — до 1800', async () => {
    const match = newMatch();
    match.addPlayer({ id: 'p1', name: 'Анна' });
    expect(match.report().window).toBe(0);
    match.start();
    await sleep(250);
    match.stop();
    const all = match.report();
    expect(all.window).toBeGreaterThanOrEqual(5);
    expect(all.tickDurationMs.p50).toBeLessThanOrEqual(all.tickDurationMs.p99);
    expect(all.tickDurationMs.p99).toBeLessThanOrEqual(all.tickDurationMs.max);
    expect(all.tickDurationMs.max).toBeGreaterThan(0);
    expect(match.report(3).window).toBe(3);
    expect(match.report(1_000_000).window).toBe(all.window); // більше, ніж є, не вигадуємо
  });

  test('GET /api/stats: p50/p99, ?window=N і лічильники процесу', async () => {
    const ctx = await startApp();
    try {
      const client = await connect(ctx.wsUrl);
      client.send({ type: 'join', room: 'mid', name: 'Анна' });
      await client.next('welcome');
      await sleep(300);

      const first = await (await fetch(ctx.http + '/api/stats?window=5')).json();
      const [match] = first.matches;
      expect(match.window).toBe(5);
      expect(Object.keys(match.tickDurationMs)).toEqual(['avg', 'p50', 'p99', 'max']);
      expect(Object.keys(match.tickLatenessMs)).toEqual(['avg', 'p50', 'p99', 'max']);
      expect(match.tickDurationMs.p99).toBeGreaterThan(0);
      expect(first.process.memory.rss).toBeGreaterThan(1_000_000);
      expect(first.process.gc.count).toBeGreaterThanOrEqual(0);

      // Лічильники циклу подій накопичувальні: другий замір не менший за перший.
      await sleep(100);
      const second = await (await fetch(ctx.http + '/api/stats')).json();
      const before = first.process.eventLoop;
      const after = second.process.eventLoop;
      expect(after.activeMs).toBeGreaterThan(before.activeMs);
      expect(after.idleMs).toBeGreaterThanOrEqual(before.idleMs);
      expect(second.process.uptimeMs).toBeGreaterThan(first.process.uptimeMs);

      for (const bad of ['0', '1801', '2.5', 'abc', '']) {
        const response = await fetch(`${ctx.http}/api/stats?window=${bad}`);
        expect(response.status, `window=${bad}`).toBe(400);
      }
      client.socket.close();
    } finally {
      await ctx.stop();
    }
  });

  test('createRuntimeStats: знімок самодостатній, close() відписує спостерігача', () => {
    const runtime = createRuntimeStats();
    const snapshot = runtime.snapshot();
    expect(snapshot.eventLoop.activeMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.memory.heapUsed).toBeGreaterThan(0);
    expect(snapshot.gc).toEqual({ count: 0, totalMs: 0, maxMs: 0 });
    runtime.close();
  });
});

describe('система зіткнень у матчі', () => {
  test('config: COLLISION=naive|hash, типово hash; ліміт гравців у кімнаті — до 256', () => {
    expect(loadConfig({}).collision).toBe('hash');
    expect(loadConfig({ COLLISION: '' }).collision).toBe('hash');
    expect(loadConfig({ COLLISION: 'naive' }).collision).toBe('naive');
    expect(() => loadConfig({ COLLISION: 'quadtree' })).toThrow(/COLLISION="quadtree"/);
    expect(loadConfig({}).maxPlayersPerRoom).toBe(8);
    expect(loadConfig({ MAX_PLAYERS_PER_ROOM: '256' }).maxPlayersPerRoom).toBe(256);
    expect(() => loadConfig({ MAX_PLAYERS_PER_ROOM: '257' })).toThrow(/MAX_PLAYERS_PER_ROOM/);
  });

  test('матч на просторовому хеші крок у крок збігається з матчем на наївній системі', () => {
    const matches = [newMatch(), newMatch({ collide: findCollisionsHashed })];
    expect(matches[1].world.collide).toBe(findCollisionsHashed);
    for (const match of matches) {
      for (let i = 0; i < 40; i += 1) match.addPlayer({ id: `p${i}`, name: `Гравець ${i}` });
    }
    // 40 героїв на тісній арені: постійні відскоки, постріли, уламки големів.
    for (let step = 1; step <= 450; step += 1) {
      for (const match of matches) {
        for (let i = 0; i < 40; i += 1) {
          match.pushInput(`p${i}`, {
            seq: step,
            turn: Math.floor((step + i * 37) / 45) % 3 === 0 ? 1 : (i + step) % 7 === 0 ? -1 : 0,
            thrust: 1,
            brake: false,
            dash: (step + i) % 90 === 0,
            fire: (step + i) % 3 === 0,
          });
        }
        match.tick();
      }
      expect(hashWorld(matches[1].world), `крок ${step}`).toBe(hashWorld(matches[0].world));
    }
    expect(matches[0].world.size).toBeGreaterThan(40);
  });

  test('сервер типово грає матч на просторовому хеші; COLLISION=naive повертає перебір', async () => {
    for (const [env, expected] of [
      [{}, findCollisionsHashed],
      [{ COLLISION: 'naive' }, findCollisions],
    ]) {
      const ctx = await startApp(env);
      try {
        const client = await connect(ctx.wsUrl);
        client.send({ type: 'join', room: 'mid', name: 'Анна' });
        await client.next('welcome');
        expect(ctx.app.matches.get('mid').world.collide).toBe(expected);
        await sleep(150);
        expect(client.snapshots.length).toBeGreaterThan(1);
        client.socket.close();
      } finally {
        await ctx.stop();
      }
    }
  });
});
