// Матч: єдине місце, де рахується світ. Клієнти надсилають лише input (газ, поворот,
// постріл); координат від них сервер не приймає взагалі — тож «телепортуватися»
// чи пришвидшитись, підправивши клієнт, неможливо.

import { EventEmitter } from 'node:events';
import { isHoming } from '@moba-arena/shared/sim/behaviors.js';
import { botCommand } from '@moba-arena/shared/sim/bot.js';
import { createDirector } from '@moba-arena/shared/sim/game.js';
import { Ship } from '@moba-arena/shared/sim/ship.js';
import { World } from '@moba-arena/shared/sim/world.js';
import { DT, TICK_MS } from '@moba-arena/shared/protocol.js';

const MAX_QUEUE = 30; // input у черзі одного гравця (1 с); понад це — найстаріші викидаємо
const MAX_BURST = 6; // скільки input гравця можна обробити за один крок сервера
const MAX_CATCH_UP = 5; // скільки пропущених кроків наздоганяємо за раз
const STATS_WINDOW = 300; // кроків (10 с)

const FORWARDED_EVENTS = ['fired', 'hit', 'exploded', 'pickup', 'respawned'];

export class Match extends EventEmitter {
  #timer = null;
  #nextTickAt = 0;
  #events = [];
  #durations = [];
  #lateness = [];

  constructor({ room, logger }) {
    super();
    this.room = room;
    this.logger = logger;
    const { width, height, asteroids, pickups, seed } = room.arena;
    // Випадковість — лише з генератора світу, а його seed задає сервер.
    this.world = new World({ arena: { width, height }, seed, cosmetics: false });
    this.director = createDirector(this.world, { asteroids, pickups });
    this.players = new Map(); // id гравця → { id, ship, queue, ack, lastSeq, budget, codec, send }
    this.bot = null;
    this.stats = { overruns: 0, droppedInputs: 0, snapshots: 0, bytesOut: 0 };

    for (const type of FORWARDED_EVENTS) {
      this.world.events.addEventListener(type, (event) => {
        this.#events.push({ type, ...event.detail });
      });
    }
  }

  // --- гравці ------------------------------------------------------------------------------

  addPlayer(player) {
    const ship = this.world.spawn(
      new Ship({ pos: this.world.findSafeSpot(16), team: 'green', name: player.name }),
    );
    player.shipId = ship.id; // потрапить у roster: клієнти підпишуть героїв іменами
    this.players.set(player.id, {
      id: player.id,
      ship,
      queue: [],
      ack: 0,
      lastSeq: 0,
      budget: MAX_BURST,
      processed: 0,
      codec: null,
      send: null,
    });
    this.#syncBot();
    return ship;
  }

  // Викликає мережевий шар, коли знає, яким кодеком і через що слати цьому гравцеві.
  attach(playerId, { codec, send }) {
    const player = this.players.get(playerId);
    if (player) Object.assign(player, { codec, send });
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;
    this.world.despawn(player.ship.id);
    this.players.delete(playerId);
    this.#syncBot();
  }

