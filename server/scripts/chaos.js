// Хаос-тести: ламаємо справжній сервер трьома способами й дивимось, що з цього вийде.
//
//   npm run chaos -w server                 # усі три сценарії + звіт у docs/lab-08/chaos-report.md
//   node scripts/chaos.js --only=flood      # один сценарій: vanish | kill | flood
//   node scripts/chaos.js --phase=5         # коротші фази сценарію flood (с)
//
//   а) vanish — клієнт зникає посеред матчу (сокет знищено без кадру закриття; окремо —
//      клієнт «завис» і не відповідає на ping);
//   б) kill   — сервер убито SIGKILL посеред матчу й запущено знову на тому самому порту;
//   в) flood  — клієнт у кімнаті A шле ~1000 зіпсованих кадрів за секунду; дивимось
//      на кроки кімнати B.
//
// Сценарії — звичайні функції, що повертають числа: ті самі функції викликає test/chaos.test.js
// і перевіряє на них інваріанти.

import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { TICK_MS, TICK_RATE } from '@moba-arena/shared/protocol.ts';
import { createConnection } from '../../client/src/net/connection.ts';
import { sleep, spawnServer, startPlayer } from './lib.js';

// --- допоміжне ---------------------------------------------------------------------------------

// Текст /metrics → Map «ім'я{мітки}» → число.
export function parseMetrics(text) {
  const values = new Map();
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const space = line.lastIndexOf(' ');
    values.set(line.slice(0, space), Number(line.slice(space + 1)));
  }
  return values;
}

export async function readMetrics(server, window) {
  const query = window === undefined ? '' : `?window=${window}`;
  const response = await fetch(`${server.http}/metrics${query}`);
  if (!response.ok) throw new Error(`/metrics відповів ${response.status}`);
  return parseMetrics(await response.text());
}

const rejectionsOf = (metrics) =>
  Object.fromEntries(
    [...metrics]
      .filter(([key]) => key.startsWith('moba_rejections_total{'))
      .map(([key, value]) => [/reason="([^"]+)"/.exec(key)[1], value]),
  );

async function until(condition, { timeoutMs, stepMs = 10, what }) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (performance.now() > deadline) throw new Error(`не дочекалися: ${what}`);
    await sleep(stepMs);
  }
}

// «Сирий» гравець: справжній сокет, до якого сценарій має повний доступ (щоб його зламати).
async function joinRaw(wsUrl, { room, name }) {
  const socket = new WebSocket(wsUrl);
  socket.on('error', () => {}); // зламаний сокет — частина досліду, а не помилка скрипта
  await once(socket, 'open');
  const welcomed = new Promise((done, fail) => {
    socket.on('message', (data, isBinary) => {
      if (!isBinary && data.toString().includes('"type":"welcome"')) done();
    });
    socket.once('close', (code) => fail(new Error(`сокет ${name} закрито з кодом ${code}`)));
  });
  socket.send(JSON.stringify({ v: 1, type: 'join', room, name }));
  await welcomed;
  return socket;
}

const round = (value, digits = 1) => Number(value.toFixed(digits));

// Тимчасова тека для журналів матчів: досліди не смітять у репозиторії.
async function withLogDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'moba-chaos-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- а) клієнт зникає -----------------------------------------------------------------------

