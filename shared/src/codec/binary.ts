// Бінарний кодек на DataView. Специфікація формату — shared/PROTOCOL.md.
//
// Чому DataView, а не Float32Array поверх буфера: у повідомленні впереміш лежать
// u8, u16, u32, i16 і f32 за довільними зсувами, а типізований масив вимагає вирівнювання
// й бере порядок байтів ПРОЦЕСОРА. DataView читає будь-який тип із будь-якого зсуву і
// приймає порядок байтів явно — тут усюди little-endian (true останнім аргументом).
//
// Zod тут не використовується: декодер сам перевіряє довжину, версію і діапазони,
// і лише після цього збирає значення потрібного типу.

import { brand, type EntityId, type Seq, type Tick } from '../brand.ts';
import {
  EFFECTS,
  KINDS,
  MESSAGE,
  PROTOCOL_VERSION,
  type Input,
  type SelfState,
  type Snapshot,
  type SnapshotEntity,
} from '../protocol.ts';
import { CodecError } from './error.ts';
import type { Codec } from './index.ts';

const LE = true;
const POSITION_SCALE = 16; // позиція чужих сутностей: u16, крок 1/16 одиниці
const ANGLE_SCALE = 32767 / Math.PI; // кут: i16, крок ≈ 0.0055°
const TAU = Math.PI * 2;

// Ці три функції експортовано, щоб тести знали точну похибку квантування.
export function quantizeAngle(angle: number): number {
  const wrapped = ((((angle + Math.PI) % TAU) + TAU) % TAU) - Math.PI; // [-π, π)
  return Math.round(wrapped * ANGLE_SCALE);
}
export const dequantizeAngle = (value: number): number => value / ANGLE_SCALE;
export const quantizePosition = (value: number): number =>
  Math.round(value * POSITION_SCALE) / POSITION_SCALE;

// Сюди потрапляє значення, якого за типами бути не може (див. combat.ts).
function unreachable(value: never): never {
  throw new CodecError(`unhandled variant: ${JSON.stringify(value)}`);
}

// Приймає ArrayBuffer (браузер) або Uint8Array/Buffer (Node). У Buffer дані можуть лежати
// не з початку спільного ArrayBuffer — тому обов'язково враховуємо byteOffset.
function view(data: unknown): DataView {
  if (data instanceof ArrayBuffer) return new DataView(data);
  if (ArrayBuffer.isView(data)) return new DataView(data.buffer, data.byteOffset, data.byteLength);
  throw new CodecError('expected binary data');
}

function header(dv: DataView, type: number, minLength: number): void {
  if (dv.byteLength < minLength) throw new CodecError('message is too short');
  if (dv.getUint8(0) !== PROTOCOL_VERSION) throw new CodecError('unsupported protocol version');
  if (dv.getUint8(1) !== type) throw new CodecError('unexpected message type');
}

// --- input: 8 байтів -----------------------------------------------------------------------

const INPUT_BYTES = 8;
const BUTTON = { thrust: 1, brake: 2, dash: 4, fire: 8 };

export function encodeInput(input: Input): Uint8Array {
  const dv = new DataView(new ArrayBuffer(INPUT_BYTES));
  dv.setUint8(0, PROTOCOL_VERSION);
  dv.setUint8(1, MESSAGE.INPUT);
  dv.setUint32(2, input.seq, LE);
  dv.setUint8(
    6,
    (input.thrust ? BUTTON.thrust : 0) |
      (input.brake ? BUTTON.brake : 0) |
      (input.dash ? BUTTON.dash : 0) |
      (input.fire ? BUTTON.fire : 0),
  );
  dv.setInt8(7, input.turn);
  return new Uint8Array(dv.buffer);
}

export function decodeInput(data: unknown): Input {
  const dv = view(data);
  header(dv, MESSAGE.INPUT, INPUT_BYTES);
  if (dv.byteLength !== INPUT_BYTES) throw new CodecError('wrong input length');
  const buttons = dv.getUint8(6);
  const turn = dv.getInt8(7);
  // Після цієї перевірки tsc знає, що turn — це −1 | 0 | 1, а не будь-яке число.
  if (buttons > 15 || (turn !== -1 && turn !== 0 && turn !== 1)) {
    throw new CodecError('input out of range');
  }
  return {
    seq: brand<Seq>(dv.getUint32(2, LE)),
    turn,
    thrust: buttons & BUTTON.thrust ? 1 : 0,
    brake: Boolean(buttons & BUTTON.brake),
    dash: Boolean(buttons & BUTTON.dash),
    fire: Boolean(buttons & BUTTON.fire),
  };
}

