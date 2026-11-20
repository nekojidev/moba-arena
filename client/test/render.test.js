// Димовий тест рендера без браузера: підставний ctx приймає будь-які виклики.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGame } from '../src/sim/game.js';
import { ARENA } from '../src/sim/arena.js';
import { lerpPose } from '../src/render/lerp.js';
import * as draw from '../src/render/draw.js';

function fakeContext() {
  const calls = { count: 0 };
  const gradient = { addColorStop() {} };
  const ctx = new Proxy(
    {},
    {
      get(target, key) {
        if (key === 'measureText') return () => ({ width: 100 });
        if (key === 'createLinearGradient') return () => gradient;
        if (key in target) return target[key];
        return () => {
          calls.count += 1;
        };
      },
      set(target, key, value) {
        target[key] = value;
        return true;
      },
    },
  );
  return { ctx, calls };
}

test('усі види сутностей малюються без помилок протягом 30 с матчу', () => {
  const { ctx, calls } = fakeContext();
  const game = createGame({ seed: 3 });
  const drawers = {
    ship: draw.drawShip,
    bullet: draw.drawBullet,
    asteroid: draw.drawAsteroid,
    pickup: draw.drawPickup,
    explosion: draw.drawExplosion,
  };
  const seen = new Set();
  for (let i = 0; i < 1800; i += 1) {
    game.step(1 / 60, { turn: 0.3, thrust: 1, brake: false, dash: false, fire: true });
    draw.drawArena(ctx, ARENA);
    for (const entity of game.world) {
      const pose = lerpPose(entity, 0.5, ARENA);
      assert.ok(Number.isFinite(pose.x) && Number.isFinite(pose.y) && Number.isFinite(pose.angle));
      drawers[entity.kind](ctx, entity, pose, i * 16);
      seen.add(entity.kind);
    }
  }
  draw.drawHud(ctx, { stepsPerSecond: 60, framesPerSecond: 60, frameTime: 16, frameTimeMax: 17 });
  draw.drawScore(ctx, 800, 10, 20);
  assert.deepEqual([...seen].sort(), ['asteroid', 'bullet', 'explosion', 'pickup', 'ship']);
  assert.ok(calls.count > 0);
});
