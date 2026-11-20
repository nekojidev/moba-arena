// Читання логів матчів. Файл ніколи не потрапляє в пам'ять цілком:
// і генератор подій, і HTTP-віддача працюють шматками.

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const REPLAY_ID = /^[\w-]{1,120}$/; // жодних крапок і слешів — із id не зібрати чужий шлях

export function replayPath(dir, id) {
  return REPLAY_ID.test(id) ? join(dir, `${id}.ndjson`) : null;
}

// Розрізає потік на рядки. Шматок із диска закінчується де завгодно —
// «хвіст» без \n чекає наступного шматка.
export async function* readLines(stream) {
  stream.setEncoding('utf8'); // щоб багатобайтовий символ не розірвало між шматками
  let rest = '';
  for await (const chunk of stream) {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop();
    yield* lines;
  }
  if (rest) yield rest;
}

// Асинхронний генератор подій: for await (const event of readEvents(file)) { … }
// Пам'яті потрібно на один шматок файла (64 КБ), а не на весь файл.
export async function* readEvents(file) {
  for await (const line of readLines(createReadStream(file))) {
    if (line.trim() !== '') yield JSON.parse(line);
  }
}

export async function listReplays(dir) {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.ndjson'));
  const replays = await Promise.all(
    names.map(async (name) => {
      const info = await stat(join(dir, name));
      return { id: name.slice(0, -'.ndjson'.length), bytes: info.size, modified: info.mtime };
    }),
  );
  return replays.sort((a, b) => b.modified - a.modified);
}
