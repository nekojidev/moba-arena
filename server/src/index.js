// Точка входу сервера: конфіг → запуск → штатна зупинка за сигналом.

import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';

let config;
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
async function shutdown(signal) {
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

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
