// Завантажувач і лобі без браузера: fetch підмінено, паузи й випадковість — керовані.
import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';

import {
  HttpError,
  ParseError,
  fetchJson,
  isRetryable,
  loadAll,
  withRetry,
} from '../src/assets/loader.ts';
import { Lobby } from '../src/lobby/lobby.ts';
import { once, sleep } from '../src/async.ts';

const realFetch = globalThis.fetch;
let calls;

// routes: шлях → функція(номер виклику) → Response | Promise<Response> | throw
function mockFetch(routes) {
  calls = {};
  globalThis.fetch = async (url, { signal } = {}) => {
    const path = new URL(url, 'http://test').pathname;
    calls[path] = (calls[path] ?? 0) + 1;
    signal?.throwIfAborted();
    const handler = routes[path];
    if (!handler) return new Response('not found', { status: 404 });
    return handler(calls[path], signal);
  };
}

const json = (value) => new Response(JSON.stringify(value), { status: 200 });
const hang = (_count, signal) =>
  new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
const noWait = async () => {};

beforeEach(() => mockFetch({}));
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('fetchJson: 404 — це HttpError, а не «успіх»', async () => {
  await assert.rejects(fetchJson('http://test/missing.json'), (error) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 404);
    return true;
  });
});

test('fetchJson: битий JSON — ParseError з причиною', async () => {
  mockFetch({ '/bad.json': () => new Response('{ "width": ', { status: 200 }) });
  await assert.rejects(fetchJson('http://test/bad.json'), (error) => {
    assert.ok(error instanceof ParseError);
    assert.ok(error.cause instanceof SyntaxError);
    return true;
  });
});

test('isRetryable: 5xx, таймаут і мережа — так; 4xx, abort і битий файл — ні', () => {
  assert.equal(isRetryable(new HttpError(503, '', 'u')), true);
  assert.equal(isRetryable(new HttpError(429, '', 'u')), true);
  assert.equal(isRetryable(new HttpError(404, '', 'u')), false);
  assert.equal(isRetryable(new HttpError(403, '', 'u')), false);
  assert.equal(isRetryable(new ParseError('x')), false);
  assert.equal(isRetryable(new DOMException('x', 'AbortError')), false);
  assert.equal(isRetryable(new DOMException('x', 'TimeoutError')), true);
  assert.equal(isRetryable(new TypeError('fetch failed')), true);
});

test('withRetry: 503, 503, 200 → успіх з третьої спроби; паузи ростуть удвічі', async () => {
  mockFetch({
    '/flaky.json': (count) => (count < 3 ? new Response('', { status: 503 }) : json({ ok: true })),
  });
  const waits = [];
  const value = await withRetry(() => fetchJson('http://test/flaky.json'), {
    attempts: 3,
    baseMs: 100,
    random: () => 1, // верхня межа jitter
    wait: async (ms) => waits.push(ms),
  });
  assert.deepEqual(value, { ok: true });
  assert.equal(calls['/flaky.json'], 3);
  assert.deepEqual(waits, [100, 200]);
});

test('withRetry: jitter тримає паузу в межах [50 %, 100 %] від експоненти', async () => {
  for (const [random, expected] of [
    [0, [50, 100, 200]],
    [0.5, [75, 150, 300]],
  ]) {
    const waits = [];
    await assert.rejects(
      withRetry(
        () => {
          throw new HttpError(500, '', 'u');
        },
        { attempts: 4, baseMs: 100, random: () => random, wait: async (ms) => waits.push(ms) },
      ),
    );
    assert.deepEqual(waits, expected);
  }
});

test('withRetry: 404 не повторюється', async () => {
  let retries = 0;
  await assert.rejects(
    withRetry(() => fetchJson('http://test/missing.json'), {
      attempts: 5,
      wait: noWait,
      onRetry: () => (retries += 1),
    }),
    HttpError,
  );
  assert.equal(calls['/missing.json'], 1);
  assert.equal(retries, 0);
});

