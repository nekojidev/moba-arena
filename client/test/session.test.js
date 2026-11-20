// Коли гру треба зупинити й повернути гравця в лобі (src/lobby/session.ts).
import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { serverMessage } from '@moba-arena/shared/protocol.ts';
import { DEFAULT_MAX_ATTEMPTS, returnReason, watchSession } from '../src/lobby/session.ts';
import { createConnection } from '../src/net/connection.ts';

describe('returnReason: чиста функція від події', () => {
  test('shutdown від сервера — одразу в лобі, з поясненням', () => {
    const decision = returnReason({ v: 1, type: 'shutdown', reason: 'server is shutting down' });
    assert.deepEqual(decision, {
      reason: 'shutdown',
      message: 'Сервер перезапускається — повертаємось у лобі',
    });
  });

  test('звичайне життя з’єднання лобі не викликає', () => {
    assert.equal(returnReason({ status: 'connecting', attempt: 0 }), null);
    assert.equal(returnReason({ status: 'open' }), null);
    assert.equal(returnReason({ status: 'reconnecting', attempt: 2 }), null);
    // Закрили самі (гравець пішов зі сторінки) — повертати нікого й нікуди.
    assert.equal(returnReason({ status: 'closed', code: 1000, reason: null, fatal: false }), null);
  });

  test('короткий збій гра переживає; кілька невдалих спроб поспіль — лобі', () => {
    const waiting = (attempt) => ({ status: 'waiting', attempt, waitMs: 500, code: 1006 });
    for (let attempt = 1; attempt <= DEFAULT_MAX_ATTEMPTS; attempt += 1) {
      assert.equal(returnReason(waiting(attempt)), null, `спроба ${attempt}`);
    }
    const decision = returnReason(waiting(DEFAULT_MAX_ATTEMPTS + 1));
    assert.equal(decision.reason, 'unreachable');
    assert.match(decision.message, /не відповідає — повертаємось у лобі/);
    // Межу можна задати.
    assert.equal(returnReason(waiting(2), { maxAttempts: 1 }).reason, 'unreachable');
    assert.equal(returnReason(waiting(1), { maxAttempts: 1 }), null);
  });

  test('сервер повернувся, але відмовив (кімнати вже немає) — лобі з причиною', () => {
    const decision = returnReason({
      status: 'closed',
      code: 4004,
      reason: 'кімната заповнена або вже не існує',
      fatal: true,
    });
    assert.equal(decision.reason, 'rejected');
    assert.match(decision.message, /кімната заповнена або вже не існує/);
    assert.match(decision.message, /повертаємось у лобі/);
    const unnamed = returnReason({ status: 'closed', code: 1000, reason: null, fatal: true });
    assert.match(unnamed.message, /сервер розірвав з’єднання/);
  });
});

// Підставне з'єднання: тест сам «надсилає» події.
function fakeConnection({ last = undefined } = {}) {
  const handlers = { shutdown: new Set(), status: new Set() };
  const subscribe = (type, handler, { signal } = {}) => {
    if (signal?.aborted) return;
    handlers[type].add(handler);
    signal?.addEventListener('abort', () => handlers[type].delete(handler), { once: true });
  };
  return {
    on: subscribe,
    onStatus: (handler, options) => subscribe('status', handler, options),
    last: () => last,
    emit: (type, event) => [...handlers[type]].forEach((handler) => handler(event)),
    get listeners() {
      return handlers.shutdown.size + handlers.status.size;
    },
  };
}

