// Навантажувальний тест: скільки гравців в одній кімнаті витримує сервер.
//
//   npm run load -w server                          # N = 8, 32, 64, 128, 192, 256
//   npm run load -w server -- --n=8,32,64,128 --seconds=20
//   npm run load -w server -- --collision=naive,hash   # «до» і «після» просторового хеша
//
// Для кожного N — СВІЖИЙ процес сервера. N безголових клієнтів заходять в одну кімнату й
// шлють бінарний input 30 разів/с (газ, повороти, часта стрільба). Після прогріву міряємо
// SECONDS секунд і читаємо справжні цифри сервера з GET /api/stats:
//   • тривалість кроку p50/p99/max і запізнення — за вікно рівно в SECONDS·30 кроків;
//   • завантаженість циклу подій (ELU), паузи збирача сміття — різниця двох замірів;
//   • rss — найбільше значення за час заміру;
//   • байти/с — і з лічильника сервера (знімки), і те, що справді отримали клієнти.
// Результат: таблиця, docs/lab-07/load-test.csv і docs/lab-07/load-capacity.svg.

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { TICK_MS, TICK_RATE } from '@moba-arena/shared/protocol.ts';
import { sleep, spawnServer, startPlayer } from './lib.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => arg.replace(/^--/, '').split('=')),
);
const COUNTS = (args.n ?? '8,32,64,128,192,256').split(',').map(Number);
const SECONDS = Number(args.seconds ?? 20);
const WARMUP_S = Number(args.warmup ?? 5);
// Порожній рядок — «як у сервера типово» (COLLISION не задано).
const COLLISIONS = (args.collision ?? '').split(',');
const BUDGET_MS = TICK_MS;
const OUT = resolve(import.meta.dirname, '../../docs/lab-07');
const MB = 1024 * 1024;

const getStats = async (server, query = '') =>
  (await fetch(`${server.http}/api/stats${query}`)).json();

async function run(clients, collision) {
  const server = await spawnServer({ MAX_PLAYERS_PER_ROOM: '256', COLLISION: collision });
  const players = [];
  try {
    for (let i = 0; i < clients; i += 1) {
      players.push(
        await startPlayer(server.wsUrl, {
          name: `Гравець ${i}`,
          index: i,
          offsetMs: (i * TICK_MS) / clients,
        }),
      );
    }
    await sleep(WARMUP_S * 1000);

    const received = () => players.reduce((sum, player) => sum + player.stats.bytes, 0);
    const before = await getStats(server);
    const bytesBefore = received();
    const loadBefore = performance.eventLoopUtilization();
    const startedAt = performance.now();
    let rss = before.process.memory.rss;
    let heap = before.process.memory.heapUsed;
    while (performance.now() - startedAt < SECONDS * 1000 - 500) {
      await sleep(500);
      const { memory } = (await getStats(server, '?window=1')).process;
      rss = Math.max(rss, memory.rss);
      heap = Math.max(heap, memory.heapUsed);
    }
    await sleep(Math.max(0, SECONDS * 1000 - (performance.now() - startedAt)));
    const after = await getStats(server, `?window=${SECONDS * TICK_RATE}`);
    const seconds = (performance.now() - startedAt) / 1000;
    const bytesAfter = received();
    const generator = performance.eventLoopUtilization(loadBefore).utilization;

    const [match] = after.matches;
    const [matchBefore] = before.matches;
    const active = after.process.eventLoop.activeMs - before.process.eventLoop.activeMs;
    const idle = after.process.eventLoop.idleMs - before.process.eventLoop.idleMs;
    const alive = players.filter((player) => player.stats.closeCode === null).length;
    const snapshotBytes = match.bytesOut - matchBefore.bytesOut;
    const recvBytes = bytesAfter - bytesBefore;
    return {
      collision: collision || 'default', // 'default' — те, що в сервера типово (hash)
      clients,
      alive,
      entities: match.entities,
      window: match.window,
      tick: match.tickDurationMs,
      late: match.tickLatenessMs,
      elu: active / (active + idle),
      generatorElu: generator,
      rssMb: rss / MB,
      heapMb: heap / MB,
      gcCount: after.process.gc.count - before.process.gc.count,
      gcMs: after.process.gc.totalMs - before.process.gc.totalMs,
      gcMaxMs: after.process.gc.maxMs,
      snapshotKbS: snapshotBytes / 1024 / seconds,
      recvKbS: recvBytes / 1024 / seconds,
      snapshotsPerClientS: (match.snapshots - matchBefore.snapshots) / seconds / clients,
      droppedSnapshots: after.sockets.dropped - before.sockets.dropped,
      overruns: match.overruns,
      droppedInputs: match.droppedInputs,
    };
  } finally {
    for (const player of players) player.close();
    await server.stop();
  }
}

