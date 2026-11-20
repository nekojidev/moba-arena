// Межі модулів: симуляція не імпортує нічого поза src/sim — ні звуку, ні HUD, ні рендера.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

test('src/sim імпортує лише сусідів із src/sim', () => {
  const dir = new URL('../src/sim/', import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith('.js'));
  assert.ok(files.length > 10);
  for (const file of files) {
    const source = readFileSync(new URL(file, dir), 'utf8');
    for (const [, specifier] of source.matchAll(/from\s+'([^']+)'/g)) {
      assert.match(specifier, /^\.\/[\w-]+\.js$/, `${file} імпортує ${specifier}`);
    }
  }
});
