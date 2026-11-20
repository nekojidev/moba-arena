// Маленькі цеглинки для асинхронного коду: обидві вміють скасовуватись через AbortSignal.
// У проміса немає методу cancel — скасування приходить «збоку»: сигнал відхиляє проміс
// і прибирає за собою (таймер, слухача).

// signal.reason у типах DOM — any; unknown чесніший: причиною може бути що завгодно.
function reasonOf(signal: AbortSignal): unknown {
  return signal.reason;
}

// setTimeout (колбек) → Promise.
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(reasonOf(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal ? reasonOf(signal) : undefined);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Подія → Promise: чекаємо РІВНО ОДНУ подію. Проміс виконується один раз,
// подія може статися багато разів — тому для потоку подій лишається addEventListener.
export function once(
  target: EventTarget,
  type: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<Event> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(reasonOf(signal));
      return;
    }
    function onEvent(event: Event): void {
      signal?.removeEventListener('abort', onAbort);
      resolve(event);
    }
    function onAbort(): void {
      target.removeEventListener(type, onEvent);
      reject(signal ? reasonOf(signal) : undefined);
    }
    target.addEventListener(type, onEvent, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
