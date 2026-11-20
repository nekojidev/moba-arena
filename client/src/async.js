// Маленькі цеглинки для асинхронного коду: обидві вміють скасовуватись через AbortSignal.
// У проміса немає методу cancel — скасування приходить «збоку»: сигнал відхиляє проміс
// і прибирає за собою (таймер, слухача).

// setTimeout (колбек) → Promise.
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Подія → Promise: чекаємо РІВНО ОДНУ подію. Проміс виконується один раз,
// подія може статися багато разів — тому для потоку подій лишається addEventListener.
export function once(target, type, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    function onEvent(event) {
      signal?.removeEventListener('abort', onAbort);
      resolve(event);
    }
    function onAbort() {
      target.removeEventListener(type, onEvent);
      reject(signal.reason);
    }
    target.addEventListener(type, onEvent, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