test('withRetry: abort під час паузи зупиняє повтори', async () => {
  mockFetch({ '/down.json': () => new Response('', { status: 500 }) });
  const controller = new AbortController();
  const promise = withRetry(() => fetchJson('http://test/down.json'), {
    attempts: 5,
    baseMs: 10_000, // справжня довга пауза — її має перервати сигнал
    signal: controller.signal,
  });
  await sleep(20);
  controller.abort();
  await assert.rejects(promise, { name: 'AbortError' });
  assert.equal(calls['/down.json'], 1);
});

test('loadAll: прогрес по кожному файлу; необов’язковий 404 не валить завантаження', async () => {
  mockFetch({ '/a.json': () => json({ a: 1 }), '/b.json': () => json({ b: 2 }) });
  const events = [];
  const result = await loadAll(
    {
      items: [
        { id: 'a', type: 'json', url: 'http://test/a.json' },
        { id: 'missing', type: 'json', url: 'http://test/nope.json', optional: true },
        { id: 'b', type: 'json', url: 'http://test/b.json' },
      ],
    },
    {
      wait: noWait,
      onProgress: (event) => events.push(`${event.type}:${event.item.id}:${event.done}`),
    },
  );
  assert.deepEqual(result.assets, { a: { a: 1 }, missing: null, b: { b: 2 } });
  assert.deepEqual(
    result.failures.map((failure) => [failure.id, failure.error.status]),
    [['missing', 404]],
  );
  const finished = events.filter((event) => !event.startsWith('start'));
  assert.equal(finished.length, 3);
  assert.equal(finished.at(-1).split(':')[2], '3', 'лічильник дійшов до кінця');
});

test('loadAll: обов’язковий файл упав → відхилення, а «сусідні» запити скасовано', async () => {
  let neighbourAborted = false;
  mockFetch({
    '/slow.json': (_count, signal) => {
      signal.addEventListener('abort', () => (neighbourAborted = true), { once: true });
      return hang(_count, signal);
    },
  });
  await assert.rejects(
    loadAll(
      {
        items: [
          { id: 'slow', type: 'json', url: 'http://test/slow.json' },
          { id: 'required', type: 'json', url: 'http://test/nope.json' },
        ],
      },
      { wait: noWait },
    ),
    HttpError,
  );
  assert.equal(neighbourAborted, true);
});

test('loadAll: таймаут на спробу → повтор → TimeoutError', async () => {
  mockFetch({ '/hang.json': hang });
  await assert.rejects(
    loadAll(
      { items: [{ id: 'hang', type: 'json', url: 'http://test/hang.json' }] },
      { timeoutMs: 30, attempts: 2, wait: noWait },
    ),
    { name: 'TimeoutError' },
  );
  assert.equal(calls['/hang.json'], 2);
});

test('loadAll: abort посеред завантаження → AbortError, навіть якщо файл optional', async () => {
  mockFetch({ '/hang.json': hang });
  const controller = new AbortController();
  const promise = loadAll(
    { items: [{ id: 'hang', type: 'json', url: 'http://test/hang.json', optional: true }] },
    { signal: controller.signal },
  );
  await sleep(10);
  controller.abort();
  await assert.rejects(promise, { name: 'AbortError' });
});

test('loadAll: concurrent швидший за sequential на тих самих файлах', async () => {
  const delayed = (ms) => async () => {
    await sleep(ms);
    return json({});
  };
  const routes = { '/1.json': delayed(40), '/2.json': delayed(40), '/3.json': delayed(40) };
  const manifest = {
    items: Object.keys(routes).map((path) => ({
      id: path,
      type: 'json',
      url: 'http://test' + path,
    })),
  };
  mockFetch(routes);
  const sequential = await loadAll(manifest, { strategy: 'sequential' });
  const concurrent = await loadAll(manifest, { strategy: 'concurrent' });
  assert.ok(sequential.elapsedMs >= 115, `sequential ${sequential.elapsedMs}`);
  assert.ok(concurrent.elapsedMs < 90, `concurrent ${concurrent.elapsedMs}`);
});

// Лобі перевіряє кімнати схемою протоколу (roomSchema), тому тут повна форма кімнати.
const ARENA_CONFIG = { width: 100, height: 100, asteroids: 5, pickups: 2, seed: 1 };
const ROOMS = {
  rooms: [
    { id: 'a', name: 'A', players: 1, maxPlayers: 4, arena: ARENA_CONFIG },
    { id: 'full', name: 'Full', players: 4, maxPlayers: 4, arena: ARENA_CONFIG },
  ],
};

