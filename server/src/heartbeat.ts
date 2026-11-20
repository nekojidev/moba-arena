// Heartbeat. TCP може «висіти» годинами після того, як клієнт зник (ноутбук закрили,
// Wi-Fi відпав) — події close не буде. Тому раз на intervalMs шлемо ping; хто пропустив
// maxMissed pong поспіль — того terminate().
//
// Облік винесено із ws.ts: тут немає ні сокетів, ні мережі — лише «учасник, якому можна
// надіслати ping і якого можна обірвати». Тому тест керує часом через фальшиві таймери.

export interface HeartbeatPeer {
  ping(): void;
  terminate(): void;
}

export interface HeartbeatOptions<P extends HeartbeatPeer> {
  readonly intervalMs: number;
  // Хто зараз підключений (у сервері — wss.clients). Питаємо на кожному колі заново.
  readonly peers: () => Iterable<P>;
  readonly maxMissed?: number;
  readonly onLost?: (peer: P) => void;
}

export interface Heartbeat<P extends HeartbeatPeer> {
  start(): void;
  stop(): void;
  // Учасник відповів (подія 'pong'): лічильник пропусків — у нуль.
  alive(peer: P): void;
  // Одне коло перевірки; таймер викликає його сам.
  beat(): void;
  missed(peer: P): number;
}

export function createHeartbeat<P extends HeartbeatPeer & object>({
  intervalMs,
  peers,
  maxMissed = 2,
  onLost,
}: HeartbeatOptions<P>): Heartbeat<P> {
  // WeakMap: учасник зник — його лічильник теж; чистити вручну нічого не треба.
  const misses = new WeakMap<P, number>();
  let timer: NodeJS.Timeout | null = null;

  function beat(): void {
    for (const peer of peers()) {
      const count = misses.get(peer) ?? 0;
      if (count >= maxMissed) {
        onLost?.(peer);
        peer.terminate();
        continue;
      }
      // Рахуємо пропуск наперед: pong, якщо прийде, обнулить лічильник до наступного кола.
      misses.set(peer, count + 1);
      peer.ping();
    }
  }

  return {
    start() {
      timer ??= setInterval(beat, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    alive(peer) {
      misses.set(peer, 0);
    },
    beat,
    missed: (peer) => misses.get(peer) ?? 0,
  };
}
