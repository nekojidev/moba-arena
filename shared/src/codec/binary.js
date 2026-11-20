// Бінарний кодек на DataView. Специфікація формату — shared/PROTOCOL.md.
//
// Чому DataView, а не Float32Array поверх буфера: у повідомленні впереміш лежать
// u8, u16, u32, i16 і f32 за довільними зсувами, а типізований масив вимагає вирівнювання
// й бере порядок байтів ПРОЦЕСОРА. DataView читає будь-який тип із будь-якого зсуву і
// приймає порядок байтів явно — тут усюди little-endian (true останнім аргументом).

import { EFFECTS, KINDS, MESSAGE, PROTOCOL_VERSION } from '../protocol.js';

const LE = true;
const POSITION_SCALE = 16; // позиція чужих сутностей: u16, крок 1/16 одиниці
const ANGLE_SCALE = 32767 / Math.PI; // кут: i16, крок ≈ 0.0055°
const TAU = Math.PI * 2;

export class CodecError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CodecError';
  }
}

// Ці три функції експортовано, щоб тести знали точну похибку квантування.
export function quantizeAngle(angle) {
  const wrapped = ((((angle + Math.PI) % TAU) + TAU) % TAU) - Math.PI; // [-π, π)
  return Math.round(wrapped * ANGLE_SCALE);
}
export const dequantizeAngle = (value) => value / ANGLE_SCALE;
export const quantizePosition = (value) => Math.round(value * POSITION_SCALE) / POSITION_SCALE;

// Приймає ArrayBuffer (браузер) або Uint8Array/Buffer (Node). У Buffer дані можуть лежати
// не з початку спільного ArrayBuffer — тому обов'язково враховуємо byteOffset.
function view(data) {
  if (data instanceof ArrayBuffer) return new DataView(data);
  if (ArrayBuffer.isView(data)) return new DataView(data.buffer, data.byteOffset, data.byteLength);
  throw new CodecError('expected binary data');
}

function header(dv, type, minLength) {
  if (dv.byteLength < minLength) throw new CodecError('message is too short');
  if (dv.getUint8(0) !== PROTOCOL_VERSION) throw new CodecError('unsupported protocol version');
  if (dv.getUint8(1) !== type) throw new CodecError('unexpected message type');
}

// --- input: 8 байтів -----------------------------------------------------------------------

const INPUT_BYTES = 8;
const BUTTON = { thrust: 1, brake: 2, dash: 4, fire: 8 };