function chart(rows) {
  const width = 760;
  const height = 400;
  const plot = { left: 64, right: 40, top: 72, bottom: 56 };
  const innerWidth = width - plot.left - plot.right;
  const innerHeight = height - plot.top - plot.bottom;
  const maxN = Math.max(...rows.map((row) => row.clients));
  const top = Math.max(BUDGET_MS * 1.2, ...rows.map((row) => row.tick.p99 * 1.15));
  const step = top > 120 ? 40 : top > 60 ? 20 : 10;
  const maxY = Math.ceil(top / step) * step;
  const x = (n) => plot.left + (n / maxN) * innerWidth;
  const y = (v) => plot.top + innerHeight - (v / maxY) * innerHeight;
  const ink = { primary: '#0b0b0b', secondary: '#52514e', grid: '#e4e3df' };
  const series = '#2a78d6';
  const budget = '#eb6834';
  const font = 'font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"';
  const ms = (value) => value.toFixed(value < 10 ? 2 : 1).replace('.', ',');

  const yTicks = [];
  for (let v = 0; v <= maxY; v += step) yTicks.push(v);
  const points = rows.map((row) => `${x(row.clients).toFixed(1)},${y(row.tick.p99).toFixed(1)}`);
  const over = rows.find((row) => row.tick.p99 > BUDGET_MS);
  const capacity = rows.filter((row) => row.tick.p99 <= BUDGET_MS).at(-1);
  const subtitle = over
    ? `Місткість — ${capacity ? capacity.clients : 0} гравців: при ${over.clients} p99 кроку вже ${ms(over.tick.p99)} мс`
    : `До ${maxN} гравців p99 кроку лишається під бюджетом`;

  // Підпис значення — над точкою; якщо точка під самою лінією бюджету, то під нею.
  const labels = rows
    .map((row) => {
      const px = x(row.clients);
      const py = y(row.tick.p99);
      const nearBudget = Math.abs(py - 12 - y(BUDGET_MS)) < 14;
      return `
  <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="4" fill="${series}" stroke="#fcfcfb" stroke-width="2"/>
  <text x="${px.toFixed(1)}" y="${(nearBudget ? py + 20 : py - 12).toFixed(1)}" font-size="12" text-anchor="middle" fill="${ink.primary}" ${font}>${ms(row.tick.p99)}</text>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Тривалість кроку сервера (p99) залежно від кількості гравців в одній кімнаті">
  <rect width="${width}" height="${height}" fill="#fcfcfb"/>
  <text x="${plot.left}" y="26" font-size="15" font-weight="600" fill="${ink.primary}" ${font}>Тривалість кроку сервера, p99 — залежно від кількості гравців у кімнаті</text>
  <text x="${plot.left}" y="46" font-size="12" fill="${ink.secondary}" ${font}>${subtitle}</text>
  ${yTicks.map((v) => `<line x1="${plot.left}" y1="${y(v).toFixed(1)}" x2="${plot.left + innerWidth}" y2="${y(v).toFixed(1)}" stroke="${ink.grid}" stroke-width="1"/><text x="${plot.left - 8}" y="${(y(v) + 4).toFixed(1)}" font-size="11" text-anchor="end" fill="${ink.secondary}" ${font}>${v}</text>`).join('\n  ')}
  ${rows.map((row) => `<text x="${x(row.clients).toFixed(1)}" y="${plot.top + innerHeight + 18}" font-size="11" text-anchor="middle" fill="${ink.secondary}" ${font}>${row.clients}</text>`).join('\n  ')}
  <text x="${plot.left - 8}" y="${plot.top - 12}" font-size="11" text-anchor="end" fill="${ink.secondary}" ${font}>мс</text>
  <text x="${plot.left + innerWidth}" y="${plot.top + innerHeight + 40}" font-size="11" text-anchor="end" fill="${ink.secondary}" ${font}>гравців в одній кімнаті (клієнти шлють input 30 разів/с)</text>
  <line x1="${plot.left}" y1="${y(BUDGET_MS).toFixed(1)}" x2="${plot.left + innerWidth}" y2="${y(BUDGET_MS).toFixed(1)}" stroke="${budget}" stroke-width="2" stroke-dasharray="6 4"/>
  <text x="${plot.left + 6}" y="${(y(BUDGET_MS) - 8).toFixed(1)}" font-size="12" fill="${ink.primary}" ${font}>бюджет кроку 33,3 мс (30 кроків/с)</text>
  <polyline points="${points.join(' ')}" fill="none" stroke="${series}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${labels}
</svg>
`;
}

const results = [];
console.log(
  `Замір ${SECONDS} с після ${WARMUP_S} с прогріву; бюджет кроку ${BUDGET_MS.toFixed(1)} мс.\n`,
);
console.log(
  'зіткнення | N   | сутн. | крок p50 / p99 / макс, мс  | запізн. p99 / макс, мс | ELU   | rss, МБ | КБ/с усього | КБ/с на клієнта | GC, мс',
);
console.log(
  '----------+-----+-------+----------------------------+------------------------+-------+---------+-------------+-----------------+-------',
);
for (const collision of COLLISIONS) {
  for (const clients of COUNTS) {
    const r = await run(clients, collision);
    results.push(r);
    const tick = `${r.tick.p50.toFixed(3)} / ${r.tick.p99.toFixed(3)} / ${r.tick.max.toFixed(3)}`;
    const late = `${r.late.p99.toFixed(3)} / ${r.late.max.toFixed(3)}`;
    console.log(
      `${r.collision.padEnd(9)} | ${String(r.clients).padEnd(3)} | ${String(r.entities).padStart(5)} | ` +
        `${tick.padStart(26)} | ${late.padStart(22)} | ${r.elu.toFixed(3)} | ${r.rssMb.toFixed(1).padStart(7)} | ` +
        `${r.recvKbS.toFixed(1).padStart(11)} | ${(r.recvKbS / r.clients).toFixed(2).padStart(15)} | ${r.gcMs.toFixed(1).padStart(6)}` +
        (r.alive < r.clients ? `  ← лишилось ${r.alive} клієнтів` : '') +
        (r.droppedSnapshots > 0 ? `  ← не надіслано знімків: ${r.droppedSnapshots}` : '') +
        (r.generatorElu > 0.8
          ? `  ← генератор навантаження зайнятий на ${(r.generatorElu * 100).toFixed(0)}%`
          : ''),
    );
  }
}

await mkdir(OUT, { recursive: true });
const csv = [
  'collision,clients,entities,ticks,tick_avg_ms,tick_p50_ms,tick_p99_ms,tick_max_ms,' +
    'late_avg_ms,late_p50_ms,late_p99_ms,late_max_ms,elu,generator_elu,rss_mb,heap_mb,' +
    'gc_count,gc_total_ms,gc_max_ms,snapshot_kb_s,recv_kb_s,recv_kb_s_per_client,' +
    'snapshots_per_client_s,dropped_snapshots,overruns,dropped_inputs,clients_alive',
];
for (const r of results) {
  csv.push(
    [
      r.collision,
      r.clients,
      r.entities,
      r.window,
      r.tick.avg,
      r.tick.p50,
      r.tick.p99,
      r.tick.max,
      r.late.avg,
      r.late.p50,
      r.late.p99,
      r.late.max,
      r.elu.toFixed(4),
      r.generatorElu.toFixed(4),
      r.rssMb.toFixed(1),
      r.heapMb.toFixed(1),
      r.gcCount,
      r.gcMs.toFixed(1),
      r.gcMaxMs.toFixed(2),
      r.snapshotKbS.toFixed(1),
      r.recvKbS.toFixed(1),
      (r.recvKbS / r.clients).toFixed(2),
      r.snapshotsPerClientS.toFixed(2),
      r.droppedSnapshots,
      r.overruns,
      r.droppedInputs,
      r.alive,
    ].join(','),
  );
}
await writeFile(join(OUT, 'load-test.csv'), csv.join('\n') + '\n');

// Графік — для останньої з перелічених систем (типово вона одна: та, що в сервера типова).
const charted = results.filter((r) => r.collision === results.at(-1).collision);
await writeFile(join(OUT, 'load-capacity.svg'), chart(charted));

const within = charted.filter((r) => r.tick.p99 <= BUDGET_MS);
const firstOver = charted.find((r) => r.tick.p99 > BUDGET_MS);
console.log(
  firstOver
    ? `\nМісткість: ${within.at(-1)?.clients ?? 0} гравців — найбільше N, де p99 кроку ≤ ${BUDGET_MS.toFixed(1)} мс ` +
        `(при N = ${firstOver.clients} p99 = ${firstOver.tick.p99} мс).`
    : `\nДо N = ${charted.at(-1).clients} p99 кроку не перевищує ${BUDGET_MS.toFixed(1)} мс.`,
);
console.log(`→ ${join(OUT, 'load-capacity.svg')}, load-test.csv`);
