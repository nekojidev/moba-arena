// Типізована шина подій. Ім'я події і форма її даних пов'язані типом:
//
//   bus.on('fired', (payload) => …)   // payload: { shipId, team, homing } — виведено з імені
//   bus.emit('fired', { shipId })      // помилка tsc: бракує полів
//   bus.on('fird', …)                  // помилка tsc: такої події немає
//
// Events — «карта подій»: { ім'я: тип даних }. K extends keyof Events — одне з імен,
// Events[K] — тип даних саме цієї події.

// Мінімум від AbortSignal, який нам потрібен. Спільний пакет не тягне ні типів DOM,
// ні типів Node — а справжній AbortSignal структурно підходить під цей інтерфейс.
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
}

export interface ListenOptions {
  readonly signal?: AbortSignalLike | undefined;
}

type Handler<Payload> = (payload: Payload) => void;

export class Bus<Events extends object> {
  #handlers: { [K in keyof Events]?: Set<Handler<Events[K]>> } = {};

  // Повертає функцію відписки; { signal } відписує за abort(), як у DOM.
  on<K extends keyof Events>(
    type: K,
    handler: Handler<Events[K]>,
    { signal }: ListenOptions = {},
  ): () => void {
    if (signal?.aborted) return () => {};
    let handlers = this.#handlers[type];
    if (!handlers) {
      handlers = new Set();
      this.#handlers[type] = handlers;
    }
    handlers.add(handler);
    const off = (): void => {
      this.#handlers[type]?.delete(handler);
    };
    signal?.addEventListener('abort', off, { once: true });
    return off;
  }

  // Синхронно: слухачі відпрацюють ще до повернення з emit.
  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const handlers = this.#handlers[type];
    if (!handlers) return;
    for (const handler of [...handlers]) handler(payload);
  }
}
