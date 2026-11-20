// Лобі: стан і мережа, без жодного DOM. Про зміни повідомляє подіями —
// малює їх окремий модуль (view.ts), який можна замінити, не чіпаючи цей.
//
// Події: 'loading'  — пішов запит списку
//        'rooms'    — { rooms }  список оновлено
//        'error'    — { error, stale }  щось не вдалося (старий список лишається)
//        'joining'  — { room }  чекаємо відповіді сервера на вхід
//        'joined'   — { room, name, playerId, connection }  сервер прийняв гравця
//
// Проміс чи подія? refresh() повертає проміс — це одна операція з одним результатом.
// «Список оновився» трапляється багато разів і цікавить багатьох — це подія.

import { Bus } from '@moba-arena/shared/bus.ts';
import { roomSchema, type RoomInfo, type Welcome } from '@moba-arena/shared/protocol.ts';
import { fetchJson, HttpError } from '../assets/loader.ts';
import { sleep } from '../async.ts';
import { isRecord } from '../guards.ts';
import type { Connection } from '../net/connection.ts';

export interface JoinRequest {
  readonly roomId: string;
  readonly name: string;
}

export interface Joined {
  readonly room: RoomInfo;
  readonly name: string;
  readonly playerId: string;
  readonly welcome: Welcome;
  readonly connection: Connection;
}

// Карта подій лобі: ім'я → форма detail. Від неї виводяться типи слухачів у on().
export interface LobbyEvents {
  loading: undefined;
  rooms: { readonly rooms: readonly RoomInfo[] };
  error: { readonly error: unknown; readonly stale: boolean };
  joining: { readonly room: RoomInfo };
  joined: Joined;
}

export interface LobbyOptions {
  readonly url: string;
  // connect({ roomId, name }) → з'єднання (net/connection.ts). Передається ззовні,
  // щоб лобі не знало про WebSocket і тестувалося без мережі.
  readonly connect?: (request: JoinRequest) => Connection;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly joinTimeoutMs?: number;
}

// Список кімнат із сервера — unknown, доки кожну не перевірила та сама схема, якою
// сервер описує кімнату у welcome. Не та форма — null.
function parseRooms(data: unknown): RoomInfo[] | null {
  if (!isRecord(data) || !Array.isArray(data.rooms)) return null;
  const rooms: RoomInfo[] = [];
  for (const item of data.rooms) {
    const parsed = roomSchema.safeParse(item);
    if (!parsed.success) return null;
    rooms.push(parsed.data);
  }
  return rooms;
}

export class Lobby extends EventTarget {
  readonly url: string;
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly joinTimeoutMs: number;

  #rooms: readonly RoomInfo[] = [];
  #controller: AbortController | null = null;
  #connect: ((request: JoinRequest) => Connection) | null;
  #joining = false;
  // Lobby лишається EventTarget (як у Lab 3), але detail у CustomEvent для tsc — any.
  // Тому ті самі події дублюються в типізовану шину: через on() слухач отримує перевірений тип.
  #bus = new Bus<LobbyEvents>();

  constructor({
    url,
    connect,
    intervalMs = 3000,
    timeoutMs = 2500,
    joinTimeoutMs = 5000,
  }: LobbyOptions) {
    super();
    this.url = url;
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
    this.joinTimeoutMs = joinTimeoutMs;
    this.#connect = connect ?? null;
  }

  get rooms(): readonly RoomInfo[] {
    return this.#rooms;
  }

  get polling(): boolean {
    return this.#controller !== null;
  }

  // Типізована підписка: lobby.on('rooms', ({ rooms }) => …). { signal } знімає слухача.
  on<K extends keyof LobbyEvents>(
    type: K,
    handler: (detail: LobbyEvents[K]) => void,
    options: { readonly signal?: AbortSignal } = {},
  ): void {
    this.#bus.on(type, handler, options);
  }

