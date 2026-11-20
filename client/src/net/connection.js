// Обгортка над WebSocket: розбір повідомлень за type, черга відправки, перепідключення.
//
//   const connection = createConnection({ url, hello: () => ({ type: 'join', room, name }) });
//   connection.on('chat', (message) => …);
//   connection.send({ type: 'chat', text: 'gg' });   // можна ще до відкриття сокета
//
// Сам WebSocket одноразовий: закрився — і все. «Перепідключення» — це новий сокет,
// тому слухачів вішаємо не на нього, а на власний EventTarget, який живе довше.

import { PROTOCOL_VERSION } from '@moba-arena/shared/protocol.js';

// Після цих кодів пробувати ще раз марно: сервер відмовив саме нам, а не «зник».
const FATAL_CODES = new Set([1000, 4000, 4001, 4003, 4004, 4005, 4006]);

export const CLOSE_REASONS = {
  4000: 'сервер не зрозумів повідомлення',
  4001: 'сервер не знає такого повідомлення',
  4002: 'сервер не дочекався входу',
  4003: 'забагато повідомлень за секунду',
  4004: 'кімната заповнена або вже не існує',
  4005: 'версія клієнта застаріла — оновіть сторінку',
  4006: 'з’єднання надто повільне',
};

export function createConnection({
  url,
  hello = null, // () => перше повідомлення після КОЖНОГО відкриття (вхід у кімнату)
  baseMs = 500,
  maxMs = 8000,
  maxQueue = 50,
  random = Math.random,
  WebSocketImpl = globalThis.WebSocket,
}) {
  const events = new EventTarget();
  const queue = [];
  const last = new Map(); // type → останнє повідомлення цього типу
  let socket = null;
  let attempt = 0;
  let timer = null;
  let closedByUs = false;
  let status = 'idle';

  const emit = (type, detail) => events.dispatchEvent(new CustomEvent(type, { detail }));
  const encode = (message) => JSON.stringify({ v: PROTOCOL_VERSION, ...message });

  function setStatus(next, detail = {}) {
    status = next;
    emit('status', { status: next, ...detail });
  }

  function open() {
    timer = null;
    setStatus(attempt === 0 ? 'connecting' : 'reconnecting', { attempt });
    const current = new WebSocketImpl(url);
    current.binaryType = 'arraybuffer'; // бінарні кадри приходять як ArrayBuffer, а не Blob
    socket = current;

    current.addEventListener('open', () => {
      attempt = 0;
      setStatus('open');
      // Спершу — вхід (сервер чекає його першим), потім усе, що накопичилось у черзі.
      if (hello) current.send(encode(hello()));
      for (const message of queue.splice(0)) current.send(encode(message));
    });

    current.addEventListener('message', (event) => {
      // Бінарний кадр — ігрове повідомлення (знімок): віддаємо байти як є, розбере кодек.
      if (typeof event.data !== 'string') {
        emit('binary', event.data);
        return;
      }
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return; // сервер наш, але клієнт теж не вірить мережі на слово
      }
      if (typeof message?.type !== 'string') return;
      last.set(message.type, message);
      emit(`message:${message.type}`, message);
    });

    // 'error' нічого корисного не каже, а за ним завжди йде 'close' — реагуємо там.
    current.addEventListener('error', () => {});

    current.addEventListener('close', (event) => {
      if (socket !== current) return;
      socket = null;
      const reason = CLOSE_REASONS[event.code] ?? null;
      if (closedByUs || FATAL_CODES.has(event.code)) {
        setStatus('closed', { code: event.code, reason, fatal: !closedByUs });
        return;
      }
      // Експоненційна пауза з jitter — та сама ідея, що у withRetry з Lab 3:
      // якщо сервер перезапускався, тисяча клієнтів не повернеться в ту саму мілісекунду.
      attempt += 1;
      const ceiling = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const waitMs = ceiling / 2 + random() * (ceiling / 2);
      setStatus('waiting', { attempt, waitMs, code: event.code });
      timer = setTimeout(open, waitMs);
    });
  }

  open();

  return {
    get status() {
      return status;
    },

    get queued() {
      return queue.length;
    },

    // Підписка за типом повідомлення. { signal } знімає слухача, як у DOM.
    on(type, handler, options) {
      const name = type === 'status' ? 'status' : `message:${type}`;
      events.addEventListener(name, (event) => handler(event.detail), options);
    },

    last: (type) => last.get(type),

    onBinary(handler, options) {
      events.addEventListener('binary', (event) => handler(event.detail), options);
    },

    // Готовий кадр (байти або рядок) без черги: input, що запізнився, уже нікому не потрібен —
    // немає зв'язку, отже просто не шлемо.
    sendRaw(data) {
      if (socket?.readyState !== WebSocketImpl.OPEN) return false;
      socket.send(data);
      return true;
    },

    // Сокет ще не відкрито (або він перепідключається) — повідомлення чекає в черзі.
    // Черга обмежена: якщо зв'язку немає довго, найстаріше викидаємо.
    send(message) {
      if (socket?.readyState === WebSocketImpl.OPEN) {
        socket.send(encode(message));
        return true;
      }
      if (closedByUs) return false;
      queue.push(message);
      if (queue.length > maxQueue) queue.shift();
      return false;
    },

    close() {
      closedByUs = true;
      clearTimeout(timer);
      queue.length = 0;
      if (socket) socket.close(1000, 'bye');
      else setStatus('closed', { code: 1000, reason: null, fatal: false });
    },
  };
}