test('Lobby: refresh → подія rooms; помилка → подія error, старий список лишається', async () => {
  mockFetch({
    '/rooms': (count) => (count === 1 ? json(ROOMS) : new Response('', { status: 500 })),
  });
  const lobby = new Lobby({ url: 'http://test/rooms' });
  assert.ok(lobby instanceof EventTarget);

  const rooms = once(lobby, 'rooms');
  await lobby.refresh();
  assert.equal((await rooms).detail.rooms.length, 2);

  const failed = once(lobby, 'error');
  await lobby.refresh();
  const { detail } = await failed;
  assert.equal(detail.error.status, 500);
  assert.equal(detail.stale, true);
  assert.equal(lobby.rooms.length, 2);
});

test('Lobby: таймаут на кожен запит', async () => {
  mockFetch({ '/rooms': hang });
  const lobby = new Lobby({ url: 'http://test/rooms', timeoutMs: 30 });
  const failed = once(lobby, 'error');
  await lobby.refresh();
  assert.equal((await failed).detail.error.name, 'TimeoutError');
});

test('Lobby: опитування за інтервалом; stop() скасовує запит у польоті без події error', async () => {
  let aborted = 0;
  mockFetch({
    '/rooms': (count, signal) => {
      if (count <= 2) return json(ROOMS);
      signal.addEventListener('abort', () => (aborted += 1), { once: true });
      return hang(count, signal);
    },
  });
  const lobby = new Lobby({ url: 'http://test/rooms', intervalMs: 15, timeoutMs: 5000 });
  let errors = 0;
  lobby.addEventListener('error', () => (errors += 1));

  lobby.start();
  assert.equal(lobby.polling, true);
  await sleep(80); // два швидкі запити, третій «висить»
  assert.equal(calls['/rooms'], 3);

  lobby.stop();
  await sleep(40);
  assert.equal(aborted, 1, 'запит у польоті скасовано');
  assert.equal(errors, 0, 'скасування — не помилка');
  assert.equal(calls['/rooms'], 3, 'нових запитів після stop() немає');
  assert.equal(lobby.polling, false);
});

// Підставне з'єднання: тест сам вирішує, що «відповість сервер».
function fakeConnection() {
  const handlers = new Map();
  const connection = {
    closed: false,
    on(type, handler, { signal } = {}) {
      handlers.set(type, handler);
      signal?.addEventListener('abort', () => handlers.delete(type));
    },
    close() {
      connection.closed = true;
    },
    receive: (type, detail) => handlers.get(type)?.(detail),
    get listeners() {
      return handlers.size;
    },
  };
  return connection;
}

test('Lobby.join: перевіряє ім’я й місця ще до з’єднання', async () => {
  mockFetch({ '/rooms': () => json(ROOMS) });
  let connects = 0;
  const lobby = new Lobby({
    url: 'http://test/rooms',
    intervalMs: 10_000,
    connect: () => (connects += 1),
  });
  lobby.start();
  await once(lobby, 'rooms');

  const problems = [];
  lobby.addEventListener('error', (event) => problems.push(event.detail.error.message));
  assert.equal(await lobby.join('a', 'x'), null);
  assert.equal(await lobby.join('nope', 'Мандрівник'), null);
  assert.equal(await lobby.join('full', 'Мандрівник'), null);
  assert.equal(problems.length, 3);
  assert.equal(connects, 0, 'сокет навіть не відкривали');
  assert.equal(lobby.polling, true);
  lobby.stop();
});

