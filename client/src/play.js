// Сам матч: ввід → команда → game.step → рендер. Викликається, коли ассети вже завантажені
// і гравець обрав кімнату.

import { createLoop } from './loop.js';
import { createInput } from './input.js';
import { createHud } from './hud.js';
import { createGame } from '@moba-arena/shared/sim/game.js';
import { BENCH_COMMAND, BENCH_DURATION } from '@moba-arena/shared/sim/bench.js';
import { fitArena } from './render/canvas.js';
import { lerpPose } from './render/lerp.js';
import {
  drawArena,
  drawAsteroid,
  drawBullet,
  drawExplosion,
  drawHud,
  drawPickup,
  drawScore,
  drawShip,
  effectLabel,
} from './render/draw.js';

const RECORD_MS = 10_000;

// Порядок шарів: що намальовано пізніше — те зверху.
const LAYERS = [
  ['pickup', drawPickup],
  ['asteroid', drawAsteroid],
  ['bullet', drawBullet],
  ['ship', drawShip],
  ['explosion', drawExplosion],
];

export function startGame({
  ctx,
  view,
  sprites,
  audio,
  config,
  playerName,
  roomName,
  warnings,
  params,
}) {
  // --- Режими експериментів Lab 1 (адресний рядок) -----------------------------------------
  //   ?exp=block | interval | variable,  ?bench — порожня арена й автопілот
  const experiment = params.get('exp');
  const bench = params.has('bench');

  const arena = { width: config.width, height: config.height };
  const input = createInput(window);
  const game = createGame({
    seed: config.seed,
    arena,
    asteroids: config.asteroids,
    pickups: config.pickups,
    playerName,
    empty: bench,
  });
  const { world, player, bot } = game;

  // Підписники шини подій. Симуляція не знає ні про звук, ні про HUD;
  // один abort() знімає всіх слухачів разом.
  const subscriptions = new AbortController();
  const hud = createHud(world, { playerId: player.id, signal: subscriptions.signal });
  audio.connect(world.events, { playerId: player.id, signal: subscriptions.signal });
  for (const warning of warnings) hud.say(warning);

  let simTime = 0;
  let benchResult = null;
  let frameCount = 0;
  let recording = null; // { startedAt, deltas: [] }
  let recordSummary = null;

  // Слухачі клавіатури лише записують стан клавіш (input.js). Постріл — це поле команди:
  // симуляція сама викликає ship.fire(world) як метод, тож this там завжди правильний.
  function readCommand() {
    return {
      turn: (input.isDown('ArrowRight') ? 1 : 0) - (input.isDown('ArrowLeft') ? 1 : 0),
      thrust: input.isDown('ArrowUp') ? 1 : 0,
      brake: input.isDown('ArrowDown'),
      dash: input.justPressed('KeyE'),
      fire: input.isDown('Space'),
    };
  }

  function simulate(dt) {
    if (input.justPressed('KeyR')) {
      recording = { startedAt: performance.now(), deltas: [] };
      recordSummary = null;
    }
    if (input.justPressed('KeyM')) hud.say(audio.toggleMute() ? 'звук вимкнено' : 'звук увімкнено');

    game.step(dt, bench && !benchResult ? BENCH_COMMAND : readCommand());
    input.endStep();

    simTime += dt;
    if (bench && !benchResult && simTime >= BENCH_DURATION - 1e-6) {
      benchResult = { x: player.pos.x, y: player.pos.y, simTime, steps: world.tick };
      console.log(
        `[bench] ${experiment === 'variable' ? 'variable' : 'fixed'} step: ` +
          `x=${player.pos.x.toFixed(3)} y=${player.pos.y.toFixed(3)} ` +
          `після ${world.tick} кроків (${simTime.toFixed(4)} с симуляції)`,
      );
    }
  }

  function summarize(deltas) {
    const n = deltas.length;
    const mean = deltas.reduce((sum, d) => sum + d, 0) / n;
    const variance = deltas.reduce((sum, d) => sum + (d - mean) ** 2, 0) / n;
    return {
      frames: n,
      fps: 1000 / mean,
      mean,
      min: Math.min(...deltas),
      max: Math.max(...deltas),
      jitter: Math.sqrt(variance), // стандартне відхилення часу кадру
      slow: deltas.filter((d) => d > 20).length,
    };
  }

  function render(alpha) {
    frameCount += 1;
    const stats = loop.stats();
    const now = performance.now();

    if (recording) {
      if (stats.totalFrames > 0) recording.deltas.push(stats.frameTime);
      if (now - recording.startedAt >= RECORD_MS && recording.deltas.length > 1) {
        recordSummary = summarize(recording.deltas);
        recording = null;
        console.log('[record]', recordSummary);
      }
    }

    const { scale, offsetX, offsetY } = fitArena(view, arena);

    ctx.clearRect(0, 0, view.width, view.height);
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    ctx.beginPath();
    ctx.rect(0, 0, arena.width, arena.height);
    ctx.clip();
    drawArena(ctx, arena);
    for (const [kind, draw] of LAYERS) {
      for (const entity of world.ofKind(kind)) {
        draw(ctx, entity, lerpPose(entity, alpha, arena), now, sprites);
      }
    }
    hud.drawWorld(ctx, now);
    ctx.restore();

    drawHud(ctx, stats, hudLines(now));
    hud.drawScreen(ctx, view, now);
    if (bot) {
      drawScore(ctx, view.width, world.score.get(player.id) ?? 0, world.score.get(bot.id) ?? 0);
    }

    if (experiment === 'block' && frameCount % 60 === 0) {
      // Lab 1, експеримент 1: 100 мс синхронної «роботи». Поки цей цикл на стеку —
      // event loop не може взяти з черги нічого: ні подію клавіатури, ні наступний кадр.
      const until = performance.now() + 100;
      while (performance.now() < until) {
        /* зайняте очікування */
      }
    }
  }

  function hudLines(now) {
    const lines = [
      `room      ${roomName}`,
      `mode      ${experiment ?? 'normal'}${bench ? ' + bench' : ''}`,
      `entities  ${world.size}`,
      player.isDown
        ? `hp        відродження через ${player.respawnTimer.toFixed(1)} с`
        : `hp        ${player.hp}`,
      `dash      ${player.dashCooldown === 0 ? 'готовий' : player.dashCooldown.toFixed(1) + ' с'}`,
    ];
    for (const [type, left] of player.effects) {
      lines.push(`руна      ${effectLabel(type)} ${left.toFixed(1)} с`);
    }
    if (benchResult) {
      lines.push(
        `bench     x=${benchResult.x.toFixed(3)} y=${benchResult.y.toFixed(3)}`,
        `          ${benchResult.steps} кроків`,
      );
    } else if (bench) {
      lines.push(`bench     ${simTime.toFixed(2)} / ${BENCH_DURATION} с`);
    }
    if (recording) {
      const left = (RECORD_MS - (now - recording.startedAt)) / 1000;
      lines.push(`record    ще ${Math.max(0, left).toFixed(1)} с…`);
    } else if (recordSummary) {
      const r = recordSummary;
      lines.push(
        `record    ${r.fps.toFixed(2)} fps, ${r.frames} кадрів`,
        `          min ${r.min.toFixed(1)} / max ${r.max.toFixed(1)} мс`,
        `          jitter σ ${r.jitter.toFixed(2)} мс, >20 мс: ${r.slow}`,
      );
    }
    lines.push(
      '',
      '← → поворот   ↑ тяга   ↓ гальмо',
      'Space постріл   E ривок',
      `M звук ${audio.muted ? '(вимкнено)' : ''}   R запис 10 с`,
    );
    return lines;
  }

  const loop = createLoop({
    step: 1 / 60,
    simulate,
    render,
    scheduler: experiment === 'interval' ? 'interval' : 'raf',
    fixed: experiment !== 'variable',
  });
  loop.start();

  return {
    world,
    player,
    stop() {
      loop.stop();
      input.dispose();
      subscriptions.abort();
    },
  };
}
