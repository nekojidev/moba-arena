// Дослід: подія 'error' без слухача і відхилений проміс без catch валять процес.
//
//   npm run demo:error -w server            # запускає всі варіанти й показує, чим скінчилось
//   node scripts/error-demo.js crash        # один варіант

import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';

const variants = {
  // EventEmitter трактує 'error' особливо: немає слухача — emit КИДАЄ помилку як виняток.
  crash() {
    const socket = new EventEmitter();
    console.log('сервер працює, 100 гравців онлайн');
    setTimeout(() => socket.emit('error', new Error('read ECONNRESET')), 50);
    setTimeout(() => console.log('цей рядок уже ніхто не надрукує'), 100);
  },

  // Фікс: слухач 'error' на КОЖНОМУ сокеті — помилка одного клієнта лишається його проблемою.
  fixed() {
    const socket = new EventEmitter();
    socket.on('error', (error) =>
      console.log('сокет зламався, закриваємо лише його:', error.message),
    );
    console.log('сервер працює, 100 гравців онлайн');
    setTimeout(() => socket.emit('error', new Error('read ECONNRESET')), 50);
    setTimeout(() => console.log('сервер працює далі, 99 гравців онлайн'), 100);
  },

  // Те саме для промісів: відхилення, яке ніхто не зловив, завершує процес (з Node 15).
  rejection() {
    async function handleRequest() {
      throw new Error('файл логу зник');
    }
    console.log('сервер працює, 100 гравців онлайн');
    setTimeout(() => handleRequest(), 50); // без await і без .catch
    setTimeout(() => console.log('цей рядок уже ніхто не надрукує'), 100);
  },

  // Фікс: кожен async-обробник закінчується на .catch (див. createRequestHandler в api.js).
  'rejection-fixed'() {
    async function handleRequest() {
      throw new Error('файл логу зник');
    }
    console.log('сервер працює, 100 гравців онлайн');
    setTimeout(
      () => handleRequest().catch((error) => console.log('відповідаємо 500:', error.message)),
      50,
    );
    setTimeout(() => console.log('сервер працює далі'), 100);
  },
};

const chosen = process.argv[2];
if (chosen) {
  variants[chosen]();
} else {
  for (const name of Object.keys(variants)) {
    const result = spawnSync(process.execPath, [import.meta.filename, name], { encoding: 'utf8' });
    const stderr = result.stderr
      .split('\n')
      .filter(
        (line) =>
          line.trim() !== '' && !line.includes('node:internal') && !line.includes('    at '),
      )
      .slice(0, 8);
    console.log(`\n=== ${name} → код завершення ${result.status} ===`);
    console.log(result.stdout.trimEnd());
    if (stderr.length > 0) console.log(stderr.join('\n'));
  }
}
