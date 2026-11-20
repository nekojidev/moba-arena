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
  // Ті самі записи масивом (це масив зі знімка): обхід за індексом не створює ітератор.
  readonly list: readonly SnapshotEntity[];
}

export interface Sample {
  readonly entities: SnapshotEntity[];
  readonly starved: boolean;
}

// Результат для рендера без створення об'єктів: записи — це посилання на записи знімка,
// а інтерпольовані x, y, angle лежать у трьох масивах за тим самим індексом.
// Буфер створюється один раз і заповнюється заново щокадру.
export interface SampleBuffer {
  readonly records: SnapshotEntity[];
  x: Float64Array;
  y: Float64Array;
  angle: Float64Array;
  count: number;
  starved: boolean;
}

export function createSampleBuffer(capacity = 256): SampleBuffer {
  return {
    records: [],
    x: new Float64Array(capacity),
    y: new Float64Array(capacity),
    angle: new Float64Array(capacity),
    count: 0,
    starved: true,
  };
}

export interface Interpolator {
  readonly size: number;
  readonly latestTime: number | null;
  readonly latest: Frame | null;
  push(snapshot: Pick<Snapshot, 'tick' | 'entities'>): boolean;
  sample(renderTime: number): Sample;
  sampleInto(renderTime: number, out: SampleBuffer): void;
}

export function createInterpolator({
  arena,
  // 12 знімків = 0,4 с — із запасом для затримки інтерполяції до 300 мс. Довший буфер
  // тримав би записи понад секунду: вони встигали б «постаріти» й перейти в стару
  // купу, а її прибирає вже дороге велике збирання сміття.
  capacity = 12,
}: {
  readonly arena: Arena;
  readonly capacity?: number;
}): Interpolator {
  const buffer: Frame[] = []; // за зростанням tick

  // Запис «як є» у комірку буфера.
  function put(
    out: SampleBuffer,
    record: SnapshotEntity,
    x: number,
    y: number,
    angle: number,
  ): void {
    const i = out.count;
    if (i >= out.x.length) {
      // Сутностей більше, ніж місця: подвоюємо масиви (трапляється рідко, не щокадру).
      const grow = (old: Float64Array): Float64Array => {
        const bigger = new Float64Array(old.length * 2);
        bigger.set(old);
        return bigger;
      };
      out.x = grow(out.x);
      out.y = grow(out.y);
      out.angle = grow(out.angle);
    }
    out.records[i] = record;
    out.x[i] = x;
    out.y[i] = y;
    out.angle[i] = angle;
    out.count = i + 1;
  }

  function putFrame(out: SampleBuffer, frame: Frame, starved: boolean): void {
    for (let i = 0; i < frame.list.length; i += 1) {
      const record = frame.list[i];
      if (record) put(out, record, record.x, record.y, record.angle);
    }
    out.starved = starved;
  }

  // Та сама логіка, що й у sample(), але результат пишеться в готовий буфер:
  // жодного нового масиву чи об'єкта на кадр.
  function sampleInto(renderTime: number, out: SampleBuffer): void {
    out.count = 0;
    out.starved = true;
    const first = buffer[0];
    const last = buffer.at(-1);
    if (!first || !last) return;
    if (renderTime >= last.time) return putFrame(out, last, true);
    if (renderTime <= first.time) return putFrame(out, first, false);

    // Останній знімок, що не пізніший за renderTime, — це «до»; наступний за ним — «після».
    let index = buffer.length - 2;
    for (let frame = buffer[index]; frame && frame.time > renderTime; frame = buffer[index])
      index -= 1;
    const from = buffer[index];
    const to = buffer[index + 1];
    if (!from || !to) return putFrame(out, last, true);
    const t = (renderTime - from.time) / (to.time - from.time);

    for (let i = 0; i < from.list.length; i += 1) {
      const a = from.list[i];
      if (!a) continue;
      const b = to.entities.get(a.id);
      // Сутність зникла в наступному знімку — домальовуємо її до цього моменту як є.
      // Сутність, що з'явилась лише в наступному, почне малюватися, коли він стане «до».
      if (!b) {
        put(out, a, a.x, a.y, a.angle);
        continue;
      }
      const dx = shortestDelta(a.x, b.x, arena.width);
      const dy = shortestDelta(a.y, b.y, arena.height);
      if (dx * dx + dy * dy > TELEPORT * TELEPORT) {
        const near = t < 0.5 ? a : b; // стрибок (респаун) не «розмазуємо» по арені
        put(out, a, near.x, near.y, near.angle);
      } else {
        put(
          out,
          a,
          wrap(a.x + dx * t, arena.width),
          wrap(a.y + dy * t, arena.height),
          a.angle + shortestDelta(a.angle, b.angle, TAU) * t,
        );
      }
    }
    out.starved = false;
  }

  // Буфер для sample(): зручний варіант, що повертає нові об'єкти (для тестів і налагодження).
  const scratch = createSampleBuffer();

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
      const entities = new Map<EntityId, SnapshotEntity>();
      for (const entity of snapshot.entities) entities.set(entity.id, entity);
      buffer.push({
        tick: snapshot.tick,
        time: snapshot.tick * TICK_MS,
        entities,
        list: snapshot.entities,
      });
      if (buffer.length > capacity) buffer.shift();
      return true;
    },

    // Стан світу на момент renderTime (у мілісекундах серверного часу).
    //   starved: true — потрібного «після» ще немає (буфер спорожнів): тримаємо останній
    //   знімок і не екстраполюємо — краще на мить завмерти, ніж показати те, чого не було.
    sample(renderTime) {
      sampleInto(renderTime, scratch);
      const entities: SnapshotEntity[] = [];
      for (let i = 0; i < scratch.count; i += 1) {
        const record = scratch.records[i];
        if (!record) continue;
        const x = scratch.x[i] ?? record.x;
        const y = scratch.y[i] ?? record.y;
        const angle = scratch.angle[i] ?? record.angle;
        // Нічого не змінилось — віддаємо сам запис; інакше — копію з новою позою.
        entities.push(
          x === record.x && y === record.y && angle === record.angle
            ? record
            : { ...record, x, y, angle },
        );
      }
      return { entities, starved: scratch.starved };
    },

    sampleInto,
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
