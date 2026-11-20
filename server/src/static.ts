// Віддача зібраного клієнта (client/dist) з правильними MIME-типами.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

// Record<string, string>: розширення — довільний рядок, тож MIME[ext] — це «рядок або
// undefined» (noUncheckedIndexedAccess), і забути про невідоме розширення tsc не дасть.
const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// Перетворює шлях із URL на шлях у каталозі root — або null, якщо шлях підозрілий.
// Два незалежні бар'єри: (1) будь-який сегмент ".." — одразу відмова, навіть закодований
// як %2e%2e; (2) після resolve() шлях мусить лишитися всередині root.
export function resolveStaticPath(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // зламане %-кодування
  }
  if (decoded.includes('\0')) return null;
  if (decoded.split(/[\\/]/).includes('..')) return null;

  const full = resolve(root, '.' + (decoded.startsWith('/') ? decoded : '/' + decoded));
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

// Повертає true, якщо відповідь надіслано.
export async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
): Promise<boolean> {
  // Беремо «сирий» шлях: new URL() мовчки згорнув би /a/../b, і ми б не побачили спроби.
  const rawPath = (request.url ?? '/').split('?')[0] ?? '/';
  let file = resolveStaticPath(root, rawPath);
  if (file === null) {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Bad path');
    return true;
  }

  let info;
  try {
    info = await stat(file);
    if (info.isDirectory()) {
      file = resolve(file, 'index.html');
      info = await stat(file);
    }
  } catch {
    return false; // немає такого файла — нехай викликач відповість 404
  }

  response.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-cache',
  });
  if (request.method === 'HEAD') {
    response.end();
    return true;
  }
  // Файл іде в сокет потоком: пам'ять не залежить від розміру файла.
  await pipeline(createReadStream(file), response);
  return true;
}
