import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Middleware для Lab 3: керована «погана мережа» прямо в dev-сервері.
//   ?delay=1500    — відповісти із затримкою, мс
//   ?failTimes=2   — перші N запитів до цього URL отримують 503, далі — нормальна відповідь
function chaosNetwork() {
  const hits = new Map();

  function middleware(req, res, next) {
    const url = new URL(req.url, 'http://localhost');
    const delay = Number(url.searchParams.get('delay') ?? 0);
    const failTimes = Number(url.searchParams.get('failTimes') ?? 0);

    const respond = () => {
      if (failTimes > 0) {
        const count = (hits.get(url.pathname) ?? 0) + 1;
        if (count <= failTimes) {
          hits.set(url.pathname, count);
          res.statusCode = 503;
          res.end('chaos: service unavailable');
          return;
        }
        hits.delete(url.pathname); // наступне перезавантаження сторінки почне лічбу знову
      }
      next();
    };

    if (delay > 0) setTimeout(respond, delay);
    else respond();
  }

  return {
    name: 'chaos-network',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

// У розробці сторінку віддає Vite (з гарячим перезавантаженням), а /api і /ws він
// пересилає на сервер гри — тож для браузера все живе на одному origin, як і в продакшені.
const SERVER = process.env.GAME_SERVER ?? 'http://127.0.0.1:3000';
const proxy = {
  '/api': { target: SERVER },
  '/health': { target: SERVER },
  '/ws': { target: SERVER, ws: true },
};

export default defineConfig({
  server: { proxy },
  preview: { proxy },
  // 'mpa': неіснуючий файл — це чесний 404, а не index.html (як у режимі SPA за замовчуванням).
  appType: 'mpa',
  plugins: [chaosNetwork()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        puzzles: resolve(import.meta.dirname, 'puzzles.html'),
      },
    },
  },
});
