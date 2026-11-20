// Захист рукостискання (Origin, ліміт з'єднань з адреси), /ready, /metrics і лог.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { CLOSE } from '@moba-arena/shared/protocol.ts';
import { createApp } from '../src/app.ts';
import { ConfigError, loadConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';
import { parseMetrics } from '../scripts/chaos.js';
import { connect, sleep, startApp } from './helpers.js';

// Спроба відкрити сокет: { open: true, socket } або { open: false, status } — код HTTP-відмови.
function attempt(url, options) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    socket.on('open', () => resolve({ open: true, socket }));
    socket.on('unexpected-response', (_request, response) => {
      resolve({ open: false, status: response.statusCode });
      socket.terminate();
    });
    socket.on('error', (error) => {
      if (!/Unexpected server response/.test(error.message)) reject(error);
    });
  });
}

const metricsOf = async (ctx, query = '') =>
  parseMetrics(await (await fetch(`${ctx.http}/metrics${query}`)).text());

async function until(condition, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('умова не настала вчасно');
    await sleep(10);
  }
}

test('Origin: зі списку — пускаємо; чужий або відсутній — 403 ще до рукостискання', async () => {
  const ctx = await startApp({
    ALLOWED_ORIGINS: 'https://game.example.com, http://localhost:5173',
  });
  try {
    const good = await attempt(ctx.wsUrl, { origin: 'https://game.example.com' });
    assert.equal(good.open, true);
    // Порівняння без урахування регістру: схема й хост в origin регістронезалежні.
    const second = await attempt(ctx.wsUrl, { origin: 'HTTP://LOCALHOST:5173' });
    assert.equal(second.open, true);

    assert.deepEqual(await attempt(ctx.wsUrl, { origin: 'https://evil.example.com' }), {
      open: false,
      status: 403,
    });
    // Підрядок чи піддомен дозволеного — теж чужий.
    assert.equal(
      (await attempt(ctx.wsUrl, { origin: 'https://game.example.com.evil.io' })).status,
      403,
    );
    // Без Origin (не браузер) — типово відмова, коли список задано.
    assert.deepEqual(await attempt(ctx.wsUrl), { open: false, status: 403 });

    assert.equal(ctx.app.ws.connections(), 2);
    const metrics = await metricsOf(ctx);
    assert.equal(metrics.get('moba_rejections_total{reason="origin_rejected"}'), 3);
    assert.equal(metrics.get('moba_connections_accepted_total'), 2);
    good.socket.close();
    second.socket.close();
  } finally {
    await ctx.stop();
  }
});

test('Origin: ALLOW_NO_ORIGIN=1 пускає скрипти; порожній список — будь-кого', async () => {
  const strict = await startApp({
    ALLOWED_ORIGINS: 'https://game.example.com',
    ALLOW_NO_ORIGIN: '1',
  });
  try {
    const script = await attempt(strict.wsUrl);
    assert.equal(script.open, true);
    script.socket.close();
    assert.equal((await attempt(strict.wsUrl, { origin: 'https://evil.example.com' })).status, 403);
  } finally {
    await strict.stop();
  }

  const dev = await startApp();
  try {
    for (const options of [undefined, { origin: 'https://anything.example' }]) {
      const result = await attempt(dev.wsUrl, options);
      assert.equal(result.open, true);
      result.socket.close();
    }
  } finally {
    await dev.stop();
  }
});

test('ліміт з’єднань з однієї адреси: зайве — 429; закрили одне — місце звільнилось', async () => {
  const ctx = await startApp({ MAX_CONNECTIONS_PER_IP: '2' });
  try {
    const first = await attempt(ctx.wsUrl);
    const second = await attempt(ctx.wsUrl);
    assert.equal(first.open && second.open, true);
    assert.deepEqual(await attempt(ctx.wsUrl), { open: false, status: 429 });
    assert.deepEqual(await attempt(ctx.wsUrl), { open: false, status: 429 });
    assert.equal(ctx.app.ws.connections(), 2);

    first.socket.close();
    await once(first.socket, 'close');
    await until(() => ctx.app.ws.connections() === 1);
    const third = await attempt(ctx.wsUrl);
    assert.equal(third.open, true);
    assert.deepEqual(await attempt(ctx.wsUrl), { open: false, status: 429 });

    // Обірване з'єднання (без кадру закриття) теж звільняє місце.
    second.socket.terminate();
    third.socket.terminate();
    await until(() => ctx.app.ws.connections() === 0);
    assert.equal(ctx.app.ws.connectionsFrom('127.0.0.1'), 0);
    assert.equal(ctx.app.ws.connectionsFrom('::ffff:127.0.0.1'), 0);
    assert.equal((await metricsOf(ctx)).get('moba_rejections_total{reason="ip_limit"}'), 3);
  } finally {
    await ctx.stop();
  }
});

