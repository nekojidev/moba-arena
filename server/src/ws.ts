// Життєвий цикл WebSocket-з'єднання: вхід, перевірка повідомлень, heartbeat, ліміти.

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { CODECS } from '@moba-arena/shared/codec/index.ts';
import {
  CLOSE,
  TICK_RATE,
  parseClientMessage,
  serverMessage,
  type ClientMessage,
  type ClientMessageOf,
  type CloseCode,
  type Input,
} from '@moba-arena/shared/protocol.ts';
import type { ServerConfig } from './config.ts';
import { createHeartbeat } from './heartbeat.ts';
import type { Logger } from './logger.ts';
import type { Metrics, RejectionReason } from './metrics.ts';
import type { Frame, MatchManager, SendOptions } from './match.ts';
import { RoomError, type PlayerRef, type Room, type RoomManager } from './rooms.ts';
import { createTokenBucket, type TokenBucket } from './token-bucket.ts';

// Input іде 30 разів/с — у нього власний, щедріший ліміт, ніж у чату.
const INPUT_RATE = TICK_RATE * 3;

// Скільки чекаємо, поки порушник сам завершить закриття, перш ніж обірвати сокет.
const CLOSE_GRACE_MS = 1000;

// Стан одного з'єднання. Живе поруч із сокетом у WeakMap, а не як вигадане поле ws.state:
// у типі WebSocket такого поля немає, і tsc не дав би до нього звернутись.
export interface SocketState {
  readonly id: string;
  readonly ip: string;
  // Логер цього з'єднання: playerId (а після входу ще й roomId) — у кожному його рядку.
  log: Logger;
  // Сервер уже закриває цей сокет: усе, що він іще надішле, ігноруємо не розбираючи.
  closing: boolean;
  player: PlayerRef | null;
  room: Room | null;
  readonly bucket: TokenBucket;
  readonly inputBucket: TokenBucket;
  dropped: number;
  readonly joinTimer: NodeJS.Timeout;
}

// Серверне повідомлення без поля v — рівно те, що приймає serverMessage().
type Outgoing = Parameters<typeof serverMessage>[0];

