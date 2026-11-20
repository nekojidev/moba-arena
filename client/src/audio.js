// Звук на Web Audio. Модуль володіє AudioContext і підписується на події світу;
// симуляція про нього не знає.
//
// Браузер не дає сторінці звучати, поки користувач нічого не натиснув: контекст
// створюється у стані "suspended". Декодувати буфери в ньому можна одразу (це робить
// завантажувач), а resume() викликаємо з першого жесту — кліку «Приєднатися» чи клавіші.

export function createAudio() {
  const context = new AudioContext();
  const master = context.createGain();
  master.gain.value = 0.35;
  master.connect(context.destination);

  const buffers = new Map();
  let muted = false;

  function play(name, { volume = 1, rate = 1 } = {}) {
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
    connect(events, { signal, playerId } = {}) {
      const on = (type, handler) => events.addEventListener(type, handler, { signal });

      on('fired', ({ detail }) => {
        const own = detail.shipId === playerId;
        // Легка випадковість висоти, щоб черга не звучала як кулемет з одного семпла.
        play('shoot', { volume: own ? 0.9 : 0.45, rate: 0.94 + Math.random() * 0.12 });
      });
      on('hit', ({ detail }) => {
        play('hit', { volume: detail.targetKind === 'ship' ? 0.9 : 0.5 });
      });
      on('exploded', ({ detail }) => {
        play('explode', { volume: detail.kind === 'ship' ? 1 : 0.6 });
      });
      on('pickup', () => play('pickup'));
    },
  };
}