test('TRUST_PROXY: адреса клієнта — перший запис X-Forwarded-For; без прапорця заголовок ігнорується', async () => {
  const proxied = await startApp({ MAX_CONNECTIONS_PER_IP: '1', TRUST_PROXY: '1' });
  try {
    const anna = await attempt(proxied.wsUrl, {
      headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
    });
    const boris = await attempt(proxied.wsUrl, { headers: { 'x-forwarded-for': '198.51.100.9' } });
    assert.equal(
      anna.open && boris.open,
      true,
      'різні клієнти за одним проксі не заважають один одному',
    );
    assert.equal(proxied.app.ws.connectionsFrom('203.0.113.7'), 1);
    const again = await attempt(proxied.wsUrl, { headers: { 'x-forwarded-for': '203.0.113.7' } });
    assert.deepEqual(again, { open: false, status: 429 });
    anna.socket.close();
    boris.socket.close();
  } finally {
    await proxied.stop();
  }

  const direct = await startApp({ MAX_CONNECTIONS_PER_IP: '1' });
  try {
    const first = await attempt(direct.wsUrl, { headers: { 'x-forwarded-for': '203.0.113.7' } });
    assert.equal(first.open, true);
    // Підроблений заголовок не допомагає обійти ліміт.
    const spoofed = await attempt(direct.wsUrl, { headers: { 'x-forwarded-for': '198.51.100.9' } });
    assert.deepEqual(spoofed, { open: false, status: 429 });
    first.socket.close();
  } finally {
    await direct.stop();
  }
});

test('/ready: 200, доки сервер приймає гравців; під час зупинки — 503 і відмова в рукостисканні', async () => {
  const ctx = await startApp();
  const ready = await fetch(ctx.http + '/ready');
  assert.equal(ready.status, 200);
  const body = await ready.json();
  assert.equal(body.status, 'ready');
  assert.equal(body.version, 'dev');
  assert.equal(body.capacity, 160);

  // Клієнт не читає сокет — отже, не відповість на закриття, і зупинка чекатиме на нього ~1 с.
  const deaf = await connect(ctx.wsUrl);
  deaf.send({ type: 'join', room: 'mid', name: 'Глухий' });
  await deaf.next('welcome');
  deaf.socket.pause();

  const closing = ctx.app.close();
  assert.equal(ctx.app.ready, false);
  const during = await fetch(ctx.http + '/ready');
  assert.equal(during.status, 503);
  assert.equal((await during.json()).status, 'shutting_down');
  assert.equal((await fetch(ctx.http + '/health')).status, 200, 'процес живий — liveness не падає');
  assert.deepEqual(await attempt(ctx.wsUrl), { open: false, status: 503 });
  assert.equal(ctx.app.metrics.rejections().shutting_down, 1);

  await closing;
  assert.equal(ctx.app.server.listening, false);
  deaf.socket.terminate();
  await ctx.stop();
});

test('/health: версія з GIT_SHA; welcome теж її несе', async () => {
  const ctx = await startApp({ GIT_SHA: 'abc1234' });
  try {
    const health = await (await fetch(ctx.http + '/health')).json();
    assert.equal(health.version, 'abc1234');
    assert.equal(health.ready, true);
    const client = await connect(ctx.wsUrl);
    client.send({ type: 'join', room: 'mid', name: 'Анна' });
    assert.equal((await client.next('welcome')).version, 'abc1234');
    client.socket.close();
  } finally {
    await ctx.stop();
  }
});