  // Самотньому гравцеві складає компанію бот; щойно людей двоє — бот іде.
  #syncBot() {
    if (this.players.size === 1 && !this.bot) {
      this.bot = this.world.spawn(
        new Ship({ pos: this.world.findSafeSpot(16), team: 'red', name: 'Бот' }),
      );
    } else if (this.players.size !== 1 && this.bot) {
      this.world.despawn(this.bot.id);
      this.bot = null;
    }
  }

  // Input уже пройшов перевірку форми в кодеку. Тут — перевірка порядку й ліміт черги.
  pushInput(playerId, input) {
    const player = this.players.get(playerId);
    if (!player) return false;
    if (input.seq <= player.lastSeq) return false; // дублікат або застарілий — ігноруємо
    player.lastSeq = input.seq;
    player.queue.push(input);
    if (player.queue.length > MAX_QUEUE) {
      player.queue.shift();
      this.stats.droppedInputs += 1;
    }
    return true;
  }

  // --- крок --------------------------------------------------------------------------------

  tick() {
    const inputs = new Map();
    for (const player of this.players.values()) {
      // Бюджет: +1 input за крок, із запасом MAX_BURST на нерівну мережу. У середньому сервер
      // обробляє не більше одного input гравця за крок — надіславши 300 input/с, герой
      // не полетить удесятеро швидше.
      player.budget = Math.min(MAX_BURST, player.budget + 1);
      const commands = [];
      while (player.queue.length > 0 && player.budget >= 1) {
        const input = player.queue.shift();
        commands.push(input);
        player.ack = input.seq;
        player.budget -= 1;
        player.processed += 1;
      }
      // Порожній масив — input не прийшов: герой цього кроку не рухається (див. Ship.update).
      inputs.set(player.ship.id, commands);
    }
    if (this.bot) inputs.set(this.bot.id, botCommand(this.bot, this.world));

    this.director.tick(DT);
    this.world.step(DT, inputs);
    this.#broadcast();
  }

  #entities() {
    const entities = [];
    for (const entity of this.world) {
      if (!entity.alive) continue;
      const base = {
        id: entity.id,
        kind: entity.kind,
        x: entity.pos.x,
        y: entity.pos.y,
        angle: entity.angle,
      };
      if (entity.kind === 'ship') {
        entities.push({
          ...base,
          hp: entity.hp,
          score: this.world.score.get(entity.id) ?? 0,
          down: entity.isDown,
          shield: entity.hasEffect('shield'),
          thrust: entity.thrust > 0,
        });
      } else if (entity.kind === 'bullet') {
        entities.push({ ...base, owner: entity.ownerId, homing: isHoming(entity) });
      } else if (entity.kind === 'asteroid') {
        entities.push({ ...base, size: entity.size, homing: isHoming(entity) });
      } else if (entity.kind === 'pickup') {
        entities.push({ ...base, effect: entity.effect.type });
      }
    }
    return entities;
  }

  #broadcast() {
    const entities = this.#entities();
    const events = this.#events.splice(0);
    const eventsMessage =
      events.length > 0
        ? JSON.stringify({ v: 1, type: 'events', tick: this.world.tick, events })
        : null;

    for (const player of this.players.values()) {
      if (!player.send) continue;
      const { ship } = player;
      // Знімок персональний: ack і точний стан власного героя — у кожного свої.
      const snapshot = {
        tick: this.world.tick,
        ack: player.ack,
        self: {
          ...ship.motionState(),
          down: ship.isDown,
          shield: ship.hasEffect('shield'),
          homing: ship.hasEffect('homing'),
          hp: ship.hp,
          respawnTimer: Math.max(0, ship.respawnTimer),
        },
        entities,
      };
      const data = player.codec.encodeSnapshot(snapshot);
      // Знімок — некритичний: повільному клієнту його не шлемо, наступний усе одно новіший.
      if (player.send(data, { critical: false })) {
        this.stats.snapshots += 1;
        this.stats.bytesOut += data.length;
      }
      if (eventsMessage) player.send(eventsMessage, { critical: true });
    }
  }

  // --- таймер ------------------------------------------------------------------------------
  //
  // Не setInterval: він планує «через 33 мс після того, як дійде черга», тож кожне запізнення
  // накопичується, і 30 кроків/с перетворюються на 29 з хвостиком. Тут кожен крок має
  // АБСОЛЮТНИЙ цільовий час: tickN = start + N·TICK_MS. Запізнились на 4 мс — наступний
  // setTimeout буде на 4 мс коротший, і середній темп лишається рівно 30.

  start() {
    if (this.#timer) return;
    this.#nextTickAt = performance.now() + TICK_MS;
    this.#timer = setTimeout(() => this.#loop(), TICK_MS);
  }

  #loop() {
    let steps = 0;
    while (performance.now() >= this.#nextTickAt && steps < MAX_CATCH_UP) {
      const started = performance.now();
      this.#record(this.#lateness, started - this.#nextTickAt);
      this.tick();
      this.#record(this.#durations, performance.now() - started);
      this.#nextTickAt += TICK_MS;
      steps += 1;
    }
    // Крок тривав довше за бюджет і ми безнадійно відстали (цикл подій був зайнятий):
    // не намагаємось відіграти все — пропускаємо й рахуємо далі від «зараз».
    if (performance.now() - this.#nextTickAt > MAX_CATCH_UP * TICK_MS) {
      this.stats.overruns += 1;
      this.#nextTickAt = performance.now() + TICK_MS;
    }
    this.#timer = setTimeout(() => this.#loop(), Math.max(0, this.#nextTickAt - performance.now()));
  }

  #record(list, value) {
    list.push(value);
    if (list.length > STATS_WINDOW) list.shift();
  }

  stop() {
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  report() {
    const summarize = (list) => ({
      avg: list.length ? Number((list.reduce((a, b) => a + b, 0) / list.length).toFixed(3)) : 0,
      max: list.length ? Number(Math.max(...list).toFixed(3)) : 0,
    });
    return {
      room: this.room.id,
      tick: this.world.tick,
      players: this.players.size,
      entities: this.world.size,
      tickDurationMs: summarize(this.#durations),
      tickLatenessMs: summarize(this.#lateness),
      ...this.stats,
    };
  }
}

// Один матч на кімнату: стартує з першим гравцем, зупиняється, коли вийшов останній.
export class MatchManager {
  #matches = new Map();

  constructor({ rooms, logger }) {
    this.logger = logger;
    rooms.list().forEach((room) => this.#wire(room));
    rooms.on('created', (room) => this.#wire(room));
  }

  #wire(room) {
    room.on('start', () => {
      const match = new Match({ room, logger: this.logger });
      this.#matches.set(room.id, match);
      match.start();
      this.logger.info('match started', { room: room.id, seed: room.arena.seed });
    });
    room.on('join', (player) => this.#matches.get(room.id)?.addPlayer(player));
    room.on('leave', (player) => this.#matches.get(room.id)?.removePlayer(player.id));
    const stop = () => {
      const match = this.#matches.get(room.id);
      if (!match) return;
      match.stop();
      this.#matches.delete(room.id);
      this.logger.info('match stopped', { room: room.id, ticks: match.world.tick });
    };
    room.on('empty', stop);
    room.on('close', stop);
  }

  get(roomId) {
    return this.#matches.get(roomId);
  }

  report() {
    return [...this.#matches.values()].map((match) => match.report());
  }

  closeAll() {
    for (const match of this.#matches.values()) match.stop();
    this.#matches.clear();
  }
}
