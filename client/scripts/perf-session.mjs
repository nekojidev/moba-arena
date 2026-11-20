/* global window -- колбеки page.evaluate() виконуються в браузері */
// Запис ігрової сесії з ботами і зняття показників продуктивності клієнта (Lab 7).
//
//   node client/scripts/perf-session.mjs <мітка> [секунд=30] [ботів=8]
//
// Сервер і зібраний клієнт скрипт піднімає сам (як `npm start`). Браузер — Chromium із
// Playwright, без вікна. Два проходи, щоб інструменти не псували заміри одне одному:
//   1) час кадру (кільцевий буфер із perf.ts) + паузи збирання сміття (трасування V8);
//   2) профіль CPU (хто їсть час) + семплювання купи (хто створює об'єкти).
// Результат: docs/lab-07/client-<мітка>.json і полум'яний графік client-<мітка>-flame.svg.

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const [label = 'run', secondsArg = '30', botsArg = '8'] = process.argv.slice(2);
const SECONDS = Number(secondsArg);
const BOTS = Number(botsArg);
const PORT = 4321;
const ROOT = resolve(import.meta.dirname, '../..');
const OUT = join(ROOT, 'docs/lab-07');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function startServer(logDir) {
  const child = spawn(process.execPath, [join(ROOT, 'server/src/index.ts')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      LOG_DIR: logDir,
      LOG_LEVEL: 'warn',
      CLIENT_DIST: join(ROOT, 'client/dist-profile'),
    },
    stdio: 'inherit',
  });
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return child;
    } catch {
      await sleep(50);
    }
  }
  throw new Error('сервер не стартував');
}

async function joinGame(page) {
  await page.goto(`http://127.0.0.1:${PORT}/?bots=${BOTS}`);
  await page.locator('#lobby input').first().fill('Профайлер');
  await page.locator('#lobby .room[data-room="mid"]').click();
  await page.locator('#lobby button[type=submit]').click();
  await page.waitForFunction(() => window.__game?.game?.state?.self != null);
  await page.waitForFunction((bots) => window.__game.game.state.entities >= bots + 1, BOTS);
}

// «Важка стрільба»: тяга і постріл затиснуті, поворот щопівсекунди міняється.
async function play(page, ms) {
  await page.keyboard.down('ArrowUp');
  await page.keyboard.down('Space');
  const end = Date.now() + ms;
  let step = 0;
  while (Date.now() < end) {
    const key = step % 3 === 0 ? 'ArrowLeft' : 'ArrowRight';
    await page.keyboard.down(key);
    await sleep(350);
    await page.keyboard.up(key);
    await sleep(150);
    step += 1;
  }
  await page.keyboard.up('Space');
  await page.keyboard.up('ArrowUp');
}

