// Лобі: стан і мережа, без жодного DOM. Про зміни повідомляє подіями —
// малює їх окремий модуль (view.js), який можна замінити, не чіпаючи цей.
//
// Події: 'loading'  — пішов запит
//        'rooms'    — { rooms }  список оновлено
//        'error'    — { error, stale }  запит не вдався (старий список лишається)
//        'joined'   — { room, name }  гравець зайшов у кімнату
//
// Проміс чи подія? refresh() повертає проміс — це одна операція з одним результатом.
// «Список оновився» трапляється багато разів і цікавить багатьох — це подія.

import { fetchJson } from '../assets/loader.js';
import { sleep } from '../async.js';

export class Lobby extends EventTarget {
  #rooms = [];
  #controller = null;

  constructor({ url, intervalMs = 3000, timeoutMs = 2500 }) {
    super();
    this.url = url;
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
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
      this.#emit('error', { error, stale: this.#rooms.length > 0 });
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

  // Поки що «приєднатися» означає почати локальну гру з конфігом кімнати; Lab 4 замінить
  // це справжнім з'єднанням із сервером.
  join(roomId, name) {
    const cleanName = String(name ?? '').trim();
    const room = this.#rooms.find((candidate) => candidate.id === roomId);
    let problem = null;
    if (cleanName.length < 2 || cleanName.length > 16)
      problem = 'Ім’я має бути від 2 до 16 символів';
    else if (!room) problem = 'Оберіть кімнату зі списку';
    else if (room.players >= room.maxPlayers) problem = `Кімната «${room.name}» заповнена`;

    if (problem) {
      this.#emit('error', { error: new Error(problem), stale: true });
      return null;
    }

    this.stop();
    this.#emit('joined', { room, name: cleanName });
    return room;
  }
}
