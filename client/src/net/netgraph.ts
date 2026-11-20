// Netgraph: що відбувається з мережею просто зараз. Без нього мережевий код
// налагоджують навпомацки.

import { createTextPanel } from '../render/draw.ts';

const WINDOW_MS = 1000;
const HISTORY = 150; // останні поправки для графіка (5 с знімків)
const REFRESH_MS = 250; // як часто оновлюється текст панелі
const GRAPH_HEIGHT = 36;

interface Traffic {
  readonly at: number;
  readonly bytes: number;
}

export interface NetMetrics {
  rtt: number | null;
  lastSnapshotAt: number | null;
  snapshots: number;
  pending: number;
}

export interface NetSummary {
  readonly rtt: number | null;
  readonly snapshotAge: number | null;
  readonly snapshotsPerSecond: number;
  readonly downBytes: number;
  readonly upBytes: number;
  readonly pending: number;
  readonly correctionLast: number;
  readonly correctionAvg: number;
  readonly correctionMax: number;
}

export interface Netgraph {
  readonly metrics: NetMetrics;
  readonly corrections: readonly number[];
  received(bytes: number, now: number): void;
  sent(bytes: number, now: number): void;
  snapshot(now: number, correction: number): void;
  summary(now: number): NetSummary;
  draw(
    ctx: CanvasRenderingContext2D,
    view: { readonly height: number },
    now: number,
    extra: () => readonly string[],
  ): void;
}

export function createNetgraph(): Netgraph {
  const down: Traffic[] = [];
  const up: Traffic[] = [];
  const corrections: number[] = []; // величина поправки на кожен знімок
  const metrics: NetMetrics = {
    rtt: null,
    lastSnapshotAt: null,
    snapshots: 0,
    pending: 0,
  };

  const trim = (list: Traffic[], now: number): void => {
    while (list[0] && now - list[0].at > WINDOW_MS) list.shift();
  };
  const total = (list: readonly Traffic[]): number =>
    list.reduce((sum, entry) => sum + entry.bytes, 0);

  function summary(now: number): NetSummary {
    trim(down, now);
    trim(up, now);
    const recent = corrections.slice(-30); // остання секунда
    return {
      rtt: metrics.rtt,
      snapshotAge: metrics.lastSnapshotAt === null ? null : now - metrics.lastSnapshotAt,
      snapshotsPerSecond: down.length,
      downBytes: total(down),
      upBytes: total(up),
      pending: metrics.pending,
      correctionLast: corrections.at(-1) ?? 0,
      correctionAvg: recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0,
      correctionMax: recent.length ? Math.max(...recent) : 0,
    };
  }

  const panel = createTextPanel({
    font: '12px ui-monospace, Menlo, Consolas, monospace',
    lineHeight: 16,
    minWidth: 300,
    extraHeight: GRAPH_HEIGHT + 10,
    background: 'rgba(8, 14, 10, 0.82)',
  });
  let refreshedAt = -Infinity;

  return {
    metrics,
    corrections,

    received(bytes, now) {
      down.push({ at: now, bytes });
    },
    sent(bytes, now) {
      up.push({ at: now, bytes });
    },
    snapshot(now, correction) {
      metrics.lastSnapshotAt = now;
      metrics.snapshots += 1;
      corrections.push(correction);
      if (corrections.length > HISTORY) corrections.shift();
    },

    summary,

    // Текст оновлюється раз на REFRESH_MS, а не щокадру (див. createTextPanel);
    // extra — функція, щоб і додаткові рядки будувались лише під час оновлення.
    draw(ctx, view, now, extra) {
      if (now - refreshedAt >= REFRESH_MS) {
        refreshedAt = now;
        const s = summary(now);
        const ms = (value: number | null): string =>
          value === null ? '—' : `${value.toFixed(0)} мс`;
        panel.update(ctx, [
          `RTT          ${ms(s.rtt)}`,
          `вік знімка   ${ms(s.snapshotAge)}   (${s.snapshotsPerSecond}/с)`,
          `вниз         ${(s.downBytes / 1024).toFixed(2)} КБ/с`,
          `вгору        ${(s.upBytes / 1024).toFixed(2)} КБ/с`,
          `черга input  ${s.pending}`,
          `поправка     ${s.correctionLast.toFixed(2)}  сер ${s.correctionAvg.toFixed(2)}  макс ${s.correctionMax.toFixed(1)}`,
          ...extra(),
        ]);
      }

      const padding = 10;
      const left = 12;
      const top = view.height - panel.height - 12;
      panel.draw(ctx, left, top);

      // Графік поправок: стовпчик на знімок, шкала — 0…8 одиниць (вище — обрізається).
      const graphTop = top + panel.height - GRAPH_HEIGHT - padding;
      const graphWidth = panel.width - padding * 2;
      ctx.save();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.fillRect(left + padding, graphTop, graphWidth, GRAPH_HEIGHT);
      const barWidth = graphWidth / HISTORY;
      let barColor = '';
      for (let index = 0; index < corrections.length; index += 1) {
        const value = corrections[index] ?? 0;
        const h = Math.min(1, value / 8) * GRAPH_HEIGHT;
        // Присвоєння fillStyle — це розбір рядка кольору; 150 стовпчиків × 60 кадрів/с.
        // Сусідні стовпчики майже завжди одного кольору, тож міняємо лише за потреби.
        const color = value > 8 ? '#e2574c' : value > 1 ? '#f2c14e' : '#3fd6a3';
        if (color !== barColor) {
          barColor = color;
          ctx.fillStyle = color;
        }
        ctx.fillRect(
          left + padding + (HISTORY - corrections.length + index) * barWidth,
          graphTop + GRAPH_HEIGHT - Math.max(1, h),
          Math.max(1, barWidth - 0.5),
          Math.max(1, h),
        );
      }
      ctx.restore();
    },
  };
}
