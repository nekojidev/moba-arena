// Генерує PNG-іконки застосунку (PWA) з одного SVG.
//
//   node client/scripts/make-icons.mjs
//
// Джерело — public/icons/icon.svg. Растеризує його Chromium із Playwright (він уже є
// в devDependencies для e2e), тож окрема бібліотека для картинок не потрібна.
// PNG лежать у репозиторії: збірці й образу браузер для цього не потрібен.
// Після зміни малюнка запустіть скрипт знову й закомітьте нові PNG.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ICONS_DIR = resolve(import.meta.dirname, '../public/icons');
const BACKGROUND = '#0b100d'; // той самий колір, що background_color у маніфесті

// scale — частка сторони, яку займає малюнок. Для maskable система сама обрізає іконку
// колом чи «краплею», і гарантовано видно лише центральне коло діаметром 80% —
// тому малюнок зменшено, а тло залито до країв.
// background: null — прозорі кути (звичайна іконка із заокругленим квадратом).
const ICONS = [
  { file: 'icon-192.png', size: 192, scale: 1, background: null },
  { file: 'icon-512.png', size: 512, scale: 1, background: null },
  { file: 'icon-maskable-512.png', size: 512, scale: 0.74, background: BACKGROUND },
  // iOS прозорість замінює чорним і сам заокруглює кути — даємо суцільне тло.
  { file: 'apple-touch-icon.png', size: 180, scale: 1, background: BACKGROUND },
];

const svg = readFileSync(resolve(ICONS_DIR, 'icon.svg'));
const source = `data:image/svg+xml;base64,${svg.toString('base64')}`;

function page({ size, scale, background }) {
  const side = Math.round(size * scale);
  return `<!doctype html>
<style>
  html, body { margin: 0; width: ${size}px; height: ${size}px; background: ${background ?? 'transparent'}; }
  body { display: grid; place-items: center; }
  img { width: ${side}px; height: ${side}px; display: block; }
</style>
<img src="${source}" alt="">`;
}

const browser = await chromium.launch();
try {
  for (const icon of ICONS) {
    const context = await browser.newContext({
      viewport: { width: icon.size, height: icon.size },
      deviceScaleFactor: 1,
    });
    const tab = await context.newPage();
    await tab.setContent(page(icon), { waitUntil: 'load' });
    await tab.screenshot({
      path: resolve(ICONS_DIR, icon.file),
      omitBackground: icon.background === null,
    });
    await context.close();
    console.log(`${icon.file}: ${icon.size}×${icon.size}`);
  }
} finally {
  await browser.close();
}
