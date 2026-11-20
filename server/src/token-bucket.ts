// Token bucket: відро на `capacity` жетонів, що наповнюється зі швидкістю `refillPerSecond`.
// Повідомлення коштує жетон; порожнє відро — клієнт шле занадто часто.
//
// Годинник передається ззовні: у сервері це performance.now(), у тесті — число, яке тест
// пересуває сам. Так ліміт перевіряється без жодного sleep і без справжнього сокета.

// Монотонний час у мілісекундах.
export type Clock = () => number;

export interface TokenBucketOptions {
  readonly capacity: number;
  // Типово відро наповнюється за секунду: capacity жетонів/с.
  readonly refillPerSecond?: number;
  readonly now?: Clock;
}

export interface TokenBucket {
  // Забирає жетон. false — відро порожнє, повідомлення понад ліміт.
  take(): boolean;
  // Скільки жетонів є просто зараз (з урахуванням часу, що минув).
  readonly tokens: number;
}

export function createTokenBucket({
  capacity,
  refillPerSecond = capacity,
  now = () => performance.now(),
}: TokenBucketOptions): TokenBucket {
  let tokens = capacity; // нове відро повне: сплеск до capacity дозволено одразу
  let refilledAt = now();

  function refill(): void {
    const at = now();
    // Годинник, що пішов назад, жетонів не забирає; вище за край відро не наповнюється.
    const elapsed = Math.max(0, at - refilledAt);
    tokens = Math.min(capacity, tokens + (elapsed / 1000) * refillPerSecond);
    refilledAt = at;
  }

  return {
    take() {
      refill();
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
    get tokens() {
      refill();
      return tokens;
    },
  };
}
