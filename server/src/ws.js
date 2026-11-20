// Життєвий цикл WebSocket-з'єднання: вхід, перевірка повідомлень, heartbeat, ліміти.

import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { CODECS } from '@moba-arena/shared/codec/index.js';
import { TICK_RATE } from '@moba-arena/shared/protocol.js';
import { CLOSE, parseClientMessage, serverMessage } from './protocol.js';
import { RoomError } from './rooms.js';

// Input іде 30 разів/с — у нього власний, щедріший ліміт, ніж у чату.
const INPUT_RATE = TICK_RATE * 3;

export function attachWebSocket({ server, rooms, matches, config, logger }) {
  // noServer: рукостискання робимо самі в 'upgrade' — щоб приймати сокети лише на /ws.
  // maxPayload: завелике повідомлення ws відкидає сам, закриваючи сокет із кодом 1009.
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxPayload });
  const socketsByRoom = new Map(); // id кімнати → Set<WebSocket>
  const stats = { accepted: 0, rejected: 0, dropped: 0 };

  server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    if (pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  });

  function closeWith(ws, code, reason) {
    stats.rejected += 1;
    logger.warn('closing socket', { socket: ws.state.id, code, reason });
    ws.close(code, reason);
  }

  // Політика «повільного клієнта». bufferedAmount — байти, які ми вже віддали в send(),
  // але мережа ще не забрала. Якщо клієнт не встигає читати, цей буфер росте в НАШІЙ пам'яті.
  // Тому некритичне (чат; у Lab 5 — знімки стану) такому клієнту просто не шлемо,
  // а якщо буфер виріс у 16 разів за поріг — розриваємо з'єднання.
  function send(ws, type, payload, options) {
    return sendRaw(ws, serverMessage(type, payload), options);
  }

  // data — уже готовий кадр: рядок JSON або байти знімка.
  function sendRaw(ws, data, { critical = true } = {}) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    if (ws.bufferedAmount > config.slowClientBytes) {
      if (ws.bufferedAmount > config.slowClientBytes * 16) {
        logger.warn('slow client terminated', { socket: ws.state.id, buffered: ws.bufferedAmount });
        ws.close(CLOSE.SLOW_CLIENT, 'too slow');
        ws.terminate();
        return false;
      }
      if (!critical) {
        stats.dropped += 1;
        ws.state.dropped += 1;
        return false;
      }
    }
    ws.send(data);
    return true;
  }

  function broadcast(room, type, payload, options) {
    for (const ws of socketsByRoom.get(room.id) ?? []) send(ws, type, payload, options);
  }

  // Розсилка — це реакція на події кімнати, а не код усередині обробника повідомлення.
  function wire(room) {
    const roster = () => broadcast(room, 'roster', { players: room.roster() });
    room.on('join', roster);
    room.on('leave', roster);
    room.on('chat', (message) => broadcast(room, 'chat', message, { critical: false }));
  }
  rooms.list().forEach(wire);
  rooms.on('created', wire);
  rooms.on('deleted', (room) => socketsByRoom.delete(room.id));

  // Token bucket: відро на N жетонів, що наповнюється зі швидкістю N/с.
  // Повідомлення коштує жетон; порожнє відро — клієнт шле занадто часто.
  function takeToken(bucket, rate) {
    const now = performance.now();
    bucket.tokens = Math.min(rate, bucket.tokens + ((now - bucket.refilledAt) / 1000) * rate);
    bucket.refilledAt = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  // Ігровий input: бінарний кадр або JSON — залежно від кодека, обраного при вході.
  function handleInput(ws, input) {
    if (!ws.state.room) return closeWith(ws, CLOSE.BAD_MESSAGE, 'join first');
    if (!takeToken(ws.state.inputBucket, INPUT_RATE)) {
      return closeWith(ws, CLOSE.RATE_LIMIT, 'input rate limit exceeded');
    }
    matches.get(ws.state.room.id)?.pushInput(ws.state.player.id, input);
    return undefined;
  }

  function detach(ws) {
    const { room, player } = ws.state;
    if (!room) return;
    ws.state.room = null;
    socketsByRoom.get(room.id)?.delete(ws);
    room.leave(player.id);
  }

  const handlers = {
    join(ws, message) {
      if (ws.state.room) return closeWith(ws, CLOSE.BAD_MESSAGE, 'already joined');
      const room = rooms.get(message.room);
      if (!room) return closeWith(ws, CLOSE.JOIN_REJECTED, 'room not found');
      if (room.isFull) return closeWith(ws, CLOSE.JOIN_REJECTED, 'room is full');

      clearTimeout(ws.state.joinTimer);
      ws.state.player = { id: ws.state.id, name: message.name.trim() };
      ws.state.room = room;
      if (!socketsByRoom.has(room.id)) socketsByRoom.set(room.id, new Set());
      socketsByRoom.get(room.id).add(ws);

      // room.join → подія 'join': спершу матч створює героя (він підписаний раніше),
      // потім розсилається roster уже з shipId.
      const joined = room.join(ws.state.player);
      const codec = CODECS[message.codec ?? 'binary'];
      matches.get(room.id)?.attach(ws.state.player.id, {
        codec,
        send: (data, options) => sendRaw(ws, data, options),
      });
      send(ws, 'welcome', {
        playerId: ws.state.id,
        shipId: joined.shipId,
        room: room.toJSON(),
        tickRate: TICK_RATE,
        codec: codec.name,
      });
      logger.info('player joined', { room: room.id, player: ws.state.player });
    },

    chat(ws, message) {
      if (!ws.state.room) return closeWith(ws, CLOSE.BAD_MESSAGE, 'join first');
      ws.state.room.chat(ws.state.player.id, message.text.trim());
    },

    ping(ws, message) {
      send(ws, 'pong', { t: message.t });
    },

    input(ws, message) {
      handleInput(ws, message.input);
    },

    leave(ws) {
      detach(ws);
      ws.close(CLOSE.NORMAL, 'bye');
    },
  };

  wss.on('connection', (ws) => {
    stats.accepted += 1;
    ws.state = {
      id: randomUUID().slice(0, 8),
      player: null,
      room: null,
      missedPongs: 0,
      bucket: { tokens: config.rateLimitPerSecond, refilledAt: performance.now() },
      inputBucket: { tokens: INPUT_RATE, refilledAt: performance.now() },
      dropped: 0,
      joinTimer: null,
    };

    // ОБОВ'ЯЗКОВО на кожному сокеті. EventEmitter без слухача 'error' кидає помилку
    // як виняток — і один клієнт із обірваним з'єднанням поклав би весь сервер.
    ws.on('error', (error) => {
      logger.warn('socket error', { socket: ws.state.id, code: error.code, error: error.message });
    });

    // Сокет, який підключився й мовчить, займає місце. Даємо 5 с на join.
    ws.state.joinTimer = setTimeout(
      () => closeWith(ws, CLOSE.JOIN_TIMEOUT, 'join timeout'),
      config.joinTimeoutMs,
    );

    ws.on('pong', () => {
      ws.state.missedPongs = 0;
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        let input;
        try {
          input = CODECS.binary.decodeInput(data);
        } catch (error) {
          return closeWith(ws, CLOSE.BAD_MESSAGE, error.message);
        }
        return handleInput(ws, input);
      }
      const parsed = parseClientMessage(data);
      if (!parsed.ok) return closeWith(ws, parsed.code, parsed.reason);
      if (
        parsed.message.type !== 'input' &&
        !takeToken(ws.state.bucket, config.rateLimitPerSecond)
      ) {
        return closeWith(ws, CLOSE.RATE_LIMIT, 'rate limit exceeded');
      }
      try {
        handlers[parsed.message.type](ws, parsed.message);
      } catch (error) {
        if (!(error instanceof RoomError)) throw error;
        closeWith(ws, CLOSE.JOIN_REJECTED, error.code);
      }
    });

    ws.on('close', (code) => {
      clearTimeout(ws.state.joinTimer);
      const { player, room } = ws.state;
      detach(ws);
      if (player) logger.info('player left', { room: room?.id, player, code });
    });
  });

  // Heartbeat. TCP може «висіти» годинами після того, як клієнт зник (ноутбук закрили,
  // Wi-Fi відпав) — події close не буде. Тому раз на heartbeatMs шлемо ping;
  // хто пропустив два pong поспіль — того terminate().
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.state.missedPongs >= 2) {
        logger.warn('heartbeat lost', { socket: ws.state.id });
        ws.terminate();
        continue;
      }
      ws.state.missedPongs += 1;
      ws.ping();
    }
  }, config.heartbeatMs);

  async function close({ graceMs = 1000 } = {}) {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.close(CLOSE.GOING_AWAY, 'server is shutting down');
    // Даємо клієнтам завершити рукостискання закриття; хто не встиг — обриваємо.
    const deadline = Date.now() + graceMs;
    while (wss.clients.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
  }

  return { wss, stats, close, connections: () => wss.clients.size };
}
