// Service worker гри. Звичайний JS: файл із public/ потрапляє в dist як є, без збирача.
//
// Навіщо: (1) щоб застосунок можна було встановити; (2) щоб повторний візит не качав
// заново скрипти, спрайти й звуки — сервер віддає все з cache-control: no-cache.
// Гра без сервера не працює, тож мета офлайн-режиму скромна: відкрити вже бачену
// сторінку, а лобі саме чесно покаже, що сервер недоступний.
//
// Правила:
//   • /ws, /api/*, /health, /ready, /metrics — не чіпаємо взагалі: це живі дані;
//   • сторінки (HTML) — спершу мережа, кеш лише як запасний варіант без зв'язку;
//   • /assets/ім'я-ХЕШ.js — спершу кеш: хеш у назві означає, що вміст не зміниться;
//   • решта статики (спрайти, звуки, JSON, іконки) — з кешу одразу, а у фоні оновлюємо.
//
// Заздалегідь (на install) нічого не кешуємо: у кеш потрапляє лише те, що сторінка
// справді завантажила, тож застарілий список файлів зламати нічого не може.

/* global self, caches, fetch, URL */

// Змініть номер, якщо кеш треба скинути всім гравцям: старі кеші видалить activate.
const CACHE_PREFIX = 'moba-arena-';
const CACHE = `${CACHE_PREFIX}v1`;

const BYPASS = ['/ws', '/health', '/ready', '/metrics'];
// Vite додає до назви хеш вмісту: main-BzmFS9HO.js
const HASHED = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/;

self.addEventListener('install', () => {
  // Новий воркер не чекає, доки закриються всі вкладки зі старим.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

function bypassed(url) {
  return (
    url.pathname.startsWith('/api/') ||
    BYPASS.some((path) => url.pathname === path || url.pathname.startsWith(path + '/'))
  );
}

// У кеш — лише повні успішні відповіді з нашого origin (не 404, не 206, не opaque).
async function store(request, response) {
  if (response.status !== 200 || response.type !== 'basic') return;
  const cache = await caches.open(CACHE);
  await cache.put(request, response);
}

// Збереження не має ламати відповідь: переповнене сховище — не причина не віддати файл.
function storeLater(event, request, response) {
  const copy = response.clone();
  event.waitUntil(store(request, copy).catch(() => {}));
}

async function networkFirst(event, request) {
  try {
    const response = await fetch(request);
    storeLater(event, request, response);
    return response;
  } catch (error) {
    // Без зв'язку: та сама сторінка з кешу. Параметри (?exp=…) сторінку не змінюють.
    const cached = await caches.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(event, request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  storeLater(event, request, response);
  return response;
}

async function staleWhileRevalidate(event, request) {
  const cached = await caches.match(request);
  const refresh = fetch(request).then((response) => {
    storeLater(event, request, response);
    return response;
  });
  if (!cached) return refresh;
  // Відповідаємо з кешу; оновлення триває у фоні, а його помилка (немає зв'язку) не важлива.
  event.waitUntil(refresh.then(() => {}).catch(() => {}));
  return cached;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  // Частковий запит (Range) кешувати не можна: у кеш потрапив би шматок файла.
  if (request.headers.has('range')) return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (bypassed(url)) return; // без respondWith запит іде в мережу так, ніби воркера немає

  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(networkFirst(event, request));
  } else if (HASHED.test(url.pathname)) {
    event.respondWith(cacheFirst(event, request));
  } else if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    // Параметри запиту тут — навчальний «хаос» (?delay, ?failTimes): такі не кешуємо.
    if (url.search !== '') return;
    event.respondWith(staleWhileRevalidate(event, request));
  } else {
    event.respondWith(networkFirst(event, request));
  }
});
