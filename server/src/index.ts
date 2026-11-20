// Точка входу сервера: конфіг → запуск → штатна зупинка за сигналом.
// Тут же — останній рубіж: помилка, яку ніхто не зловив, голосно завершує процес.

import { createApp } from './app.ts';
import { ConfigError, loadConfig, type ServerConfig } from './config.ts';
import { createLogger } from './logger.ts';

// Скільки даємо штатній зупинці. Платформа після SIGTERM чекає 10 с і шле SIGKILL —
// ми маємо або встигнути раніше, або самі вийти з кодом 1 і записом у лозі.
const SHUTDOWN_TIMEOUT_MS = 8000;

let config: ServerConfig;
try {
  config = loadConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
}

const logger = createLogger({ level: config.logLevel });

// Невідома помилка — це баг, і стан процесу після неї невідомий: можливо, матч уже рахує
// нісенітницю. Тому не «ковтаємо й працюємо далі», а пишемо запис fatal зі стеком і виходимо
// з кодом 1. Перезапустить нас платформа (restart policy), а клієнти перепідключаться самі.
function crash(kind: string, error: unknown): never {
  logger.fatal(kind, {
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
  logger.flush(); // лог асинхронний: без цього останній, найважливіший рядок загубився б
  process.exit(1);
}
process.on('uncaughtException', (error) => crash('uncaught exception', error));
process.on('unhandledRejection', (reason) => crash('unhandled rejection', reason));

const app = await createApp(config, { logger });
const address = await app.listen();
// У лог іде лише те, що не є секретом; саме оточення (process.env) не друкуємо ніколи.
logger.info('server listening', {
  url: `http://${address.address}:${address.port}`,
  version: config.version,
  clientDist: config.clientDist,
  logDir: config.logDir,
  debugRoutes: config.debugRoutes,
  originCheck: config.allowedOrigins.length > 0,
  trustProxy: config.trustProxy,
});
const local = ['127.0.0.1', 'localhost', '::1'].includes(config.host);
if (config.allowedOrigins.length === 0 && !local) {
  logger.warn('ALLOWED_ORIGINS is empty: WebSocket accepts any Origin — set it in production');
}

let stopping = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return; // другий сигнал (нетерплячий Ctrl+C) не починає зупинку вдруге
  stopping = true;
  const startedAt = performance.now();
  logger.info('shutting down', { signal });

  // Якщо щось зависло — не чекаємо вічно.
  const watchdog = setTimeout(() => {
    logger.error('shutdown timed out', { afterMs: SHUTDOWN_TIMEOUT_MS });
    logger.flush();
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  watchdog.unref();

  await app.close();
  logger.info('bye', { tookMs: Math.round(performance.now() - startedAt) });
  logger.flush();
  // Не process.exit(0): просто даємо циклу подій спорожніти. Якщо процес після цього
  // не завершився — десь лишився незакритий ресурс; тоді спрацює watchdog і скаже про це.
  process.exitCode = 0;
}

// Обробник сигналу нічого не чекає, тож відхилений проміс зупинки ловимо тут самі:
// інакше це було б «необроблене відхилення» вже під час виходу.
function onSignal(signal: NodeJS.Signals): void {
  shutdown(signal).catch((error: unknown) => {
    logger.error('shutdown failed', {
      error: error instanceof Error ? error.stack : String(error),
    });
    logger.flush();
    process.exit(1);
  });
}

process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
