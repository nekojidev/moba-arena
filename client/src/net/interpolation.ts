// Інтерполяція чужих сутностей. Знімки приходять 30 разів/с, екран малює 60–144.
// Малювати «останній відомий стан» — отже смикатися з кожним знімком і завмирати,
// коли знімок запізнився. Тому малюємо світ НАВМИСНО В МИНУЛОМУ — на delay мс позаду:
// для такого моменту в буфері вже є знімок «до» і знімок «після», і між ними можна
// чесно інтерполювати, нічого не вгадуючи.

import type { EntityId, Tick } from '@moba-arena/shared/brand.ts';
import { TICK_MS, type Snapshot, type SnapshotEntity } from '@moba-arena/shared/protocol.ts';
import { shortestDelta, wrap, type Arena } from '@moba-arena/shared/sim/arena.ts';

const TAU = Math.PI * 2;
const TELEPORT = 300; // стрибок більший за це (респаун) не «розмазуємо» по арені

interface Frame {
  readonly tick: Tick;
  readonly time: number;
  readonly entities: ReadonlyMap<EntityId, SnapshotEntity>;
}

export interface Sample {
  readonly entities: SnapshotEntity[];
  readonly starved: boolean;
}

export interface Interpolator {
  readonly size: number;
  readonly latestTime: number | null;
  readonly latest: Frame | null;
  push(snapshot: Pick<Snapshot, 'tick' | 'entities'>): boolean;
  sample(renderTime: number): Sample;
}

export function createInterpolator({
  arena,
  capacity = 40,
}: {
  readonly arena: Arena;
  readonly capacity?: number;
}): Interpolator {
  const buffer: Frame[] = []; // за зростанням tick

  function blend(a: SnapshotEntity, b: SnapshotEntity, t: number): SnapshotEntity {
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
      return buffer.at(-1)?.time ?? null;
    },
    get latest() {
      return buffer.at(-1) ?? null;
    },

    // Знімок, що прийшов не по порядку (старіший за останній), уже не потрібен.
    push(snapshot) {
      const newest = buffer.at(-1);
      if (newest && snapshot.tick <= newest.tick) return false;
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
      const first = buffer[0];
      const last = buffer.at(-1);
      if (!first || !last) return { entities: [], starved: true };
      if (renderTime >= last.time) return { entities: [...last.entities.values()], starved: true };
      if (renderTime <= first.time)
        return { entities: [...first.entities.values()], starved: false };

      // Останній знімок, що не пізніший за renderTime, — це «до»; наступний за ним — «після».
      const index = buffer.findLastIndex((frame) => frame.time <= renderTime);
      const from = buffer[index];
      const to = buffer[index + 1];
      // Перевірки вище гарантують, що обидва є; для tsc елемент масиву — «значення або undefined».
      if (!from || !to) return { entities: [...last.entities.values()], starved: true };
      const t = (renderTime - from.time) / (to.time - from.time);

      const entities: SnapshotEntity[] = [];
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

export interface ServerClock {
  readonly ready: boolean;
  observe(snapshotTime: number, now: number): void;
  now(clientNow: number): number;
}

// Оцінка «котра зараз година на сервері». Кожен знімок дає зразок
// (час отримання − час знімка); згладжуємо, щоб розкид затримки не смикав годинник.
export function createServerClock(): ServerClock {
  let offset: number | null = null;
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
    // Поки зразків немає (ready === false), зсув вважаємо нульовим.
    now: (clientNow) => clientNow - (offset ?? 0),
  };
}
