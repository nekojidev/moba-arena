// Підсумок логу матчу: файл читається потоком, подія за подією.
//   npm run replay -w server -- logs/<id>.ndjson
import { readEvents } from '../src/log/replay.js';

const file = process.argv[2];
if (!file) {
  console.error('Використання: node scripts/replay.js <файл.ndjson>');
  process.exit(1);
}

const counts = {};
let first = null;
let last = null;
for await (const event of readEvents(file)) {
  counts[event.type] = (counts[event.type] ?? 0) + 1;
  first ??= event.t;
  last = event.t;
  if (event.type === 'chat') console.log(`${event.from.name}: ${event.text}`);
}
console.log(counts, `тривалість ${(((last ?? 0) - (first ?? 0)) / 1000).toFixed(1)} с`);
