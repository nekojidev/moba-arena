// Netgraph: що відбувається з мережею просто зараз. Без нього мережевий код
// налагоджують навпомацки.

const WINDOW_MS = 1000;
const HISTORY = 150; // останні поправки для графіка (5 с знімків)

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
    extra: readonly string[],
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

    draw(ctx, view, now, extra) {
      const s = summary(now);
      const ms = (value: number | null): string =>
        value === null ? '—' : `${value.toFixed(0)} мс`;
      const lines = [
        `RTT          ${ms(s.rtt)}`,
        `вік знімка   ${ms(s.snapshotAge)}   (${s.snapshotsPerSecond}/с)`,
        `вниз         ${(s.downBytes / 1024).toFixed(2)} КБ/с`,
        `вгору        ${(s.upBytes / 1024).toFixed(2)} КБ/с`,
        `черга input  ${s.pending}`,
        `поправка     ${s.correctionLast.toFixed(2)}  сер ${s.correctionAvg.toFixed(2)}  макс ${s.correctionMax.toFixed(1)}`,
        ...extra,
      ];

      const lineHeight = 16;
      const padding = 10;
      const graphHeight = 36;
      ctx.save();
      ctx.font = '12px ui-monospace, Menlo, Consolas, monospace';
      ctx.textBaseline = 'top';
      const width = Math.max(
        300,
        ...lines.map((line) => ctx.measureText(line).width + padding * 2),
      );
      const height = lines.length * lineHeight + graphHeight + padding * 3;
      const left = 12;
      const top = view.height - height - 12;
      ctx.fillStyle = 'rgba(8, 14, 10, 0.82)';
      ctx.fillRect(left, top, width, height);
      ctx.fillStyle = '#d7f5df';
      lines.forEach((line, index) =>
        ctx.fillText(line, left + padding, top + padding + index * lineHeight),
      );

      // Графік поправок: стовпчик на знімок, шкала — 0…8 одиниць (вище — обрізається).
      const graphTop = top + padding * 2 + lines.length * lineHeight;
      const graphWidth = width - padding * 2;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.fillRect(left + padding, graphTop, graphWidth, graphHeight);
      const barWidth = graphWidth / HISTORY;
      corrections.forEach((value, index) => {
        const h = Math.min(1, value / 8) * graphHeight;
        ctx.fillStyle = value > 8 ? '#e2574c' : value > 1 ? '#f2c14e' : '#3fd6a3';
        ctx.fillRect(
          left + padding + (HISTORY - corrections.length + index) * barWidth,
          graphTop + graphHeight - Math.max(1, h),
          Math.max(1, barWidth - 0.5),
          Math.max(1, h),
        );
      });
      ctx.restore();
    },
  };
}
