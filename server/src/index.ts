// Точка входу сервера: конфіг → запуск → штатна зупинка за сигналом.

import { createApp } from './app.ts';
import { ConfigError, loadConfig, type ServerConfig } from './config.ts';

let config: ServerConfig;
try {
  config = loadConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
}

const app = await createApp(config);
const address = await app.listen();
app.logger.info('server listening', {
  url: `http://${address.address}:${address.port}`,
  clientDist: config.clientDist,
  logDir: config.logDir,
  debugRoutes: config.debugRoutes,
});

let stopping = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return; // другий Ctrl+C не починає зупинку вдруге
  stopping = true;
  app.logger.info('shutting down', { signal });

  // Якщо щось зависло — не чекаємо вічно.
  const watchdog = setTimeout(() => {
    app.logger.error('shutdown timed out');
    process.exit(1);
  }, 10_000);
  watchdog.unref();

  await app.close();
  app.logger.info('bye');
  // Не process.exit(0): просто даємо циклу подій спорожніти. Якщо процес після цього
  // не завершився — десь лишився незакритий ресурс, і це варто знати.
  process.exitCode = 0;
}

// Обробник сигналу нічого не чекає, тож відхилений проміс зупинки ловимо тут самі:
// інакше це було б «необроблене відхилення» вже під час виходу.
function onSignal(signal: NodeJS.Signals): void {
  shutdown(signal).catch((error: unknown) => {
    app.logger.error('shutdown failed', {
      error: error instanceof Error ? error.stack : String(error),
    });
    process.exit(1);
  });
}

process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
