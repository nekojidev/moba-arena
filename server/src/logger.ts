// Структурований лог на pino: один JSON-рядок на подію в stdout.
//
//   {"level":"info","time":"2026-…","roomId":"mid","playerId":"3f2a9c1e","msg":"player joined"}
//
// Решта коду бачить лише інтерфейс Logger нижче, а не сам pino: так виклики лишаються
// однаковими (повідомлення, потім поля), а в тестах логер легко підмінити.
//
// Чого в лог НЕ пишемо: змінні оточення, заголовки запитів цілком, тексти чату.
// Якщо заголовки колись потраплять у запис — authorization і cookie закриє redact.

import pino from 'pino';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

// Додаткові поля запису: що завгодно, що переживе JSON.stringify.
export type LogFields = Readonly<Record<string, unknown>>;
type LogMethod = (message: string, fields?: LogFields) => void;

export interface Logger {
  readonly debug: LogMethod;
  readonly info: LogMethod;
  readonly warn: LogMethod;
  readonly error: LogMethod;
  // fatal — після цього запису процес завершується (див. index.ts).
  readonly fatal: LogMethod;
  // Дочірній логер: його поля (roomId, playerId…) потрапляють у КОЖЕН його рядок.
  child(bindings: LogFields): Logger;
  // Дописати все, що ще в буфері. Викликається перед виходом із процесу.
  flush(): void;
}

// Від потоку потрібен лише write(): підробка в тесті теж підходить.
export interface LogSink {
  write(line: string): unknown;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly stream?: LogSink;
}

const REDACTED = [
  'headers.authorization',
  'headers.cookie',
  'headers["set-cookie"]',
  'req.headers.authorization',
  'req.headers.cookie',
  'request.headers.authorization',
  'request.headers.cookie',
];

function wrap(log: pino.Logger, flush: () => void): Logger {
  // pino приймає спершу поля, потім текст; у нас навпаки — так читається природніше.
  const method =
    (level: 'debug' | 'info' | 'warn' | 'error' | 'fatal'): LogMethod =>
    (message, fields) => {
      if (fields === undefined) log[level](message);
      else log[level](fields, message);
    };
  return {
    debug: method('debug'),
    info: method('info'),
    warn: method('warn'),
    error: method('error'),
    fatal: method('fatal'),
    child: (bindings) => wrap(log.child({ ...bindings }), flush),
    flush,
  };
}

export function createLogger({ level = 'info', stream }: LoggerOptions = {}): Logger {
  // Типово — асинхронний запис у stdout: повільний читач логу (docker logs, файл на
  // мережевому диску) не зупиняє цикл подій, а разом із ним і всі матчі. Ціна — буфер,
  // який треба дописати перед виходом: це робить flush().
  const destination = stream ? null : pino.destination({ fd: 1, sync: false });
  const log = pino(
    {
      level,
      // pid і hostname у кожному рядку не потрібні: у контейнері їх і так знає платформа.
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: REDACTED, censor: '[redacted]' },
    },
    stream ?? destination ?? process.stdout,
  );

  function flush(): void {
    if (!destination) return;
    try {
      destination.flushSync();
    } catch (error) {
      // stdout уже закрито (наприклад, читач логу зник) — дописати нікуди, але мовчати
      // теж не можна: кажемо про це в stderr.
      console.error('не вдалося дописати лог:', error instanceof Error ? error.message : error);
    }
  }

  return wrap(log, flush);
}
