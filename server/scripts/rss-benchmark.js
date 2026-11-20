// Дослід із backpressure: великий лог матчу качають через повільний канал,
// а ми раз на 200 мс записуємо rss сервера (GET /health).
//
//   npm run bench:rss -w server            # 200 МБ, 20 МБ/с
//   npm run bench:rss -w server -- 200 20
//
// Два прогони на свіжих процесах сервера:
//   stream — /api/replays/:id            pipeline(createReadStream, response)
//   buffer — /api/replays/:id?mode=buffer  readFile → response.end (лише з DEBUG_ROUTES=1)
// Результат: docs/lab-04/rss.csv і docs/lab-04/rss.svg.

import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sleep, spawnServer } from './lib.js';

const SIZE_MB = Number(process.argv[2] ?? 200);
const RATE_MB_S = Number(process.argv[3] ?? 20);
const MB = 1024 * 1024;
const OUT = resolve(import.meta.dirname, '../../docs/lab-04');

// Синтетичний лог. Запис теж поважає backpressure: write() повернув false —
// чекаємо 'drain', інакше ці 200 МБ спершу осіли б у пам'яті цього скрипта.
async function makeLog(file, bytes) {
  const stream = createWriteStream(file);
  let written = 0;
  for (let i = 0; written < bytes; i += 1) {
    const line =
      JSON.stringify({
        t: 1_700_000_000_000 + i * 16,
        room: 'bench',
        type: 'chat',
        from: { id: 'p' + (i % 8), name: 'Гравець ' + (i % 8) },
        text: 'повідомлення №' + i + ' ' + 'x'.repeat(i % 97),
      }) + '\n';
    written += Buffer.byteLength(line);
    if (!stream.write(line)) await once(stream, 'drain');
  }
  stream.end();
  await once(stream, 'finish');
  return written;
}

// Повільний клієнт: після кожного шматка ставимо потік на паузу рівно на стільки,
// щоб середня швидкість не перевищила RATE_MB_S. Поки ми на паузі, заповнюються буфери
// TCP, і серверний write() починає повертати false — це і є backpressure.
function slowDownload(url) {
  return new Promise((done, fail) => {
    get(url, (response) => {
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        response.pause();
        setTimeout(() => response.resume(), (chunk.length / (RATE_MB_S * MB)) * 1000);
      });
      response.on('end', () => done(bytes));
      response.on('error', fail);
    }).on('error', fail);
  });
}

async function run(mode, logDir) {
  const server = await spawnServer({ LOG_DIR: logDir, DEBUG_ROUTES: '1' });
  const samples = [];
  const started = performance.now();
  let downloading = true;
  const sampler = (async () => {
    while (downloading) {
      const { rss } = await (await fetch(server.http + '/health')).json();
      samples.push({ t: (performance.now() - started) / 1000, rss: rss / MB });
      await sleep(200);
    }
  })();

  await sleep(1000); // базовий рівень до початку
  const downloadStart = (performance.now() - started) / 1000;
  const bytes = await slowDownload(
    `${server.http}/api/replays/bench${mode === 'buffer' ? '?mode=buffer' : ''}`,
  );
  const downloadEnd = (performance.now() - started) / 1000;
  await sleep(1000);
  downloading = false;
  await sampler;
  const exit = await server.stop();

  const baseline = Math.min(...samples.filter((s) => s.t < downloadStart).map((s) => s.rss));
  const peak = Math.max(...samples.map((s) => s.rss));
  return { mode, samples, bytes, baseline, peak, downloadStart, downloadEnd, exitCode: exit.code };
}

