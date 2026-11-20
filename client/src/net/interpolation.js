// Інтерполяція чужих сутностей. Знімки приходять 30 разів/с, екран малює 60–144.
// Малювати «останній відомий стан» — отже смикатися з кожним знімком і завмирати,
// коли знімок запізнився. Тому малюємо світ НАВМИСНО В МИНУЛОМУ — на delay мс позаду:
// для такого моменту в буфері вже є знімок «до» і знімок «після», і між ними можна
// чесно інтерполювати, нічого не вгадуючи.

import { TICK_MS } from '@moba-arena/shared/protocol.js';
import { shortestDelta, wrap } from '@moba-arena/shared/sim/arena.js';

const TAU = Math.PI * 2;
const TELEPORT = 300; // стрибок більший за це (респаун) не «розмазуємо» по арені

export function createInterpolator({ arena, capacity = 40 }) {
  const buffer = []; // { tick, time, entities: Map<id, запис> }, за зростанням tick

  function blend(a, b, t) {
    const dx = shortestDelta(a.x, b.x, arena.width);
    const dy = shortestDelta(a.y, b.y, arena.height);
    if (Math.hypot(dx, dy) > TELEPORT) return t < 0.5 ? a : b;
    return {
      ...a,
      x: wrap(a.x + dx * t, arena.width),
      y: wrap(a.y + dy * t, arena.height),
      angle: a.angle + shortestDelta(a.angle, b.angle, TAU) * t,
    };
  }

  return {
    get size() {
      return buffer.length;
    },
    get latestTime() {
      return buffer.length > 0 ? buffer.at(-1).time : null;
    },
    get latest() {
      return buffer.at(-1) ?? null;
    },

    // Знімок, що прийшов не по порядку (старіший за останній), уже не потрібен.
    push(snapshot) {
      if (buffer.length > 0 && snapshot.tick <= buffer.at(-1).tick) return false;
      buffer.push({
        tick: snapshot.tick,
        time: snapshot.tick * TICK_MS,
        entities: new Map(snapshot.entities.map((entity) => [entity.id, entity])),
      });
      if (buffer.length > capacity) buffer.shift();
      return true;
    },

    // Стан світу на момент renderTime (у мілісекундах серверного часу).
    //   starved: true — потрібного «після» ще немає (буфер спорожнів): тримаємо останній
    //   знімок і не екстраполюємо — краще на мить завмерти, ніж показати те, чого не було.
    sample(renderTime) {
      if (buffer.length === 0) return { entities: [], starved: true };
      const last = buffer.at(-1);
      if (renderTime >= last.time) return { entities: [...last.entities.values()], starved: true };
      if (renderTime <= buffer[0].time) {
        return { entities: [...buffer[0].entities.values()], starved: false };
      }

      let index = buffer.length - 2;
      while (buffer[index].time > renderTime) index -= 1;
      const from = buffer[index];
      const to = buffer[index + 1];
      const t = (renderTime - from.time) / (to.time - from.time);

      const entities = [];
      for (const [id, a] of from.entities) {
        const b = to.entities.get(id);
        // Сутність зникла в наступному знімку — домальовуємо її до цього моменту як є.
        // Сутність, що з'явилась лише в наступному, почне малюватися, коли він стане «до».
        entities.push(b ? blend(a, b, t) : a);
      }
      return { entities, starved: false };
    },
  };
}

// Оцінка «котра зараз година на сервері». Кожен знімок дає зразок
// (час отримання − час знімка); згладжуємо, щоб розкид затримки не смикав годинник.
export function createServerClock() {
  let offset = null;
  return {
    get ready() {
      return offset !== null;
    },
    observe(snapshotTime, now) {
      const sample = now - snapshotTime;
      if (offset === null || Math.abs(sample - offset) > 250) offset = sample;
      else offset += (sample - offset) * 0.05;
    },
    // Серверний час, який «зараз» видно клієнту (тобто вже з урахуванням затримки мережі).
    now: (clientNow) => clientNow - offset,
  };
}
