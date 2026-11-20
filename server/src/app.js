// Збирає сервер із частин. Окремо від index.js, щоб тести могли підняти його на порту 0.

import { createServer } from 'node:http';
import { createRequestHandler } from './api.js';
import { MatchLogs } from './log/matchlog.js';
import { createLogger } from './logger.js';
import { RoomManager } from './rooms.js';
import { attachWebSocket } from './ws.js';

// Постійні кімнати, які є завжди (не видаляються, коли порожні).
const SEED_ROOMS = [
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
  config,
  { logger = createLogger({ level: config.logLevel }) } = {},
) {
  const rooms = new RoomManager({
    maxRooms: config.maxRooms,
    maxPlayersPerRoom: config.maxPlayersPerRoom,
    emptyTtlMs: config.emptyRoomTtlMs,
  });
  for (const room of SEED_ROOMS) rooms.create({ ...room, persistent: true });

  const logs = new MatchLogs({ dir: config.logDir, rooms, logger });
  await logs.init();

  const server = createServer();
  const ws = attachWebSocket({ server, rooms, config, logger });
  server.on(
    'request',
    createRequestHandler({ config, rooms, ws, logs, logger, startedAt: Date.now() }),
  );
  // Зламаний HTTP-запит (сміття замість заголовків) — не привід падати.
  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject); // зайнятий порт — це подія 'error', а не виняток
      server.listen(config.port, config.host, () => {
        server.off('error', reject);
        resolve(server.address());
      });
    });
  }

  // Штатна зупинка: (1) перестати приймати нові з'єднання, (2) закрити сокети,
  // (3) дописати логи, (4) дочекатися, поки HTTP-сервер відпустить усі з'єднання.
  async function close() {
    const closed = new Promise((resolve) => server.close(resolve));
    await ws.close();
    await logs.closeAll(rooms);
    server.closeIdleConnections();
    const force = setTimeout(() => server.closeAllConnections(), 2000);
    await closed;
    clearTimeout(force);
  }

  return { server, rooms, ws, logs, logger, listen, close };
}
