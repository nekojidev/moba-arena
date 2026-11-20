// Token bucket як чиста одиниця: годинник — число, яке тест пересуває сам.
import { describe, expect, test } from 'vitest';
import { createTokenBucket } from '../src/token-bucket.ts';

function manualClock(start = 1000) {
  let at = start;
  const now = () => at;
  now.advance = (ms) => {
    at += ms;
  };
  return now;
}

// Скільки жетонів удається забрати поспіль.
function drain(bucket) {
  let taken = 0;
  while (bucket.take()) taken += 1;
  return taken;
}

describe('token bucket', () => {
  test('сплеск: нове відро віддає рівно capacity жетонів, далі відмовляє', () => {
    const bucket = createTokenBucket({ capacity: 5, now: manualClock() });
    expect([1, 2, 3, 4, 5].map(() => bucket.take())).toEqual([true, true, true, true, true]);
    expect(bucket.take()).toBe(false);
    expect(bucket.take()).toBe(false); // відмова жетонів не «позичає»
    expect(bucket.tokens).toBe(0);
  });

  test('наповнення пропорційне часу, що минув', () => {
    const now = manualClock();
    const bucket = createTokenBucket({ capacity: 10, now }); // 10 жетонів/с
    expect(drain(bucket)).toBe(10);

    now.advance(99); // 0.99 жетона — ще не цілий
    expect(bucket.take()).toBe(false);
    now.advance(1); // рівно 100 мс від спорожнення → 1 жетон
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);

    now.advance(350); // 3.5 жетона
    expect(drain(bucket)).toBe(3);
    now.advance(50); // залишок 0.5 + 0.5 → ще один
    expect(drain(bucket)).toBe(1);
  });

  test('вище за край відро не наповнюється, скільки б часу не минуло', () => {
    const now = manualClock();
    const bucket = createTokenBucket({ capacity: 4, now });
    now.advance(60_000); // повне відро «постояло» хвилину
    expect(bucket.tokens).toBe(4);
    expect(drain(bucket)).toBe(4);

    now.advance(3_600_000);
    expect(bucket.tokens).toBe(4);
    expect(drain(bucket)).toBe(4);
  });

  test('швидкість наповнення можна задати окремо від місткості', () => {
    const now = manualClock();
    const bucket = createTokenBucket({ capacity: 3, refillPerSecond: 1, now });
    expect(drain(bucket)).toBe(3);
    now.advance(1000);
    expect(drain(bucket)).toBe(1);
    now.advance(10_000);
    expect(drain(bucket)).toBe(3);
  });

  test('усталений темп у межах ліміту не відхиляється ніколи', () => {
    const now = manualClock();
    const bucket = createTokenBucket({ capacity: 4, now }); // 4/с — один жетон на 250 мс
    for (let i = 0; i < 1000; i += 1) {
      now.advance(250);
      expect(bucket.take()).toBe(true);
    }
  });

  test('удвічі швидший за ліміт: проходить стільки, скільки дозволяє швидкість + запас відра', () => {
    const now = manualClock();
    const capacity = 4;
    const bucket = createTokenBucket({ capacity, now });
    let accepted = 0;
    for (let i = 0; i < 80; i += 1) {
      now.advance(125); // 8 спроб/с проти ліміту 4/с, 10 секунд
      if (bucket.take()) accepted += 1;
    }
    expect(accepted).toBeGreaterThanOrEqual(4 * 10); // не менше, ніж наповнилось за 10 с
    expect(accepted).toBeLessThanOrEqual(4 * 10 + capacity); // і не більше: + стартовий запас
    expect(accepted).toBeLessThan(80);
  });

  test('годинник, що пішов назад, жетонів не забирає', () => {
    const now = manualClock();
    const bucket = createTokenBucket({ capacity: 2, now });
    expect(bucket.take()).toBe(true);
    now.advance(-500);
    expect(bucket.tokens).toBe(1);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
  });

  test('без переданого годинника працює на performance.now()', () => {
    const bucket = createTokenBucket({ capacity: 2 });
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
  });
});
