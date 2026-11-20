// CPU-профіль сервера під час матчу: куди насправді йде час кроку.
//
//   npm run profile -w server                      # 60 с, 1 клієнт + 16 ботів
//   npm run profile -w server -- 60 64 0           # 60 с, 64 клієнти, без ботів
//   COLLISION=naive npm run profile -w server      # із наївною системою зіткнень
//
// Сервер стартує окремим процесом із `node --cpu-prof`; профіль V8 записує сам під час
// штатного завершення (SIGTERM). Далі читаємо .cpuprofile і рахуємо ВЛАСНИЙ час функцій:
// скільки семплів припало саме на тіло функції, без того, що вона викликала.

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TICK_MS } from '@moba-arena/shared/protocol.ts';
import { sleep, spawnServer, startPlayer } from './lib.js';

const SECONDS = Number(process.argv[2] ?? 60);
const CLIENTS = Number(process.argv[3] ?? 1);
const BOTS = Number(process.argv[4] ?? 16);
const TOP = 12;
const ROOT = resolve(import.meta.dirname, '../..');

function location(callFrame) {
  const { url, lineNumber } = callFrame;
  if (!url) return '(V8 / вбудоване)';
  if (url.startsWith('node:')) return url;
  const path = url.startsWith('file:') ? relative(ROOT, fileURLToPath(url)) : url;
  return `${path.replace(/^.*node_modules\//, 'node_modules/')}:${lineNumber + 1}`;
}

const keyOf = ({ callFrame }) =>
  `${callFrame.functionName || '(анонімна)'}\t${location(callFrame)}`;

// Власний час вузла = сума проміжків між семплами, що припали на цей вузол.
// Сукупний (inclusive) = власний + усіх, кого вузол викликав; для функції беремо лише
// «верхні» її вузли, щоб рекурсія не порахувалась двічі.
function times(profile) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const selfById = new Map();
  let total = 0;
  for (const [i, id] of profile.samples.entries()) {
    const delta = profile.timeDeltas[i] ?? 0;
    total += delta;
    selfById.set(id, (selfById.get(id) ?? 0) + delta);
  }
  const self = new Map();
  const inclusive = new Map();
  function visit(node, open) {
    const key = keyOf(node);
    const own = selfById.get(node.id) ?? 0;
    self.set(key, (self.get(key) ?? 0) + own);
    const nested = open.has(key);
    if (!nested) open.add(key);
    let sum = own;
    for (const childId of node.children ?? []) sum += visit(byId.get(childId), open);
    if (!nested) {
      open.delete(key);
      inclusive.set(key, (inclusive.get(key) ?? 0) + sum);
    }
    return sum;
  }
  visit(profile.nodes[0], new Set());
  return { self, inclusive, total };
}

const profDir = await mkdtemp(join(tmpdir(), 'moba-prof-'));
try {
  const server = await spawnServer(
    { MAX_PLAYERS_PER_ROOM: '256', COLLISION: process.env.COLLISION ?? '' },
    { nodeArgs: ['--cpu-prof', `--cpu-prof-dir=${profDir}`] },
  );
  const players = [];
  for (let i = 0; i < CLIENTS; i += 1) {
    players.push(
      await startPlayer(server.wsUrl, {
        name: `Гравець ${i}`,
        index: i,
        offsetMs: (i * TICK_MS) / CLIENTS,
      }),
    );
  }
  let bots = 0;
  if (BOTS > 0) {
    const response = await fetch(`${server.http}/api/rooms/mid/bots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ count: BOTS }),
    });
    ({ bots } = await response.json());
  }
  console.log(`Матч: ${CLIENTS} клієнт(ів) + ${bots} бот(ів), ${SECONDS} с…`);
  await sleep(SECONDS * 1000);

  const window = Math.min(1800, Math.round((SECONDS * 1000) / TICK_MS));
  const stats = await (await fetch(`${server.http}/api/stats?window=${window}`)).json();
  const [match] = stats.matches;
  for (const player of players) player.close();
  const exit = await server.stop();

  const [file] = (await readdir(profDir)).filter((name) => name.endsWith('.cpuprofile'));
  if (!file) throw new Error(`профіль не записано (код завершення ${exit.code})`);
  const profile = JSON.parse(await readFile(join(profDir, file), 'utf8'));
  const { self: micros, inclusive, total } = times(profile);
  const idle = micros.get('(idle)\t(V8 / вбудоване)') ?? 0;
  const busy = total - idle;

  const { tickDurationMs: d, tickLatenessMs: l } = match;
  console.log(
    `\nКрок (останні ${match.window}): сер. ${d.avg} мс, p50 ${d.p50}, p99 ${d.p99}, макс. ${d.max}; ` +
      `запізнення сер. ${l.avg}, p99 ${l.p99}, макс. ${l.max} мс`,
  );
  console.log(
    `Сутностей ${match.entities}, знімків ${match.snapshots}, байтів ${match.bytesOut}, ` +
      `пропущених кроків ${match.overruns}; збирач сміття: ${stats.process.gc.count} пауз, ` +
      `${stats.process.gc.totalMs.toFixed(1)} мс разом, найдовша ${stats.process.gc.maxMs.toFixed(2)} мс`,
  );
  console.log(
    `Профіль: ${(total / 1e6).toFixed(1)} с, з них (idle) ${((idle / total) * 100).toFixed(1)}% — ` +
      `процесор зайнятий ${((busy / total) * 100).toFixed(1)}% часу\n`,
  );
  console.log(' % усього | % зайнятого |    мс | функція — файл');
  console.log('----------+-------------+-------+----------------');
  const top = [...micros.entries()]
    .filter(([key]) => !key.startsWith('(idle)'))
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP);
  for (const [key, time] of top) {
    const [name, where] = key.split('\t');
    console.log(
      `${((time / total) * 100).toFixed(2).padStart(8)}% | ${((time / busy) * 100).toFixed(2).padStart(10)}% | ` +
        `${(time / 1000).toFixed(0).padStart(5)} | ${name} — ${where}`,
    );
  }

  // Сукупний час функцій нашого коду: видно, яка ЧАСТИНА кроку дорога (світ чи розсилка).
  console.log('\nСукупний час (разом із викликаними), лише код проєкту:');
  console.log(' % зайнятого |    мс | функція — файл');
  console.log('-------------+-------+----------------');
  const ours = [...inclusive.entries()]
    .filter(([key]) => /\t(server|shared)\//.test(key))
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP);
  for (const [key, time] of ours) {
    const [name, where] = key.split('\t');
    console.log(
      `${((time / busy) * 100).toFixed(2).padStart(11)}% | ${(time / 1000).toFixed(0).padStart(5)} | ${name} — ${where}`,
    );
  }
} finally {
  await rm(profDir, { recursive: true, force: true });
}
