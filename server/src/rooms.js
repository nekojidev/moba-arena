// Кімнати. Room і RoomManager — EventEmitter-и: вони повідомляють, ЩО сталося,
// а хто на це реагує (розсилка в сокети, лог матчу) — їм байдуже.
//
// Події Room:  'start'  — у порожню кімнату заходить перший гравець
//              'join'   — (player)
//              'leave'  — (player)
//              'chat'   — ({ from, text, t })
//              'empty'  — вийшов останній гравець
//              'event'  — ({ t, room, type, ... }) усе підряд, для логу матчу
//              'close'  — кімнату видалено

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoomError';
    this.code = code;
  }
}

export class Room extends EventEmitter {
  constructor({ id, name, arena, maxPlayers, persistent = false }) {
    super();
    this.id = id;
    this.name = name;
    this.arena = arena;
    this.maxPlayers = maxPlayers;
    this.persistent = persistent;
    this.players = new Map(); // id → { id, name, joinedAt }
  }

  get size() {
    return this.players.size;
  }

  get isFull() {
    return this.players.size >= this.maxPlayers;
  }

  roster() {
    return [...this.players.values()].map(({ id, name }) => ({ id, name }));
  }

  // Те, що бачить клієнт у списку кімнат.
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      players: this.size,
      maxPlayers: this.maxPlayers,
      arena: this.arena,
    };
  }

  #record(type, data) {
    this.emit('event', { t: Date.now(), room: this.id, type, ...data });
  }

  join({ id, name }) {
    if (this.players.has(id)) throw new RoomError('already_joined', 'Гравець уже в кімнаті');
    if (this.isFull) throw new RoomError('room_full', `Кімната «${this.name}» заповнена`);
    if (this.size === 0) this.emit('start');
    const player = { id, name, joinedAt: Date.now() };
    this.players.set(id, player);
    this.#record('join', { player: { id, name } });
    this.emit('join', player);
    return player;
  }

  leave(id) {
    const player = this.players.get(id);
    if (!player) return false;
    this.players.delete(id);
    this.#record('leave', { player: { id, name: player.name } });
    this.emit('leave', player);
    if (this.size === 0) this.emit('empty');
    return true;
  }

  chat(id, text) {
    const player = this.players.get(id);
    if (!player) throw new RoomError('not_joined', 'Гравець не в кімнаті');
    const message = { from: { id, name: player.name }, text, t: Date.now() };
    this.#record('chat', message);
    this.emit('chat', message);
    return message;
  }
}

// Події RoomManager: 'created' (room), 'deleted' (room).
export class RoomManager extends EventEmitter {
  #rooms = new Map();

  constructor({ maxRooms = 20, maxPlayersPerRoom = 8, emptyTtlMs = 60_000 } = {}) {
    super();
    this.maxRooms = maxRooms;
    this.maxPlayersPerRoom = maxPlayersPerRoom;
    this.emptyTtlMs = emptyTtlMs;
  }

  get size() {
    return this.#rooms.size;
  }

  get(id) {
    return this.#rooms.get(id);
  }

  list() {
    return [...this.#rooms.values()];
  }

  create({ id = randomUUID().slice(0, 8), name, arena, persistent = false }) {
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

  delete(id) {
    const room = this.#rooms.get(id);
    if (!room) return false;
    this.#rooms.delete(id);
    room.emit('close');
    this.emit('deleted', room);
    room.removeAllListeners(); // інакше слухачі тримали б кімнату в пам'яті
    return true;
  }
}
