import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runSelftest, SELFTEST_HASH } from '../src/sim/selftest.js';
import { atan2, cos, sin } from '../src/sim/dmath.js';
import { integrate, stepInput } from '../src/sim/ship.js';
import { DT } from '../src/protocol.js';

test('еталонний матч дає відомий хеш (і двічі поспіль — однаковий)', () => {
  const first = runSelftest();
  assert.equal(first.hash, SELFTEST_HASH);
  assert.deepEqual(runSelftest(), first);
});

test('integrate і stepInput — чисті функції', () => {
  const arena = { width: 1600, height: 900 };
  const state = Object.freeze({
    x: 100,
    y: 100,
    vx: 10,
    vy: 0,
    angle: 0,
    dashCooldown: 0,
    fireCooldown: 0,
    rapid: false,
  });
  const command = Object.freeze({ turn: 1, thrust: 1, brake: false, dash: true, fire: true });
  const a = stepInput(state, command, DT, arena);
  const b = stepInput(state, command, DT, arena);
  assert.deepEqual(a, b);
  assert.equal(a.fired, true);
  assert.equal(a.fireCooldown, 0.28);
  assert.equal(a.dashCooldown, 2.5);
  assert.equal(state.x, 100, 'вхідний стан не змінено');
  assert.equal(integrate(state, command, DT, arena).x, a.x);
});

test('dmath: точність проти Math.* і крайні випадки', () => {
  let worst = 0;
  for (let i = -5000; i <= 5000; i += 1) {
    const angle = i * 0.0137;
    worst = Math.max(
      worst,
      Math.abs(sin(angle) - Math.sin(angle)),
      Math.abs(cos(angle) - Math.cos(angle)),
    );
    const x = Math.cos(i * 0.7) * (1 + Math.abs(i % 13));
    const y = Math.sin(i * 1.3) * (1 + Math.abs(i % 7));
    // −π і π — той самий кут: порівнюємо різницю по колу.
    const diff = Math.abs(atan2(y, x) - Math.atan2(y, x));
    worst = Math.max(worst, Math.min(diff, Math.abs(diff - 2 * Math.PI)));
  }
  assert.ok(worst < 1e-11, `найбільша похибка ${worst}`);
  assert.equal(sin(0), 0);
  assert.ok(Math.abs(cos(0) - 1) < 1e-12);
  assert.equal(atan2(0, 0), 0);
  assert.equal(atan2(0, -1), Math.PI);
  assert.equal(atan2(1, 0), Math.PI / 2);
  assert.equal(atan2(-1, 0), -Math.PI / 2);
});

test('симуляція не викликає Math.sin/cos/atan2/hypot/exp і не знає про час та випадковість', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../src/sim/', import.meta.url);
  const banned =
    /Math\.(sin|cos|tan|atan2?|asin|acos|hypot|exp|log|pow|random)\b|Date\.now|performance\.now/;
  for (const file of readdirSync(dir)) {
    const code = readFileSync(new URL(file, dir), 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    assert.doesNotMatch(code, banned, file);
  }
});