export interface WebSocketDeps {
  readonly server: Server;
  readonly rooms: RoomManager;
  readonly matches: MatchManager;
  readonly config: ServerConfig;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

// Причина відмови для метрик — за кодом закриття, який повернув розбір повідомлення.
function parseFailure(code: CloseCode): RejectionReason {
  if (code === CLOSE.UNKNOWN_TYPE) return 'unknown_type';
  if (code === CLOSE.VERSION) return 'bad_version';
  return 'bad_message';
}

function byteSize(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((sum, chunk) => sum + chunk.length, 0);
  return data.byteLength;
}

const HTTP_STATUS = {
  403: 'Forbidden',
  404: 'Not Found',
  429: 'Too Many Requests',
  503: 'Service Unavailable',
} as const;

// Бібліотека ws віддає текстовий кадр як Buffer (або шматками, або ArrayBuffer —
// залежно від налаштувань). Зводимо всі варіанти до рядка.
function toText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

export function attachWebSocket({
  server,
  rooms,
  matches,
  config,
  logger,
  metrics,
}: WebSocketDeps) {
  // noServer: рукостискання робимо самі в 'upgrade' — щоб приймати сокети лише на /ws.
  // maxPayload: завелике повідомлення ws відкидає сам, закриваючи сокет із кодом 1009.
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxPayload });
  const socketsByRoom = new Map<string, Set<WebSocket>>(); // id кімнати → сокети
  // WeakMap: щойно сокет зник, його стан теж можна прибрати — ключ не тримає об'єкт у пам'яті.
  const states = new WeakMap<WebSocket, SocketState>();
  // Лічильники з Lab 4 (їх віддає /api/stats): rejected — сокети, які закрив сам сервер
  // за порушення. Докладніше, за причинами й разом із відмовами в рукостисканні, — у metrics.
  const stats = { accepted: 0, rejected: 0, dropped: 0 };
  // IP-адреса → скільки живих сокетів із неї. Запис зникає разом з останнім сокетом,
  // тож карта не росте від адрес, які давно пішли.
  const perIp = new Map<string, number>();
  const allowedOrigins = new Set(config.allowedOrigins);
  let accepting = true;

  // Адреса клієнта. За проксі хостингу remoteAddress — це адреса самого проксі, а справжня
  // їде в X-Forwarded-For (перший запис). Довіряти заголовку можна лише коли проксі справді є.
  function clientIp(request: IncomingMessage): string {
    if (config.trustProxy) {
      const header = request.headers['x-forwarded-for'];
      const first = (Array.isArray(header) ? header[0] : header)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return request.socket.remoteAddress ?? 'unknown';
  }

  // Відмова ще ДО рукостискання WebSocket: звичайна HTTP-відповідь і закритий сокет.
  // У браузері це подія error + close 1006 — сторінка-зловмисник не дізнається причини.
  function refuse(
    socket: Duplex,
    status: keyof typeof HTTP_STATUS,
    reason: RejectionReason,
    fields: Readonly<Record<string, unknown>>,
  ): void {
    metrics.reject(reason);
    logger.warn('handshake rejected', { status, reason, ...fields });
    socket.end(
      `HTTP/1.1 ${status} ${HTTP_STATUS[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }

  function originAllowed(origin: string | undefined): boolean {
    if (allowedOrigins.size === 0) return true; // перевірку вимкнено (розробка)
    if (origin === undefined) return config.allowNoOrigin; // не браузер
    return allowedOrigins.has(origin.toLowerCase());
  }

  server.on('upgrade', (request, socket, head) => {
    // Сокет, що обірвався посеред рукостискання, не повинен валити процес.
    socket.on('error', (error) => logger.debug('upgrade socket error', { error: error.message }));
    const { pathname } = new URL(request.url ?? '/', 'http://localhost');
    const ip = clientIp(request);
    if (pathname !== '/ws') return refuse(socket, 404, 'not_found', { ip, path: pathname });
    if (!accepting) return refuse(socket, 503, 'shutting_down', { ip });
    // Origin браузер ставить сам, і сторінка підробити його не може. Без цієї перевірки
    // будь-який чужий сайт міг би відкрити сокет до гри з браузера нашого гравця.
    const { origin } = request.headers;
    if (!originAllowed(origin)) return refuse(socket, 403, 'origin_rejected', { ip, origin });
    if ((perIp.get(ip) ?? 0) >= config.maxConnectionsPerIp) {
      return refuse(socket, 429, 'ip_limit', { ip, limit: config.maxConnectionsPerIp });
    }
    wss.handleUpgrade(request, socket, head, (ws) => onConnection(ws, ip));
  });

  function closeWith(
    ws: WebSocket,
    code: CloseCode,
    reason: string,
    metric: RejectionReason,
  ): void {
    const state = states.get(ws);
    if (state?.closing) return; // уже закриваємо — другий раз не рахуємо й не пишемо
    stats.rejected += 1;
    metrics.reject(metric);
    (state?.log ?? logger).warn('closing socket', { code, reason, rejection: metric });
    ws.close(code, reason);
    if (!state) return;
    state.closing = true;
    // Чемне закриття чекає на кадр закриття від клієнта. Порушник може його не надіслати
    // й далі слати сміття — тому за секунду обриваємо з'єднання самі.
    const force = setTimeout(() => ws.terminate(), CLOSE_GRACE_MS);
    force.unref();
    ws.once('close', () => clearTimeout(force));
  }

  // Політика «повільного клієнта». bufferedAmount — байти, які ми вже віддали в send(),
  // але мережа ще не забрала. Якщо клієнт не встигає читати, цей буфер росте в НАШІЙ пам'яті.
  // Тому некритичне (чат; у Lab 5 — знімки стану) такому клієнту просто не шлемо,
  // а якщо буфер виріс у 16 разів за поріг — розриваємо з'єднання.
  function send(ws: WebSocket, message: Outgoing, options?: SendOptions): boolean {
    return sendRaw(ws, serverMessage(message), options);
  }

  // data — уже готовий кадр: рядок JSON або байти знімка.
  function sendRaw(ws: WebSocket, data: Frame, { critical = true }: SendOptions = {}): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    if (ws.bufferedAmount > config.slowClientBytes) {
      const state = states.get(ws);
      if (ws.bufferedAmount > config.slowClientBytes * 16) {
        metrics.reject('slow_client');
        (state?.log ?? logger).warn('slow client terminated', { buffered: ws.bufferedAmount });
        ws.close(CLOSE.SLOW_CLIENT, 'too slow');
        ws.terminate();
        return false;
      }
      if (!critical) {
        stats.dropped += 1;
        metrics.dropped();
        if (state) state.dropped += 1;
        return false;
      }
    }
    ws.send(data);
    metrics.bytesOut(typeof data === 'string' ? Buffer.byteLength(data) : data.length);
    return true;
  }

  function broadcast(room: Room, message: Outgoing, options?: SendOptions): void {
    for (const ws of socketsByRoom.get(room.id) ?? []) send(ws, message, options);
  }

  // Розсилка — це реакція на події кімнати, а не код усередині обробника повідомлення.
  function wire(room: Room): void {
    const roster = (): void => broadcast(room, { type: 'roster', players: room.roster() });
    room.on('join', roster);
    room.on('leave', roster);
    room.on('chat', (message) =>
      broadcast(room, { type: 'chat', ...message }, { critical: false }),
    );
  }
  rooms.list().forEach(wire);
  rooms.on('created', wire);
  rooms.on('deleted', (room) => {
    socketsByRoom.delete(room.id);
  });

  // Ігровий input: бінарний кадр або JSON — залежно від кодека, обраного при вході.
  function handleInput(ws: WebSocket, state: SocketState, input: Input): void {
    const { room, player } = state;
    if (!room || !player) return closeWith(ws, CLOSE.BAD_MESSAGE, 'join first', 'bad_message');
    if (!state.inputBucket.take()) {
      return closeWith(ws, CLOSE.RATE_LIMIT, 'input rate limit exceeded', 'rate_limit');
    }
    matches.get(room.id)?.pushInput(player.id, input);
  }

  function detach(ws: WebSocket, state: SocketState): void {
    const { room, player } = state;
    if (!room || !player) return;
    state.room = null;
    socketsByRoom.get(room.id)?.delete(ws);
    room.leave(player.id);
  }

  function handleJoin(ws: WebSocket, state: SocketState, message: ClientMessageOf<'join'>): void {
    if (state.room) return closeWith(ws, CLOSE.BAD_MESSAGE, 'already joined', 'bad_message');
    const room = rooms.get(message.room);
    if (!room) return closeWith(ws, CLOSE.JOIN_REJECTED, 'room not found', 'room_not_found');
    if (room.isFull) return closeWith(ws, CLOSE.JOIN_REJECTED, 'room is full', 'room_full');

    clearTimeout(state.joinTimer);
    // Пробіли з країв імені вже обрізала схема протоколу.
    const player: PlayerRef = { id: state.id, name: message.name };
    state.player = player;
    state.room = room;
    let sockets = socketsByRoom.get(room.id);
    if (!sockets) {
      sockets = new Set();
      socketsByRoom.set(room.id, sockets);
    }
    sockets.add(ws);

    // room.join → подія 'join': спершу матч створює героя (він підписаний раніше),
    // потім розсилається roster уже з shipId.
    const joined = room.join(player);
    const match = matches.get(room.id);
    // Героя створює матч у відповідь на подію 'join'. Без матчу немає й shipId,
    // а welcome без нього клієнт не прийме — тож чесно відмовляємо.
    if (!match || joined.shipId === undefined) {
      detach(ws, state);
      return closeWith(ws, CLOSE.JOIN_REJECTED, 'match is not running', 'join_rejected');
    }
    const codec = CODECS[message.codec ?? 'binary'];
    match.attach(player.id, {
      codec,
      send: (data, options) => sendRaw(ws, data, options),
    });
    send(ws, {
      type: 'welcome',
      playerId: state.id,
      shipId: joined.shipId,
      room: room.toJSON(),
      tickRate: TICK_RATE,
      codec: codec.name,
      version: config.version,
    });
    state.log = state.log.child({ roomId: room.id });
    state.log.info('player joined', { name: player.name, codec: codec.name });
  }

  function handleChat(ws: WebSocket, state: SocketState, message: ClientMessageOf<'chat'>): void {
    const { room, player } = state;
    if (!room || !player) return closeWith(ws, CLOSE.BAD_MESSAGE, 'join first', 'bad_message');
    // Сам текст чату в лог сервера не потрапляє — лише в журнал матчу (він і є повтором).
    room.chat(player.id, message.text); // текст уже обрізаний схемою протоколу
  }

  // Розподіл за типом повідомлення. ClientMessage — розрізнюване об'єднання, тож у кожній
  // гілці tsc знає точну форму message.
  function handleMessage(ws: WebSocket, state: SocketState, message: ClientMessage): void {
    switch (message.type) {
      case 'join':
        return handleJoin(ws, state, message);
      case 'chat':
        return handleChat(ws, state, message);
      case 'ping':
        send(ws, { type: 'pong', t: message.t });
        return;
      case 'input': {
        const { seq, turn, thrust, brake, dash, fire } = message;
        return handleInput(ws, state, { seq, turn, thrust, brake, dash, fire });
      }
      case 'leave':
        detach(ws, state);
        ws.close(CLOSE.NORMAL, 'bye');
        return;
      default: {
        // Усі типи розібрано вище, тож тут message має тип never. Додасться новий тип
        // повідомлення без гілки — цей рядок перестане компілюватись.
        const unhandled: never = message;
        throw new Error(`Невідомий тип повідомлення: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  function onConnection(ws: WebSocket, ip: string): void {
    stats.accepted += 1;
    metrics.accepted();
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    const id = randomUUID().slice(0, 8);
    const state: SocketState = {
      id,
      ip,
      log: logger.child({ playerId: id }),
      closing: false,
      player: null,
      room: null,
      // Ліміти — token bucket (див. token-bucket.ts): N жетонів, наповнення N/с.
      bucket: createTokenBucket({ capacity: config.rateLimitPerSecond }),
      inputBucket: createTokenBucket({ capacity: INPUT_RATE }),
      dropped: 0,
      // Сокет, який підключився й мовчить, займає місце. Даємо 5 с на join.
      joinTimer: setTimeout(
        () => closeWith(ws, CLOSE.JOIN_TIMEOUT, 'join timeout', 'join_timeout'),
        config.joinTimeoutMs,
      ),
    };
    states.set(ws, state);

    // ОБОВ'ЯЗКОВО на кожному сокеті. EventEmitter без слухача 'error' кидає помилку
    // як виняток — і один клієнт із обірваним з'єднанням поклав би весь сервер.
    ws.on('error', (error) => {
      // Поле code є не в кожної помилки — у типі Error його немає, тому перевіряємо.
      const code = 'code' in error ? error.code : undefined;
      // Завеликий кадр ws відкидає сам (закриття з кодом 1009) і повідомляє цією помилкою.
      if (code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') metrics.reject('oversize');
      state.log.warn('socket error', { code, error: error.message });
    });

    ws.on('pong', () => heartbeat.alive(ws));

    ws.on('message', (data, isBinary) => {
      metrics.messageIn(byteSize(data));
      // Сокет уже закриваємо за порушення: решту його кадрів не розбираємо взагалі.
      // Так потік сміття коштує серверу лише читання байтів, а не JSON.parse і схему.
      if (state.closing) return;
      if (isBinary) {
        let input: Input;
        try {
          input = CODECS.binary.decodeInput(data);
        } catch (error) {
          // error тут unknown: кинути можна що завгодно, не лише Error.
          const reason = error instanceof Error ? error.message : 'invalid binary frame';
          return closeWith(ws, CLOSE.BAD_MESSAGE, reason, 'bad_message');
        }
        return handleInput(ws, state, input);
      }
      // Розбір не кидає винятків: поганий JSON чи не та форма — це результат { ok: false }.
      const parsed = parseClientMessage(toText(data));
      if (!parsed.ok) {
        return closeWith(ws, parsed.code, parsed.reason, parseFailure(parsed.code));
      }
      if (parsed.message.type !== 'input' && !state.bucket.take()) {
        return closeWith(ws, CLOSE.RATE_LIMIT, 'rate limit exceeded', 'rate_limit');
      }
      try {
        handleMessage(ws, state, parsed.message);
      } catch (error) {
        if (!(error instanceof RoomError)) throw error;
        closeWith(
          ws,
          CLOSE.JOIN_REJECTED,
          error.code,
          error.code === 'room_full' ? 'room_full' : 'join_rejected',
        );
      }
    });

    ws.on('close', (code) => {
      clearTimeout(state.joinTimer);
      const left = (perIp.get(ip) ?? 1) - 1;
      if (left > 0) perIp.set(ip, left);
      else perIp.delete(ip);
      const { player } = state;
      detach(ws, state);
      if (player) state.log.info('player left', { name: player.name, code });
    });
  }

  // Heartbeat: раз на heartbeatMs — ping; два пропущені pong поспіль — terminate().
  // Сам облік — у heartbeat.ts (там же пояснення, навіщо він узагалі потрібен).
  const heartbeat = createHeartbeat<WebSocket>({
    intervalMs: config.heartbeatMs,
    peers: () => wss.clients,
    onLost: (ws) => {
      metrics.reject('heartbeat_lost');
      (states.get(ws)?.log ?? logger).warn('heartbeat lost');
    },
  });
  heartbeat.start();

  // Зупинка: нових не приймаємо; кожному підключеному — повідомлення shutdown (клієнт за ним
  // повертає гравця в лобі) і одразу закриття з кодом 1001. Кадри в сокеті йдуть по черзі,
  // тож shutdown гарантовано приходить раніше за закриття.
  async function close({
    graceMs = 1000,
    reason = 'server is shutting down',
  }: { graceMs?: number; reason?: string } = {}): Promise<void> {
    accepting = false;
    heartbeat.stop();
    const farewell = serverMessage({ type: 'shutdown', reason });
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(farewell);
      ws.close(CLOSE.GOING_AWAY, 'server is shutting down');
    }
    // Даємо клієнтам завершити рукостискання закриття; хто не встиг — обриваємо.
    const deadline = Date.now() + graceMs;
    while (wss.clients.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  return {
    wss,
    stats,
    close,
    connections: () => wss.clients.size,
    // Скільки з'єднань зараз рахується за адресою (для тестів і діагностики).
    connectionsFrom: (ip: string): number => perIp.get(ip) ?? 0,
    get accepting() {
      return accepting;
    },
    // Стан з'єднання за сокетом (для тестів і діагностики).
    stateOf: (ws: WebSocket): SocketState | undefined => states.get(ws),
  };
}

export type WebSocketLayer = ReturnType<typeof attachWebSocket>;
