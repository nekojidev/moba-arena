// Лог матчу як потік: події кімнати → Transform (об'єкт → рядок NDJSON) → файл.
//
// pipeline з'єднує потоки й бере на себе дві речі, які легко зробити неправильно вручну:
//  • backpressure — якщо диск не встигає, Transform і джерело призупиняються;
//  • прибирання — помилка в будь-якій ланці закриває всі інші (файл не лишається відкритим).

import { on } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Logger } from '../logger.ts';
import type { Room, RoomManager } from '../rooms.ts';

// На вхід — об'єкти (writableObjectMode), на вихід — байти: один JSON на рядок.
export function ndjsonTransform(): Transform {
  return new Transform({
    writableObjectMode: true,
    transform(item: unknown, _encoding, callback) {
      // events.on() видає масив аргументів події: [event].
      const event: unknown = Array.isArray(item) ? item[0] : item;
      try {
        callback(null, JSON.stringify(event) + '\n');
      } catch (error) {
        // помилка піде в pipeline, а не в повітря
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
}

let sequence = 0;

export interface MatchLog {
  readonly id: string;
  readonly file: string;
  readonly done: Promise<void>;
}

export function openMatchLog(room: Room, { dir }: { dir: string }): MatchLog {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  const id = `${room.id}-${stamp}-${(sequence += 1)}`;
  const file = join(dir, `${id}.ndjson`);

  // events.on() перетворює події на асинхронний ітератор. Слухач вішається одразу,
  // тож жодна подія не губиться; 'empty' і 'shutdown' завершують ітерацію — і потік
  // закривається штатно, дописавши все у файл.
  const events = on(room, 'event', { close: ['empty', 'shutdown'] });
  const done = pipeline(Readable.from(events), ndjsonTransform(), createWriteStream(file));

  return { id, file, done };
}

// Веде лог для кожного «матчу»: від входу першого гравця до виходу останнього.
export class MatchLogs {
  #active = new Map<string, MatchLog>(); // id кімнати → { id, file, done }

  readonly dir: string;
  readonly logger: Logger;

  constructor({ dir, rooms, logger }: { dir: string; rooms: RoomManager; logger: Logger }) {
    this.dir = dir;
    this.logger = logger;
    rooms.list().forEach((room) => this.#wire(room));
    rooms.on('created', (room) => this.#wire(room));
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  #wire(room: Room): void {
    room.on('start', () => {
      const log = openMatchLog(room, { dir: this.dir });
      this.#active.set(room.id, log);
      this.logger.info('match log opened', { room: room.id, file: log.file });
      log.done
        .then(() => this.logger.info('match log closed', { room: room.id, file: log.file }))
        .catch((error: unknown) =>
          this.logger.error('match log failed', {
            room: room.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        )
        .finally(() => {
          if (this.#active.get(room.id) === log) this.#active.delete(room.id);
        });
    });
  }

  get activeCount(): number {
    return this.#active.size;
  }

  // Зупинка сервера: просимо всі відкриті логи завершитись і чекаємо, поки вони допишуться.
  async closeAll(rooms: RoomManager): Promise<void> {
    const pending = [...this.#active.values()].map((log) => log.done.catch(() => {}));
    for (const room of rooms.list()) room.emit('shutdown');
    await Promise.all(pending);
  }
}
