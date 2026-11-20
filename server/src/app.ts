// Збирає сервер із частин. Окремо від index.ts, щоб тести могли підняти його на порту 0.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { findCollisionsHashed } from '@moba-arena/shared/sim/spatial-hash.ts';
import { createRequestHandler } from './api.ts';
import type { ServerConfig } from './config.ts';
import { MatchLogs } from './log/matchlog.ts';
import { createLogger, type Logger } from './logger.ts';
import { MatchManager } from './match.ts';
import { RoomManager, type CreateRoomOptions } from './rooms.ts';
import { createMetrics } from './metrics.ts';
import { createRuntimeStats } from './runtime-stats.ts';
import { attachWebSocket } from './ws.ts';

// Постійні кімнати, які є завжди (не видаляються, коли порожні).
const SEED_ROOMS: readonly CreateRoomOptions[] = [
  {
    id: 'mid',
    name: 'Центральна лінія',
    arena: { width: 1600, height: 900, asteroids: 5, pickups: 2, seed: 1 },
  },
  {
    id: 'river',
    name: 'Тісна річка',
    arena: { width: 1200, height: 700, asteroids: 8, pickups: 3, seed: 7 },
  },
  {
    id: 'quarry',
    name: 'Кар’єр големів',
    arena: { width: 2000, height: 1100, asteroids: 12, pickups: 2, seed: 42 },
  },
];

export async function createApp(
  config: ServerConfig,
  { logger = createLogger({ level: config.logLevel }) }: { logger?: Logger } = {},
) {
  const rooms = new RoomManager({
    maxRooms: config.maxRooms,
    maxPlayersPerRoom: config.maxPlayersPerRoom,
    emptyTtlMs: config.emptyRoomTtlMs,
  });
  for (const room of SEED_ROOMS) rooms.create({ ...room, persistent: true });

  const logs = new MatchLogs({ dir: config.logDir, rooms, logger });
  await logs.init();

  // Порядок важливий: матчі підписуються на події кімнат РАНІШЕ за мережевий шар,
  // щоб на момент розсилки roster герой гравця вже існував.
  const matches = new MatchManager({
    rooms,
    logger,
    ...(config.collision === 'hash' ? { collide: findCollisionsHashed } : {}),
  });
  const runtime = createRuntimeStats();
  const metrics = createMetrics();
  // Готовність: true від початку прослуховування порту до початку зупинки.
  let ready = false;

  const server = createServer();
  const ws = attachWebSocket({ server, rooms, matches, config, logger, metrics });
  server.on(
    'request',
    createRequestHandler({
      config,
      rooms,
      matches,
      ws,
      logs,
      logger,
      runtime,
      metrics,
      startedAt: Date.now(),
      isReady: () => ready,
    }),
  );
  // Зламаний HTTP-запит (сміття замість заголовків) — не привід падати.
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  function listen(): Promise<AddressInfo> {
    return new Promise((resolve, reject) => {
      server.once('error', reject); // зайнятий порт — це подія 'error', а не виняток
      server.listen(config.port, config.host, () => {
        server.off('error', reject);
        // address() повертає ще й рядок (для unix-сокета) або null (сервер не слухає).
        // Ми слухаємо TCP-порт, але tsc цього не знає — перевіряємо.
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('Сервер не слухає TCP-порт'));
          return;
        }
        ready = true;
        resolve(address);
      });
    });
  }

  // Штатна зупинка:
  //   1) /ready → 503, нові WebSocket-рукостискання отримують 503;
  //   2) кожному гравцеві — повідомлення shutdown і закриття сокета з кодом 1001
  //      (до 1 с на чемне закриття; порт іще слухаємо, тож перевірка готовності бачить
  //      саме 503, а не «з'єднання відхилено»);
  //   3) HTTP-сервер перестає приймати з'єднання;
  //   4) матчі зупинено, журнали матчів дописано на диск;
  //   5) чекаємо, поки HTTP-сервер відпустить з'єднання (за 2 с рвемо ті, що лишились).
  // Найдовший шлях — близько 3 с, далеко до 10.
  let closing: Promise<void> | null = null;
  function close(): Promise<void> {
    closing ??= shutdown(); // повторний виклик не починає зупинку вдруге
    return closing;
  }

  async function shutdown(): Promise<void> {
    ready = false;
    await ws.close();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    matches.closeAll();
    await logs.closeAll(rooms);
    runtime.close();
    metrics.close();
    server.closeIdleConnections();
    const force = setTimeout(() => server.closeAllConnections(), 2000);
    await closed;
    clearTimeout(force);
  }

  return {
    server,
    rooms,
    matches,
    ws,
    logs,
    logger,
    metrics,
    listen,
    close,
    get ready() {
      return ready;
    },
  };
}
