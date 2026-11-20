import { createLoop } from './loop.js';
import { createInput } from './input.js';
import { createGame } from './sim/game.js';
import { ARENA } from './sim/arena.js';
import { BENCH_COMMAND, BENCH_DURATION } from './sim/bench.js';
import { setupCanvas, fitArena } from './render/canvas.js';
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

// --- Режими експериментів (Lab 1, M4) задаються в адресному рядку --------------------------
//   ?exp=block      — блокуючий цикл 100 мс у кожному 60-му кадрі
//   ?exp=interval   — setInterval(frame, 16) замість requestAnimationFrame
//   ?exp=variable   — змінний крок: simulate(dt) раз на кадр, без акумулятора
//   ?bench          — порожня арена й автопілот: 5 с симульованого часу тяги → позиція
const params = new URLSearchParams(window.location.search);
const experiment = params.get('exp');
const bench = params.has('bench');

const RECORD_MS = 10_000;

const { ctx, view } = setupCanvas(document.querySelector('#game'));
const input = createInput(window);
const game = createGame({ seed: 1, empty: bench });
const { world, player, bot } = game;

// Порядок шарів: що намальовано пізніше — те зверху.
const LAYERS = [
  ['pickup', drawPickup],
  ['asteroid', drawAsteroid],
  ['bullet', drawBullet],
  ['ship', drawShip],
  ['explosion', drawExplosion],
];

let simTime = 0;
let benchResult = null;
let frameCount = 0;
let recording = null; // { startedAt, deltas: [] }
let recordSummary = null;

// Слухачі клавіатури лише записують стан клавіш (input.js). Постріл — це поле команди:
// симуляція сама викликає ship.fire(world) як метод, тож this там завжди правильний.
// Наївний варіант `window.addEventListener('keydown', player.fire)` зламав би this —
// див. README та scripts/this-bug.js.
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

  const { scale, offsetX, offsetY } = fitArena(view, ARENA);

  ctx.clearRect(0, 0, view.width, view.height);
  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);
  ctx.beginPath();
  ctx.rect(0, 0, ARENA.width, ARENA.height);
  ctx.clip();
  drawArena(ctx, ARENA);
  for (const [kind, draw] of LAYERS) {
    for (const entity of world.ofKind(kind)) {
      draw(ctx, entity, lerpPose(entity, alpha, ARENA), now);
    }
  }
  ctx.restore();

  drawHud(ctx, stats, hudLines(now));
  if (bot) {
    drawScore(ctx, view.width, world.score.get(player.id) ?? 0, world.score.get(bot.id) ?? 0);
  }

  if (experiment === 'block' && frameCount % 60 === 0) {
    // Експеримент 1: 100 мс синхронної «роботи». Поки цей цикл на стеку —
    // event loop не може взяти з черги нічого: ні подію клавіатури, ні наступний кадр.
    const until = performance.now() + 100;
    while (performance.now() < until) {
      /* зайняте очікування */
    }
  }
}

function hudLines(now) {
  const lines = [
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
  lines.push('', '← → поворот   ↑ тяга   ↓ гальмо', 'Space постріл   E ривок   R запис 10 с');
  return lines;
}

const loop = createLoop({
  step: 1 / 60,
  simulate,
  render,
  scheduler: experiment === 'interval' ? 'interval' : 'raf',
  fixed: experiment !== 'variable',
});

// Підсвічуємо активний режим у меню.
const activeMode = [experiment ? `exp=${experiment}` : null, bench ? 'bench' : null]
  .filter(Boolean)
  .join('&');
for (const link of document.querySelectorAll('#modes a')) {
  link.classList.toggle('active', link.dataset.mode === activeMode);
}

loop.start();
