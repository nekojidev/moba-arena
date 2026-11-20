// Відбиток стану світу: одне число, яке збігається лише тоді, коли збігається все.
// Потрібен, щоб довести детермінізм: однакові input у Node і в браузері → однаковий хеш.

const buffer = new DataView(new ArrayBuffer(8));

function mix(hash, value) {
  // FNV-1a по байтах float64: порівнюємо числа біт у біт, без округлень.
  buffer.setFloat64(0, value);
  for (let i = 0; i < 8; i += 1) {
    hash ^= buffer.getUint8(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash;
}

export function hashWorld(world) {
  let hash = 2166136261;
  hash = mix(hash, world.tick);
  for (const entity of world) {
    if (!entity.alive) continue;
    hash = mix(hash, entity.kind.length);
    for (const value of [entity.pos.x, entity.pos.y, entity.vel.x, entity.vel.y, entity.angle]) {
      hash = mix(hash, value);
    }
    if (entity.kind === 'ship') hash = mix(hash, entity.hp);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
