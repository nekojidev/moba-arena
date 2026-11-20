// EventEmitter із суворою картою подій.
//
// У Node є дженерик EventEmitter<T>: з ним room.on('join', (player) => …) сам знає тип
// player. Але типи Node навмисно лишають «чорний хід»: будь-яке ІНШЕ ім'я події теж
// дозволене, тож room.on('jion', …) компілюється без помилок, а слухач отримує що завгодно.
//
// Тут той самий EventEmitter, але on / once / off / emit перевизначені із суворішими
// типами: ім'я — лише з карти подій, аргументи — рівно ті, що в карті. Тіла методів
// лише передають виклик базовому класу — у рантаймі нічого не змінюється.
//
//   interface RoomEvents { start: []; join: [player: RoomPlayer] }
//   class Room extends TypedEmitter<RoomEvents> { … }
//   room.on('join', (player) => …)   // player: RoomPlayer — виведено з імені
//   room.on('jion', …)               // помилка tsc: такої події немає
//   room.emit('join')                // помилка tsc: бракує аргументу

import { EventEmitter } from 'node:events';

// Карта подій: ім'я → список аргументів слухача.
type EventMap<Events> = Record<keyof Events, unknown[]>;
type Listener<Args extends unknown[]> = (...args: Args) => void;

export class TypedEmitter<Events extends EventMap<Events>> extends EventEmitter {
  override on<K extends keyof Events & string>(type: K, listener: Listener<Events[K]>): this {
    return super.on(type, listener);
  }

  override once<K extends keyof Events & string>(type: K, listener: Listener<Events[K]>): this {
    return super.once(type, listener);
  }

  override off<K extends keyof Events & string>(type: K, listener: Listener<Events[K]>): this {
    return super.off(type, listener);
  }

  override emit<K extends keyof Events & string>(type: K, ...args: Events[K]): boolean {
    return super.emit(type, ...args);
  }
}
