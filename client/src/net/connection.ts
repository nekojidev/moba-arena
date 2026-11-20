// Обгортка над WebSocket: розбір повідомлень за type, черга відправки, перепідключення.
//
//   const connection = createConnection({ url, hello: () => ({ type: 'join', room, name }) });
//   connection.on('chat', (message) => …);          // message: саме chat, виведено з імені
//   connection.send({ type: 'chat', text: 'gg' });   // можна ще до відкриття сокета
//
// Сам WebSocket одноразовий: закрився — і все. «Перепідключення» — це новий сокет,
// тому слухачів вішаємо не на нього, а на власну шину подій, яка живе довше.
//
// Це межа з мережею. Усе, що прийшло текстом, — unknown, доки його не перевірила схема
// (parseServerMessage). Далі в коді клієнта повідомленням уже можна довіряти.

import { Bus } from '@moba-arena/shared/bus.ts';
import {
  clientMessage,
  parseServerMessage,
  type ServerMessage,
  type ServerMessageOf,
} from '@moba-arena/shared/protocol.ts';
import { assertNever } from '../guards.ts';

// Після цих кодів пробувати ще раз марно: сервер відмовив саме нам, а не «зник».
const FATAL_CODES = new Set([1000, 4000, 4001, 4003, 4004, 4005, 4006]);

export const CLOSE_REASONS: Readonly<Record<number, string>> = {
  4000: 'сервер не зрозумів повідомлення',
  4001: 'сервер не знає такого повідомлення',
  4002: 'сервер не дочекався входу',
  4003: 'забагато повідомлень за секунду',
  4004: 'кімната заповнена або вже не існує',
  4005: 'версія клієнта застаріла — оновіть сторінку',
  4006: 'з’єднання надто повільне',
};

// Повідомлення клієнта без поля v — його додає clientMessage(). Тип беремо з самої
// функції, щоб не описувати його вдруге.
export type OutgoingMessage = Parameters<typeof clientMessage>[0];

// Стан з'єднання — розрізнюване об'єднання: поле status каже, які ще поля є в події.
// waitMs існує лише у 'waiting', reason — лише у 'closed'; прочитати їх деінде tsc не дасть.
export type ConnectionStatus =
  | { readonly status: 'connecting'; readonly attempt: number }
  | { readonly status: 'reconnecting'; readonly attempt: number }
  | { readonly status: 'open' }
  | {
      readonly status: 'waiting';
      readonly attempt: number;
      readonly waitMs: number;
      readonly code: number;
    }
  | {
      readonly status: 'closed';
      readonly code: number;
      readonly reason: string | null;
      readonly fatal: boolean;
    };

// Карта подій з'єднання: для кожного type серверного повідомлення — саме це повідомлення,
// плюс 'status'. З неї виводяться типи слухачів у on().
export type ConnectionEvents = {
  [T in ServerMessage['type']]: ServerMessageOf<T>;
} & { status: ConnectionStatus };

export interface ListenOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface ConnectionOptions {
  readonly url: string;
  // () => перше повідомлення після КОЖНОГО відкриття (вхід у кімнату)
  readonly hello?: (() => OutgoingMessage) | null;
  readonly baseMs?: number;
  readonly maxMs?: number;
  readonly maxQueue?: number;
  readonly random?: () => number;
  readonly WebSocketImpl?: typeof WebSocket;
}

export interface Connection {
  readonly status: ConnectionStatus['status'] | 'idle';
  readonly queued: number;
  // Підписка за типом повідомлення (або 'status'). { signal } знімає слухача, як у DOM.
  on<K extends keyof ConnectionEvents>(
    type: K,
    handler: (event: ConnectionEvents[K]) => void,
    options?: ListenOptions,
  ): void;
  // Те саме, що on('status', …): окрема підписка на стан з'єднання.
  onStatus(handler: (event: ConnectionStatus) => void, options?: ListenOptions): void;
  last<T extends ServerMessage['type']>(type: T): ServerMessageOf<T> | undefined;
  onBinary(handler: (data: ArrayBuffer) => void, options?: ListenOptions): void;
  sendRaw(data: string | Uint8Array): boolean;
  send(message: OutgoingMessage): boolean;
  close(): void;
}

// WebSocket.send не приймає байти, що лежать у SharedArrayBuffer. Кодек такого не створює,
// але тип Uint8Array цього не обіцяє — тому перевіряємо, а не «переконуємо» компілятор.
function isSendable(bytes: Uint8Array): bytes is Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer;
}