// --- snapshot ------------------------------------------------------------------------------

const SNAPSHOT_HEADER = 10; // version, type, tick u32, ack u32
const SELF_BYTES = 32;
const ENTITY_BYTES = 12; // id u32, kind u8, flags u8, x u16, y u16, angle i16
// Record за видом: додаси вид у протокол — tsc вимагатиме рядок і тут.
const TAIL_BYTES: Record<SnapshotEntity['kind'], number> = {
  ship: 3,
  bullet: 4,
  asteroid: 1,
  pickup: 1,
};

const SELF = { present: 1, down: 2, shield: 4, rapid: 8, homing: 16 };
const FLAG = { down: 1, shield: 2, thrust: 4, homing: 8 };
const MAX_HP = 100;

export function snapshotByteLength(snapshot: Snapshot): number {
  let bytes = SNAPSHOT_HEADER + SELF_BYTES + 2;
  for (const entity of snapshot.entities) bytes += ENTITY_BYTES + TAIL_BYTES[entity.kind];
  return bytes;
}

export function encodeSnapshot(snapshot: Snapshot): Uint8Array {
  const dv = new DataView(new ArrayBuffer(snapshotByteLength(snapshot)));
  dv.setUint8(0, PROTOCOL_VERSION);
  dv.setUint8(1, MESSAGE.SNAPSHOT);
  dv.setUint32(2, snapshot.tick, LE);
  dv.setUint32(6, snapshot.ack, LE);

  // Власний герой — точно (f32): із цього стану клієнт заново програє свої input.
  const self = snapshot.self;
  let o = SNAPSHOT_HEADER;
  if (self) {
    dv.setUint8(
      o,
      SELF.present |
        (self.down ? SELF.down : 0) |
        (self.shield ? SELF.shield : 0) |
        (self.rapid ? SELF.rapid : 0) |
        (self.homing ? SELF.homing : 0),
    );
    dv.setUint8(o + 1, self.hp);
    dv.setFloat32(o + 2, self.x, LE);
    dv.setFloat32(o + 6, self.y, LE);
    dv.setFloat32(o + 10, self.vx, LE);
    dv.setFloat32(o + 14, self.vy, LE);
    dv.setInt16(o + 18, quantizeAngle(self.angle), LE);
    dv.setFloat32(o + 20, self.dashCooldown, LE);
    dv.setFloat32(o + 24, self.fireCooldown, LE);
    dv.setFloat32(o + 28, self.respawnTimer, LE);
  }
  o += SELF_BYTES;

  dv.setUint16(o, snapshot.entities.length, LE);
  o += 2;

  // Решта сутностей — стисло: їх лише малюють, тож 1/16 одиниці вистачає з запасом.
  for (const entity of snapshot.entities) {
    dv.setUint32(o, entity.id, LE);
    dv.setUint8(o + 4, KINDS.indexOf(entity.kind));
    dv.setUint16(o + 6, Math.round(entity.x * POSITION_SCALE), LE);
    dv.setUint16(o + 8, Math.round(entity.y * POSITION_SCALE), LE);
    dv.setInt16(o + 10, quantizeAngle(entity.angle), LE);
    const tail = o + ENTITY_BYTES;

    // Усередині кожного case tsc знає точний вид запису — і які в нього поля.
    switch (entity.kind) {
      case 'ship':
        dv.setUint8(
          o + 5,
          (entity.down ? FLAG.down : 0) |
            (entity.shield ? FLAG.shield : 0) |
            (entity.thrust ? FLAG.thrust : 0),
        );
        dv.setUint8(tail, entity.hp);
        dv.setUint16(tail + 1, Math.min(65535, entity.score), LE);
        break;
      case 'bullet':
        dv.setUint8(o + 5, entity.homing ? FLAG.homing : 0);
        dv.setUint32(tail, entity.owner, LE);
        break;
      case 'asteroid':
        dv.setUint8(o + 5, entity.homing ? FLAG.homing : 0);
        dv.setUint8(tail, entity.size);
        break;
      case 'pickup':
        dv.setUint8(tail, EFFECTS.indexOf(entity.effect));
        break;
      default:
        unreachable(entity);
    }
    o = tail + TAIL_BYTES[entity.kind];
  }

  return new Uint8Array(dv.buffer);
}