export function vanishScenario({ heartbeatMs = 1000, others = 3 } = {}) {
  return withLogDir(async (dir) => {
    const server = await spawnServer({ LOG_DIR: dir, HEARTBEAT_MS: String(heartbeatMs) });
    const players = [];
    try {
      for (let i = 0; i < others; i += 1) {
        players.push(
          await startPlayer(server.wsUrl, { room: 'mid', name: `Гравець ${i}`, index: i }),
        );
      }
      const destroyed = await joinRaw(server.wsUrl, { room: 'mid', name: 'Зниклий' });
      const frozen = await joinRaw(server.wsUrl, { room: 'mid', name: 'Завислий' });
      await sleep(500);
      const playersIn = async () =>
        (await readMetrics(server)).get('moba_room_players{room="mid"}');
      const initial = await playersIn();

      // 1. Сокет знищено: кадру закриття WebSocket немає, але ОС закриває TCP-з'єднання,
      //    тож сервер бачить обрив одразу (код 1006) — heartbeat тут навіть не потрібен.
      let startedAt = performance.now();
      destroyed._socket.destroy();
      await until(async () => (await playersIn()) === initial - 1, {
        timeoutMs: 5000,
        stepMs: 5,
        what: 'сервер прибрав гравця зі знищеним сокетом',
      });
      const destroyedMs = performance.now() - startedAt;

      // 2. Клієнт «завис» (ноутбук закрили, Wi-Fi відпав): TCP живий, але на ping ніхто
      //    не відповідає. Саме для цього heartbeat: два пропущені pong — і terminate().
      startedAt = performance.now();
      frozen.pause(); // сокет більше нічого не читає — отже, і pong не надішле
      await until(async () => (await playersIn()) === initial - 2, {
        timeoutMs: heartbeatMs * 3 + 3000,
        stepMs: 20,
        what: 'heartbeat прибрав завислого гравця',
      });
      const frozenMs = performance.now() - startedAt;
      frozen.terminate();

      // Решта грає далі: за секунду кожен отримує свої знімки, а матч рахує кроки.
      const framesBefore = players.map((player) => player.stats.frames);
      const before = await readMetrics(server);
      await sleep(1000);
      const after = await readMetrics(server);
      const framesPerSecond = players.map((player, i) => player.stats.frames - framesBefore[i]);

      return {
        heartbeatMs,
        heartbeatWindowMs: heartbeatMs * 3,
        playersBefore: initial,
        playersAfter: after.get('moba_room_players{room="mid"}'),
        destroyedMs: round(destroyedMs),
        frozenMs: round(frozenMs),
        heartbeatLost: after.get('moba_rejections_total{reason="heartbeat_lost"}'),
        matches: after.get('moba_matches'),
        connections: after.get('moba_connections'),
        ticksPerSecond:
          after.get('moba_room_ticks_total{room="mid"}') -
          before.get('moba_room_ticks_total{room="mid"}'),
        othersFramesPerSecond: framesPerSecond,
        othersClosed: players.filter((player) => player.stats.closeCode !== null).length,
        logLines: server
          .logs()
          .filter((record) => record.msg === 'heartbeat lost')
          .map(({ level, msg, roomId, playerId }) => ({ level, msg, roomId, playerId })),
      };
    } finally {
      for (const player of players) player.close();
      await server.stop();
    }
  });
}

// --- б) сервер убито ------------------------------------------------------------------------

