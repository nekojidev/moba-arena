// Матч: єдине місце, де рахується світ. Клієнти надсилають лише input (газ, поворот,
// постріл); координат від них сервер не приймає взагалі — тож «телепортуватися»
// чи пришвидшитись, підправивши клієнт, неможливо.

import { seq, tick, type EntityId, type Seq } from '@moba-arena/shared/brand.ts';
import type { Codec } from '@moba-arena/shared/codec/index.ts';
import { isHoming } from '@moba-arena/shared/sim/behaviors.ts';
import { createDirector, type Director } from '@moba-arena/shared/sim/game.ts';
import { Ship, type Command } from '@moba-arena/shared/sim/ship.ts';
import { World, type AnyEntity } from '@moba-arena/shared/sim/world.ts';
import {
  DT,
  TICK_MS,
  serverMessage,
  type Input,
  type NetEvent,
  type Snapshot,
  type SnapshotEntity,
} from '@moba-arena/shared/protocol.ts';
import { Bot } from './bot.ts';
import type { Logger } from './logger.ts';
import type { PlayerRef, Room, RoomManager } from './rooms.ts';

const MAX_QUEUE = 30; // input у черзі одного гравця (1 с); понад це — найстаріші викидаємо
const MAX_BURST = 6; // скільки input гравця можна обробити за один крок сервера
const MAX_CATCH_UP = 5; // скільки пропущених кроків наздоганяємо за раз
const STATS_WINDOW = 300; // кроків (10 с)
export const MAX_BOTS = 16;
const AUTO_BOT_ID = 'bot-auto';

// Готовий кадр для сокета: рядок JSON або байти знімка.
export type Frame = Uint8Array | string;
export interface SendOptions {
  readonly critical?: boolean;
}
// Повертає true, якщо кадр справді пішов у сокет.
export type SendFrame = (data: Frame, options?: SendOptions) => boolean;

// Те, що дає мережевий шар: яким кодеком і через що слати гравцеві. Кодек і send
// з'являються лише разом — тому це один об'єкт, а не два окремі поля з null.
export interface PlayerLink {
  readonly codec: Pick<Codec, 'encodeSnapshot'>;
  readonly send: SendFrame;
}

// Гравець, якого додають у матч: матч запише йому shipId (він потрапить у roster).
export interface MatchEntrant extends PlayerRef {
  shipId?: EntityId;
}

export interface MatchPlayer {
  readonly id: string;
  readonly ship: Ship;
  readonly queue: Input[];
  ack: Seq;
  lastSeq: Seq;
  budget: number;
  processed: number;
  link: PlayerLink | null;
}

export interface MatchStats {
  overruns: number;
  droppedInputs: number;
  snapshots: number;
  bytesOut: number;
}

interface Summary {
  readonly avg: number;
  readonly max: number;
}

export interface MatchReport extends MatchStats {
  readonly room: string;
  readonly tick: number;
  readonly players: number;
  readonly bots: number;
  readonly entities: number;
  readonly tickDurationMs: Summary;
  readonly tickLatenessMs: Summary;
}

// Спільна частина запису в знімку. Вид передаємо окремо, щоб тип поля kind був
// точним літералом ('ship'), а не всім об'єднанням.
function placed<K extends SnapshotEntity['kind']>(kind: K, entity: AnyEntity) {
  return { id: entity.id, kind, x: entity.pos.x, y: entity.pos.y, angle: entity.angle };
}

function summarize(list: readonly number[]): Summary {
  return {
    avg: list.length ? Number((list.reduce((a, b) => a + b, 0) / list.length).toFixed(3)) : 0,
    max: list.length ? Number(Math.max(...list).toFixed(3)) : 0,
  };
}

export class Match {
  #timer: NodeJS.Timeout | null = null;
  #nextTickAt = 0;
  #events: NetEvent[] = [];
  #durations: number[] = [];
  #lateness: number[] = [];

  readonly room: Room;
  readonly logger: Logger;
  readonly world: World;
  readonly director: Director;
  readonly players = new Map<string, MatchPlayer>(); // id гравця → стан гравця в матчі
  // Боти — такі самі гравці, лише input їм видає Bot, а не сокет.
  readonly #bots = new Map<string, Bot>();
  #botCounter = 0;
  readonly stats: MatchStats = { overruns: 0, droppedInputs: 0, snapshots: 0, bytesOut: 0 };

