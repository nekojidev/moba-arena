// Vector2 і геометрія тора (arena.ts): значення пораховано вручну.
import { describe, test } from 'vitest';
import assert from 'node:assert/strict';

import { ARENA, shortestDelta, torusDelta, wrap, wrapVector } from '../src/sim/arena.ts';
import { Vector2 } from '../src/sim/vector.ts';

const near = (actual, expected, eps = 1e-12) =>
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} ≠ ${expected} (±${eps})`);

describe('Vector2', () => {
  test('конструктор без аргументів — нульовий вектор; ZERO заморожений', () => {
    const zero = new Vector2();
    assert.equal(zero.x, 0);
    assert.equal(zero.y, 0);
    assert.ok(Object.isFrozen(Vector2.ZERO));
    assert.throws(() => {
      Vector2.ZERO.x = 5;
    }, TypeError);
  });

  test('add, sub, scale, dot — покомпонентно', () => {
    const a = new Vector2(3, -4);
    const b = new Vector2(-1, 2);
    assert.deepEqual({ ...a.add(b) }, { x: 2, y: -2 });
    assert.deepEqual({ ...a.sub(b) }, { x: 4, y: -6 });
    assert.deepEqual({ ...a.scale(-2) }, { x: -6, y: 8 });
    assert.equal(a.dot(b), -11);
    assert.equal(a.dot(new Vector2(4, 3)), 0, 'перпендикулярні вектори');
  });

  test('length: єгипетський трикутник і нуль', () => {
    assert.equal(new Vector2(3, 4).length(), 5);
    assert.equal(new Vector2(-5, 12).length(), 13);
    assert.equal(Vector2.ZERO.length(), 0);
  });

  test('normalize: одинична довжина, напрямок той самий; нуль лишається нулем', () => {
    const unit = new Vector2(3, 4).normalize();
    near(unit.x, 0.6);
    near(unit.y, 0.8);
    near(unit.length(), 1);
    assert.equal(Vector2.ZERO.normalize(), Vector2.ZERO, 'без ділення на нуль');
    assert.equal(new Vector2(0, 0).normalize(), Vector2.ZERO);
  });

  test('rotate: чверть оберту, півоберту, повний оберт', () => {
    const v = new Vector2(2, 1);
    const quarter = v.rotate(Math.PI / 2);
    near(quarter.x, -1);
    near(quarter.y, 2);
    const half = v.rotate(Math.PI);
    near(half.x, -2);
    near(half.y, -1);
    const full = v.rotate(2 * Math.PI);
    near(full.x, 2);
    near(full.y, 1);
    assert.deepEqual({ ...v }, { x: 2, y: 1 }, 'оригінал не змінено');
  });

  test('fromAngle і angle — взаємно обернені', () => {
    const up = Vector2.fromAngle(Math.PI / 2, 3);
    near(up.x, 0);
    near(up.y, 3);
    near(Vector2.fromAngle(0).x, 1);
    near(Vector2.fromAngle(0).y, 0);
    for (const angle of [0, 0.5, 1.2, -2.9, 3.1, -Math.PI / 2]) {
      near(Vector2.fromAngle(angle, 7).angle(), angle, 1e-11);
    }
    assert.equal(Vector2.ZERO.angle(), 0, 'кут нульового вектора — 0 за домовленістю');
  });
});

describe('арена-тор', () => {
  test('wrap: усередині, за правим краєм, за лівим, рівно на краю', () => {
    assert.equal(wrap(5, 1600), 5);
    assert.equal(wrap(1605, 1600), 5);
    assert.equal(wrap(-5, 1600), 1595);
    assert.equal(wrap(1600, 1600), 0, 'правий край не входить у [0, size)');
    assert.equal(wrap(-1600, 1600), 0);
    assert.equal(wrap(3205.5, 1600), 5.5, 'кілька обертів');
  });

  test('wrap: крихітне від’ємне число не дає рівно size', () => {
    // −1e-20 + 1600 округлюється до 1600; другий залишок повертає 0, а не 1600.
    const wrapped = wrap(-1e-20, 1600);
    assert.ok(wrapped >= 0 && wrapped < 1600, `wrap дав ${wrapped}`);
  });

  test('wrapVector загортає обидві координати і приймає звичайний об’єкт', () => {
    assert.deepEqual({ ...wrapVector({ x: -10, y: 910 }, ARENA) }, { x: 1590, y: 10 });
    assert.ok(wrapVector(new Vector2(1, 2), ARENA) instanceof Vector2);
  });

  test('shortestDelta: напряму, через край, рівно пів арени', () => {
    assert.equal(shortestDelta(100, 300, 1600), 200);
    assert.equal(shortestDelta(300, 100, 1600), -200);
    assert.equal(shortestDelta(1590, 10, 1600), 20, 'через правий край ближче');
    assert.equal(shortestDelta(10, 1590, 1600), -20);
    assert.equal(shortestDelta(0, 800, 1600), -800, 'результат у [-size/2, size/2)');
    assert.equal(shortestDelta(0, 799, 1600), 799);
  });

  test('torusDelta: найкоротший вектор через кут арени', () => {
    const delta = torusDelta({ x: 1598, y: 898 }, { x: 2, y: 2 }, ARENA);
    assert.deepEqual({ ...delta }, { x: 4, y: 4 });
    assert.equal(torusDelta({ x: 100, y: 100 }, { x: 103, y: 104 }, ARENA).length(), 5);
  });
});
