// HTTP на «голому» node:http: маршрути, читання тіла з обмеженням, потокова віддача.

import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { listReplays, replayPath } from './log/replay.js';
import { RoomError } from './rooms.js';
import { serveStatic } from './static.js';

class HttpProblem extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, body) {
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
async function readBody(request, limit) {
  if (Number(request.headers['content-length'] ?? 0) > limit) {
    throw new HttpProblem(413, 'Request body is too large');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new HttpProblem(413, 'Request body is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const inRange = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

const DEFAULT_ARENA = { width: 1600, height: 900, asteroids: 5, pickups: 2, seed: 1 };
const ARENA_LIMITS = {
  width: [800, 3000],
  height: [500, 2000],
  asteroids: [0, 20],
  pickups: [0, 5],
  seed: [0, 2 ** 31 - 1],
};

function parseRoomRequest(buffer) {
  let body;
  try {
    body = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new HttpProblem(400, 'Body must be valid JSON');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpProblem(400, 'Body must be a JSON object');
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length < 2 || name.length > 24) {
    throw new HttpProblem(400, 'Field "name" must be a string of 2–24 characters');
  }
  const arena = { ...DEFAULT_ARENA };
  if (body.arena !== undefined) {
    if (body.arena === null || typeof body.arena !== 'object') {
      throw new HttpProblem(400, 'Field "arena" must be an object');
    }
    for (const [key, [min, max]] of Object.entries(ARENA_LIMITS)) {
      if (body.arena[key] === undefined) continue;
      if (!inRange(body.arena[key], min, max)) {
        throw new HttpProblem(400, `Field "arena.${key}" must be an integer in ${min}…${max}`);
      }
      arena[key] = body.arena[key];
    }
  }
  return { name, arena };
}

export function createRequestHandler({ config, rooms, matches, ws, logs, logger, startedAt }) {
  async function route(request, response) {
    const url = new URL(request.url, 'http://localhost');
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

    // Як почувається сервер: тривалість кроку матчу і запізнення відносно цільового часу.
    if (pathname === '/api/stats' && method === 'GET') {
      return sendJson(response, 200, { matches: matches.report(), sockets: ws.stats });
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

    if (pathname === '/api/replays' && method === 'GET') {
      return sendJson(response, 200, { replays: await listReplays(config.logDir) });
    }

    const replay = /^\/api\/replays\/([^/]+)$/.exec(pathname);
    if (replay && method === 'GET') {
      const file = replayPath(config.logDir, replay[1]);
      const info = file && (await stat(file).catch(() => null));
      if (!info) throw new HttpProblem(404, 'Replay not found');

      const headers = { 'content-type': 'application/x-ndjson', 'content-length': info.size };

      // ЛИШЕ ДЛЯ ДОСЛІДУ (DEBUG_ROUTES=1): «наївна» віддача — увесь файл у пам'ять.
      if (config.debugRoutes && url.searchParams.get('mode') === 'buffer') {
        response.writeHead(200, headers);
        return response.end(await readFile(file));
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
  return (request, response) => {
    route(request, response).catch((error) => {
      // Клієнт пішов посеред завантаження — це не помилка сервера.
      if (error.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
      const status = error instanceof HttpProblem ? error.status : 500;
      if (status === 500) logger.error('request failed', { url: request.url, error: error.stack });
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
