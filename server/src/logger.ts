// Мінімальний структурований лог: один JSON-рядок на подію в stdout.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export type LogLevel = keyof typeof LEVELS;
// Додаткові поля запису: що завгодно, що переживе JSON.stringify.
export type LogFields = Readonly<Record<string, unknown>>;
type LogMethod = (message: string, fields?: LogFields) => void;

export interface Logger {
  readonly debug: LogMethod;
  readonly info: LogMethod;
  readonly warn: LogMethod;
  readonly error: LogMethod;
}

// Від потоку потрібен лише write(): process.stdout підходить, і підробка в тесті — теж.
export interface LogSink {
  write(line: string): unknown;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly stream?: LogSink;
}

export function createLogger({
  level = 'info',
  stream = process.stdout,
}: LoggerOptions = {}): Logger {
  const threshold = LEVELS[level];
  const write =
    (name: keyof Logger): LogMethod =>
    (message, fields = {}) => {
      if (LEVELS[name] < threshold) return;
      stream.write(
        JSON.stringify({ t: new Date().toISOString(), level: name, message, ...fields }) + '\n',
      );
    };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}
