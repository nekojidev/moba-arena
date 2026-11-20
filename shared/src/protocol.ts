// Протокол — єдине джерело правди. Кожне повідомлення описане схемою Zod, а тип
// TypeScript ВИВОДИТЬСЯ зі схеми (z.infer), тож вони не можуть розійтися.
//
// Навіщо схеми, якщо є типи? Типи існують лише до збірки: у рантаймі їх немає, і
// `message as ClientMessage` нічого не перевіряє. Дані з мережі — це unknown, і лише
// схема перетворює їх на значення, якому можна довіряти.

import { z } from 'zod';
import { brand, type EntityId, type Seq, type Tick } from './brand.ts';
import type { GameEvents } from './sim/events.ts';

export const PROTOCOL_VERSION = 1;

export const TICK_RATE = 30; // кроків симуляції за секунду — і на сервері, і в передбаченні
export const DT = 1 / TICK_RATE;
export const TICK_MS = 1000 / TICK_RATE;

// Типи ігрових повідомлень (другий байт бінарного кадру).
export const MESSAGE = Object.freeze({ INPUT: 1, SNAPSHOT: 2 });

// Порядок у цих списках — частина протоколу: у байті їде індекс.
export const KINDS = ['ship', 'bullet', 'asteroid', 'pickup'] as const;
export const EFFECTS = ['shield', 'rapid', 'homing'] as const;

// Коди закриття WebSocket: 4000–4999 — діапазон, відданий застосункам.
export const CLOSE = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001, // сервер зупиняється
  TOO_BIG: 1009, // повідомлення більше за maxPayload (ставить сама бібліотека ws)
  BAD_MESSAGE: 4000, // не JSON, не об'єкт, не та форма
  UNKNOWN_TYPE: 4001,
  JOIN_TIMEOUT: 4002,
  RATE_LIMIT: 4003,
  JOIN_REJECTED: 4004, // кімнати немає або вона заповнена
  VERSION: 4005,
  SLOW_CLIENT: 4006,
});
export type CloseCode = (typeof CLOSE)[keyof typeof CLOSE];

// --- цеглинки --------------------------------------------------------------------------------

const u32 = z.number().int().min(0).max(0xffffffff);
// Перевірене число одразу отримує бренд: з мережі не може прийти «просто number» там,
// де далі чекають EntityId.
const entityIdSchema = u32.transform((value) => brand<EntityId>(value));
const tickSchema = u32.transform((value) => brand<Tick>(value));
const seqSchema = u32.transform((value) => brand<Seq>(value));
const version = z.literal(PROTOCOL_VERSION);
const hp = z.number().int().min(0).max(100);

// --- ігрові повідомлення (їх також уміє бінарний кодек) --------------------------------------

const inputFields = {
  seq: seqSchema,
  turn: z.literal([-1, 0, 1]),
  thrust: z.literal([0, 1]),
  brake: z.boolean(),
  dash: z.boolean(),
  fire: z.boolean(),
};
export const inputSchema = z.strictObject(inputFields).readonly();
export type Input = z.infer<typeof inputSchema>;

const selfSchema = z
  .strictObject({
    down: z.boolean(),
    shield: z.boolean(),
    rapid: z.boolean(),
    homing: z.boolean(),
    hp,
    x: z.number(),
    y: z.number(),
    vx: z.number(),
    vy: z.number(),
    angle: z.number(),
    dashCooldown: z.number(),
    fireCooldown: z.number(),
    respawnTimer: z.number(),
  })
  .readonly();
export type SelfState = z.infer<typeof selfSchema>;

const placed = { id: entityIdSchema, x: z.number(), y: z.number(), angle: z.number() };