// restartDelayMs — скільки «платформа» чекає, перш ніж запустити процес знову.
export function killScenario({ clients = 4, restartDelayMs = 1000, baseMs, maxMs } = {}) {
  return withLogDir(async (dir) => {
    let server = await spawnServer({ LOG_DIR: dir });
    const { port } = server;
    // Справжнє клієнтське з'єднання (client/src/net/connection.ts) на глобальному WebSocket
    // із Node: та сама черга, той самий backoff із jitter, що й у браузері.
    const sessions = Array.from({ length: clients }, (_, i) => {
      const connection = createConnection({
        url: server.wsUrl,
        hello: () => ({ type: 'join', room: 'mid', name: `Клієнт ${i}` }),
        ...(baseMs === undefined ? {} : { baseMs }),
        ...(maxMs === undefined ? {} : { maxMs }),
      });
      const session = { connection, welcomes: [], waits: [] };
      connection.on('welcome', (welcome) =>
        session.welcomes.push({ at: performance.now(), playerId: welcome.playerId }),
      );
      connection.onStatus((event) => {
        if (event.status === 'waiting') session.waits.push(round(event.waitMs, 0));
      });
      return session;
    });
    try {
      await until(() => sessions.every((session) => session.welcomes.length === 1), {
        timeoutMs: 5000,
        what: 'усі клієнти в кімнаті',
      });
      await sleep(3000); // матч іде
      const tickBefore = (await readMetrics(server)).get('moba_room_ticks_total{room="mid"}');

      const killedAt = performance.now();
      const exit = await server.kill(); // SIGKILL: жодного shutdown, жодного кадру закриття
      await sleep(restartDelayMs);
      server = await spawnServer({ LOG_DIR: dir }, { port });
      const upAt = performance.now();

      await until(() => sessions.every((session) => session.welcomes.length === 2), {
        timeoutMs: 30_000,
        what: 'усі клієнти повернулися після перезапуску',
      });
      const recoveries = sessions.map((session) => session.welcomes[1].at - killedAt);
      await sleep(500);
      const metrics = await readMetrics(server);

      return {
        clients,
        restartDelayMs,
        exit,
        downtimeMs: round(upAt - killedAt, 0),
        recoverMs: recoveries.map((ms) => round(ms, 0)),
        recoverMinMs: round(Math.min(...recoveries), 0),
        recoverMaxMs: round(Math.max(...recoveries), 0),
        // Скільки з цього — очікування самого клієнта вже ПІСЛЯ того, як сервер піднявся.
        afterUpMaxMs: round(Math.max(...sessions.map((s) => s.welcomes[1].at - upAt)), 0),
        attempts: sessions.map((session) => session.waits.length),
        waits: sessions.map((session) => session.waits),
        newPlayerIds: sessions.every((s) => s.welcomes[0].playerId !== s.welcomes[1].playerId),
        statuses: sessions.map((session) => session.connection.status),
        playersAfter: metrics.get('moba_room_players{room="mid"}'),
        tickBefore,
        tickAfter: metrics.get('moba_room_ticks_total{room="mid"}'),
      };
    } finally {
      for (const session of sessions) session.connection.close();
      await server.stop();
    }
  });
}

// --- в) потік сміття ------------------------------------------------------------------------

// Різне сміття: кожен вид сервер відхиляє на своєму етапі розбору.
const GARBAGE = [
  () => 'це не JSON {{{',
  () => '[1,2,3]',
  () => JSON.stringify({ v: 1, type: 'teleport', x: 1e9 }),
  () => JSON.stringify({ v: 99, type: 'chat', text: 'x' }),
  () => JSON.stringify({ v: 1, type: 'chat', text: 42 }),
  () => JSON.stringify({ v: 1, type: 'input', seq: -1, turn: 5 }),
  () => Buffer.from([0xff, 0x00, 0x13, 0x37, 0xde, 0xad]),
  () => Buffer.alloc(64, 0xab),
];

// Нападник: заходить у кімнату як чесний гравець, потім шле сміття з частотою rate кадрів/с.
// Сервер закриває його на першому ж кадрі — тож нападник підключається знову й знову.
function startFlooder(wsUrl, { room, rate }) {
  const stats = { sent: 0, connections: 0, closeCodes: {}, closeMs: [], refused: 0 };
  const burst = Math.max(1, Math.round(rate / 100)); // кадрів за одне коло таймера
  const startedAt = performance.now();
  let running = true;
  let timer = null;
  let planned = 0;
  // Поточне з'єднання: ready — сервер прийняв у кімнату; firstAt — коли пішов перший кадр сміття.
  let active = null;

  function connect() {
    const link = { socket: new WebSocket(wsUrl), opened: false, ready: false, firstAt: null };
    active = link;
    link.socket.on('error', () => {
      if (!link.opened) stats.refused += 1; // відмова ще на рукостисканні (429, 503…)
    });
    link.socket.on('open', () => {
      link.opened = true;
      stats.connections += 1;
      link.socket.send(JSON.stringify({ v: 1, type: 'join', room, name: 'Флудер' }));
    });
    link.socket.on('message', (data, isBinary) => {
      if (!isBinary && data.toString().includes('"type":"welcome"')) link.ready = true;
    });
    link.socket.on('close', (code) => {
      if (link.firstAt !== null && running) stats.closeMs.push(performance.now() - link.firstAt);
      // Останній сокет обриває сам дослід (stop) — це не рішення сервера, його не рахуємо.
      if (link.opened && running) stats.closeCodes[code] = (stats.closeCodes[code] ?? 0) + 1;
      if (active === link) active = null; // наступне коло таймера підключиться знову
    });
  }

  function loop() {
    if (!running) return;
    // Скільки кадрів мало б піти на цю мить (абсолютний розклад, без дрейфу).
    const due = Math.floor(((performance.now() - startedAt) / 1000) * rate);
    if (active === null) connect();
    else if (active.ready && active.socket.readyState === WebSocket.OPEN) {
      active.firstAt ??= performance.now();
      for (let i = 0; i < burst && planned < due; i += 1) {
        const make = GARBAGE[stats.sent % GARBAGE.length];
        active.socket.send(make());
        stats.sent += 1;
        planned += 1;
      }
    }
    // Відстали більш ніж на секунду — не наздоганяємо одним велетенським сплеском.
    if (planned < due - rate) planned = due - rate;
    timer = setTimeout(loop, 2);
  }
  loop();

  return {
    stats,
    stop() {
      running = false;
      clearTimeout(timer);
      active?.socket.terminate();
    },
  };
}