function decodeSelf(dv: DataView, o: number): SelfState | null {
  const flags = dv.getUint8(o);
  if (!(flags & SELF.present)) return null;
  const hp = dv.getUint8(o + 1);
  const floats = [2, 6, 10, 14, 20, 24, 28].map((offset) => dv.getFloat32(o + offset, LE));
  const [x, y, vx, vy, dashCooldown, fireCooldown, respawnTimer] = floats;
  // noUncheckedIndexedAccess: елементи масиву можуть бути undefined, а з мережі може
  // прийти NaN чи Infinity — одна перевірка закриває обидва випадки.
  if (
    hp > MAX_HP ||
    x === undefined ||
    y === undefined ||
    vx === undefined ||
    vy === undefined ||
    dashCooldown === undefined ||
    fireCooldown === undefined ||
    respawnTimer === undefined ||
    !floats.every(Number.isFinite)
  ) {
    throw new CodecError('self state out of range');
  }
  return {
    down: Boolean(flags & SELF.down),
    shield: Boolean(flags & SELF.shield),
    rapid: Boolean(flags & SELF.rapid),
    homing: Boolean(flags & SELF.homing),
    hp,
    x,
    y,
    vx,
    vy,
    angle: dequantizeAngle(dv.getInt16(o + 18, LE)),
    dashCooldown,
    fireCooldown,
    respawnTimer,
  };
}

export function decodeSnapshot(data: unknown): Snapshot {
  const dv = view(data);
  header(dv, MESSAGE.SNAPSHOT, SNAPSHOT_HEADER + SELF_BYTES + 2);

  let o = SNAPSHOT_HEADER;
  const self = decodeSelf(dv, o);
  o += SELF_BYTES;

  const count = dv.getUint16(o, LE);
  o += 2;
  const entities: SnapshotEntity[] = [];
  for (let i = 0; i < count; i += 1) {
    if (o + ENTITY_BYTES > dv.byteLength) throw new CodecError('snapshot is truncated');
    const kind = KINDS[dv.getUint8(o + 4)];
    if (kind === undefined) throw new CodecError('unknown entity kind');
    const flags = dv.getUint8(o + 5);
    const placed = {
      id: brand<EntityId>(dv.getUint32(o, LE)),
      x: dv.getUint16(o + 6, LE) / POSITION_SCALE,
      y: dv.getUint16(o + 8, LE) / POSITION_SCALE,
      angle: dequantizeAngle(dv.getInt16(o + 10, LE)),
    };
    const tail = o + ENTITY_BYTES;
    if (tail + TAIL_BYTES[kind] > dv.byteLength) throw new CodecError('snapshot is truncated');

    switch (kind) {
      case 'ship': {
        const hp = dv.getUint8(tail);
        if (hp > MAX_HP) throw new CodecError('hp out of range');
        entities.push({
          kind,
          ...placed,
          hp,
          score: dv.getUint16(tail + 1, LE),
          down: Boolean(flags & FLAG.down),
          shield: Boolean(flags & FLAG.shield),
          thrust: Boolean(flags & FLAG.thrust),
        });
        break;
      }
      case 'bullet':
        entities.push({
          kind,
          ...placed,
          owner: brand<EntityId>(dv.getUint32(tail, LE)),
          homing: Boolean(flags & FLAG.homing),
        });
        break;
      case 'asteroid': {
        const size = dv.getUint8(tail);
        if (size !== 1 && size !== 2 && size !== 3) throw new CodecError('size out of range');
        entities.push({ kind, ...placed, size, homing: Boolean(flags & FLAG.homing) });
        break;
      }
      case 'pickup': {
        const effect = EFFECTS[dv.getUint8(tail)];
        if (effect === undefined) throw new CodecError('unknown effect');
        entities.push({ kind, ...placed, effect });
        break;
      }
      default:
        unreachable(kind);
    }
    o = tail + TAIL_BYTES[kind];
  }

  return {
    tick: brand<Tick>(dv.getUint32(2, LE)),
    ack: brand<Seq>(dv.getUint32(6, LE)),
    self,
    entities,
  };
}

export const binaryCodec: Codec = Object.freeze({
  name: 'binary',
  encodeInput,
  decodeInput,
  encodeSnapshot,
  decodeSnapshot,
});
