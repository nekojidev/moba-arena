// Життєвий цикл WebSocket-з'єднання: вхід, перевірка повідомлень, heartbeat, ліміти.

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
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
import type { Logger } from './logger.ts';
import type { Frame, MatchManager, SendOptions } from './match.ts';
import { RoomError, type PlayerRef, type Room, type RoomManager } from './rooms.ts';

// Input іде 30 разів/с — у нього власний, щедріший ліміт, ніж у чату.
const INPUT_RATE = TICK_RATE * 3;

interface Bucket {
  tokens: number;
  refilledAt: number;
}

// Стан одного з'єднання. Живе поруч із сокетом у WeakMap, а не як вигадане поле ws.state:
// у типі WebSocket такого поля немає, і tsc не дав би до нього звернутись.
export interface SocketState {
  readonly id: string;
  player: PlayerRef | null;
  room: Room | null;
  missedPongs: number;
  readonly bucket: Bucket;
  readonly inputBucket: Bucket;
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
}

// Бібліотека ws віддає текстовий кадр як Buffer (або шматками, або ArrayBuffer —
// залежно від налаштувань). Зводимо всі варіанти до рядка.
function toText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

export function attachWebSocket({ server, rooms, matches, config, logger }: WebSocketDeps) {
  // noServer: рукостискання робимо самі в 'upgrade' — щоб приймати сокети лише на /ws.
  // maxPayload: завелике повідомлення ws відкидає сам, закриваючи сокет із кодом 1009.
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxPayload });
  const socketsByRoom = new Map<string, Set<WebSocket>>(); // id кімнати → сокети
  // WeakMap: щойно сокет зник, його стан теж можна прибрати — ключ не тримає об'єкт у пам'яті.
  const states = new WeakMap<WebSocket, SocketState>();
  const stats = { accepted: 0, rejected: 0, dropped: 0 };

  server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url ?? '/', 'http://localhost');
    if (pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  });

  function closeWith(ws: WebSocket, code: CloseCode, reason: string): void {
    stats.rejected += 1;
    logger.warn('closing socket', { socket: states.get(ws)?.id, code, reason });
    ws.close(code, reason);
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
        logger.warn('slow client terminated', { socket: state?.id, buffered: ws.bufferedAmount });
        ws.close(CLOSE.SLOW_CLIENT, 'too slow');
        ws.terminate();
        return false;
      }
      if (!critical) {
        stats.dropped += 1;
        if (state) state.dropped += 1;
        return false;
      }
    }
    ws.send(data);
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

  // Token bucket: відро на N жетонів, що наповнюється зі швидкістю N/с.
  // Повідомлення коштує жетон; порожнє відро — клієнт шле занадто часто.
  function takeToken(bucket: Bucket, rate: number): boolean {
    const now = performance.now();
    bucket.tokens = Math.min(rate, bucket.tokens + ((now - bucket.refilledAt) / 1000) * rate);
    bucket.refilledAt = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  // Ігровий input: бінарний кадр або JSON — залежно від кодека, обраного при вході.
  function handleInput(ws: WebSocket, state: SocketState, input: Input): void {
    const { room, player } = state;
    if (!room || !player) return closeWith(ws, CLOSE.BAD_MESSAGE, 'join first');
    if (!takeToken(state.inputBucket, INPUT_RATE)) {
      return closeWith(ws, CLOSE.RATE_LIMIT, 'input rate limit exceeded');
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
    if (state.room) return closeWith(ws, CLOSE.BAD_MESSAGE, 'already joined');
    const room = rooms.get(message.room);
    if (!room) return closeWith(ws, CLOSE.JOIN_REJECTED, 'room not found');
    if (room.isFull) return closeWith(ws, CLOSE.JOIN_REJECTED, 'room is full');

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
      return closeWith(ws, CLOSE.JOIN_REJECTED, 'match is not running');
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
    });
    logger.info('player joined', { room: room.id, player });
  }

  function handleChat(ws: WebSocket, state: SocketState, message: ClientMessageOf<'chat'>): void {
    const { room, player } = state;
    if (!room || !player) return closeWith(ws, CLOSE.BAD_MESSAGE, 'join first');
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

  wss.on('connection', (ws) => {
    stats.accepted += 1;
    const state: SocketState = {
      id: randomUUID().slice(0, 8),
      player: null,
      room: null,
      missedPongs: 0,
      bucket: { tokens: config.rateLimitPerSecond, refilledAt: performance.now() },
      inputBucket: { tokens: INPUT_RATE, refilledAt: performance.now() },
      dropped: 0,
      // Сокет, який підключився й мовчить, займає місце. Даємо 5 с на join.
      joinTimer: setTimeout(
        () => closeWith(ws, CLOSE.JOIN_TIMEOUT, 'join timeout'),
        config.joinTimeoutMs,
      ),
    };
    states.set(ws, state);

    // ОБОВ'ЯЗКОВО на кожному сокеті. EventEmitter без слухача 'error' кидає помилку
    // як виняток — і один клієнт із обірваним з'єднанням поклав би весь сервер.
    ws.on('error', (error) => {
      // Поле code є не в кожної помилки — у типі Error його немає, тому перевіряємо.
      const code = 'code' in error ? error.code : undefined;
      logger.warn('socket error', { socket: state.id, code, error: error.message });
    });

    ws.on('pong', () => {
      state.missedPongs = 0;
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        let input: Input;
        try {
          input = CODECS.binary.decodeInput(data);
        } catch (error) {
          // error тут unknown: кинути можна що завгодно, не лише Error.
          const reason = error instanceof Error ? error.message : 'invalid binary frame';
          return closeWith(ws, CLOSE.BAD_MESSAGE, reason);
        }
        return handleInput(ws, state, input);
      }
      // Розбір не кидає винятків: поганий JSON чи не та форма — це результат { ok: false }.
      const parsed = parseClientMessage(toText(data));
      if (!parsed.ok) return closeWith(ws, parsed.code, parsed.reason);
      if (parsed.message.type !== 'input' && !takeToken(state.bucket, config.rateLimitPerSecond)) {
        return closeWith(ws, CLOSE.RATE_LIMIT, 'rate limit exceeded');
      }
      try {
        handleMessage(ws, state, parsed.message);
      } catch (error) {
        if (!(error instanceof RoomError)) throw error;
        closeWith(ws, CLOSE.JOIN_REJECTED, error.code);
      }
    });

    ws.on('close', (code) => {
      clearTimeout(state.joinTimer);
      const { player, room } = state;
      detach(ws, state);
      if (player) logger.info('player left', { room: room?.id, player, code });
    });
  });

  // Heartbeat. TCP може «висіти» годинами після того, як клієнт зник (ноутбук закрили,
  // Wi-Fi відпав) — події close не буде. Тому раз на heartbeatMs шлемо ping;
  // хто пропустив два pong поспіль — того terminate().
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const state = states.get(ws);
      if (!state) continue;
      if (state.missedPongs >= 2) {
        logger.warn('heartbeat lost', { socket: state.id });
        ws.terminate();
        continue;
      }
      state.missedPongs += 1;
      ws.ping();
    }
  }, config.heartbeatMs);

  async function close({ graceMs = 1000 }: { graceMs?: number } = {}): Promise<void> {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.close(CLOSE.GOING_AWAY, 'server is shutting down');
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
    // Стан з'єднання за сокетом (для тестів і діагностики).
    stateOf: (ws: WebSocket): SocketState | undefined => states.get(ws),
  };
}

export type WebSocketLayer = ReturnType<typeof attachWebSocket>;
