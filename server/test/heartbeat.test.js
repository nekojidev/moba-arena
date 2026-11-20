// Heartbeat на фальшивих таймерах: жодного сокета й жодного очікування.
// (Той самий сценарій на справжніх сокетах — у ws.test.js.)
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createHeartbeat } from '../src/heartbeat.ts';

const INTERVAL = 15_000;

// «Сокет»: рахує ping-и; якщо answers — відповідає pong-ом за 20 мс, як справжній клієнт.
function fakePeer(name, { answers }) {
  const peer = {
    name,
    pings: 0,
    terminated: false,
    onPong: () => {},
    ping() {
      peer.pings += 1;
      if (answers) setTimeout(() => peer.onPong(), 20);
    },
    terminate() {
      peer.terminated = true;
    },
  };
  return peer;
}

// Мінімальна «кімната сокетів»: обірваний учасник зникає зі списку, як із wss.clients.
function setup(peers, options = {}) {
  const clients = new Set(peers);
  const lost = [];
  const heartbeat = createHeartbeat({
    intervalMs: INTERVAL,
    peers: () => [...clients].filter((peer) => !peer.terminated),
    onLost: (peer) => lost.push(peer.name),
    ...options,
  });
  for (const peer of peers) peer.onPong = () => heartbeat.alive(peer);
  return { heartbeat, lost };
}

describe('heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('два пропущені pong — сокет обірвано на третьому колі; живий лишається', () => {
    const dead = fakePeer('привид', { answers: false });
    const alive = fakePeer('живий', { answers: true });
    const { heartbeat, lost } = setup([dead, alive]);
    heartbeat.start();

    vi.advanceTimersByTime(INTERVAL - 1);
    expect(dead.pings).toBe(0); // до першого кола нічого не відбувається

    vi.advanceTimersByTime(1); // коло 1: ping обом
    expect([dead.pings, alive.pings]).toEqual([1, 1]);
    expect(heartbeat.missed(dead)).toBe(1);

    vi.advanceTimersByTime(INTERVAL); // коло 2: привид мовчить удруге
    expect(heartbeat.missed(dead)).toBe(2);
    expect(dead.terminated).toBe(false);
    expect(heartbeat.missed(alive)).toBe(1); // ping щойно пішов, pong ще в дорозі
    vi.advanceTimersByTime(20);
    expect(heartbeat.missed(alive)).toBe(0);

    vi.advanceTimersByTime(INTERVAL - 20); // коло 3: два пропуски поспіль → terminate()
    expect(dead.terminated).toBe(true);
    expect(dead.pings).toBe(2); // третього ping мертвому вже не шлемо
    expect(lost).toEqual(['привид']);

    vi.advanceTimersByTime(INTERVAL * 20); // живий відповідає далі — його не чіпають
    expect(alive.terminated).toBe(false);
    expect(alive.pings).toBe(23);
    expect(lost).toEqual(['привид']);
    heartbeat.stop();
  });

  test('один пропущений pong пробачається: відповів — лічильник у нуль', () => {
    const flaky = fakePeer('нестабільний', { answers: false });
    const { heartbeat } = setup([flaky]);
    heartbeat.start();

    vi.advanceTimersByTime(INTERVAL * 2); // два кола без відповіді
    expect(heartbeat.missed(flaky)).toBe(2);
    flaky.onPong(); // відповів в останню мить
    expect(heartbeat.missed(flaky)).toBe(0);

    vi.advanceTimersByTime(INTERVAL * 2); // знову два пропуски — ще не обрив
    expect(flaky.terminated).toBe(false);
    vi.advanceTimersByTime(INTERVAL);
    expect(flaky.terminated).toBe(true);
    heartbeat.stop();
  });

  test('поріг пропусків налаштовується', () => {
    const dead = fakePeer('привид', { answers: false });
    const { heartbeat } = setup([dead], { maxMissed: 1 });
    heartbeat.start();
    vi.advanceTimersByTime(INTERVAL);
    expect(dead.terminated).toBe(false);
    vi.advanceTimersByTime(INTERVAL);
    expect(dead.terminated).toBe(true);
    heartbeat.stop();
  });

  test('учасник, що підключився пізніше, рахується від нуля', () => {
    const clients = [];
    const heartbeat = createHeartbeat({ intervalMs: INTERVAL, peers: () => clients });
    heartbeat.start();
    vi.advanceTimersByTime(INTERVAL * 5);

    const late = fakePeer('запізнілий', { answers: false });
    clients.push(late);
    vi.advanceTimersByTime(INTERVAL * 2);
    expect(late.pings).toBe(2);
    expect(late.terminated).toBe(false);
    vi.advanceTimersByTime(INTERVAL);
    expect(late.terminated).toBe(true); // onLost не задано — обрив усе одно відбувається
    heartbeat.stop();
  });

  test('stop() зупиняє перевірки; повторний start() не подвоює таймер', () => {
    const peer = fakePeer('тихий', { answers: false });
    const { heartbeat } = setup([peer]);
    heartbeat.start();
    heartbeat.start();
    vi.advanceTimersByTime(INTERVAL);
    expect(peer.pings).toBe(1); // один таймер, а не два
    expect(vi.getTimerCount()).toBe(1);

    heartbeat.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(INTERVAL * 10);
    expect(peer.pings).toBe(1);
    expect(peer.terminated).toBe(false);
    heartbeat.stop(); // двічі — не помилка
  });
});
