// Звук на Web Audio. Модуль володіє AudioContext і підписується на події світу;
// симуляція про нього не знає.
//
// Браузер не дає сторінці звучати, поки користувач нічого не натиснув: контекст
// створюється у стані "suspended". Декодувати буфери в ньому можна одразу (це робить
// завантажувач), а resume() викликаємо з першого жесту — кліку «Приєднатися» чи клавіші.

import type { EntityId } from '@moba-arena/shared/brand.ts';
import type { Bus } from '@moba-arena/shared/bus.ts';
import type { GameEvents } from '@moba-arena/shared/sim/events.ts';

export interface PlayOptions {
  readonly volume?: number;
  readonly rate?: number;
}

export interface ConnectOptions {
  readonly signal?: AbortSignal;
  readonly playerId?: EntityId;
}

export interface GameAudio {
  readonly context: AudioContext;
  readonly muted: boolean;
  setBuffers(entries: Readonly<Record<string, AudioBuffer | null>>): void;
  unlock(): void;
  toggleMute(): boolean;
  play(name: string, options?: PlayOptions): void;
  connect(events: Bus<GameEvents>, options?: ConnectOptions): void;
}

export function createAudio(): GameAudio {
  const context = new AudioContext();
  const master = context.createGain();
  master.gain.value = 0.35;
  master.connect(context.destination);

  const buffers = new Map<string, AudioBuffer>();
  let muted = false;

  function play(name: string, { volume = 1, rate = 1 }: PlayOptions = {}): void {
    const buffer = buffers.get(name);
    if (!buffer || muted || context.state !== 'running') return; // немає звуку — просто тиша
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    gain.gain.value = volume;
    source.connect(gain).connect(master);
    source.start();
  }

  // Об'єкт зібрано із замикань, а не з методів класу: unlock можна сміливо віддати
  // в addEventListener('pointerdown', audio.unlock) — this тут не використовується взагалі.
  return {
    context,

    setBuffers(entries) {
      for (const [name, buffer] of Object.entries(entries)) {
        if (buffer) buffers.set(name, buffer);
      }
    },

    // resume() повертає проміс; помилку ковтаємо — без звуку гра все одно працює.
    unlock() {
      if (context.state === 'suspended') context.resume().catch(() => {});
    },

    toggleMute() {
      muted = !muted;
      return muted;
    },

    get muted() {
      return muted;
    },

    play,

    // Підписка на шину подій світу. Знімається одним controller.abort() через { signal }.
    // Шина типізована: ім'я події визначає форму payload, тож описка в імені чи полі — помилка tsc.
    connect(events, { signal, playerId } = {}) {
      events.on(
        'fired',
        ({ shipId }) => {
          const own = shipId === playerId;
          // Легка випадковість висоти, щоб черга не звучала як кулемет з одного семпла.
          play('shoot', { volume: own ? 0.9 : 0.45, rate: 0.94 + Math.random() * 0.12 });
        },
        { signal },
      );
      events.on(
        'hit',
        ({ targetKind }) => play('hit', { volume: targetKind === 'ship' ? 0.9 : 0.5 }),
        { signal },
      );
      events.on('exploded', ({ kind }) => play('explode', { volume: kind === 'ship' ? 1 : 0.6 }), {
        signal,
      });
      events.on('pickup', () => play('pickup'), { signal });
    },
  };
}