test('/metrics: формат Prometheus, гравці й кімнати, квантилі кроку за кімнатою, відмови за причиною', async () => {
  const ctx = await startApp({
    GIT_SHA: 'abc1234',
    RATE_LIMIT_PER_SECOND: '5',
    JOIN_TIMEOUT_MS: '80',
  });
  try {
    const response = await fetch(ctx.http + '/metrics');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/plain; version=0\.0\.4/);
    const text = await response.text();
    // Кожен рядок — коментар (# HELP / # TYPE) або «ім'я{мітки} число».
    for (const line of text.trimEnd().split('\n')) {
      assert.match(line, /^(# (HELP|TYPE) \w+ .+|[a-z_]+(\{[^}]*\})? -?[\d.e+-]+)$/, line);
    }
    assert.match(text, /^# TYPE moba_rejections_total counter$/m);
    const empty = parseMetrics(text);
    assert.equal(empty.get('moba_build_info{version="abc1234"}'), 1);
    assert.equal(empty.get('moba_ready'), 1);
    assert.equal(empty.get('moba_rooms'), 3);
    assert.equal(empty.get('moba_players'), 0);
    assert.equal(empty.get('moba_matches'), 0);
    assert.ok(empty.get('moba_memory_rss_bytes') > 0);
    assert.ok(empty.get('moba_memory_heap_used_bytes') > 0);
    assert.ok(empty.has('moba_event_loop_utilization'));

    const anna = await connect(ctx.wsUrl);
    anna.send({ type: 'join', room: 'mid', name: 'Анна' });
    await anna.next('welcome');
    const boris = await connect(ctx.wsUrl);
    boris.send({ type: 'join', room: 'river', name: 'Борис' });
    await boris.next('welcome');
    await sleep(300);

    // Відмови — кожна зі своєю причиною.
    const cases = [
      ['not json', CLOSE.BAD_MESSAGE],
      ['{"v":1,"type":"teleport"}', CLOSE.UNKNOWN_TYPE],
      ['{"v":7,"type":"ping","t":1}', CLOSE.VERSION],
      ['{"v":1,"type":"join","room":"nowhere","name":"Привид"}', CLOSE.JOIN_REJECTED],
      ['x'.repeat(5000), CLOSE.TOO_BIG],
    ];
    for (const [raw, code] of cases) {
      const client = await connect(ctx.wsUrl);
      client.socket.send(raw);
      assert.equal((await client.closed()).code, code, raw.slice(0, 30));
    }
    const binary = await connect(ctx.wsUrl);
    binary.socket.send(Buffer.from([9, 9, 9]));
    assert.equal((await binary.closed()).code, CLOSE.BAD_MESSAGE);
    const silent = await connect(ctx.wsUrl);
    assert.equal((await silent.closed()).code, CLOSE.JOIN_TIMEOUT);
    const chatty = await connect(ctx.wsUrl);
    chatty.send({ type: 'join', room: 'mid', name: 'Балакун' });
    await chatty.next('welcome');
    for (let i = 0; i < 20; i += 1) chatty.send({ type: 'ping', t: i });
    assert.equal((await chatty.closed()).code, CLOSE.RATE_LIMIT);
    await until(() => ctx.app.ws.connections() === 2);

    const metrics = await metricsOf(ctx, '?window=5');
    assert.equal(metrics.get('moba_connections'), 2);
    assert.equal(metrics.get('moba_players'), 2);
    assert.equal(metrics.get('moba_matches'), 2);
    assert.equal(metrics.get('moba_room_players{room="mid"}'), 1);
    assert.equal(metrics.get('moba_room_players{room="river"}'), 1);
    for (const room of ['mid', 'river', '*']) {
      const p50 = metrics.get(`moba_tick_duration_ms{room="${room}",quantile="0.5"}`);
      const p99 = metrics.get(`moba_tick_duration_ms{room="${room}",quantile="0.99"}`);
      assert.ok(p50 > 0 && p99 >= p50, `${room}: p50=${p50} p99=${p99}`);
    }
    assert.ok(metrics.has('moba_tick_lateness_ms{room="river",quantile="0.99"}'));
    assert.ok(metrics.get('moba_room_ticks_total{room="mid"}') > 5);
    assert.ok(metrics.get('moba_messages_in_total') >= 10);
    assert.ok(metrics.get('moba_bytes_in_total') > 100);
    assert.ok(metrics.get('moba_bytes_out_total') > 1000);
    const rejected = (reason) => metrics.get(`moba_rejections_total{reason="${reason}"}`);
    assert.equal(rejected('bad_message'), 2);
    assert.equal(rejected('unknown_type'), 1);
    assert.equal(rejected('bad_version'), 1);
    assert.equal(rejected('room_not_found'), 1);
    assert.equal(rejected('oversize'), 1);
    assert.equal(rejected('join_timeout'), 1);
    assert.equal(rejected('rate_limit'), 1);
    assert.equal(rejected('origin_rejected'), 0);

    assert.equal((await fetch(ctx.http + '/metrics?window=0')).status, 400);
    const stats = await (await fetch(ctx.http + '/api/stats')).json();
    assert.equal(stats.rejections.rate_limit, 1);
    anna.socket.close();
    boris.socket.close();
  } finally {
    await ctx.stop();
  }
});

test('/metrics: кімната заповнена й повільний клієнт теж рахуються', async () => {
  const ctx = await startApp({ MAX_PLAYERS_PER_ROOM: '1' });
  try {
    const anna = await connect(ctx.wsUrl);
    anna.send({ type: 'join', room: 'mid', name: 'Анна' });
    await anna.next('welcome');
    const late = await connect(ctx.wsUrl);
    late.send({ type: 'join', room: 'mid', name: 'Запізнілий' });
    assert.equal((await late.closed()).code, CLOSE.JOIN_REJECTED);
    assert.equal(ctx.app.metrics.rejections().room_full, 1);
    anna.socket.close();
  } finally {
    await ctx.stop();
  }
});

test('порушника, що не відповідає на закриття, сервер обриває сам; сміття після закриття не розбирається', async () => {
  const ctx = await startApp();
  try {
    const client = await connect(ctx.wsUrl);
    client.send({ type: 'join', room: 'mid', name: 'Флудер' });
    await client.next('welcome');
    // 200 зіпсованих кадрів одним махом: рахується й логується одна відмова, а не двісті.
    for (let i = 0; i < 200; i += 1) client.socket.send('сміття ' + i);
    await until(() => ctx.app.metrics.rejections().bad_message === 1);
    await sleep(100);
    assert.equal(ctx.app.metrics.rejections().bad_message, 1);
    assert.equal(ctx.app.ws.stats.rejected, 1);
    assert.equal((await client.closed()).code, CLOSE.BAD_MESSAGE);
    await until(() => ctx.app.ws.connections() === 0);
    assert.equal(ctx.app.rooms.get('mid').size, 0);

    // Клієнт, який після порушення перестав читати сокет: кадру закриття від нього не буде.
    const deaf = await connect(ctx.wsUrl);
    deaf.socket.pause();
    deaf.socket.send('знову сміття');
    await until(() => ctx.app.metrics.rejections().bad_message === 2);
    assert.equal(ctx.app.ws.connections(), 1);
    await until(() => ctx.app.ws.connections() === 0, 2500);
    deaf.socket.terminate();
  } finally {
    await ctx.stop();
  }
});

test('config: нові змінні, типові значення і помилки разом з іншими', () => {
  const defaults = loadConfig({});
  assert.deepEqual(defaults.allowedOrigins, []);
  assert.equal(defaults.allowNoOrigin, false);
  assert.equal(defaults.maxConnectionsPerIp, 32);
  assert.equal(defaults.trustProxy, false);
  assert.equal(defaults.version, 'dev');

  const custom = loadConfig({
    ALLOWED_ORIGINS: ' https://Game.example.com ,http://localhost:5173,',
    MAX_CONNECTIONS_PER_IP: '4',
    TRUST_PROXY: 'true',
    GIT_SHA: '0a1b2c3',
    LOG_LEVEL: 'fatal',
  });
  assert.deepEqual(custom.allowedOrigins, ['https://game.example.com', 'http://localhost:5173']);
  assert.equal(custom.maxConnectionsPerIp, 4);
  assert.equal(custom.trustProxy, true);
  assert.equal(custom.version, '0a1b2c3');
  assert.equal(custom.logLevel, 'fatal');

  assert.throws(
    () =>
      loadConfig({
        ALLOWED_ORIGINS: 'https://game.example.com/play',
        MAX_CONNECTIONS_PER_IP: '0',
        TRUST_PROXY: 'maybe',
        PORT: 'abc',
      }),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.problems.length, 4);
      assert.match(error.message, /ALLOWED_ORIGINS=/);
      assert.match(error.message, /MAX_CONNECTIONS_PER_IP="0"/);
      return true;
    },
  );
  assert.throws(() => loadConfig({ ALLOWED_ORIGINS: 'game.example.com' }), ConfigError);
  assert.throws(() => loadConfig({ ALLOWED_ORIGINS: '*' }), ConfigError);
});

