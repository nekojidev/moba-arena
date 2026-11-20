// Межі пакета shared: той самий код має виконуватись і в браузері, і в Node.
// Отже — жодних модулів Node, жодного DOM і жодних імпортів назовні.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    return entry.isDirectory() ? sources(url) : entry.name.endsWith('.ts') ? [url] : [];
  });
}

const files = sources(new URL('../src/', import.meta.url));

test('shared імпортує лише власні файли (відносні шляхи) і zod', () => {
  assert.ok(files.length > 20);
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const [, specifier] of source.matchAll(/from\s+'([^']+)'/g)) {
      // Єдина зовнішня залежність — zod (схеми протоколу); він працює і в браузері, і в Node.
      if (specifier === 'zod') continue;
      assert.match(specifier, /^\.\.?\/[\w/.-]+\.ts$/, `${file.pathname} імпортує ${specifier}`);
    }
  }
});

test('shared не торкається DOM і глобалів Node', () => {
  const banned = /\b(window|document|navigator|localStorage|process|Buffer|require)\b\s*[.([]/;
  for (const file of files) {
    const code = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    assert.doesNotMatch(code, banned, file.pathname);
  }
});

test('увесь пакет завантажується в Node без браузера', async () => {
  for (const file of files) await import(file.href);
});
