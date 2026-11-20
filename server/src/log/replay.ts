// Читання логів матчів. Файл ніколи не потрапляє в пам'ять цілком:
// і генератор подій, і HTTP-віддача працюють шматками.

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

const REPLAY_ID = /^[\w-]{1,120}$/; // жодних крапок і слешів — із id не зібрати чужий шлях

export function replayPath(dir: string, id: string): string | null {
  return REPLAY_ID.test(id) ? join(dir, `${id}.ndjson`) : null;
}

// Розрізає потік на рядки. Шматок із диска закінчується де завгодно —
// «хвіст» без \n чекає наступного шматка.
export async function* readLines(stream: Readable): AsyncGenerator<string> {
  stream.setEncoding('utf8'); // щоб багатобайтовий символ не розірвало між шматками
  let rest = '';
  for await (const chunk of stream) {
    const lines = (rest + String(chunk)).split('\n');
    rest = lines.pop() ?? ''; // split завжди дає хоч один елемент, але tsc цього не знає
    yield* lines;
  }
  if (rest) yield rest;
}

// Асинхронний генератор подій: for await (const event of readEvents(file)) { … }
// Пам'яті потрібно на один шматок файла (64 КБ), а не на весь файл.
// unknown: у файлі може бути що завгодно — хто читає, той і перевіряє форму.
export async function* readEvents(file: string): AsyncGenerator<unknown> {
  for await (const line of readLines(createReadStream(file))) {
    if (line.trim() !== '') {
      const event: unknown = JSON.parse(line);
      yield event;
    }
  }
}

export interface ReplayInfo {
  readonly id: string;
  readonly bytes: number;
  readonly modified: Date;
}

export async function listReplays(dir: string): Promise<ReplayInfo[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.ndjson'));
  const replays = await Promise.all(
    names.map(async (name) => {
      const info = await stat(join(dir, name));
      return { id: name.slice(0, -'.ndjson'.length), bytes: info.size, modified: info.mtime };
    }),
  );
  return replays.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}