  constructor({ room, logger }: { room: Room; logger: Logger }) {
    this.room = room;
    this.logger = logger;
    const { width, height, asteroids, pickups, seed } = room.arena;
    // Випадковість — лише з генератора світу, а його seed задає сервер.
    this.world = new World({ arena: { width, height }, seed, cosmetics: false });
    this.director = createDirector(this.world, { asteroids, pickups });

    // Події світу, які їдуть клієнтам. Слухач отримує дані події напряму; до них додаємо
    // type. Кожна підписка окремо — так tsc перевіряє форму кожної події (NetEvent).
    const { events } = this.world;
    events.on('fired', (data) => this.#events.push({ type: 'fired', ...data }));
    events.on('hit', (data) => this.#events.push({ type: 'hit', ...data }));
    events.on('exploded', (data) => this.#events.push({ type: 'exploded', ...data }));
    events.on('pickup', (data) => this.#events.push({ type: 'pickup', ...data }));
    events.on('respawned', (data) => this.#events.push({ type: 'respawned', ...data }));
  }

  // --- гравці ------------------------------------------------------------------------------

  addPlayer(player: MatchEntrant): Ship {
    const ship = this.#spawn(player.id, player.name, 'green');
    player.shipId = ship.id; // потрапить у roster: клієнти підпишуть героїв іменами
    this.#syncAutoBot();
    return ship;
  }

  #spawn(id: string, name: string, team: 'green' | 'red'): Ship {
    const ship = this.world.spawn(new Ship({ pos: this.world.findSafeSpot(16), team, name }));
    this.players.set(id, {
      id,
      ship,
      queue: [],
      ack: seq(0),
      lastSeq: seq(0),
      budget: MAX_BURST,
      processed: 0,
      link: null,
    });
    return ship;
  }

  // Додає ботів (POST /api/rooms/:id/bots). Повертає, скільки їх стало.
  addBots(count: number): number {
    this.#removeBot(AUTO_BOT_ID); // «компаньйон» самотнього гравця більше не потрібен
    for (let i = 0; i < count && this.#bots.size < MAX_BOTS; i += 1) {
      this.#botCounter += 1;
      const id = `bot-${this.#botCounter}`;
      this.#spawn(id, `Бот ${this.#botCounter}`, 'red');
      this.#bots.set(id, new Bot());
    }
    return this.#bots.size;
  }

  #removeBot(id: string): void {
    const player = this.players.get(id);
    if (!player || !this.#bots.delete(id)) return;
    this.world.despawn(player.ship.id);
    this.players.delete(id);
  }

  get humans(): number {
    return this.players.size - this.#bots.size;
  }

  get botCount(): number {
    return this.#bots.size;
  }

  // Герой бота-компаньйона (або null) — для тестів.
  get bot(): Ship | null {
    return this.#bots.has(AUTO_BOT_ID) ? (this.players.get(AUTO_BOT_ID)?.ship ?? null) : null;
  }

  // Викликає мережевий шар, коли знає, яким кодеком і через що слати цьому гравцеві.
  attach(playerId: string, { codec, send }: PlayerLink): void {
    const player = this.players.get(playerId);
    if (player) player.link = { codec, send };
  }

  removePlayer(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player) return;
    this.world.despawn(player.ship.id);
    this.players.delete(playerId);
    this.#syncAutoBot();
  }

  // Самотньому гравцеві складає компанію бот; щойно людей двоє (або ботів додали
  // вручну) — компаньйон іде.
  #syncAutoBot(): void {
    const onlyAuto = this.#bots.size === 1 && this.#bots.has(AUTO_BOT_ID);
    if (this.humans === 1 && this.#bots.size === 0) {
      this.#spawn(AUTO_BOT_ID, 'Бот', 'red');
      this.#bots.set(AUTO_BOT_ID, new Bot());
    } else if (this.humans !== 1 && onlyAuto) {
      this.#removeBot(AUTO_BOT_ID);
    }
  }

  // Input уже пройшов перевірку форми в кодеку. Тут — перевірка порядку й ліміт черги.
  pushInput(playerId: string, input: Input): boolean {
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

  tick(): void {
    // Боти «натискають кнопки» так само, як люди: input із наступним номером — у чергу.
    for (const [id, bot] of this.#bots) {
      const player = this.players.get(id);
      if (!player) continue;
      this.pushInput(id, {
        seq: seq(player.lastSeq + 1),
        ...bot.nextInput(player.ship, this.world),
      });
    }

    const inputs = new Map<EntityId, Command | readonly Command[]>();
    for (const player of this.players.values()) {
      // Бюджет: +1 input за крок, із запасом MAX_BURST на нерівну мережу. У середньому сервер
      // обробляє не більше одного input гравця за крок — надіславши 300 input/с, герой
      // не полетить удесятеро швидше.
      player.budget = Math.min(MAX_BURST, player.budget + 1);
      const commands: Command[] = [];
      while (player.budget >= 1) {
        const input = player.queue.shift();
        if (!input) break; // черга порожня
        commands.push(input);
        player.ack = input.seq;
        player.budget -= 1;
        player.processed += 1;
      }
      // Порожній масив — input не прийшов: герой цього кроку не рухається (див. Ship.update).
      inputs.set(player.ship.id, commands);
    }

    this.director.tick(DT);
    this.world.step(DT, inputs);
    this.#broadcast();
  }

  #entities(): SnapshotEntity[] {
    const entities: SnapshotEntity[] = [];
    for (const entity of this.world) {
      if (!entity.alive) continue;
      switch (entity.kind) {
        case 'ship':
          entities.push({
            ...placed('ship', entity),
            hp: entity.hp,
            score: this.world.score.get(entity.id) ?? 0,
            down: entity.isDown,
            shield: entity.hasEffect('shield'),
            thrust: entity.thrust > 0,
          });
          break;
        case 'bullet':
          entities.push({
            ...placed('bullet', entity),
            owner: entity.ownerId,
            homing: isHoming(entity),
          });
          break;
        case 'asteroid':
          entities.push({
            ...placed('asteroid', entity),
            size: entity.size,
            homing: isHoming(entity),
          });
          break;
        case 'pickup':
          entities.push({ ...placed('pickup', entity), effect: entity.effect.type });
          break;
        case 'explosion':
          break; // прикраса: клієнт малює вибух сам, отримавши подію
        default: {
          // Сюди tsc не пускає жодного виду. З'явиться новий вид сутності без гілки вище —
          // цей рядок перестане компілюватись.
          const unhandled: never = entity;
          throw new Error(`Невідомий вид сутності: ${String(unhandled)}`);
        }
      }
    }
    return entities;
  }

  #broadcast(): void {
    const entities = this.#entities();
    const events = this.#events.splice(0);
    const eventsMessage =
      events.length > 0
        ? serverMessage({ type: 'events', tick: tick(this.world.tick), events })
        : null;

    for (const player of this.players.values()) {
      const { ship, link } = player;
      if (!link) continue;
      // Знімок персональний: ack і точний стан власного героя — у кожного свої.
      const snapshot: Snapshot = {
        tick: tick(this.world.tick),
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
      const data = link.codec.encodeSnapshot(snapshot);
      // Знімок — некритичний: повільному клієнту його не шлемо, наступний усе одно новіший.
      if (link.send(data, { critical: false })) {
        this.stats.snapshots += 1;
        this.stats.bytesOut += data.length;
      }
      if (eventsMessage) link.send(eventsMessage, { critical: true });
    }
  }

  // --- таймер ------------------------------------------------------------------------------
  //
  // Не setInterval: він планує «через 33 мс після того, як дійде черга», тож кожне запізнення
  // накопичується, і 30 кроків/с перетворюються на 29 з хвостиком. Тут кожен крок має
  // АБСОЛЮТНИЙ цільовий час: tickN = start + N·TICK_MS. Запізнились на 4 мс — наступний
  // setTimeout буде на 4 мс коротший, і середній темп лишається рівно 30.

  start(): void {
    if (this.#timer) return;
    this.#nextTickAt = performance.now() + TICK_MS;
    this.#timer = setTimeout(() => this.#loop(), TICK_MS);
  }

  #loop(): void {
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

  #record(list: number[], value: number): void {
    list.push(value);
    if (list.length > STATS_WINDOW) list.shift();
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  report(): MatchReport {
    return {
      room: this.room.id,
      tick: this.world.tick,
      players: this.humans,
      bots: this.#bots.size,
      entities: this.world.size,
      tickDurationMs: summarize(this.#durations),
      tickLatenessMs: summarize(this.#lateness),
      ...this.stats,
    };
  }
}

// Один матч на кімнату: стартує з першим гравцем, зупиняється, коли вийшов останній.
export class MatchManager {
  #matches = new Map<string, Match>();

  readonly logger: Logger;

  constructor({ rooms, logger }: { rooms: RoomManager; logger: Logger }) {
    this.logger = logger;
    rooms.list().forEach((room) => this.#wire(room));
    rooms.on('created', (room) => this.#wire(room));
  }

  #wire(room: Room): void {
    room.on('start', () => {
      const match = new Match({ room, logger: this.logger });
      this.#matches.set(room.id, match);
      match.start();
      this.logger.info('match started', { room: room.id, seed: room.arena.seed });
    });
    room.on('join', (player) => {
      this.#matches.get(room.id)?.addPlayer(player);
    });
    room.on('leave', (player) => {
      this.#matches.get(room.id)?.removePlayer(player.id);
    });
    const stop = (): void => {
      const match = this.#matches.get(room.id);
      if (!match) return;
      match.stop();
      this.#matches.delete(room.id);
      this.logger.info('match stopped', { room: room.id, ticks: match.world.tick });
    };
    room.on('empty', stop);
    room.on('close', stop);
  }

  get(roomId: string): Match | undefined {
    return this.#matches.get(roomId);
  }

  report(): MatchReport[] {
    return [...this.#matches.values()].map((match) => match.report());
  }

  closeAll(): void {
    for (const match of this.#matches.values()) match.stop();
    this.#matches.clear();
  }
}
