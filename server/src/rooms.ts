// Кімнати. Room і RoomManager — EventEmitter-и: вони повідомляють, ЩО сталося,
// а хто на це реагує (розсилка в сокети, лог матчу) — їм байдуже.
//
// Події Room:  'start'    — у порожню кімнату заходить перший гравець
//              'join'     — (player)
//              'leave'    — (player)
//              'chat'     — ({ from, text, t })
//              'empty'    — вийшов останній гравець
//              'event'    — ({ t, room, type, ... }) усе підряд, для логу матчу
//              'close'    — кімнату видалено
//              'shutdown' — сервер зупиняється (її надсилає MatchLogs, щоб дописати лог)

import { randomUUID } from 'node:crypto';
import type { EntityId } from '@moba-arena/shared/brand.ts';
import type { ArenaConfig, RoomInfo, RosterPlayer } from '@moba-arena/shared/protocol.ts';
import { TypedEmitter } from './emitter.ts';

export type RoomErrorCode =
  'already_joined' | 'room_full' | 'not_joined' | 'too_many_rooms' | 'room_exists';

export class RoomError extends Error {
  readonly code: RoomErrorCode;

  constructor(code: RoomErrorCode, message: string) {
    super(message);
    this.name = 'RoomError';
    this.code = code;
  }
}

// Мінімум, за яким гравця впізнають: із цим він заходить у кімнату.
export interface PlayerRef {
  readonly id: string;
  readonly name: string;
}

export interface RoomPlayer extends PlayerRef {
  readonly joinedAt: number;
  // id сутності героя у світі; проставляє матч, щойно створив героя.
  shipId?: EntityId;
}

export interface ChatMessage {
  readonly from: PlayerRef;
  readonly text: string;
  readonly t: number;
}

// Запис для логу матчу. Розрізнюване об'єднання: поле type каже, які ще поля є.
type RoomEventBody =
  | { readonly type: 'join' | 'leave'; readonly player: PlayerRef }
  | ({ readonly type: 'chat' } & ChatMessage);
export type RoomEvent = { readonly t: number; readonly room: string } & RoomEventBody;

// Карта подій: ім'я → список аргументів слухача. Завдяки їй room.on('join', (player) => …)
// сам знає тип player, а room.on('jion', …) — помилка компіляції (див. emitter.ts).
export interface RoomEvents {
  start: [];
  join: [player: RoomPlayer];
  leave: [player: RoomPlayer];
  chat: [message: ChatMessage];
  empty: [];
  event: [event: RoomEvent];
  close: [];
  shutdown: [];
}

export interface RoomOptions {
  readonly id: string;
  readonly name: string;
  readonly arena: ArenaConfig;
  readonly maxPlayers: number;
  readonly persistent?: boolean;
}

export class Room extends TypedEmitter<RoomEvents> {
  readonly id: string;
  readonly name: string;
  readonly arena: ArenaConfig;
  readonly maxPlayers: number;
  readonly persistent: boolean;
  readonly players = new Map<string, RoomPlayer>(); // id → { id, name, joinedAt }

  constructor({ id, name, arena, maxPlayers, persistent = false }: RoomOptions) {
    super();
    this.id = id;
    this.name = name;
    this.arena = arena;
    this.maxPlayers = maxPlayers;
    this.persistent = persistent;
  }

  get size(): number {
    return this.players.size;
  }

  get isFull(): boolean {
    return this.players.size >= this.maxPlayers;
  }

  roster(): RosterPlayer[] {
    // shipId проставляє матч (id сутності героя у світі) — за ним клієнт підписує героїв.
    return [...this.players.values()].map(({ id, name, shipId }) =>
      shipId === undefined ? { id, name } : { id, name, shipId },
    );
  }

  // Те, що бачить клієнт у списку кімнат.
  toJSON(): RoomInfo {
    return {
      id: this.id,
      name: this.name,
      players: this.size,
      maxPlayers: this.maxPlayers,
      arena: this.arena,
    };
  }

