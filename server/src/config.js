// Конфігурація з оточення. Усе читається й перевіряється в одному місці, один раз на старті:
// сервер із PORT=abc має впасти одразу зі зрозумілим повідомленням, а не о третій ночі.

import { resolve } from 'node:path';

export class ConfigError extends Error {
  constructor(problems) {
    super('Некоректна конфігурація:\n' + problems.map((problem) => `  • ${problem}`).join('\n'));
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'];

export function loadConfig(env = process.env) {
  const problems = [];

  function integer(name, fallback, { min, max }) {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name}="${raw}": потрібне ціле число від ${min} до ${max}`);
      return fallback;
    }
    return value;
  }

  function flag(name, fallback) {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    if (['1', 'true'].includes(raw)) return true;
    if (['0', 'false'].includes(raw)) return false;
    problems.push(`${name}="${raw}": потрібно 0/1 або true/false`);
    return fallback;
  }

  function oneOf(name, fallback, allowed) {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    if (!allowed.includes(raw)) {
      problems.push(`${name}="${raw}": дозволено ${allowed.join(', ')}`);
      return fallback;
    }
    return raw;
  }

  const config = {
    port: integer('PORT', 3000, { min: 0, max: 65535 }), // 0 — будь-який вільний (тести)
    host: env.HOST || '127.0.0.1',
    logDir: resolve(env.LOG_DIR || './logs'),
    clientDist: resolve(env.CLIENT_DIST || resolve(import.meta.dirname, '../../client/dist')),
    logLevel: oneOf('LOG_LEVEL', 'info', LOG_LEVELS),
    debugRoutes: flag('DEBUG_ROUTES', false),

    maxRooms: integer('MAX_ROOMS', 20, { min: 1, max: 1000 }),
    maxPlayersPerRoom: integer('MAX_PLAYERS_PER_ROOM', 8, { min: 1, max: 64 }),
    maxPayload: integer('MAX_PAYLOAD_BYTES', 4096, { min: 64, max: 1_048_576 }),
    maxBodyBytes: integer('MAX_BODY_BYTES', 4096, { min: 64, max: 1_048_576 }),
    joinTimeoutMs: integer('JOIN_TIMEOUT_MS', 5000, { min: 10, max: 60_000 }),
    heartbeatMs: integer('HEARTBEAT_MS', 15_000, { min: 10, max: 120_000 }),
    rateLimitPerSecond: integer('RATE_LIMIT_PER_SECOND', 10, { min: 1, max: 1000 }),
    slowClientBytes: integer('SLOW_CLIENT_BYTES', 64 * 1024, { min: 1024, max: 16_777_216 }),
    emptyRoomTtlMs: integer('EMPTY_ROOM_TTL_MS', 60_000, { min: 10, max: 3_600_000 }),
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return Object.freeze(config);
}
