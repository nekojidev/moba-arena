// Конфігурація з оточення. Усе читається й перевіряється в одному місці, один раз на старті:
// сервер із PORT=abc має впасти одразу зі зрозумілим повідомленням, а не о третій ночі.
//
// Оточення — це дані ззовні, як і повідомлення з мережі: рядки, яким не можна довіряти.
// Тому воно проходить через схему Zod, а тип ServerConfig ВИВОДИТЬСЯ з неї (z.infer).

import { resolve } from 'node:path';
import { z } from 'zod';

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super('Некоректна конфігурація:\n' + problems.map((problem) => `  • ${problem}`).join('\n'));
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
const COLLISION_SYSTEMS = ['naive', 'hash'] as const;

// Змінної немає або вона порожня (PORT=) — однаково «не задано»: спрацює типове значення.
const blankAsMissing = (raw: unknown): unknown => (raw === '' ? undefined : raw);

function integer(fallback: number, { min, max }: { min: number; max: number }) {
  const error = `потрібне ціле число від ${min} до ${max}`;
  return z.preprocess(
    blankAsMissing,
    z.coerce
      .number({ error })
      .refine((value) => Number.isInteger(value) && value >= min && value <= max, { error })
      .default(fallback),
  );
}

function flag(fallback: boolean) {
  return z.preprocess(
    blankAsMissing,
    z
      .enum(['1', 'true', '0', 'false'], { error: 'потрібно 0/1 або true/false' })
      .transform((raw) => raw === '1' || raw === 'true')
      .default(fallback),
  );
}

function text(fallback: string) {
  return z.preprocess(blankAsMissing, z.string().default(fallback));
}

// Ключі — імена змінних оточення: так шлях помилки Zod одразу каже, яка змінна погана.
const envSchema = z.object({
  PORT: integer(3000, { min: 0, max: 65535 }), // 0 — будь-який вільний (тести)
  HOST: text('127.0.0.1'),
  LOG_DIR: text('./logs'),
  CLIENT_DIST: text(resolve(import.meta.dirname, '../../client/dist')),
  LOG_LEVEL: z.preprocess(
    blankAsMissing,
    z.enum(LOG_LEVELS, { error: `дозволено ${LOG_LEVELS.join(', ')}` }).default('info'),
  ),
  DEBUG_ROUTES: flag(false),
  // Система зіткнень у матчі: hash — просторовий хеш, naive — перебір усіх пар.
  // Результат однаковий (доведено тестом у shared), різниця лише у швидкості: хеш швидший
  // за будь-якої кількості сутностей (npm run bench:collision), тому він типовий.
  // naive лишено, щоб порівнювати «до» і «після» (npm run load -- --collision=naive,hash).
  COLLISION: z.preprocess(
    blankAsMissing,
    z
      .enum(COLLISION_SYSTEMS, { error: `дозволено ${COLLISION_SYSTEMS.join(', ')}` })
      .default('hash'),
  ),

  MAX_ROOMS: integer(20, { min: 1, max: 1000 }),
  // Верхня межа 256 — для навантажувального тесту (npm run load); типово кімната на 8.
  MAX_PLAYERS_PER_ROOM: integer(8, { min: 1, max: 256 }),
  MAX_PAYLOAD_BYTES: integer(4096, { min: 64, max: 1_048_576 }),
  MAX_BODY_BYTES: integer(4096, { min: 64, max: 1_048_576 }),
  JOIN_TIMEOUT_MS: integer(5000, { min: 10, max: 60_000 }),
  HEARTBEAT_MS: integer(15_000, { min: 10, max: 120_000 }),
  RATE_LIMIT_PER_SECOND: integer(10, { min: 1, max: 1000 }),
  SLOW_CLIENT_BYTES: integer(64 * 1024, { min: 1024, max: 16_777_216 }),
  EMPTY_ROOM_TTL_MS: integer(60_000, { min: 10, max: 3_600_000 }),
});

// Перевірені змінні → об'єкт конфігурації. readonly() заморожує результат (Object.freeze)
// і робить поля readonly в типі.
const configSchema = envSchema
  .transform((env) => ({
    port: env.PORT,
    host: env.HOST,
    logDir: resolve(env.LOG_DIR),
    clientDist: resolve(env.CLIENT_DIST),
    logLevel: env.LOG_LEVEL,
    debugRoutes: env.DEBUG_ROUTES,
    collision: env.COLLISION,

    maxRooms: env.MAX_ROOMS,
    maxPlayersPerRoom: env.MAX_PLAYERS_PER_ROOM,
    maxPayload: env.MAX_PAYLOAD_BYTES,
    maxBodyBytes: env.MAX_BODY_BYTES,
    joinTimeoutMs: env.JOIN_TIMEOUT_MS,
    heartbeatMs: env.HEARTBEAT_MS,
    rateLimitPerSecond: env.RATE_LIMIT_PER_SECOND,
    slowClientBytes: env.SLOW_CLIENT_BYTES,
    emptyRoomTtlMs: env.EMPTY_ROOM_TTL_MS,
  }))
  .readonly();

export type ServerConfig = z.infer<typeof configSchema>;

export type Env = Readonly<Record<string, string | undefined>>;

export function loadConfig(env: Env = process.env): ServerConfig {
  // safeParse не зупиняється на першій помилці: усі проблеми збираються й показуються разом.
  const result = configSchema.safeParse(env);
  if (result.success) return result.data;

  const problems = result.error.issues.map((issue) => {
    const name = String(issue.path[0]);
    return `${name}="${env[name]}": ${issue.message}`;
  });
  throw new ConfigError(problems);
}