test('logger: JSON-рядки pino, дочірні поля в кожному рядку, рівні й приховані заголовки', () => {
  const lines = [];
  const logger = createLogger({ level: 'info', stream: { write: (line) => lines.push(line) } });
  logger.debug('нижче за рівень');
  logger.info('server listening', { port: 3000 });
  const room = logger.child({ roomId: 'mid' });
  const player = room.child({ playerId: 'p1' });
  player.warn('closing socket', { code: 4000 });
  room.error('match log failed');
  logger.fatal('uncaught exception', { error: 'Error: boom\n    at x' });
  logger.info('request', {
    headers: { authorization: 'Bearer secret-token', cookie: 'sid=secret', accept: '*/*' },
  });

  const records = lines.map((line) => JSON.parse(line));
  assert.equal(
    lines.every((line) => line.endsWith('\n') && line.trim().split('\n').length === 1),
    true,
  );
  assert.deepEqual(
    records.map((record) => [record.level, record.msg]),
    [
      ['info', 'server listening'],
      ['warn', 'closing socket'],
      ['error', 'match log failed'],
      ['fatal', 'uncaught exception'],
      ['info', 'request'],
    ],
  );
  assert.equal(records[0].port, 3000);
  assert.ok(!Number.isNaN(Date.parse(records[0].time)));
  assert.deepEqual(
    { roomId: records[1].roomId, playerId: records[1].playerId, code: records[1].code },
    { roomId: 'mid', playerId: 'p1', code: 4000 },
  );
  assert.equal(records[2].roomId, 'mid');
  assert.equal(records[2].playerId, undefined);
  assert.deepEqual(records[4].headers, {
    authorization: '[redacted]',
    cookie: '[redacted]',
    accept: '*/*',
  });
  assert.doesNotMatch(lines.join(''), /secret/);

  const silent = [];
  const quiet = createLogger({ level: 'silent', stream: { write: (line) => silent.push(line) } });
  quiet.fatal('навіть це');
  quiet.child({ roomId: 'x' }).error('і це');
  assert.equal(silent.length, 0);
});