// Розрізнюване об'єднання: поле kind каже, які ще поля є в записі.
const entitySchema = z.discriminatedUnion('kind', [
  z
    .strictObject({
      kind: z.literal('ship'),
      ...placed,
      hp,
      score: z.number().int().min(0).max(65535),
      down: z.boolean(),
      shield: z.boolean(),
      thrust: z.boolean(),
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal('bullet'),
      ...placed,
      owner: entityIdSchema,
      homing: z.boolean(),
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal('asteroid'),
      ...placed,
      size: z.literal([1, 2, 3]),
      homing: z.boolean(),
    })
    .readonly(),
  z.strictObject({ kind: z.literal('pickup'), ...placed, effect: z.enum(EFFECTS) }).readonly(),
]);
export type SnapshotEntity = z.infer<typeof entitySchema>;
// Запис конкретного виду: SnapshotEntityOf<'ship'> — лише варіант із kind: 'ship'.
export type SnapshotEntityOf<K extends SnapshotEntity['kind']> = Extract<
  SnapshotEntity,
  { readonly kind: K }
>;

const snapshotFields = {
  tick: tickSchema,
  ack: seqSchema,
  self: selfSchema.nullable(),
  entities: z.array(entitySchema).readonly(),
};
export const snapshotSchema = z.strictObject(snapshotFields).readonly();
export const snapshotMessageSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('snapshot'),
  ...snapshotFields,
});
export type Snapshot = z.infer<typeof snapshotSchema>;

// --- керувальні повідомлення: клієнт → сервер -------------------------------------------------

const codecName = z.enum(['binary', 'json']);
export type CodecName = z.infer<typeof codecName>;

export const inputMessageSchema = z.strictObject({
  v: version,
  type: z.literal('input'),
  ...inputFields,
});

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    v: version,
    type: z.literal('join'),
    room: z.string().min(1).max(64),
    name: z.string().trim().min(2).max(16),
    codec: codecName.optional(),
  }),
  z.strictObject({ v: version, type: z.literal('chat'), text: z.string().trim().min(1).max(200) }),
  z.strictObject({ v: version, type: z.literal('ping'), t: z.number() }),
  z.strictObject({ v: version, type: z.literal('leave') }),
  inputMessageSchema, // input текстом — лише коли клієнт попросив codec: "json"
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// --- керувальні повідомлення: сервер → клієнт -------------------------------------------------

const arenaSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  asteroids: z.number().int().min(0),
  pickups: z.number().int().min(0),
  seed: z.number().int(),
});
export type ArenaConfig = z.infer<typeof arenaSchema>;

export const roomSchema = z.object({
  id: z.string(),
  name: z.string(),
  players: z.number().int().min(0),
  maxPlayers: z.number().int().min(1),
  arena: arenaSchema,
});
export type RoomInfo = z.infer<typeof roomSchema>;

const rosterPlayer = z.object({
  id: z.string(),
  name: z.string(),
  shipId: entityIdSchema.optional(),
});
export type RosterPlayer = z.infer<typeof rosterPlayer>;

// Події світу, що їдуть мережею. Тип ВИВОДИТЬСЯ з карти подій симуляції (GameEvents):
// для кожного імені K береться форма GameEvents[K] і до неї додається поле type: K.
// Зміниш подію в симуляції — tsc одразу покаже, що схема нижче їй більше не відповідає.
export type ForwardedEvent = 'fired' | 'hit' | 'exploded' | 'pickup' | 'respawned';
export type NetEvent = {
  [K in ForwardedEvent]: { readonly type: K } & GameEvents[K];
}[ForwardedEvent];

const netEventSchema: z.ZodType<NetEvent> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('fired'),
    shipId: entityIdSchema,
    team: z.enum(['green', 'red']),
    homing: z.boolean(),
  }),
  z.object({
    type: z.literal('hit'),
    targetKind: z.enum(['ship', 'asteroid']),
    targetId: entityIdSchema,
    shielded: z.boolean(),
  }),
  z.object({
    type: z.literal('exploded'),
    kind: z.enum(['ship', 'asteroid']),
    id: entityIdSchema,
    killerId: entityIdSchema.nullable(),
    x: z.number(),
    y: z.number(),
    size: z.number().optional(),
  }),
  z.object({
    type: z.literal('pickup'),
    shipId: entityIdSchema,
    effect: z.object({ type: z.enum(EFFECTS), duration: z.number() }),
  }),
  z.object({ type: z.literal('respawned'), shipId: entityIdSchema }),
]);

