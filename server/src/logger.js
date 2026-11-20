// Мінімальний структурований лог: один JSON-рядок на подію в stdout.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function createLogger({ level = 'info', stream = process.stdout } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const write =
    (name) =>
    (message, fields = {}) => {
      if (LEVELS[name] < threshold) return;
      stream.write(
        JSON.stringify({ t: new Date().toISOString(), level: name, message, ...fields }) + '\n',
      );
    };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}
