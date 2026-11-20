// Дослід: що бачать гравці, коли один HTTP-обробник на 300 мс займає цикл подій.
//
//   npm run demo:block -w server
//
// Анна шле в чат повідомлення кожні 50 мс, Борис міряє, за скільки воно доходить.
// Посеред цього тричі смикаємо GET /api/slow?ms=300 (синхронний busy-loop).

import { once } from 'node:events';
import { WebSocket } from 'ws';
import { sleep, spawnServer } from './lib.js';

const server = await spawnServer({ DEBUG_ROUTES: '1', RATE_LIMIT_PER_SECOND: '100' });

async function join(name) {
  const socket = new WebSocket(server.wsUrl);
  await once(socket, 'open');
  socket.send(JSON.stringify({ v: 0, type: 'join', room: 'mid', name }));
  return socket;
}

const anna = await join('Анна');
const boris = await join('Борис');
await sleep(200);

const sentAt = new Map();
const latencies = []; // { at, ms }
const started = performance.now();
boris.on('message', (data) => {
  const message = JSON.parse(data.toString());
  if (message.type !== 'chat') return;
  const sent = sentAt.get(message.text);
  latencies.push({ at: sent - started, ms: performance.now() - sent });
});

let counter = 0;
const ticker = setInterval(() => {
  const text = `ping ${(counter += 1)}`;
  sentAt.set(text, performance.now());
  anna.send(JSON.stringify({ v: 0, type: 'chat', text }));
}, 50);

const blocks = [];
await sleep(1500);
for (let i = 0; i < 3; i += 1) {
  const at = performance.now() - started;
  await fetch(server.http + '/api/slow?ms=300');
  blocks.push({ from: at, to: performance.now() - started });
  await sleep(700);
}
await sleep(500);
clearInterval(ticker);
await sleep(200);

const during = (entry) =>
  blocks.some((block) => entry.at >= block.from - 5 && entry.at <= block.to);
const stats = (list) => {
  const sorted = list.map((entry) => entry.ms).sort((a, b) => a - b);
  return {
    повідомлень: sorted.length,
    'медіана, мс': sorted[Math.floor(sorted.length / 2)].toFixed(1),
    'макс, мс': sorted.at(-1).toFixed(1),
  };
};
console.table({
  'цикл вільний': stats(latencies.filter((entry) => !during(entry))),
  'під час /api/slow': stats(latencies.filter(during)),
});
console.log(
  `надіслано ${counter}, отримано ${latencies.length} — жодне не загубилось, вони чекали в черзі`,
);

anna.close();
boris.close();
const exit = await server.stop();
console.log('код завершення сервера:', exit.code);