function phaseNumbers(metrics, room) {
  const get = (name, quantile) => metrics.get(`${name}{room="${room}",quantile="${quantile}"}`);
  return {
    tickP50: get('moba_tick_duration_ms', '0.5'),
    tickP99: get('moba_tick_duration_ms', '0.99'),
    tickMax: get('moba_tick_duration_ms', '1'),
    lateP50: get('moba_tick_lateness_ms', '0.5'),
    lateP99: get('moba_tick_lateness_ms', '0.99'),
  };
}

export function floodScenario({
  phaseSeconds = 10,
  rate = 1000,
  playersB = 4,
  playersA = 2,
  roomA = 'mid',
  roomB = 'river',
} = {}) {
  return withLogDir(async (dir) => {
    const server = await spawnServer({ LOG_DIR: dir });
    const players = [];
    let flooder = null;
    try {
      for (let i = 0; i < playersB; i += 1) {
        players.push(
          await startPlayer(server.wsUrl, {
            room: roomB,
            name: `B${i}`,
            index: i,
            offsetMs: (i * TICK_MS) / playersB,
          }),
        );
      }
      for (let i = 0; i < playersA; i += 1) {
        players.push(
          await startPlayer(server.wsUrl, { room: roomA, name: `A${i}`, index: i + 10 }),
        );
      }
      await sleep(3000); // розігрів: JIT, перші зіткнення

      const window = phaseSeconds * TICK_RATE; // стільки кроків уміщає одна фаза
      const stats = async () => (await fetch(`${server.http}/api/stats?window=1`)).json();
      // Частка зайнятості циклу подій за фазу — з накопичувальних лічильників процесу.
      const loopShare = (from, to) => {
        const active = to.process.eventLoop.activeMs - from.process.eventLoop.activeMs;
        const idle = to.process.eventLoop.idleMs - from.process.eventLoop.idleMs;
        return round((active / (active + idle)) * 100, 1);
      };
      const tickOf = (metrics) => metrics.get(`moba_room_ticks_total{room="${roomB}"}`);

      async function phase(action) {
        const from = await stats();
        const ticksFrom = tickOf(await readMetrics(server));
        const startedAt = performance.now();
        await action();
        await sleep(Math.max(0, phaseSeconds * 1000 - (performance.now() - startedAt)));
        const seconds = (performance.now() - startedAt) / 1000;
        const metrics = await readMetrics(server, window);
        const to = await stats();
        return {
          ...phaseNumbers(metrics, roomB),
          eventLoopPercent: loopShare(from, to),
          ticksPerSecond: round((tickOf(metrics) - ticksFrom) / seconds, 1),
          metrics,
        };
      }

      const before = await phase(() => {});
      const during = await phase(() => {
        flooder = startFlooder(server.wsUrl, { room: roomA, rate });
      });
      flooder.stop();
      await sleep(1000); // сокет нападника закрився, кімната A заспокоїлась
      const after = await phase(() => {});

      const rejectedBefore = rejectionsOf(before.metrics);
      const rejectedAfter = rejectionsOf(after.metrics);
      const rejections = Object.fromEntries(
        Object.entries(rejectedAfter)
          .map(([reason, value]) => [reason, value - rejectedBefore[reason]])
          .filter(([, value]) => value > 0),
      );
      const closeMs = flooder.stats.closeMs.toSorted((a, b) => a - b);
      const logged = server.logs().filter((record) => record.msg === 'closing socket');
      const strip = ({ metrics: _metrics, ...numbers }) => numbers;

      return {
        phaseSeconds,
        rate,
        playersA,
        playersB,
        roomA,
        roomB,
        before: strip(before),
        during: strip(during),
        after: strip(after),
        flood: {
          framesSent: flooder.stats.sent,
          framesPerSecond: round(flooder.stats.sent / phaseSeconds, 0),
          connections: flooder.stats.connections,
          refused: flooder.stats.refused,
          closeCodes: flooder.stats.closeCodes,
          closeFirstMs: round(flooder.stats.closeMs[0] ?? NaN, 2),
          closeP50Ms: round(closeMs[Math.floor(closeMs.length / 2)] ?? NaN, 2),
          closeMaxMs: round(closeMs.at(-1) ?? NaN, 2),
        },
        rejections,
        rejectionsTotal: Object.values(rejections).reduce((sum, value) => sum + value, 0),
        loggedCloses: logged.length,
        // Чи кожен запис про закриття несе roomId і playerId (перший кадр сміття приходить
        // уже після входу в кімнату).
        loggedWithIds: logged.filter((record) => record.roomId && record.playerId).length,
        logSample: logged.slice(0, 2),
        playersInB: after.metrics.get(`moba_room_players{room="${roomB}"}`),
        closedPlayers: players.filter((player) => player.stats.closeCode !== null).length,
      };
    } finally {
      flooder?.stop();
      for (const player of players) player.close();
      await server.stop();
    }
  });
}

