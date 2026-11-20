// Ігрові повідомлення на екрані: «+100», стрічка подій. Як і звук, HUD лише слухає шину
// світу — симуляція його не імпортує і не знає, що він існує.

import type { EntityId } from '@moba-arena/shared/brand.ts';
import type { Bus } from '@moba-arena/shared/bus.ts';
import type { Point } from '@moba-arena/shared/sim/arena.ts';
import type { GameEvents } from '@moba-arena/shared/sim/events.ts';
import { effectLabel } from './render/draw.ts';

const FEED_LIFETIME = 4000; // мс
const POPUP_LIFETIME = 900;

// Усе, що HUD потрібно від світу: шина подій і «хто це й де він». Справжній World сюди
// підходить, і мережева гра теж — вона збирає такий об'єкт зі знімків (netplay.ts).
export interface HudWorld {
  readonly events: Bus<GameEvents>;
  get(id: EntityId): { readonly name?: string; readonly pos: Point } | undefined;
}

export interface HudOptions {
  readonly playerId?: EntityId;
  readonly signal?: AbortSignal;
}

export interface Hud {
  say(text: string): void;
  drawWorld(ctx: CanvasRenderingContext2D, now: number): void;
  drawScreen(
    ctx: CanvasRenderingContext2D,
    view: { readonly width: number; readonly height: number },
    now: number,
  ): void;
}

interface FeedEntry {
  readonly text: string;
  readonly at: number;
}

interface Popup {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly at: number;
  readonly color: string;
}

export function createHud(world: HudWorld, { playerId, signal }: HudOptions = {}): Hud {
  const feed: FeedEntry[] = [];
  const popups: Popup[] = [];

  const nameOf = (id: EntityId): string => world.get(id)?.name || 'хтось';
  const say = (text: string): void => {
    feed.push({ text, at: performance.now() });
    if (feed.length > 5) feed.shift();
  };

  world.events.on(
    'score',
    ({ id, points }) => {
      const ship = world.get(id);
      if (!ship) return;
      popups.push({
        text: `+${points}`,
        x: ship.pos.x,
        y: ship.pos.y - 44,
        at: performance.now(),
        color: id === playerId ? '#7ef0c0' : '#ff9a8a',
      });
    },
    { signal },
  );

  world.events.on(
    'exploded',
    ({ kind, id, killerId }) => {
      if (kind !== 'ship') return;
      const victim = nameOf(id);
      say(killerId === null ? `${victim} розбився об голема` : `${nameOf(killerId)} ✦ ${victim}`);
    },
    { signal },
  );

  world.events.on(
    'pickup',
    ({ shipId, effect }) => say(`${nameOf(shipId)} підібрав руну: ${effectLabel(effect.type)}`),
    { signal },
  );

  return {
    say,

    // Спливні числа живуть у координатах арени — малюються всередині її трансформації.
    drawWorld(ctx, now) {
      ctx.save();
      ctx.font = 'bold 20px ui-monospace, Menlo, Consolas, monospace';
      ctx.textAlign = 'center';
      for (let i = popups.length - 1; i >= 0; i -= 1) {
        const popup = popups[i];
        if (!popup) continue;
        const age = (now - popup.at) / POPUP_LIFETIME;
        if (age >= 1) {
          popups.splice(i, 1);
          continue;
        }
        ctx.globalAlpha = 1 - age;
        ctx.fillStyle = popup.color;
        ctx.fillText(popup.text, popup.x, popup.y - age * 30);
      }
      ctx.restore();
    },

    // Стрічка подій — у координатах екрана, внизу по центру.
    drawScreen(ctx, view, now) {
      while (feed[0] && now - feed[0].at > FEED_LIFETIME) feed.shift();
      ctx.save();
      ctx.font = '14px ui-monospace, Menlo, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      feed.forEach((entry, index) => {
        const age = (now - entry.at) / FEED_LIFETIME;
        const y = view.height - 20 - (feed.length - 1 - index) * 22;
        const width = ctx.measureText(entry.text).width + 20;
        ctx.globalAlpha = Math.min(1, (1 - age) * 3);
        ctx.fillStyle = 'rgba(8, 14, 10, 0.78)';
        ctx.fillRect(view.width / 2 - width / 2, y - 19, width, 22);
        ctx.fillStyle = '#d7f5df';
        ctx.fillText(entry.text, view.width / 2, y);
      });
      ctx.restore();
    },
  };
}