function chart(runs) {
  const width = 760;
  const height = 380;
  const plot = { left: 64, right: 150, top: 64, bottom: 48 };
  const innerWidth = width - plot.left - plot.right;
  const innerHeight = height - plot.top - plot.bottom;
  const maxT = Math.max(...runs.flatMap((r) => r.samples.map((s) => s.t)));
  const maxY = Math.ceil(Math.max(...runs.map((r) => r.peak)) / 50) * 50;
  const x = (t) => plot.left + (t / maxT) * innerWidth;
  const y = (v) => plot.top + innerHeight - (v / maxY) * innerHeight;
  const ink = { primary: '#0b0b0b', secondary: '#52514e', grid: '#e4e3df' };
  const series = {
    stream: { color: '#2a78d6', label: 'pipeline (потік)' },
    buffer: { color: '#eb6834', label: 'readFile (у пам’ять)' },
  };
  const font = 'font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"';

  const yTicks = [];
  for (let v = 0; v <= maxY; v += maxY > 200 ? 100 : 50) yTicks.push(v);
  const xTicks = [];
  for (let t = 0; t <= maxT; t += 2) xTicks.push(t);

  const lines = runs
    .map((run) => {
      const { color, label } = series[run.mode];
      const points = run.samples
        .map((s) => `${x(s.t).toFixed(1)},${y(s.rss).toFixed(1)}`)
        .join(' ');
      const end = run.samples.at(-1);
      return `
  <polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
  <circle cx="${x(end.t).toFixed(1)}" cy="${y(end.rss).toFixed(1)}" r="4" fill="${color}" stroke="#fcfcfb" stroke-width="2"/>
  <text x="${(x(end.t) + 10).toFixed(1)}" y="${(y(end.rss) + 4).toFixed(1)}" font-size="12" fill="${ink.primary}" ${font}>${label}</text>
  <text x="${(x(end.t) + 10).toFixed(1)}" y="${(y(end.rss) + 19).toFixed(1)}" font-size="11" fill="${ink.secondary}" ${font}>пік ${run.peak.toFixed(0)} МБ</text>`;
    })
    .join('');

  const legend = runs
    .map((run, i) => {
      const { color, label } = series[run.mode];
      const lx = plot.left + i * 190;
      return `<line x1="${lx}" y1="44" x2="${lx + 18}" y2="44" stroke="${color}" stroke-width="2" stroke-linecap="round"/><text x="${lx + 24}" y="48" font-size="12" fill="${ink.secondary}" ${font}>${label}</text>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Пам’ять сервера (rss) під час повільного завантаження логу ${SIZE_MB} МБ">
  <rect width="${width}" height="${height}" fill="#fcfcfb"/>
  <text x="${plot.left}" y="24" font-size="15" font-weight="600" fill="${ink.primary}" ${font}>Пам’ять сервера (rss), поки лог ${SIZE_MB} МБ качають на ${RATE_MB_S} МБ/с</text>
  ${legend}
  ${yTicks.map((v) => `<line x1="${plot.left}" y1="${y(v)}" x2="${plot.left + innerWidth}" y2="${y(v)}" stroke="${ink.grid}" stroke-width="1"/><text x="${plot.left - 8}" y="${y(v) + 4}" font-size="11" text-anchor="end" fill="${ink.secondary}" ${font}>${v}</text>`).join('\n  ')}
  ${xTicks.map((t) => `<text x="${x(t).toFixed(1)}" y="${plot.top + innerHeight + 18}" font-size="11" text-anchor="middle" fill="${ink.secondary}" ${font}>${t}</text>`).join('\n  ')}
  <text x="${plot.left - 8}" y="${plot.top - 10}" font-size="11" text-anchor="end" fill="${ink.secondary}" ${font}>МБ</text>
  <text x="${plot.left + innerWidth}" y="${plot.top + innerHeight + 38}" font-size="11" text-anchor="end" fill="${ink.secondary}" ${font}>час від початку заміру, с</text>
  ${lines}
</svg>
`;
}

const dir = await mkdtemp(join(tmpdir(), 'moba-rss-'));
try {
  process.stdout.write(`Генерую лог ${SIZE_MB} МБ… `);
  const bytes = await makeLog(join(dir, 'bench.ndjson'), SIZE_MB * MB);
  console.log(`${(bytes / MB).toFixed(1)} МБ`);

  const runs = [];
  for (const mode of ['stream', 'buffer']) {
    process.stdout.write(`Качаю (${mode})… `);
    const result = await run(mode, dir);
    runs.push(result);
    console.log(
      `${(result.bytes / MB).toFixed(1)} МБ за ${(result.downloadEnd - result.downloadStart).toFixed(1)} с; ` +
        `rss: база ${result.baseline.toFixed(0)} МБ, пік ${result.peak.toFixed(0)} МБ ` +
        `(+${(result.peak - result.baseline).toFixed(0)} МБ); код завершення сервера ${result.exitCode}`,
    );
  }

  await mkdir(OUT, { recursive: true });
  const csv = ['mode,seconds,rss_mb'];
  for (const run of runs) {
    for (const sample of run.samples)
      csv.push(`${run.mode},${sample.t.toFixed(2)},${sample.rss.toFixed(1)}`);
  }
  await writeFile(join(OUT, 'rss.csv'), csv.join('\n') + '\n');
  await writeFile(join(OUT, 'rss.svg'), chart(runs));
  console.log(`→ ${join(OUT, 'rss.svg')}, rss.csv`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
