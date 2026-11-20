// Lab 7: пул об'єктів, частинки в типізованих масивах, інтерполяція без нових об'єктів,
// вимірювач часу.
import { test } from 'vitest';
import assert from 'node:assert/strict';

import { TICK_MS } from '@moba-arena/shared/protocol.ts';
import { createEffects } from '../src/effects.ts';
import { createInterpolator, createSampleBuffer } from '../src/net/interpolation.ts';
import { createPerf } from '../src/perf.ts';
import { createPool } from '../src/pool.ts';

const ARENA = { width: 1600, height: 900 };
const ship = (id, x, y, angle = 0) => ({ id, kind: 'ship', x, y, angle, hp: 100, score: 0 });

test('пул: повернутий об’єкт видається знову, нових не створюється', () => {
  const pool = createPool(() => ({ value: 0 }));
  const a = pool.acquire();
  const b = pool.acquire();
  assert.equal(pool.created, 2);
  pool.release(a);
  assert.equal(pool.acquire(), a, 'той самий об’єкт, а не новий');
  pool.release(a);
  pool.release(b);
  for (let i = 0; i < 1000; i += 1) pool.release(pool.acquire());
  assert.equal(pool.created, 2, 'тисяча циклів «взяв — повернув» без жодного нового об’єкта');
});

test('частинки: вибух займає комірки, згаслі звільняють, місткість не перевищується', () => {
  const effects = createEffects();
  effects.explode(100, 100, { count: 50 });
  assert.equal(effects.count, 50);
  effects.update(0.1);
  assert.equal(effects.count, 50, 'за 0,1 с ще ніхто не згас (життя 0,35…0,85 с)');
  effects.update(1);
  assert.equal(effects.count, 0, 'за секунду згасли всі');

  for (let i = 0; i < 100; i += 1) effects.explode(0, 0, { count: 100 });
  assert.equal(effects.count, 2048, 'зайві частинки просто не з’являються');
  effects.update(2);
  assert.equal(effects.count, 0);
});

test('частинки: малювання міняє колір лише коли він інший', () => {
  const effects = createEffects();
  effects.explode(0, 0, { count: 30, color: '#111111' });
  effects.explode(0, 0, { count: 30, color: '#222222' });
  let colorChanges = 0;
  let arcs = 0;
  const ctx = {
    save() {},
    restore() {},
    beginPath() {},
    fill() {},
    arc: () => (arcs += 1),
    set fillStyle(_value) {
      colorChanges += 1;
    },
    set globalAlpha(_value) {},
  };
  effects.draw(ctx);
  assert.equal(arcs, 60);
  assert.equal(colorChanges, 2, 'два кольори → два присвоєння, а не шістдесят');
});

test('sampleInto дає те саме, що sample, і не створює нових об’єктів для незмінних сутностей', () => {
  const interpolator = createInterpolator({ arena: ARENA });
  interpolator.push({ tick: 10, entities: [ship(1, 100, 100, 0), ship(2, 1590, 450, 3.1)] });
  interpolator.push({ tick: 11, entities: [ship(1, 130, 100, 0.2), ship(2, 10, 450, -3.1)] });
  const out = createSampleBuffer();
  const arrays = [out.x, out.y, out.angle, out.records];

  for (const time of [9, 10, 10.25, 10.5, 10.999, 11, 15]) {
    const expected = interpolator.sample(time * TICK_MS);
    interpolator.sampleInto(time * TICK_MS, out);
    assert.equal(out.count, expected.entities.length);
    assert.equal(out.starved, expected.starved);
    expected.entities.forEach((entity, i) => {
      assert.equal(out.records[i].id, entity.id);
      assert.equal(out.x[i], entity.x);
      assert.equal(out.y[i], entity.y);
      assert.equal(out.angle[i], entity.angle);
    });
  }
  assert.deepEqual([out.x, out.y, out.angle, out.records], arrays, 'буфер той самий усі сім разів');
});

test('sampleInto: буфер росте, якщо сутностей більше за місткість', () => {
  const interpolator = createInterpolator({ arena: ARENA });
  const many = Array.from({ length: 40 }, (_, i) => ship(i + 1, i * 10, 5));
  interpolator.push({ tick: 1, entities: many });
  const out = createSampleBuffer(16);
  interpolator.sampleInto(TICK_MS, out);
  assert.equal(out.count, 40);
  assert.ok(out.x.length >= 40);
  assert.equal(out.x[39], 390);
});

test('інтерполятор тримає не більше 12 знімків', () => {
  const interpolator = createInterpolator({ arena: ARENA });
  for (let tick = 1; tick <= 50; tick += 1)
    interpolator.push({ tick, entities: [ship(1, tick, 0)] });
  assert.equal(interpolator.size, 12);
});

test('вимірювач: перцентилі, кільцевий буфер, reset', () => {
  const perf = createPerf();
  for (let i = 1; i <= 100; i += 1) perf.frame(i);
  const { frame } = perf.report();
  assert.equal(frame.samples, 100);
  assert.equal(frame.p50, 51);
  assert.equal(frame.p95, 96);
  assert.equal(frame.p99, 100);
  assert.equal(frame.max, 100);

  for (let i = 0; i < 10_000; i += 1) perf.frame(16.7);
  assert.equal(perf.report().frame.samples, 4096, 'старі заміри витісняються новими');

  const started = perf.begin();
  perf.end('render', started);
  assert.equal(perf.report().sections.render.samples, 1);
  perf.reset();
  assert.equal(perf.report().frame.samples, 0);
  assert.equal(perf.report().sections.render.samples, 0);
});