test('лог сервера: рядки про кімнату й гравця несуть roomId і playerId; тексту чату немає', async () => {
  const lines = [];
  const logger = createLogger({ level: 'info', stream: { write: (line) => lines.push(line) } });
  const dir = await mkdtemp(join(tmpdir(), 'moba-log-'));
  const app = await createApp(loadConfig({ PORT: '0', LOG_DIR: dir, CLIENT_DIST: dir }), {
    logger,
  });
  const { port } = await app.listen();
  try {
    const client = await connect(`ws://127.0.0.1:${port}/ws`);
    client.send({ type: 'join', room: 'mid', name: 'Анна' });
    await client.next('welcome');
    client.send({ type: 'chat', text: 'таємний текст чату' });
    await client.next('chat');
    client.socket.send('сміття');
    await client.closed();
    await until(() => app.ws.connections() === 0);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }

  const records = lines.map((line) => JSON.parse(line));
  const about = (msg) => records.find((record) => record.msg === msg);
  for (const msg of ['player joined', 'closing socket', 'player left']) {
    const record = about(msg);
    assert.ok(record, msg);
    assert.equal(record.roomId, 'mid', msg);
    assert.match(record.playerId, /^[0-9a-f]{8}$/, msg);
  }
  for (const msg of ['match started', 'match stopped', 'match log opened', 'match log closed']) {
    assert.equal(about(msg)?.roomId, 'mid', msg);
  }
  assert.equal(about('closing socket').rejection, 'bad_message');
  assert.equal(about('closing socket').level, 'warn');
  assert.doesNotMatch(lines.join(''), /таємний текст чату/);
});
