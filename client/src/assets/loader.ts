// Пайплайн ассетів: fetch → перевірка ok → декодування, з повторами, таймаутом і скасуванням.

import { sleep } from '../async.ts';
import { isRecord } from '../guards.ts';

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, statusText: string, url: string) {
    super(`HTTP ${status}${statusText ? ' ' + statusText : ''}: ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

// Файл прийшов, але його не вдалося розібрати (битий JSON, не картинка, не звук).
export class ParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ParseError';
  }
}

export interface FetchOptions {
  readonly signal?: AbortSignal | undefined;
}

// Маніфест: перелік файлів, які треба завантажити до початку гри.
export interface ManifestItem {
  readonly id: string;
  readonly type: string; // 'json' | 'image' | 'audio'; невідомий тип — помилка елемента
  readonly url: string;
  readonly optional?: boolean;
}

export interface Manifest {
  readonly items: readonly ManifestItem[];
}

// Маніфест — теж файл із мережі: перш ніж читати items, перевіряємо форму.
export function isManifest(value: unknown): value is Manifest {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.every(
      (item: unknown) =>
        isRecord(item) &&
        typeof item.id === 'string' &&
        typeof item.type === 'string' &&
        typeof item.url === 'string',
    )
  );
}

// fetch відхиляє проміс лише коли відповіді немає взагалі (мережа, CORS, abort).
// 404 чи 500 — це «успішно отримана відповідь», тому ok перевіряємо самі.
async function fetchOk(url: string, { signal }: FetchOptions = {}): Promise<Response> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new HttpError(response.status, response.statusText, url);
  return response;
}

// Читання відповіді двокрокове: спершу приходять заголовки (fetch виконався),
// і лише потім — тіло (ще один await). Обірватися може на будь-якому кроці.
// Результат — unknown: що лежить у файлі, знає лише той, хто його перевірить.
export async function fetchJson(url: string, { signal }: FetchOptions = {}): Promise<unknown> {
  const response = await fetchOk(url, { signal });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new ParseError(`Битий JSON: ${url}`, { cause });
  }
}

export function loadJson(url: string, options?: FetchOptions): Promise<unknown> {
  return fetchJson(url, options);
}

export async function loadImage(url: string, { signal }: FetchOptions = {}): Promise<ImageBitmap> {
  const response = await fetchOk(url, { signal });
  const blob = await response.blob();
  try {
    return await createImageBitmap(blob);
  } catch (cause) {
    throw new ParseError(`Не вдалося декодувати зображення: ${url}`, { cause });
  }
}

// Буфер декодується одразу під час завантаження: у грі play() лише запускає готові семпли.
export async function loadAudio(
  context: BaseAudioContext,
  url: string,
  { signal }: FetchOptions = {},
): Promise<AudioBuffer> {
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
// error — unknown: кинути можна що завгодно, тому спершу з'ясовуємо, що це.
export function isRetryable(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return false;
  if (error instanceof ParseError) return false;
  if (error instanceof HttpError) {
    return error.status >= 500 || error.status === 408 || error.status === 429;
  }
  return true;
}

export interface RetryInfo {
  readonly attempt: number;
  readonly error: unknown;
  readonly waitMs: number;
}

export interface RetryOptions {
  readonly attempts?: number | undefined;
  readonly baseMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onRetry?: ((info: RetryInfo) => void) | undefined;
  readonly random?: (() => number) | undefined;
  readonly wait?: ((ms: number, signal?: AbortSignal) => Promise<unknown>) | undefined;
}

// Повтор з експоненційною паузою: baseMs, 2·baseMs, 4·baseMs…
// Jitter (випадкова частка паузи) потрібен, щоб тисяча клієнтів після збою сервера
// не прийшла знову одночасно. `random` і `wait` підміняються в тестах.
// Дженерик T: що повертає fn, те повертає і withRetry.
export async function withRetry<T>(
  fn: (attempt: number) => T | Promise<T>,
  {
    attempts = 3,
    baseMs = 250,
    signal,
    onRetry,
    random = Math.random,
    wait = sleep,
  }: RetryOptions = {},
): Promise<T> {
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

// Подія прогресу — розрізнюване об'єднання: поле type каже, які ще поля є.
interface ProgressBase {
  readonly item: ManifestItem;
  readonly done: number;
  readonly total: number;
}

export type LoadProgress =
  | (ProgressBase & { readonly type: 'start' })
  | (ProgressBase & { readonly type: 'loaded'; readonly ms: number })
  | (ProgressBase & { readonly type: 'retry' } & RetryInfo)
  | (ProgressBase & { readonly type: 'failed'; readonly error: unknown });

export interface LoadFailure {
  readonly id: string;
  readonly error: unknown;
}

export interface LoadOptions {
  readonly baseUrl?: string;
  readonly audioContext?: BaseAudioContext;
  readonly onProgress?: (event: LoadProgress) => void;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number | undefined;
  readonly attempts?: number | undefined;
  readonly baseMs?: number;
  readonly strategy?: 'concurrent' | 'sequential';
  readonly random?: () => number;
  readonly wait?: (ms: number, signal?: AbortSignal) => Promise<unknown>;
}

export interface LoadResult {
  // id → завантажене значення (JSON, ImageBitmap, AudioBuffer) або null, якщо необов'язковий
  // файл не завантажився. Тип значення — unknown: споживач перевіряє його сам (див. main.ts).
  readonly assets: Record<string, unknown>;
  readonly failures: LoadFailure[];
  readonly elapsedMs: number;
}

type Loader = (url: string, options: FetchOptions) => Promise<unknown>;

// Завантажує все з маніфесту.
//   strategy: 'concurrent' — Promise.all, усі запити летять одночасно;
//             'sequential' — await у циклі, по одному (лише для порівняння в README).
// Елемент з `optional: true` не валить завантаження: його значення буде null,
// а гра візьме запасний варіант (векторне малювання, тиша).
// Обов'язковий елемент, що не завантажився, відхиляє весь loadAll.
export async function loadAll(
  manifest: Manifest,
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
  }: LoadOptions = {},
): Promise<LoadResult> {
  const started = performance.now();
  const items = manifest.items;
  const failures: LoadFailure[] = [];
  let done = 0;

  // Promise.all відхиляється на першій помилці, але решту запитів НЕ зупиняє —
  // вони летять далі в нікуди. Тому в групи свій контролер: упав один — скасували всіх.
  const group = new AbortController();
  const groupSignal = signal ? AbortSignal.any([signal, group.signal]) : group.signal;

  // Record<string, Loader>: за невідомим ключем tsc чесно каже «Loader або undefined».
  const loaders: Record<string, Loader> = {
    json: loadJson,
    image: loadImage,
    audio: (url, options) => {
      if (!audioContext) throw new ParseError(`Немає AudioContext, щоб декодувати звук: ${url}`);
      return loadAudio(audioContext, url, options);
    },
  };

  async function loadItem(item: ManifestItem): Promise<[string, unknown]> {
    const url = baseUrl ? new URL(item.url, baseUrl).href : item.url;
    const load = loaders[item.type];
    const itemStarted = performance.now();
    // Спільна частина кожної події прогресу; done читаємо в момент події.
    const progress = (): ProgressBase => ({ item, done, total: items.length });

    onProgress?.({ type: 'start', ...progress() });
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
          onRetry: (info) => onProgress?.({ type: 'retry', ...progress(), ...info }),
        },
      );
      done += 1;
      onProgress?.({ type: 'loaded', ...progress(), ms: performance.now() - itemStarted });
      return [item.id, value];
    } catch (error) {
      // Скасування — не «збій елемента»: його не можна проковтнути як optional.
      if (groupSignal.aborted || !item.optional) throw error;
      done += 1;
      failures.push({ id: item.id, error });
      onProgress?.({ type: 'failed', ...progress(), error });
      return [item.id, null];
    }
  }

  try {
    let entries: [string, unknown][];
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
