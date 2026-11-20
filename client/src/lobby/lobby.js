// Лобі: стан і мережа, без жодного DOM. Про зміни повідомляє подіями —
// малює їх окремий модуль (view.js), який можна замінити, не чіпаючи цей.
//
// Події: 'loading'  — пішов запит списку
//        'rooms'    — { rooms }  список оновлено
//        'error'    — { error, stale }  щось не вдалося (старий список лишається)
//        'joining'  — { room }  чекаємо відповіді сервера на вхід
//        'joined'   — { room, name, playerId, connection }  сервер прийняв гравця
//
// Проміс чи подія? refresh() повертає проміс — це одна операція з одним результатом.
// «Список оновився» трапляється багато разів і цікавить багатьох — це подія.

import { fetchJson, HttpError } from '../assets/loader.js';
import { sleep } from '../async.js';

export class Lobby extends EventTarget {
  #rooms = [];
  #controller = null;
  #connect;
  #joining = false;

  // connect({ roomId, name }) → з'єднання (net/connection.js). Передається ззовні,
  // щоб лобі не знало про WebSocket і тестувалося без мережі.
  constructor({ url, connect, intervalMs = 3000, timeoutMs = 2500, joinTimeoutMs = 5000 }) {
    super();
    this.url = url;
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
    this.joinTimeoutMs = joinTimeoutMs;
    this.#connect = connect;
  }

  get rooms() {
    return this.#rooms;
  }

  get polling() {
    return this.#controller !== null;
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #fail(error) {
    this.#emit('error', { error, stale: this.#rooms.length > 0 });
  }

  // Один запит списку кімнат. Таймаут — на кожен запит; зовнішній сигнал — «гравець пішов».
  async refresh({ signal } = {}) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    this.#emit('loading');
    try {
      const data = await fetchJson(this.url, { signal: combined });
      if (!Array.isArray(data?.rooms)) throw new TypeError('У відповіді немає списку rooms');
      this.#rooms = data.rooms;
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
  start() {
    if (this.#controller) return;
    this.#controller = new AbortController();
    this.#poll(this.#controller.signal);
  }

  async #poll(signal) {
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
  stop() {
    this.#controller?.abort();
    this.#controller = null;
  }

  // POST /api/rooms. Повертає створену кімнату або null (помилка піде подією).
  async createRoom(name) {
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new HttpError(response.status, response.statusText, this.url);
        if (body.error) error.message = body.error;
        throw error;
      }
      await this.refresh();
      return body.room;
    } catch (error) {
      this.#fail(error);
      return null;
    }
  }

  // Вхід у кімнату: відкриваємо сокет, шлемо join і чекаємо welcome від сервера.
  // Три можливі фінали — і проміс виконується першим із них: welcome, відмова, таймаут.
  async join(roomId, name) {
    if (this.#joining) return null;
    const cleanName = String(name ?? '').trim();
    const room = this.#rooms.find((candidate) => candidate.id === roomId);
    let problem = null;
    if (cleanName.length < 2 || cleanName.length > 16)
      problem = 'Ім’я має бути від 2 до 16 символів';
    else if (!room) problem = 'Оберіть кімнату зі списку';
    else if (room.players >= room.maxPlayers) problem = `Кімната «${room.name}» заповнена`;
    if (problem) {
      this.#fail(new Error(problem));
      return null;
    }

    this.#joining = true;
    this.#emit('joining', { room });
    const connection = this.#connect({ roomId, name: cleanName });
    const listeners = new AbortController();
    try {
      const welcome = await new Promise((resolve, reject) => {
        const { signal } = listeners;
        connection.on('welcome', resolve, { signal });
        connection.on(
          'status',
          ({ status, reason }) => {
            if (status === 'closed') reject(new Error(reason ?? 'сервер розірвав з’єднання'));
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
