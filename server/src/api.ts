// HTTP на «голому» node:http: маршрути, читання тіла з обмеженням, потокова віддача.

import { MAX_BOTS, STATS_CAPACITY } from './match.ts';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import type { ArenaConfig } from '@moba-arena/shared/protocol.ts';
import type { ServerConfig } from './config.ts';
import type { MatchLogs } from './log/matchlog.ts';
import { listReplays, replayPath } from './log/replay.ts';
import type { Logger } from './logger.ts';
import type { MatchManager } from './match.ts';
import { RoomError, type RoomManager } from './rooms.ts';
import type { RuntimeStats } from './runtime-stats.ts';
import { serveStatic } from './static.ts';
import type { WebSocketLayer } from './ws.ts';

class HttpProblem extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

// Тіло запиту — потік шматків (Buffer). Рахуємо байти на льоту й зупиняємось, щойно
// перевищено ліміт: інакше один POST на гігабайт зайняв би гігабайт пам'яті.
async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  if (Number(request.headers['content-length'] ?? 0) > limit) {
    throw new HttpProblem(413, 'Request body is too large');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    // Потік без setEncoding() видає Buffer; перевірка робить це відомим і компілятору.
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += bytes.length;
    if (size > limit) throw new HttpProblem(413, 'Request body is too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

// Охоронці типу: після них tsc знає, що value — об'єкт із довільними полями / ціле число.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

const DEFAULT_ARENA: ArenaConfig = { width: 1600, height: 900, asteroids: 5, pickups: 2, seed: 1 };
const ARENA_KEYS = ['width', 'height', 'asteroids', 'pickups', 'seed'] as const;
const ARENA_LIMITS: Record<keyof ArenaConfig, readonly [min: number, max: number]> = {
  width: [800, 3000],
  height: [500, 2000],
  asteroids: [0, 20],
  pickups: [0, 5],
  seed: [0, 2 ** 31 - 1],
};

function parseRoomRequest(buffer: Buffer): { name: string; arena: ArenaConfig } {
  let body: unknown;
  try {
    body = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new HttpProblem(400, 'Body must be valid JSON');
  }
  if (!isRecord(body) || Array.isArray(body)) {
    throw new HttpProblem(400, 'Body must be a JSON object');
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length < 2 || name.length > 24) {
    throw new HttpProblem(400, 'Field "name" must be a string of 2–24 characters');
  }
  const arena = { ...DEFAULT_ARENA };
  if (body.arena !== undefined) {
    if (!isRecord(body.arena)) {
      throw new HttpProblem(400, 'Field "arena" must be an object');
    }
    for (const key of ARENA_KEYS) {
      const [min, max] = ARENA_LIMITS[key];
      const value = body.arena[key];
      if (value === undefined) continue;
      if (!inRange(value, min, max)) {
        throw new HttpProblem(400, `Field "arena.${key}" must be an integer in ${min}…${max}`);
      }
      arena[key] = value;
    }
  }
  return { name, arena };
}

// Код помилки Node (ENOENT, ERR_STREAM_PREMATURE_CLOSE…). У catch помилка — unknown,
// тож спершу перевіряємо, що це Error і що поле code в неї взагалі є.
function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

export interface RequestHandlerDeps {
  readonly config: ServerConfig;
  readonly rooms: RoomManager;
  readonly matches: MatchManager;
  readonly ws: WebSocketLayer;
  readonly logs: MatchLogs;
  readonly logger: Logger;
  readonly runtime: RuntimeStats;
  readonly startedAt: number;
}

function parseBotCount(buffer: Buffer): number {
  let body: unknown;
  try {
    body = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new HttpProblem(400, 'Body must be valid JSON');
  }
  const count = isRecord(body) ? body.count : undefined;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_BOTS) {
    throw new HttpProblem(400, `Field "count" must be an integer in 1…${MAX_BOTS}`);
  }
  return count;
}

export function createRequestHandler({
  config,
  rooms,
  matches,
  ws,
  logs,
  logger,
  runtime,
  startedAt,
}: RequestHandlerDeps) {
  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const { pathname } = url;
    const method = request.method;

    if (pathname === '/health' && method === 'GET') {
      return sendJson(response, 200, {
        status: 'ok',
        uptime: Math.round((Date.now() - startedAt) / 1000),
        rooms: rooms.size,
        connections: ws.connections(),
        droppedMessages: ws.stats.dropped,
        openLogs: logs.activeCount,
        rss: process.memoryUsage().rss,
      });
    }

    // Як почувається сервер: тривалість кроку матчу (avg/p50/p99/max) і запізнення відносно
    // цільового часу — за останні ?window=N кроків (типово 300 = 10 с, щонайбільше STATS_CAPACITY);
    // process — накопичувальні лічильники процесу (цикл подій, пам'ять, збирач сміття).
    if (pathname === '/api/stats' && method === 'GET') {
      const raw = url.searchParams.get('window');
      const window = raw === null ? undefined : Number(raw);
      if (window !== undefined && !inRange(window, 1, STATS_CAPACITY)) {
        throw new HttpProblem(400, `Parameter "window" must be an integer in 1…${STATS_CAPACITY}`);
      }
      return sendJson(response, 200, {
        matches: matches.report(window),
        sockets: ws.stats,
        process: runtime.snapshot(),
      });
    }

    if (pathname === '/api/rooms' && method === 'GET') {
      return sendJson(response, 200, { rooms: rooms.list() });
    }

    if (pathname === '/api/rooms' && method === 'POST') {
      const { name, arena } = parseRoomRequest(await readBody(request, config.maxBodyBytes));
      try {
        const room = rooms.create({ name, arena });
        logger.info('room created', { room: room.id, name });
        return sendJson(response, 201, { room });
      } catch (error) {
        if (error instanceof RoomError) throw new HttpProblem(409, error.message);
        throw error;
      }
    }

    // Додати ботів у матч, що вже йде: POST /api/rooms/:id/bots  { "count": 8 }
    const botsRoom = /^\/api\/rooms\/([^/]+)\/bots$/.exec(pathname)?.[1];
    if (botsRoom !== undefined && method === 'POST') {
      const match = matches.get(botsRoom);
      if (!match) throw new HttpProblem(409, 'Match is not running: join the room first');
      const count = parseBotCount(await readBody(request, config.maxBodyBytes));
      const bots = match.addBots(count);
      logger.info('bots added', { room: botsRoom, bots });
      return sendJson(response, 200, { bots });
    }

    if (pathname === '/api/replays' && method === 'GET') {
      return sendJson(response, 200, { replays: await listReplays(config.logDir) });
    }

    const replayId = /^\/api\/replays\/([^/]+)$/.exec(pathname)?.[1];
    if (replayId !== undefined && method === 'GET') {
      const file = replayPath(config.logDir, replayId);
      const info = file === null ? null : await stat(file).catch(() => null);
      if (file === null || info === null) throw new HttpProblem(404, 'Replay not found');

      const headers = { 'content-type': 'application/x-ndjson', 'content-length': info.size };

      // ЛИШЕ ДЛЯ ДОСЛІДУ (DEBUG_ROUTES=1): «наївна» віддача — увесь файл у пам'ять.
      if (config.debugRoutes && url.searchParams.get('mode') === 'buffer') {
        response.writeHead(200, headers);
        response.end(await readFile(file));
        return;
      }

      // Потокова віддача. Якщо клієнт читає повільно, сокет перестає приймати дані,
      // pipeline призупиняє читання файла — і в пам'яті лишається кілька шматків по 64 КБ.
      response.writeHead(200, headers);
      return pipeline(createReadStream(file), response);
    }

    // ЛИШЕ ДЛЯ ДОСЛІДУ: навмисно займаємо цикл подій синхронною роботою.
    if (config.debugRoutes && pathname === '/api/slow' && method === 'GET') {
      const ms = Math.min(Number(url.searchParams.get('ms') ?? 300) || 300, 2000);
      const until = performance.now() + ms;
      while (performance.now() < until) {
        /* поки цей цикл на стеку, сервер не обслуговує НІКОГО */
      }
      return sendJson(response, 200, { blockedMs: ms });
    }

    if (pathname.startsWith('/api/')) throw new HttpProblem(404, 'No such endpoint');

    if (method === 'GET' || method === 'HEAD') {
      if (await serveStatic(request, response, config.clientDist)) return undefined;
      throw new HttpProblem(404, 'Not found');
    }
    throw new HttpProblem(405, 'Method not allowed');
  }

  // Обробник async → помилка стає відхиленим промісом. Його ОБОВ'ЯЗКОВО треба зловити тут:
  // неперехоплене відхилення в Node завершує процес.
  return (request: IncomingMessage, response: ServerResponse): void => {
    route(request, response).catch((error: unknown) => {
      // Клієнт пішов посеред завантаження — це не помилка сервера.
      if (errorCode(error) === 'ERR_STREAM_PREMATURE_CLOSE') return;
      const status = error instanceof HttpProblem ? error.status : 500;
      if (status === 500) {
        // Відхилити проміс можна чим завгодно, тож stack беремо лише у справжньої помилки.
        const details = error instanceof Error ? error.stack : String(error);
        logger.error('request failed', { url: request.url, error: details });
      }
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (status === 413) {
        // Решту тіла читати не будемо: відповідаємо й закриваємо з'єднання.
        response.setHeader('connection', 'close');
        response.once('finish', () => request.destroy());
      }
      sendJson(response, status, {
        error: error instanceof HttpProblem ? error.message : 'Internal error',
      });
    });
  };
}