export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({
    v: version,
    type: z.literal('welcome'),
    playerId: z.string(),
    shipId: entityIdSchema,
    room: roomSchema,
    tickRate: z.number().positive(),
    codec: codecName,
    // Версія сервера (git SHA збірки). Необов'язкова: старий сервер її не надсилає.
    version: z.string().max(64).optional(),
  }),
  z.object({ v: version, type: z.literal('roster'), players: z.array(rosterPlayer) }),
  z.object({
    v: version,
    type: z.literal('chat'),
    from: z.object({ id: z.string(), name: z.string() }),
    text: z.string(),
    t: z.number(),
  }),
  z.object({ v: version, type: z.literal('pong'), t: z.number() }),
  z.object({
    v: version,
    type: z.literal('events'),
    tick: tickSchema,
    events: z.array(netEventSchema),
  }),
  // Сервер зупиняється (оновлення, перезапуск): останнє повідомлення перед закриттям
  // сокета з кодом 1001. Клієнт за ним повертає гравця в лобі.
  z.object({ v: version, type: z.literal('shutdown'), reason: z.string().max(200) }),
  snapshotMessageSchema,
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
// Повідомлення конкретного типу: ServerMessageOf<'welcome'> тощо.
export type ServerMessageOf<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;
export type ClientMessageOf<T extends ClientMessage['type']> = Extract<ClientMessage, { type: T }>;
export type Welcome = ServerMessageOf<'welcome'>;

// --- розбір -----------------------------------------------------------------------------------

// Результат замість винятку: погане повідомлення — це не аварія, а звичайна гілка коду.
// Викликач мусить перевірити ok, перш ніж tsc дозволить торкнутись message.
export type ParseResult<T> =
  | { readonly ok: true; readonly message: T }
  | { readonly ok: false; readonly code: CloseCode; readonly reason: string };

const CLIENT_TYPES: ReadonlySet<string> = new Set(['join', 'chat', 'ping', 'leave', 'input']);
const SERVER_TYPES: ReadonlySet<string> = new Set([
  'welcome',
  'roster',
  'chat',
  'pong',
  'events',
  'shutdown',
  'snapshot',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMessage<T>(
  data: unknown,
  schema: z.ZodType<T>,
  knownTypes: ReadonlySet<string>,
): ParseResult<T> {
  const fail = (code: CloseCode, reason: string): ParseResult<T> => ({ ok: false, code, reason });

  let raw: unknown = data;
  if (typeof data === 'string') {
    try {
      raw = JSON.parse(data);
    } catch {
      return fail(CLOSE.BAD_MESSAGE, 'invalid JSON');
    }
  }
  if (!isRecord(raw)) return fail(CLOSE.BAD_MESSAGE, 'message must be an object');
  if (raw.v !== PROTOCOL_VERSION) return fail(CLOSE.VERSION, 'unsupported protocol version');
  if (typeof raw.type !== 'string' || !knownTypes.has(raw.type)) {
    return fail(CLOSE.UNKNOWN_TYPE, 'unknown message type');
  }

  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, message: result.data };
  const issue = result.error.issues[0];
  const where = issue ? issue.path.join('.') : '';
  // Причина йде в кадр закриття WebSocket, а він обмежений 123 байтами.
  return fail(
    CLOSE.BAD_MESSAGE,
    `invalid message${where ? `: field "${where}"` : ''}`.slice(0, 100),
  );
}

// Приймає що завгодно (unknown) і ніколи не кидає виняток.
export function parseClientMessage(data: unknown): ParseResult<ClientMessage> {
  return parseMessage(data, clientMessageSchema, CLIENT_TYPES);
}

export function parseServerMessage(data: unknown): ParseResult<ServerMessage> {
  return parseMessage(data, serverMessageSchema, SERVER_TYPES);
}

// Серверне повідомлення → рядок JSON. Omit прибирає поле v: його додає сама функція.
// Повідомлення — об'єднання, а Omit від об'єднання злив би варіанти в один; тому
// «T extends unknown ? … : never» застосовує Omit до КОЖНОГО варіанта окремо.
type WithoutVersion<T> = T extends unknown ? Omit<T, 'v'> : never;

export function serverMessage(message: WithoutVersion<ServerMessage>): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, ...message });
}

export function clientMessage(message: WithoutVersion<ClientMessage>): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, ...message });
}
