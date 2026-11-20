// Маленькі помічники для звуження типів. Дані ззовні (мережа, JSON, catch) — це unknown,
// і перш ніж читати з них поля, тип треба перевірити в рантаймі.

// «Сюди потрапити неможливо». Викликається в гілці default: якщо в об'єднання додадуть
// новий варіант і забудуть його обробити, value вже не буде never — і tsc покаже помилку.
export function assertNever(value: never): never {
  throw new Error(`Необроблений варіант: ${JSON.stringify(value)}`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Елемент сторінки, без якого працювати не можна: немає — одразу зрозуміла помилка,
// а не «Cannot read properties of null» десь далі.
export function requireElement<E extends Element>(element: E | null, selector: string): E {
  if (!element) throw new Error(`На сторінці немає елемента ${selector}`);
  return element;
}

// Ім'я і текст помилки з catch: там error — unknown, бо кинути можна що завгодно.
export function errorName(error: unknown): string | null {
  return error instanceof Error ? error.name : null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
