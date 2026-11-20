// Пайплайн ассетів: fetch → перевірка ok → декодування, з повторами, таймаутом і скасуванням.

import { sleep } from '../async.js';

export class HttpError extends Error {
  constructor(status, statusText, url) {
    super(`HTTP ${status}${statusText ? ' ' + statusText : ''}: ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

// Файл прийшов, але його не вдалося розібрати (битий JSON, не картинка, не звук).
export class ParseError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ParseError';
  }
}

// fetch відхиляє проміс лише коли відповіді немає взагалі (мережа, CORS, abort).
// 404 чи 500 — це «успішно отримана відповідь», тому ok перевіряємо самі.
async function fetchOk(url, { signal } = {}) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new HttpError(response.status, response.statusText, url);
  return response;
}

// Читання відповіді двокрокове: спершу приходять заголовки (fetch виконався),
// і лише потім — тіло (ще один await). Обірватися може на будь-якому кроці.
export async function fetchJson(url, { signal } = {}) {
  const response = await fetchOk(url, { signal });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new ParseError(`Битий JSON: ${url}`, { cause });
  }
}

export function loadJson(url, options) {
  return fetchJson(url, options);
}

export async function loadImage(url, { signal } = {}) {
  const response = await fetchOk(url, { signal });
  const blob = await response.blob();
  try {
    return await createImageBitmap(blob);
  } catch (cause) {
    throw new ParseError(`Не вдалося декодувати зображення: ${url}`, { cause });
  }
}

// Буфер декодується одразу під час завантаження: у грі play() лише запускає готові семпли.
export async function loadAudio(context, url, { signal } = {}) {
  const response = await fetchOk(url, { signal });
  const data = await response.arrayBuffer();
  try {
    return await context.decodeAudioData(data);
  } catch (cause) {
    throw new ParseError(`Не вдалося декодувати звук: ${url}`, { cause });
  }
}

// Чи є сенс пробувати ще раз?
//  • скасував гравець (AbortError)      — ні, він цього й хотів;
//  • 4xx                                — ні: файла немає, і за секунду він не з'явиться
//                                         (виняток — 408 і 429, вони якраз «спробуй пізніше»);
//  • битий файл                         — ні, вдруге прийде той самий;
//  • 5xx, таймаут, обрив мережі         — так.
export function isRetryable(error) {
  if (error?.name === 'AbortError') return false;
  if (error instanceof ParseError) return false;
  if (error instanceof HttpError) {
    return error.status >= 500 || error.status === 408 || error.status === 429;
  }
  return true;
}

// Повтор з експоненційною паузою: baseMs, 2·baseMs, 4·baseMs…
// Jitter (випадкова частка паузи) потрібен, щоб тисяча клієнтів після збою сервера
// не прийшла знову одночасно. `random` і `wait` підміняються в тестах.
export async function withRetry(
  fn,
  { attempts = 3, baseMs = 250, signal, onRetry, random = Math.random, wait = sleep } = {},
) {
  for (let attempt = 1; ; attempt += 1) {
    signal?.throwIfAborted();
    try {
      return await fn(attempt);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (attempt >= attempts || !isRetryable(error)) throw error;
      const ceiling = baseMs * 2 ** (attempt - 1);
      const waitMs = ceiling / 2 + random() * (ceiling / 2); // «equal jitter»: [50 %, 100 %]
      onRetry?.({ attempt, error, waitMs });
      await wait(waitMs, signal);
    }
  }
}

// Завантажує все з маніфесту.
//   strategy: 'concurrent' — Promise.all, усі запити летять одночасно;
//             'sequential' — await у циклі, по одному (лише для порівняння в README).
// Елемент з `optional: true` не валить завантаження: його значення буде null,
// а гра візьме запасний варіант (векторне малювання, тиша).
// Обов'язковий елемент, що не завантажився, відхиляє весь loadAll.
export async function loadAll(
  manifest,
  {
    baseUrl,
    audioContext,
    onProgress,
    signal,
    timeoutMs = 8000,
    attempts = 3,
    baseMs = 250,
    strategy = 'concurrent',
    random,
    wait,
  } = {},
) {
  const started = performance.now();
  const items = manifest.items;
  const failures = [];
  let done = 0;

  // Promise.all відхиляється на першій помилці, але решту запитів НЕ зупиняє —
  // вони летять далі в нікуди. Тому в групи свій контролер: упав один — скасували всіх.
  const group = new AbortController();
  const groupSignal = signal ? AbortSignal.any([signal, group.signal]) : group.signal;

  const loaders = {
    json: loadJson,
    image: loadImage,
    audio: (url, options) => loadAudio(audioContext, url, options),
  };

  async function loadItem(item) {
    const url = baseUrl ? new URL(item.url, baseUrl).href : item.url;
    const load = loaders[item.type];
    const itemStarted = performance.now();
    const report = (type, extra) =>
      onProgress?.({ type, item, done, total: items.length, ...extra });

    report('start');
    try {
      if (!load) throw new ParseError(`Невідомий тип ассета "${item.type}" (${item.id})`);
      const value = await withRetry(
        // Таймаут — на кожну спробу окремо; загальний сигнал скасовує і спробу, і паузу.
        () => load(url, { signal: AbortSignal.any([groupSignal, AbortSignal.timeout(timeoutMs)]) }),
        {
          attempts,
          baseMs,
          signal: groupSignal,
          random,
          wait,
          onRetry: ({ attempt, error, waitMs }) => report('retry', { attempt, error, waitMs }),
        },
      );
      done += 1;
      report('loaded', { ms: performance.now() - itemStarted });
      return [item.id, value];
    } catch (error) {
      // Скасування — не «збій елемента»: його не можна проковтнути як optional.
      if (groupSignal.aborted || !item.optional) throw error;
      done += 1;
      failures.push({ id: item.id, error });
      report('failed', { error });
      return [item.id, null];
    }
  }

  try {
    let entries;
    if (strategy === 'sequential') {
      entries = [];
      for (const item of items) entries.push(await loadItem(item));
    } else {
      entries = await Promise.all(items.map(loadItem));
    }
    return {
      assets: Object.fromEntries(entries),
      failures,
      elapsedMs: performance.now() - started,
    };
  } catch (error) {
    group.abort(error);
    throw error;
  }
}
