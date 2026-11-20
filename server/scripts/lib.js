// Спільне для дослідів: запуск сервера окремим процесом на вільному порту.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { WebSocket } from 'ws';
import { CODECS } from '@moba-arena/shared/codec/index.ts';
import { TICK_MS } from '@moba-arena/shared/protocol.ts';

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function freePort() {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  probe.close();
  await once(probe, 'close');
  return port;
}

// nodeArgs — прапорці самого Node (наприклад, --cpu-prof для профілювання).
// port — конкретний порт (щоб підняти сервер знову на тому самому після падіння).
export async function spawnServer(env = {}, { nodeArgs = [], port: fixedPort } = {}) {
  const port = fixedPort ?? (await freePort());
  const entry = resolve(import.meta.dirname, '../src/index.ts');
  const child = spawn(process.execPath, [...nodeArgs, entry], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'warn',
      // Досліди відкривають сотні сокетів з однієї адреси — типова межа їм завадила б.
      MAX_CONNECTIONS_PER_IP: '1000',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  let exitInfo = null;
  const exited = once(child, 'exit').then(([code, signal]) => (exitInfo = { code, signal }));

  const http = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      if ((await fetch(http + '/health')).ok) break;
    } catch {
      if (exitInfo) throw new Error(`сервер завершився з кодом ${exitInfo.code}:\n` + output);
      if (attempt > 100) throw new Error('сервер не стартував:\n' + output);
      await sleep(50);
    }
  }

  return {
    http,
    port,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    output: () => output,
    // Рядки логу сервера, розібрані з JSON (не-JSON рядки, як-от стек у stderr, пропускаємо).
    logs() {
      const records = [];
      for (const line of output.split('\n')) {
        if (!line.startsWith('{')) continue;
        try {
          records.push(JSON.parse(line));
        } catch {
          continue; // обірваний останній рядок
        }
      }
      return records;
    },
    // Проміс із { code, signal }, коли процес завершився (сам чи за сигналом).
    exited,
    // Штатна зупинка: SIGTERM і чекаємо коду завершення.
    async stop() {
      child.kill('SIGTERM');
      return exited;
    },
    // Сигнал без очікування (SIGKILL — «висмикнули шнур»; другий SIGTERM тощо).
    signal(name) {
      child.kill(name);
    },
    // Убити процес без жодної зупинки й дочекатися, поки він зникне.
    async kill() {
      child.kill('SIGKILL');
      return exited;
    },
  };
}

// Заскриптований гравець для дослідів під навантаженням: постійний газ, періодичні
// повороти, часта стрільба — близько до найгіршого випадку для сервера (багато снарядів).
// i — номер гравця: зсуває фазу, щоб усі не робили те саме одночасно.
export function scriptedButtons(step, i = 0) {
  const phase = Math.floor((step + i * 37) / 45) % 4;
  return {
    turn: phase === 0 ? 1 : phase === 2 ? -1 : 0,
    thrust: 1,
    brake: false,
    dash: (step + i * 11) % 150 === 0,
    fire: (step + i) % 3 !== 0,
  };
}

// Безголовий клієнт: заходить у кімнату й шле бінарний input 30 разів/с. Знімки не
// розбирає — лише рахує кадри й байти (так генератор навантаження сам не стає вузьким місцем).
// offsetMs розводить клієнтів у часі: справжні гравці не шлють input усі в ту саму мілісекунду.
export async function startPlayer(wsUrl, { room = 'mid', name, index = 0, offsetMs = 0 }) {
  const socket = new WebSocket(wsUrl);
  const stats = { frames: 0, bytes: 0, sent: 0, closeCode: null };
  let timer = null;
  let step = 0;

  const welcomed = new Promise((done, fail) => {
    socket.on('error', fail);
    socket.on('close', (code) => {
      stats.closeCode = code;
      clearTimeout(timer);
      fail(new Error(`сокет ${name} закрито з кодом ${code}`));
    });
    socket.on('message', (data, isBinary) => {
      stats.frames += 1;
      stats.bytes += data.length;
      if (!isBinary && data.toString().includes('"type":"welcome"')) done();
    });
  });
  welcomed.catch(() => {}); // закриття після welcome — не «необроблене відхилення»
  await once(socket, 'open');
  socket.send(JSON.stringify({ v: 1, type: 'join', room, name }));
  await welcomed;

  // Абсолютний цільовий час, як у серверному таймері: рівно 30 input/с без дрейфу.
  const startAt = performance.now() + offsetMs;
  function loop() {
    while (performance.now() >= startAt + step * TICK_MS) {
      step += 1;
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(CODECS.binary.encodeInput({ seq: step, ...scriptedButtons(step, index) }));
      stats.sent += 1;
    }
    timer = setTimeout(loop, Math.max(0, startAt + step * TICK_MS - performance.now()));
  }
  timer = setTimeout(loop, offsetMs);

  return {
    stats,
    close() {
      clearTimeout(timer);
      socket.close();
    },
  };
}
