// Сам матч: ввід → команда → game.step → рендер. Викликається, коли ассети вже завантажені
// і гравець обрав кімнату.

import { createLoop } from './loop.ts';
import { createInput } from './input.ts';
import { createHud } from './hud.ts';
import type { GameAudio } from './audio.ts';
import { assertNever } from './guards.ts';
import type { Arena } from '@moba-arena/shared/sim/arena.ts';
import { createGame } from '@moba-arena/shared/sim/game.ts';
import { BENCH_COMMAND, BENCH_DURATION } from '@moba-arena/shared/sim/bench.ts';
import type { Command, Ship } from '@moba-arena/shared/sim/ship.ts';
import type { AnyEntity, World } from '@moba-arena/shared/sim/world.ts';
import { fitArena, type View } from './render/canvas.ts';
import { lerpPose, type Pose } from './render/lerp.ts';
import type { Sprites } from './render/sprites.ts';
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
} from './render/draw.ts';

const RECORD_MS = 10_000;

// Порядок шарів: що намальовано пізніше — те зверху.
// as const — не приведення типу: воно фіксує літерали, тож елемент — це 'pickup' | …, а не string.
const LAYERS = ['pickup', 'asteroid', 'bullet', 'ship', 'explosion'] as const;

// Налаштування локального матчу: розмір арени обов'язковий, решта має типові значення.
export interface LocalConfig extends Arena {
  readonly seed?: number | undefined;
  readonly asteroids?: number | undefined;
  readonly pickups?: number | undefined;
}

export interface LocalGameOptions {
  readonly ctx: CanvasRenderingContext2D;
  readonly view: View;
  readonly sprites: Sprites;
  readonly audio: GameAudio;
  readonly config: LocalConfig;
  readonly playerName: string;
  readonly roomName: string;
  readonly warnings: readonly string[];
  readonly params: URLSearchParams;
}

export interface LocalGame {
  readonly world: World;
  readonly player: Ship;
  stop(): void;
}

interface BenchResult {
  readonly x: number;
  readonly y: number;
  readonly simTime: number;
  readonly steps: number;
}

interface Recording {
  readonly startedAt: number;
  readonly deltas: number[];
}

interface RecordSummary {
  readonly frames: number;
  readonly fps: number;
  readonly mean: number;
  readonly min: number;
  readonly max: number;
  readonly jitter: number; // стандартне відхилення часу кадру
  readonly slow: number;
}

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
}: LocalGameOptions): LocalGame {
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
  let benchResult: BenchResult | null = null;
  let frameCount = 0;
  let recording: Recording | null = null;
  let recordSummary: RecordSummary | null = null;

  // Слухачі клавіатури лише записують стан клавіш (input.js). Постріл — це поле команди:
  // симуляція сама викликає ship.fire(world) як метод, тож this там завжди правильний.
  function readCommand(): Command {
    return {
      turn: (input.isDown('ArrowRight') ? 1 : 0) - (input.isDown('ArrowLeft') ? 1 : 0),
      thrust: input.isDown('ArrowUp') ? 1 : 0,
      brake: input.isDown('ArrowDown'),
      dash: input.justPressed('KeyE'),
      fire: input.isDown('Space'),
    };
  }

  function simulate(dt: number): void {
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

  function summarize(deltas: readonly number[]): RecordSummary {
    const n = deltas.length;
    const mean = deltas.reduce((sum, d) => sum + d, 0) / n;
    const variance = deltas.reduce((sum, d) => sum + (d - mean) ** 2, 0) / n;
    return {
      frames: n,
      fps: 1000 / mean,
      mean,
      min: Math.min(...deltas),
      max: Math.max(...deltas),
      jitter: Math.sqrt(variance),
      slow: deltas.filter((d) => d > 20).length,
    };
  }

  // Малює одну сутність. switch за kind звужує тип: у гілці 'ship' entity — це Ship тощо.
  // У default сутність має тип never; з'явиться новий вид без гілки — tsc покаже помилку.
  function drawEntity(entity: AnyEntity, pose: Pose, now: number): void {
    switch (entity.kind) {
      case 'pickup':
        drawPickup(ctx, entity, pose, now, sprites);
        break;
      case 'asteroid':
        drawAsteroid(ctx, entity, pose, now, sprites);
        break;
      case 'bullet':
        drawBullet(ctx, entity, pose, now, sprites);
        break;
      case 'ship':
        drawShip(ctx, entity, pose, now, sprites);
        break;
      case 'explosion':
        drawExplosion(ctx, entity, pose);
        break;
      default:
        assertNever(entity);
    }
  }

  function render(alpha: number): void {
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
    for (const kind of LAYERS) {
      for (const entity of world.ofKind(kind)) {
        drawEntity(entity, lerpPose(entity, alpha, arena), now);
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

  function hudLines(now: number): string[] {
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