describe('watchSession: підписка на з’єднання', () => {
  const shutdown = { v: 1, type: 'shutdown', reason: 'deploy' };

  test('спрацьовує рівно один раз і знімає своїх слухачів', () => {
    const connection = fakeConnection();
    const decisions = [];
    watchSession(connection, { onReturn: (decision) => decisions.push(decision) });
    assert.equal(connection.listeners, 2);

    connection.emit('status', { status: 'open' });
    assert.equal(decisions.length, 0);
    connection.emit('shutdown', shutdown);
    // За shutdown сервер закриває сокет — це вже не має викликати друге повернення.
    connection.emit('status', { status: 'waiting', attempt: 9, waitMs: 8000, code: 1001 });
    connection.emit('status', { status: 'closed', code: 4004, reason: 'x', fatal: true });
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].reason, 'shutdown');
    assert.equal(connection.listeners, 0, 'слухачів не лишилось');
  });

  test('невдалі спроби: рішення саме на (maxAttempts + 1)-й паузі', () => {
    const connection = fakeConnection();
    const decisions = [];
    watchSession(connection, { maxAttempts: 2, onReturn: (decision) => decisions.push(decision) });
    for (const attempt of [1, 2]) {
      connection.emit('status', { status: 'waiting', attempt, waitMs: 100, code: 1006 });
      connection.emit('status', { status: 'reconnecting', attempt });
    }
    assert.equal(decisions.length, 0);
    connection.emit('status', { status: 'waiting', attempt: 3, waitMs: 100, code: 1006 });
    assert.deepEqual(
      decisions.map((decision) => decision.reason),
      ['unreachable'],
    );
  });

  test('зовнішній сигнал (гру зупинили інакше) знімає слухачів, рішення вже не буде', () => {
    const connection = fakeConnection();
    const controller = new AbortController();
    let returned = 0;
    watchSession(connection, { signal: controller.signal, onReturn: () => (returned += 1) });
    controller.abort();
    assert.equal(connection.listeners, 0);
    connection.emit('shutdown', shutdown);
    assert.equal(returned, 0);
  });

  test('shutdown, що прийшов до підписки, не губиться', () => {
    const decisions = [];
    watchSession(fakeConnection({ last: shutdown }), {
      onReturn: (decision) => decisions.push(decision),
    });
    assert.equal(decisions[0]?.reason, 'shutdown');
  });
});

// Справжнє з'єднання з підставним WebSocket: повний шлях «shutdown від сервера → рішення».
class FakeSocket extends EventTarget {
  static OPEN = 1;
  static instances = [];
  readyState = 0;
  sent = [];
  constructor(url) {
    super();
    this.url = url;
    FakeSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.serverClose(code);
  }
  serverOpen() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }
  serverSend(data) {
    this.dispatchEvent(Object.assign(new Event('message'), { data }));
  }
  serverClose(code) {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code }));
  }
}

test('з’єднання: shutdown розбирається схемою і доходить до спостерігача; після повернення сокет закрито', () => {
  FakeSocket.instances.length = 0;
  const connection = createConnection({
    url: 'ws://test/ws',
    hello: () => ({ type: 'join', room: 'mid', name: 'Анна' }),
    WebSocketImpl: FakeSocket,
  });
  const statuses = [];
  connection.onStatus((event) => statuses.push(event.status));
  const decisions = [];
  watchSession(connection, {
    onReturn(decision) {
      decisions.push(decision);
      connection.close(); // так робить main.ts: у лобі буде нове з'єднання
    },
  });

  const [socket] = FakeSocket.instances;
  socket.serverOpen();
  assert.equal(JSON.parse(socket.sent[0]).type, 'join');
  // Зіпсований shutdown (без reason) схема не пропускає — рішення немає.
  socket.serverSend(JSON.stringify({ v: 1, type: 'shutdown' }));
  assert.equal(decisions.length, 0);

  socket.serverSend(serverMessage({ type: 'shutdown', reason: 'server is shutting down' }));
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].message, 'Сервер перезапускається — повертаємось у лобі');
  assert.deepEqual(connection.last('shutdown'), {
    v: 1,
    type: 'shutdown',
    reason: 'server is shutting down',
  });
  // Закрили самі — жодних повторних спроб, новий сокет не створено.
  assert.equal(connection.status, 'closed');
  assert.equal(FakeSocket.instances.length, 1);
  assert.equal(statuses.includes('waiting'), false);
});