const short = (url) =>
  url
    .replace(/^.*\/assets\//, '')
    .replace(/^.*\/src\//, 'src/')
    .replace(/\?.*$/, '');

// --- прохід 1: кадри й збирання сміття -------------------------------------------------------
async function measureFrames(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const cdp = await page.context().newCDPSession(page);
  await joinGame(page);
  await play(page, 3000); // прогрів: JIT, перші знімки
  await page.evaluate(() => window.__game.game.perf.reset());

  const events = [];
  cdp.on('Tracing.dataCollected', ({ value }) => events.push(...value));
  await cdp.send('Tracing.start', {
    traceConfig: { includedCategories: ['devtools.timeline', 'v8', 'disabled-by-default-v8.gc'] },
    transferMode: 'ReportEvents',
  });
  await play(page, SECONDS * 1000);
  const done = new Promise((resolveDone) => cdp.once('Tracing.tracingComplete', resolveDone));
  await cdp.send('Tracing.end');
  await done;

  const report = await page.evaluate(() => window.__game.game.perf.report());
  const state = await page.evaluate(() => window.__game.game.state);
  await page.close();

  const majors = [];
  const firstTs = events.reduce(
    (min, event) => (event.ts > 0 && event.ts < min ? event.ts : min),
    Infinity,
  );
  const gc = {
    minor: { count: 0, totalMs: 0, maxMs: 0 },
    major: { count: 0, totalMs: 0, maxMs: 0 },
  };
  for (const event of events) {
    if (event.ph !== 'X' || (event.name !== 'MinorGC' && event.name !== 'MajorGC')) continue;
    const bucket = event.name === 'MinorGC' ? gc.minor : gc.major;
    const ms = event.dur / 1000;
    bucket.count += 1;
    bucket.totalMs += ms;
    bucket.maxMs = Math.max(bucket.maxMs, ms);
    // Для великих збирань запам'ятовуємо, коли і чому вони сталися.
    if (event.name === 'MajorGC') {
      majors.push({
        atSeconds: Number(((event.ts - firstTs) / 1e6).toFixed(1)),
        ms: Number(ms.toFixed(2)),
        type: event.args?.type ?? null,
        usedBeforeMB: event.args?.usedHeapSizeBefore
          ? Number((event.args.usedHeapSizeBefore / 1048576).toFixed(1))
          : null,
        usedAfterMB: event.args?.usedHeapSizeAfter
          ? Number((event.args.usedHeapSizeAfter / 1048576).toFixed(1))
          : null,
      });
    }
  }
  return { report, gc, majors, entities: state.entities };
}

// --- прохід 2: хто їсть час і хто створює об'єкти --------------------------------------------
async function profile(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const cdp = await page.context().newCDPSession(page);
  await joinGame(page);
  await play(page, 3000);

  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); // мкс
  await cdp.send('HeapProfiler.enable');
  await cdp.send('Profiler.start');
  // Рахуємо ВСЕ створене, а не лише те, що дожило до кінця: саме короткоживучі об'єкти
  // і годують збирач сміття.
  await cdp.send('HeapProfiler.startSampling', {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const seconds = Math.min(SECONDS, 15);
  await play(page, seconds * 1000);
  const { profile: heap } = await cdp.send('HeapProfiler.stopSampling');
  const { profile: cpu } = await cdp.send('Profiler.stop');
  await page.close();

  // Купа: selfSize кожного вузла дерева → сума за функцією.
  const allocations = new Map();
  let allocated = 0;
  (function walk(node) {
    if (node.selfSize > 0) {
      const { functionName, url, lineNumber } = node.callFrame;
      const key = `${functionName || '(анонімна)'} — ${short(url) || '(рушій)'}:${lineNumber + 1}`;
      allocations.set(key, (allocations.get(key) ?? 0) + node.selfSize);
      allocated += node.selfSize;
    }
    node.children.forEach(walk);
  })(heap.head);

  // CPU: кількість семплів, де функція була на вершині стека.
  const total = cpu.nodes.reduce((sum, node) => sum + (node.hitCount ?? 0), 0);
  const self = new Map();
  for (const node of cpu.nodes) {
    const { functionName, url, lineNumber } = node.callFrame;
    const key = `${functionName || '(анонімна)'} — ${short(url) || '(рушій)'}${url ? ':' + (lineNumber + 1) : ''}`;
    self.set(key, (self.get(key) ?? 0) + (node.hitCount ?? 0));
  }
  const top = (map, n, scale) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([name, value]) => ({ name, value: scale(value) }));

  return {
    seconds,
    allocatedKBPerSecond: Number((allocated / 1024 / seconds).toFixed(1)),
    topAllocators: top(allocations, 6, (bytes) => `${((bytes / allocated) * 100).toFixed(1)} %`),
    topSelfTime: top(self, 10, (hits) => `${((hits / total) * 100).toFixed(1)} %`),
    cpu,
  };
}

// --- полум'яний графік із профілю CPU --------------------------------------------------------
// Ширина прямокутника — частка часу функції разом з усім, що вона викликала;
// глибина — вкладеність викликів. Простій рушія (idle) відкинуто.
function flameSvg(cpu, title) {
  const byId = new Map(cpu.nodes.map((node) => [node.id, node]));
  const totalOf = new Map();
  const total = (node) => {
    if (totalOf.has(node.id)) return totalOf.get(node.id);
    let sum = node.hitCount ?? 0;
    for (const id of node.children ?? []) sum += total(byId.get(id));
    totalOf.set(node.id, sum);
    return sum;
  };
  const root = cpu.nodes[0];
  const skip = new Set(['(idle)', '(program)', '(garbage collector)']);
  const roots = (root.children ?? [])
    .map((id) => byId.get(id))
    .filter((n) => !skip.has(n.callFrame.functionName));
  const grand = roots.reduce((sum, node) => sum + total(node), 0) || 1;

  const width = 1200;
  const row = 18;
  const rects = [];
  let maxDepth = 0;
  const palette = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#6250d6', '#e87ba4'];
  (function place(nodes, x, depth) {
    for (const node of nodes.sort((a, b) => total(b) - total(a))) {
      const w = (total(node) / grand) * width;
      if (w >= 1.5) {
        maxDepth = Math.max(maxDepth, depth);
        const name = node.callFrame.functionName || '(анонімна)';
        const file = short(node.callFrame.url);
        const color =
          palette[
            Math.abs([...file].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) % palette.length
          ];
        rects.push({ x, y: depth * row, w, name, file, share: (total(node) / grand) * 100, color });
        place(
          (node.children ?? []).map((id) => byId.get(id)),
          x,
          depth + 1,
        );
      }
      x += w;
    }
  })(roots, 0, 0);

  const height = (maxDepth + 1) * row + 40;
  const esc = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const body = rects
    .map(
      (r) =>
        `<g><title>${esc(r.name)} — ${esc(r.file)} · ${r.share.toFixed(1)} %</title>` +
        `<rect x="${r.x.toFixed(1)}" y="${r.y + 30}" width="${Math.max(0.5, r.w - 0.5).toFixed(1)}" height="${row - 1}" fill="${r.color}" fill-opacity="0.85"/>` +
        (r.w > 60
          ? `<text x="${(r.x + 3).toFixed(1)}" y="${r.y + 43}" font-size="11" fill="#ffffff" font-family="ui-monospace, Menlo, monospace">${esc(`${r.name} ${r.share.toFixed(0)}%`.slice(0, Math.floor(r.w / 6.7)))}</text>`
          : '') +
        '</g>',
    )
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="#fcfcfb"/>
<text x="4" y="18" font-size="13" font-weight="600" fill="#0b0b0b" font-family="ui-sans-serif, system-ui, sans-serif">${esc(title)}</text>
${body}
</svg>
`;
}

// Збірка без мініфікації — інакше в профілі замість імен функцій буде «Hf» і «ws».
await new Promise((done, fail) => {
  // Окремий каталог: звичайний dist у цей час може перезбирати хтось інший (наприклад, e2e).
  const build = spawn('npx', ['vite', 'build', '--outDir', 'dist-profile'], {
    cwd: join(ROOT, 'client'),
    env: { ...process.env, PROFILE: '1' },
    stdio: 'ignore',
  });
  build.on('exit', (code) => (code === 0 ? done() : fail(new Error('збірка не вдалася'))));
});

const logDir = await mkdtemp(join(tmpdir(), 'moba-perf-'));
const server = await startServer(logDir);
const browser = await chromium.launch();
try {
  const frames = await measureFrames(browser);
  const prof = await profile(browser);
  const { cpu, ...attribution } = prof;
  const round = (p) =>
    Object.fromEntries(Object.entries(p).map(([k, v]) => [k, Number(v.toFixed(2))]));
  const result = {
    label,
    seconds: SECONDS,
    bots: BOTS,
    entities: frames.entities,
    browser: browser.version(),
    frameMs: round(frames.report.frame),
    sectionsMs: Object.fromEntries(
      Object.entries(frames.report.sections).map(([k, v]) => [k, round(v)]),
    ),
    gc: {
      minor: round(frames.gc.minor),
      major: round(frames.gc.major),
      majorEvents: frames.majors,
    },
    ...attribution,
  };
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, `client-${label}.json`), JSON.stringify(result, null, 2) + '\n');
  await writeFile(
    join(OUT, `client-${label}-flame.svg`),
    flameSvg(cpu, `Профіль CPU клієнта (${label}): ${BOTS} ботів, ${prof.seconds} с, без простою`),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  server.kill('SIGTERM');
  await rm(logDir, { recursive: true, force: true });
}