test('Lobby.join: welcome від сервера → joined, опитування зупинено', async () => {
  mockFetch({ '/rooms': () => json(ROOMS) });
  const connection = fakeConnection();
  let asked;
  const lobby = new Lobby({
    url: 'http://test/rooms',
    intervalMs: 10_000,
    connect: (request) => ((asked = request), connection),
  });
  lobby.start();
  await once(lobby, 'rooms');

  const joined = once(lobby, 'joined');
  const result = lobby.join('a', '  Мандрівник  ');
  assert.deepEqual(asked, { roomId: 'a', name: 'Мандрівник' });
  connection.receive('welcome', { playerId: 'p1', room: ROOMS.rooms[0] });

  const { detail } = await joined;
  assert.equal((await result).id, 'a');
  assert.equal(detail.name, 'Мандрівник');
  assert.equal(detail.playerId, 'p1');
  assert.equal(detail.connection, connection);
  assert.equal(lobby.polling, false);
  assert.equal(connection.closed, false);
  assert.equal(connection.listeners, 0, 'тимчасових слухачів знято');
});

test('Lobby.join: відмова сервера або мовчання → error, сокет закрито, лобі живе далі', async () => {
  mockFetch({ '/rooms': () => json(ROOMS) });
  const connections = [];
  const lobby = new Lobby({
    url: 'http://test/rooms',
    intervalMs: 10_000,
    joinTimeoutMs: 40,
    connect: () => {
      connections.push(fakeConnection());
      return connections.at(-1);
    },
  });
  lobby.start();
  await once(lobby, 'rooms');
  const problems = [];
  lobby.addEventListener('error', (event) => problems.push(event.detail.error.message));

  const refused = lobby.join('a', 'Мандрівник');
  connections[0].receive('status', {
    status: 'closed',
    reason: 'кімната заповнена або вже не існує',
  });
  assert.equal(await refused, null);

  assert.equal(await lobby.join('a', 'Мандрівник'), null); // сервер мовчить → таймаут

  assert.deepEqual(problems, ['кімната заповнена або вже не існує', 'сервер не відповів на вхід']);
  assert.ok(connections.every((connection) => connection.closed));
  assert.equal(lobby.polling, true, 'гравець лишився в лобі');
  lobby.stop();
});

test('Lobby.createRoom: POST, потім оновлення списку; помилка сервера → подія error', async () => {
  let posted = null;
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === 'POST') {
      posted = JSON.parse(options.body);
      if (posted.name === 'x') {
        return new Response(JSON.stringify({ error: 'Field "name" must be 2–24 characters' }), {
          status: 400,
        });
      }
      const room = { id: 'new', name: posted.name, players: 0, maxPlayers: 4, arena: ARENA_CONFIG };
      return new Response(JSON.stringify({ room }), { status: 201 });
    }
    return json(ROOMS);
  };
  const lobby = new Lobby({ url: 'http://test/rooms' });
  const refreshed = once(lobby, 'rooms');
  assert.deepEqual(await lobby.createRoom('Нова'), {
    id: 'new',
    name: 'Нова',
    players: 0,
    maxPlayers: 4,
    arena: ARENA_CONFIG,
  });
  await refreshed;

  const failed = once(lobby, 'error');
  assert.equal(await lobby.createRoom('x'), null);
  assert.match((await failed).detail.error.message, /2–24/);
});

test('Шина подій світу: fired / hit / exploded / score приходять синхронно', async () => {
  const { World } = await import('@moba-arena/shared/sim/world.ts');
  const { Ship } = await import('@moba-arena/shared/sim/ship.ts');
  const { Vector2 } = await import('@moba-arena/shared/sim/vector.ts');
  const world = new World({ arena: { width: 1600, height: 900 } });
  const shooter = world.spawn(new Ship({ pos: new Vector2(300, 400), angle: 0 }));
  const victim = world.spawn(new Ship({ pos: new Vector2(420, 400), team: 'red' }));
  const seen = [];
  // world.events — типізована шина (Bus): слухач отримує одразу дані події, без event.detail.
  for (const type of ['fired', 'hit', 'exploded', 'score']) {
    world.events.on(type, () => seen.push(type));
  }
  const inputs = new Map([
    [shooter.id, { turn: 0, thrust: 0, brake: false, dash: false, fire: true }],
  ]);
  for (let i = 0; i < 600 && !victim.isDown; i += 1) world.step(1 / 60, inputs);
  assert.equal(seen[0], 'fired');
  assert.equal(seen.filter((type) => type === 'hit').length, 5);
  assert.deepEqual(seen.slice(-2), ['exploded', 'score']);
});