export function createConnection({
  url,
  hello = null,
  baseMs = 500,
  maxMs = 8000,
  maxQueue = 50,
  random = Math.random,
  WebSocketImpl = globalThis.WebSocket,
}: ConnectionOptions): Connection {
  const events = new Bus<ConnectionEvents>();
  const binary = new Bus<{ binary: ArrayBuffer }>();
  const queue: OutgoingMessage[] = [];
  // type → останнє повідомлення цього типу
  const last: { [T in ServerMessage['type']]?: ServerMessageOf<T> } = {};
  let socket: WebSocket | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closedByUs = false;
  let status: Connection['status'] = 'idle';

  function setStatus(next: ConnectionStatus): void {
    status = next.status;
    events.emit('status', next);
  }

  // Розкладає перевірене повідомлення за типом. У кожній гілці message уже звужено
  // до конкретного варіанта, тож і запис у last, і слухачі отримують точний тип.
  function dispatch(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome':
        last.welcome = message;
        events.emit('welcome', message);
        break;
      case 'roster':
        last.roster = message;
        events.emit('roster', message);
        break;
      case 'chat':
        last.chat = message;
        events.emit('chat', message);
        break;
      case 'pong':
        last.pong = message;
        events.emit('pong', message);
        break;
      case 'events':
        last.events = message;
        events.emit('events', message);
        break;
      case 'shutdown':
        // Сервер попереджає, що зупиняється; сокет він закриє сам наступним кадром.
        // Що з цим робити (повернути гравця в лобі) — вирішує власник з'єднання.
        last.shutdown = message;
        events.emit('shutdown', message);
        break;
      case 'snapshot':
        last.snapshot = message;
        events.emit('snapshot', message);
        break;
      default:
        // Новий тип у протоколі без гілки тут — помилка tsc.
        assertNever(message);
    }
  }

  function open(): void {
    timer = null;
    setStatus({ status: attempt === 0 ? 'connecting' : 'reconnecting', attempt });
    const current = new WebSocketImpl(url);
    current.binaryType = 'arraybuffer'; // бінарні кадри приходять як ArrayBuffer, а не Blob
    socket = current;

    current.addEventListener('open', () => {
      attempt = 0;
      delete last.shutdown; // попередження стосувалось попереднього сервера
      setStatus({ status: 'open' });
      // Спершу — вхід (сервер чекає його першим), потім усе, що накопичилось у черзі.
      if (hello) current.send(clientMessage(hello()));
      for (const message of queue.splice(0)) current.send(clientMessage(message));
    });

    current.addEventListener('message', (event) => {
      const data: unknown = event.data; // у типах DOM це any; для нас — unknown
      // Бінарний кадр — ігрове повідомлення (знімок): віддаємо байти як є, розбере кодек.
      if (typeof data !== 'string') {
        if (data instanceof ArrayBuffer) binary.emit('binary', data);
        return;
      }
      // Сервер наш, але клієнт теж не вірить мережі на слово: не JSON, не та версія,
      // невідомий type чи не та форма — повідомлення просто ігноруємо.
      const parsed = parseServerMessage(data);
      if (!parsed.ok) {
        console.warn(`[net] відкинуто повідомлення сервера: ${parsed.reason}`);
        return;
      }
      dispatch(parsed.message);
    });

    // 'error' нічого корисного не каже, а за ним завжди йде 'close' — реагуємо там.
    current.addEventListener('error', () => {});

    current.addEventListener('close', (event) => {
      if (socket !== current) return;
      socket = null;
      const reason = CLOSE_REASONS[event.code] ?? null;
      if (closedByUs || FATAL_CODES.has(event.code)) {
        setStatus({ status: 'closed', code: event.code, reason, fatal: !closedByUs });
        return;
      }
      // Експоненційна пауза з jitter — та сама ідея, що у withRetry з Lab 3:
      // якщо сервер перезапускався, тисяча клієнтів не повернеться в ту саму мілісекунду.
      attempt += 1;
      const ceiling = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const waitMs = ceiling / 2 + random() * (ceiling / 2);
      setStatus({ status: 'waiting', attempt, waitMs, code: event.code });
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

    on(type, handler, options) {
      events.on(type, handler, options);
    },

    onStatus(handler, options) {
      events.on('status', handler, options);
    },

    last: (type) => last[type],

    onBinary(handler, options) {
      binary.on('binary', handler, options);
    },

    // Готовий кадр (байти або рядок) без черги: input, що запізнився, уже нікому не потрібен —
    // немає зв'язку, отже просто не шлемо.
    sendRaw(data) {
      if (socket?.readyState !== WebSocketImpl.OPEN) return false;
      if (typeof data !== 'string' && !isSendable(data)) return false;
      socket.send(data);
      return true;
    },

    // Сокет ще не відкрито (або він перепідключається) — повідомлення чекає в черзі.
    // Черга обмежена: якщо зв'язку немає довго, найстаріше викидаємо.
    send(message) {
      if (socket?.readyState === WebSocketImpl.OPEN) {
        socket.send(clientMessage(message));
        return true;
      }
      if (closedByUs) return false;
      queue.push(message);
      if (queue.length > maxQueue) queue.shift();
      return false;
    },

    close() {
      closedByUs = true;
      if (timer !== null) clearTimeout(timer);
      queue.length = 0;
      if (socket) socket.close(1000, 'bye');
      else setStatus({ status: 'closed', code: 1000, reason: null, fatal: false });
    },
  };
}
