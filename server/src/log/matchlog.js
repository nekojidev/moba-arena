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

// На вхід — об'єкти (writableObjectMode), на вихід — байти: один JSON на рядок.
export function ndjsonTransform() {
  return new Transform({
    writableObjectMode: true,
    transform(item, _encoding, callback) {
      // events.on() видає масив аргументів події: [event].
      const event = Array.isArray(item) ? item[0] : item;
      try {
        callback(null, JSON.stringify(event) + '\n');
      } catch (error) {
        callback(error); // помилка піде в pipeline, а не в повітря
      }
    },
  });
}

let sequence = 0;

export function openMatchLog(room, { dir }) {
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
  #active = new Map(); // id кімнати → { id, file, done }

  constructor({ dir, rooms, logger }) {
    this.dir = dir;
    this.logger = logger;
    rooms.list().forEach((room) => this.#wire(room));
    rooms.on('created', (room) => this.#wire(room));
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
  }

  #wire(room) {
    room.on('start', () => {
      const log = openMatchLog(room, { dir: this.dir });
      this.#active.set(room.id, log);
      this.logger.info('match log opened', { room: room.id, file: log.file });
      log.done
        .then(() => this.logger.info('match log closed', { room: room.id, file: log.file }))
        .catch((error) =>
          this.logger.error('match log failed', { room: room.id, error: error.message }),
        )
        .finally(() => {
          if (this.#active.get(room.id) === log) this.#active.delete(room.id);
        });
    });
  }

  get activeCount() {
    return this.#active.size;
  }

  // Зупинка сервера: просимо всі відкриті логи завершитись і чекаємо, поки вони допишуться.
  async closeAll(rooms) {
    const pending = [...this.#active.values()].map((log) => log.done.catch(() => {}));
    for (const room of rooms.list()) room.emit('shutdown');
    await Promise.all(pending);
  }
}