export function encodeInput(input) {
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

export function decodeInput(data) {
  const dv = view(data);
  header(dv, MESSAGE.INPUT, INPUT_BYTES);
  if (dv.byteLength !== INPUT_BYTES) throw new CodecError('wrong input length');
  const buttons = dv.getUint8(6);
  const turn = dv.getInt8(7);
  if (buttons > 15 || turn < -1 || turn > 1) throw new CodecError('input out of range');
  return {
    seq: dv.getUint32(2, LE),
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
const TAIL_BYTES = { ship: 3, bullet: 4, asteroid: 1, pickup: 1 };

const SELF = { present: 1, down: 2, shield: 4, rapid: 8, homing: 16 };
const FLAG = { down: 1, shield: 2, thrust: 4, homing: 8 };

export function snapshotByteLength(snapshot) {
  let bytes = SNAPSHOT_HEADER + SELF_BYTES + 2;
  for (const entity of snapshot.entities) bytes += ENTITY_BYTES + TAIL_BYTES[entity.kind];
  return bytes;
}

export function encodeSnapshot(snapshot) {
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
    dv.setUint8(
      o + 5,
      (entity.down ? FLAG.down : 0) |
        (entity.shield ? FLAG.shield : 0) |
        (entity.thrust ? FLAG.thrust : 0) |
        (entity.homing ? FLAG.homing : 0),
    );
    dv.setUint16(o + 6, Math.round(entity.x * POSITION_SCALE), LE);
    dv.setUint16(o + 8, Math.round(entity.y * POSITION_SCALE), LE);
    dv.setInt16(o + 10, quantizeAngle(entity.angle), LE);
    o += ENTITY_BYTES;

    if (entity.kind === 'ship') {
      dv.setUint8(o, entity.hp);
      dv.setUint16(o + 1, Math.min(65535, entity.score), LE);
    } else if (entity.kind === 'bullet') {
      dv.setUint32(o, entity.owner, LE);
    } else if (entity.kind === 'asteroid') {
      dv.setUint8(o, entity.size);
    } else {
      dv.setUint8(o, EFFECTS.indexOf(entity.effect));
    }
    o += TAIL_BYTES[entity.kind];
  }

  return new Uint8Array(dv.buffer);
}

export function decodeSnapshot(data) {
  const dv = view(data);
  header(dv, MESSAGE.SNAPSHOT, SNAPSHOT_HEADER + SELF_BYTES + 2);

  let o = SNAPSHOT_HEADER;
  const selfFlags = dv.getUint8(o);
  const self =
    selfFlags & SELF.present
      ? {
          down: Boolean(selfFlags & SELF.down),
          shield: Boolean(selfFlags & SELF.shield),
          rapid: Boolean(selfFlags & SELF.rapid),
          homing: Boolean(selfFlags & SELF.homing),
          hp: dv.getUint8(o + 1),
          x: dv.getFloat32(o + 2, LE),
          y: dv.getFloat32(o + 6, LE),
          vx: dv.getFloat32(o + 10, LE),
          vy: dv.getFloat32(o + 14, LE),
          angle: dequantizeAngle(dv.getInt16(o + 18, LE)),
          dashCooldown: dv.getFloat32(o + 20, LE),
          fireCooldown: dv.getFloat32(o + 24, LE),
          respawnTimer: dv.getFloat32(o + 28, LE),
        }
      : null;
  o += SELF_BYTES;

  const count = dv.getUint16(o, LE);
  o += 2;
  const entities = [];
  for (let i = 0; i < count; i += 1) {
    if (o + ENTITY_BYTES > dv.byteLength) throw new CodecError('snapshot is truncated');
    const kind = KINDS[dv.getUint8(o + 4)];
    if (!kind) throw new CodecError('unknown entity kind');
    const flags = dv.getUint8(o + 5);
    const entity = {
      id: dv.getUint32(o, LE),
      kind,
      x: dv.getUint16(o + 6, LE) / POSITION_SCALE,
      y: dv.getUint16(o + 8, LE) / POSITION_SCALE,
      angle: dequantizeAngle(dv.getInt16(o + 10, LE)),
    };
    o += ENTITY_BYTES;
    if (o + TAIL_BYTES[kind] > dv.byteLength) throw new CodecError('snapshot is truncated');

    if (kind === 'ship') {
      entity.hp = dv.getUint8(o);
      entity.score = dv.getUint16(o + 1, LE);
      entity.down = Boolean(flags & FLAG.down);
      entity.shield = Boolean(flags & FLAG.shield);
      entity.thrust = Boolean(flags & FLAG.thrust);
    } else if (kind === 'bullet') {
      entity.owner = dv.getUint32(o, LE);
      entity.homing = Boolean(flags & FLAG.homing);
    } else if (kind === 'asteroid') {
      entity.size = dv.getUint8(o);
      entity.homing = Boolean(flags & FLAG.homing);
    } else {
      entity.effect = EFFECTS[dv.getUint8(o)];
    }
    o += TAIL_BYTES[kind];
    entities.push(entity);
  }

  return { tick: dv.getUint32(2, LE), ack: dv.getUint32(6, LE), self, entities };
}

export const binaryCodec = Object.freeze({
  name: 'binary',
  encodeInput,
  decodeInput,
  encodeSnapshot,
  decodeSnapshot,
});