  #emit<K extends keyof LobbyEvents>(type: K, detail: LobbyEvents[K]): void {
    this.#bus.emit(type, detail);
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #fail(error: unknown): void {
    this.#emit('error', { error, stale: this.#rooms.length > 0 });
  }

  // Один запит списку кімнат. Таймаут — на кожен запит; зовнішній сигнал — «гравець пішов».
  async refresh({ signal }: { readonly signal?: AbortSignal } = {}): Promise<readonly RoomInfo[]> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    this.#emit('loading', undefined);
    try {
      const rooms = parseRooms(await fetchJson(this.url, { signal: combined }));
      if (!rooms) throw new TypeError('У відповіді немає списку rooms');
      this.#rooms = rooms;
      this.#emit('rooms', { rooms: this.#rooms });
    } catch (error) {
      // Гравець пішов — це не помилка, і показувати її вже нікому.
      if (signal?.aborted) return this.#rooms;
      this.#fail(error);
    }
    return this.#rooms;
  }

  // Періодичне оновлення, поки лобі видиме. Наступний запит плануємо лише ПІСЛЯ
  // завершення попереднього (await у циклі), тож повільна мережа не накопичує черги запитів,
  // як це зробив би setInterval.
  start(): void {
    if (this.#controller) return;
    this.#controller = new AbortController();
    this.#poll(this.#controller.signal);
  }

  async #poll(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.refresh({ signal });
      try {
        await sleep(this.intervalMs, signal);
      } catch {
        return; // паузу перервано — виходимо з циклу
      }
    }
  }

  // Один abort() скасовує і запит у польоті, і паузу між запитами: сиріт не лишається.
  stop(): void {
    this.#controller?.abort();
    this.#controller = null;
  }

  // POST /api/rooms. Повертає створену кімнату або null (помилка піде подією).
  async createRoom(name: string): Promise<RoomInfo | null> {
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      // Тіло відповіді — unknown: і текст помилки, і кімнату перевіряємо, перш ніж узяти.
      const body: unknown = await response.json().catch(() => ({}));
      const fields = isRecord(body) ? body : {};
      if (!response.ok) {
        const error = new HttpError(response.status, response.statusText, this.url);
        if (typeof fields.error === 'string' && fields.error) error.message = fields.error;
        throw error;
      }
      const room = roomSchema.safeParse(fields.room);
      if (!room.success) throw new TypeError('Сервер не повернув створену кімнату');
      await this.refresh();
      return room.data;
    } catch (error) {
      this.#fail(error);
      return null;
    }
  }

  // Вхід у кімнату: відкриваємо сокет, шлемо join і чекаємо welcome від сервера.
  // Три можливі фінали — і проміс виконується першим із них: welcome, відмова, таймаут.
  async join(roomId: string | null, name: string): Promise<RoomInfo | null> {
    if (this.#joining) return null;
    const cleanName = String(name ?? '').trim();
    const room = this.#rooms.find((candidate) => candidate.id === roomId);
    const connect = this.#connect;
    let problem: string | null = null;
    if (cleanName.length < 2 || cleanName.length > 16)
      problem = 'Ім’я має бути від 2 до 16 символів';
    else if (!room) problem = 'Оберіть кімнату зі списку';
    else if (room.players >= room.maxPlayers) problem = `Кімната «${room.name}» заповнена`;
    else if (!connect) problem = 'Лобі створено без connect — з’єднатися нічим';
    // Повторні !room і !connect — для tsc: за змінною problem він не бачить, що вони вже перевірені.
    if (problem !== null || !room || !connect) {
      this.#fail(new Error(problem ?? 'Оберіть кімнату зі списку'));
      return null;
    }

    this.#joining = true;
    this.#emit('joining', { room });
    const connection = connect({ roomId: room.id, name: cleanName });
    const listeners = new AbortController();
    try {
      const welcome = await new Promise<Welcome>((resolve, reject) => {
        const { signal } = listeners;
        connection.on('welcome', resolve, { signal });
        connection.on(
          'status',
          (event) => {
            if (event.status === 'closed') {
              reject(new Error(event.reason ?? 'сервер розірвав з’єднання'));
            }
          },
          { signal },
        );
        AbortSignal.timeout(this.joinTimeoutMs).addEventListener(
          'abort',
          () => reject(new Error('сервер не відповів на вхід')),
          { signal },
        );
      });
      this.stop(); // гравець іде з лобі: опитування більше не потрібне
      this.#emit('joined', {
        room: welcome.room,
        name: cleanName,
        playerId: welcome.playerId,
        welcome,
        connection,
      });
      return welcome.room;
    } catch (error) {
      connection.close();
      this.#fail(error);
      this.refresh(); // список міг змінитися (кімнату зайняли або видалили)
      return null;
    } finally {
      listeners.abort();
      this.#joining = false;
    }
  }
}
