import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { startApp } from './helpers.js';

let ctx;
beforeAll(async () => {
  ctx = await startApp({ MAX_ROOMS: '5', MAX_BODY_BYTES: '256' });
  await mkdir(join(ctx.config.clientDist, 'assets'), { recursive: true });
  await writeFile(join(ctx.config.clientDist, 'index.html'), '<!doctype html><title>arena</title>');
  await writeFile(join(ctx.config.clientDist, 'assets', 'main.js'), 'console.log(1)');
  await writeFile(join(ctx.dir, 'secret.txt'), 'top secret');
});
afterAll(() => ctx.stop());

// fetch нормалізує /../ ще до відправки, тому «сирі» шляхи шлемо через node:http.
function raw(path, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(ctx.http);
    // Шлях передаємо окремим полем: рядок-URL Node теж нормалізував би.
    const req = request({ hostname, port, path, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const post = (body, headers = { 'content-type': 'application/json' }) =>
  fetch(ctx.http + '/api/rooms', { method: 'POST', headers, body });

test('GET /health', async () => {
  const response = await fetch(ctx.http + '/health');
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.rooms, 3);
  assert.ok(body.rss > 0);
});

test('статика: index.html, MIME-типи, HEAD, 404', async () => {
  const index = await raw('/');
  assert.equal(index.status, 200);
  assert.match(index.headers['content-type'], /^text\/html/);
  assert.match(index.body, /arena/);

  const script = await raw('/assets/main.js');
  assert.match(script.headers['content-type'], /^text\/javascript/);
  assert.equal(script.headers['content-length'], '14');

  const head = await raw('/assets/main.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');

  assert.equal((await raw('/nope.png')).status, 404);
  assert.equal((await raw('/api/nope')).status, 404);
  assert.equal((await raw('/', { method: 'DELETE' })).status, 405);
});

test('статика: обхід каталогу відхиляється', async () => {
  for (const path of ['/../secret.txt', '/assets/../../secret.txt', '/%2e%2e/secret.txt']) {
    const response = await raw(path);
    assert.equal(response.status, 400, path);
    assert.doesNotMatch(response.body, /top secret/);
  }
});

test('GET /api/rooms: постійні кімнати', async () => {
  const { rooms } = await (await fetch(ctx.http + '/api/rooms')).json();
  assert.deepEqual(
    rooms.map((room) => room.id),
    ['mid', 'river', 'quarry'],
  );
  assert.deepEqual(Object.keys(rooms[0]), ['id', 'name', 'players', 'maxPlayers', 'arena']);
});

test('POST /api/rooms: створення, перевірка, ліміти', async () => {
  const created = await post(JSON.stringify({ name: 'Моя кімната', arena: { width: 1000 } }));
  assert.equal(created.status, 201);
  const { room } = await created.json();
  assert.equal(room.name, 'Моя кімната');
  assert.equal(room.arena.width, 1000);
  assert.equal(room.arena.height, 900, 'решта полів — типові');
  assert.ok(ctx.app.rooms.get(room.id));

  for (const [body, status] of [
    ['{ not json', 400],
    ['[]', 400],
    [JSON.stringify({ name: 'x' }), 400],
    [JSON.stringify({ name: 'Ок', arena: { width: 10 } }), 400],
    [JSON.stringify({ name: 'Ок', arena: { asteroids: 1.5 } }), 400],
    [JSON.stringify({ name: 'Ок', pad: 'x'.repeat(400) }), 413],
  ]) {
    const response = await post(body);
    assert.equal(response.status, status, body.slice(0, 40));
    assert.ok((await response.json()).error);
  }

  assert.equal((await post(JSON.stringify({ name: 'Ще одна' }))).status, 201);
  const overLimit = await post(JSON.stringify({ name: 'Шоста' }));
  assert.equal(overLimit.status, 409, 'MAX_ROOMS=5');
});