// --- звіт -------------------------------------------------------------------------------------

function report({ vanish, kill, flood }) {
  const lines = ['# Хаос-тести сервера (Lab 8)', ''];
  lines.push(
    `Згенеровано \`npm run chaos -w server\` ${new Date().toISOString()} ` +
      `(Node ${process.version}, ${process.platform}/${process.arch}). ` +
      'Сервер — справжній окремий процес; клієнти — на тій самій машині, тож мережевих затримок немає.',
    '',
  );

  if (vanish) {
    lines.push(
      '## а) Клієнт зникає посеред матчу',
      '',
      `У кімнаті ${vanish.playersBefore} гравців, HEARTBEAT_MS=${vanish.heartbeatMs} ` +
        `(у продакшені типово 15000 — часи нижче масштабуються разом із ним).`,
      '',
      '| Що сталося | Через скільки сервер прибрав гравця |',
      '| --- | --- |',
      `| сокет знищено без кадру закриття (ОС закрила TCP) | ${vanish.destroyedMs} мс |`,
      `| клієнт «завис»: TCP живий, на ping не відповідає | ${vanish.frozenMs} мс (вікно heartbeat — до ${vanish.heartbeatWindowMs} мс) |`,
      '',
      `Після цього: гравців у кімнаті ${vanish.playersAfter}, матчів ${vanish.matches}, ` +
        `з’єднань ${vanish.connections}; лічильник \`moba_rejections_total{reason="heartbeat_lost"}\` = ${vanish.heartbeatLost}. ` +
        `Матч іде далі: ${vanish.ticksPerSecond} кроків за секунду, решта гравців отримала ` +
        `${vanish.othersFramesPerSecond.join(', ')} кадрів за секунду; жодного з них не від’єднано (${vanish.othersClosed}).`,
      '',
      'Знищений сокет сервер помічає одразу, бо ОС надсилає FIN/RST. Heartbeat потрібен для другого ' +
        'випадку, коли «з того боку» просто тиша: гравця прибирають після двох пропущених pong, ' +
        'тобто за 2–3 періоди ping.',
      '',
    );
  }

  if (kill) {
    lines.push(
      '## б) Сервер убито посеред матчу (SIGKILL) і запущено знову',
      '',
      `${kill.clients} безголових клієнтів на справжньому \`client/src/net/connection.ts\` ` +
        '(типові паузи: 0,5 с → 1 → 2 → 4 → 8 с, із jitter). «Платформа» запускає процес ' +
        `знову через ${kill.restartDelayMs} мс після вбивства.`,
      '',
      '| Показник | Значення |',
      '| --- | --- |',
      `| сервер недоступний (від SIGKILL до першого 200 на /health) | ${kill.downtimeMs} мс |`,
      `| клієнти знову в кімнаті (від SIGKILL до нового welcome) | ${kill.recoverMinMs}–${kill.recoverMaxMs} мс |`,
      `| з цього очікування клієнта вже після підняття сервера | до ${kill.afterUpMaxMs} мс |`,
      `| невдалих спроб на клієнта | ${kill.attempts.join(', ')} |`,
      `| паузи між спробами, мс | ${kill.waits.map((waits) => waits.join(' → ')).join('; ')} |`,
      '',
      `Усі клієнти повернулися самі (стан з’єднань: ${[...new Set(kill.statuses)].join(', ')}), ` +
        `гравців у кімнаті знову ${kill.playersAfter}. Але це НОВИЙ матч: сервер тримає стан лише ` +
        `в пам’яті, тож лічильник кроків почався з нуля (було ${kill.tickBefore}, стало ${kill.tickAfter}), ` +
        'рахунок утрачено, а гравці отримали нові id. Час відновлення складається з часу перезапуску ' +
        'і паузи, на якій клієнт саме стояв: що довше сервер лежить, то довша наступна пауза (до 8 с).',
      '',
      'У браузері гравець при цьому не лишається перед завмерлою грою: після чотирьох невдалих ' +
        'спроб поспіль (або одразу після повідомлення `shutdown` під час штатної зупинки) клієнт ' +
        'зупиняє гру й повертає його в лобі з поясненням — цю логіку перевіряє ' +
        '`client/test/session.test.js`.',
      '',
    );
  }

  if (flood) {
    const row = (name, phase) =>
      `| ${name} | ${phase.tickP50} | ${phase.tickP99} | ${phase.tickMax} | ${phase.lateP50} | ${phase.lateP99} | ${phase.ticksPerSecond} | ${phase.eventLoopPercent} % |`;
    lines.push(
      '## в) Потік сміття в сусідній кімнаті',
      '',
      `Кімната A (\`${flood.roomA}\`): ${flood.playersA} чесні гравці й нападник, який ${flood.phaseSeconds} с ` +
        `шле ~${flood.rate} зіпсованих кадрів за секунду (не JSON, чужа версія, невідомий тип, ` +
        `не та форма, зіпсовані бінарні кадри). Кімната B (\`${flood.roomB}\`): ${flood.playersB} чесних гравців. ` +
        `Кожна фаза — ${flood.phaseSeconds} с (${flood.phaseSeconds * TICK_RATE} кроків); числа кімнати B — з \`/metrics\`.`,
      '',
      '| Фаза | крок p50, мс | крок p99, мс | крок max, мс | запізнення p50, мс | запізнення p99, мс | кроків/с | цикл подій зайнятий |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      row('до', flood.before),
      row('під час', flood.during),
      row('після', flood.after),
      '',
      `Нападник надіслав ${flood.flood.framesSent} кадрів (${flood.flood.framesPerSecond}/с) через ` +
        `${flood.flood.connections} з’єднань: сервер закриває сокет на ПЕРШОМУ ж зіпсованому кадрі, ` +
        'решту кадрів того самого сокета вже не розбирає, тож нападникові доводиться підключатися знову. ' +
        `Від першого кадру сміття до закриття: ${flood.flood.closeFirstMs} мс (перше з’єднання), ` +
        `медіана ${flood.flood.closeP50Ms} мс, найдовше ${flood.flood.closeMaxMs} мс. ` +
        `Коди закриття: ${Object.entries(flood.flood.closeCodes)
          .map(([code, count]) => `${code} × ${count}`)
          .join(', ')}.`,
      '',
      `Метрики: \`moba_rejections_total\` зріс на ${flood.rejectionsTotal} ` +
        `(${Object.entries(flood.rejections)
          .map(([reason, count]) => `${reason}: ${count}`)
          .join(', ')}). ` +
        `Лог: ${flood.loggedCloses} записів \`closing socket\` рівня warn, з них ${flood.loggedWithIds} ` +
        'мають і `roomId`, і `playerId`. Приклад:',
      '',
      '```json',
      ...flood.logSample.map((record) => JSON.stringify(record)),
      '```',
      '',
      `Чесні гравці: у кімнаті B їх ${flood.playersInB}, від’єднаних серед усіх чесних — ${flood.closedPlayers}.`,
      '',
      '### Що ці числа показують насправді',
      '',
      'Сервер однопотоковий: кімнати A і B ділять один цикл подій. «Тривалість кроку» — це час ' +
        'самого обчислення кроку кімнати B; сміття в кімнаті A на неї майже не впливає, бо розбір ' +
        'чужих кадрів відбувається МІЖ кроками, а не всередині них. Тому чесніший показник — ' +
        '«запізнення»: на скільки пізніше за розклад крок почався, бо цикл подій був зайнятий ' +
        'чужою роботою (розбір сміття, рукостискання, вхід і вихід нападника з кімнати A, записи в лог). ' +
        'Поруч — частка часу, коли цикл подій був зайнятий: саме вона показує ціну потоку ' +
        `(${flood.before.eventLoopPercent} % → ${flood.during.eventLoopPercent} % → ${flood.after.eventLoopPercent} %). ` +
        'Різниця в частках мілісекунди між фазами (зокрема коли «під час» виходить МЕНШЕ, ніж «до») — ' +
        'шум вимірювання й розігрів JIT, а не ефект потоку. Ізоляції між кімнатами немає: достатньо ' +
        'потужний потік (або багато нападників з різних адрес) зрештою затримає кроки всіх кімнат. ' +
        'Захист тут — зробити кожен зіпсований кадр дешевим (закриття на першому, решта не ' +
        'розбирається) і обмежити кількість з’єднань з однієї адреси (`MAX_CONNECTIONS_PER_IP`); ' +
        'справжня ізоляція потребує окремих процесів або worker-потоків на кімнату.',
      '',
    );
  }
  return lines.join('\n');
}

// --- запуск -----------------------------------------------------------------------------------

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => arg.replace(/^--/, '').split('=')),
  );
  const only = args.only ? args.only.split(',') : ['vanish', 'kill', 'flood'];
  const results = {};

  if (only.includes('vanish')) {
    console.log('а) клієнт зникає…');
    results.vanish = await vanishScenario();
    console.log(results.vanish);
  }
  if (only.includes('kill')) {
    console.log('\nб) сервер убито SIGKILL…');
    results.kill = await killScenario();
    console.log(results.kill);
  }
  if (only.includes('flood')) {
    const phaseSeconds = Number(args.phase ?? 10);
    console.log(`\nв) потік сміття (3 фази по ${phaseSeconds} с)…`);
    results.flood = await floodScenario({ phaseSeconds });
    console.log(results.flood);
  }

  const text = report(results);
  console.log('\n' + text);
  if (only.length === 3) {
    const out = resolve(import.meta.dirname, '../../docs/lab-08');
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'chaos-report.md'), text);
    console.log(`звіт: ${join(out, 'chaos-report.md')}`);
  } else {
    console.log('(звіт у файл пишеться лише коли запущено всі три сценарії)');
  }
}

if (import.meta.main) {
  await main();
  process.exit(0);
}