  #record(body: RoomEventBody): void {
    this.emit('event', { t: Date.now(), room: this.id, ...body });
  }

  join({ id, name }: PlayerRef): RoomPlayer {
    if (this.players.has(id)) throw new RoomError('already_joined', 'Гравець уже в кімнаті');
    if (this.isFull) throw new RoomError('room_full', `Кімната «${this.name}» заповнена`);
    if (this.size === 0) this.emit('start');
    const player: RoomPlayer = { id, name, joinedAt: Date.now() };
    this.players.set(id, player);
    this.#record({ type: 'join', player: { id, name } });
    this.emit('join', player);
    return player;
  }

  leave(id: string): boolean {
    const player = this.players.get(id);
    if (!player) return false;
    this.players.delete(id);
    this.#record({ type: 'leave', player: { id, name: player.name } });
    this.emit('leave', player);
    if (this.size === 0) this.emit('empty');
    return true;
  }

  chat(id: string, text: string): ChatMessage {
    const player = this.players.get(id);
    if (!player) throw new RoomError('not_joined', 'Гравець не в кімнаті');
    const message: ChatMessage = { from: { id, name: player.name }, text, t: Date.now() };
    this.#record({ type: 'chat', ...message });
    this.emit('chat', message);
    return message;
  }
}

export interface RoomManagerEvents {
  created: [room: Room];
  deleted: [room: Room];
}

export interface RoomManagerOptions {
  readonly maxRooms?: number;
  readonly maxPlayersPerRoom?: number;
  readonly emptyTtlMs?: number;
}

export interface CreateRoomOptions {
  readonly id?: string;
  readonly name: string;
  readonly arena: ArenaConfig;
  readonly persistent?: boolean;
}

// Події RoomManager: 'created' (room), 'deleted' (room).
export class RoomManager extends TypedEmitter<RoomManagerEvents> {
  #rooms = new Map<string, Room>();

  readonly maxRooms: number;
  readonly maxPlayersPerRoom: number;
  readonly emptyTtlMs: number;

  constructor({
    maxRooms = 20,
    maxPlayersPerRoom = 8,
    emptyTtlMs = 60_000,
  }: RoomManagerOptions = {}) {
    super();
    this.maxRooms = maxRooms;
    this.maxPlayersPerRoom = maxPlayersPerRoom;
    this.emptyTtlMs = emptyTtlMs;
  }

  get size(): number {
    return this.#rooms.size;
  }

  get(id: string): Room | undefined {
    return this.#rooms.get(id);
  }

  list(): Room[] {
    return [...this.#rooms.values()];
  }

  create({
    id = randomUUID().slice(0, 8),
    name,
    arena,
    persistent = false,
  }: CreateRoomOptions): Room {
    if (this.#rooms.size >= this.maxRooms) {
      throw new RoomError('too_many_rooms', `На сервері вже ${this.maxRooms} кімнат`);
    }
    if (this.#rooms.has(id)) throw new RoomError('room_exists', `Кімната ${id} вже існує`);

    const room = new Room({ id, name, arena, persistent, maxPlayers: this.maxPlayersPerRoom });
    this.#rooms.set(id, room);

    if (!persistent) {
      // Порожня кімната видаляється: одразу, коли вийшов останній гравець,
      // або за таймером, якщо в щойно створену так ніхто й не зайшов.
      const idle = setTimeout(() => this.delete(id), this.emptyTtlMs);
      idle.unref(); // таймер не повинен тримати процес живим
      room.once('start', () => clearTimeout(idle));
      room.on('empty', () => this.delete(id));
      room.once('close', () => clearTimeout(idle));
    }

    this.emit('created', room);
    return room;
  }

  delete(id: string): boolean {
    const room = this.#rooms.get(id);
    if (!room) return false;
    this.#rooms.delete(id);
    room.emit('close');
    this.emit('deleted', room);
    room.removeAllListeners(); // інакше слухачі тримали б кімнату в пам'яті
    return true;
  }
}
