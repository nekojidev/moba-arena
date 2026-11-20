// JSON-кодек: ті самі повідомлення текстом. Лишається за прапорцем (?codec=json),
// щоб було з чим порівнювати бінарний формат.

import { PROTOCOL_VERSION } from '../protocol.js';
import { CodecError } from './binary.js';

function parse(data, type) {
  let message;
  try {
    message = typeof data === 'string' ? JSON.parse(data) : data;
  } catch {
    throw new CodecError('invalid JSON');
  }
  if (message === null || typeof message !== 'object') throw new CodecError('not an object');
  if (message.v !== PROTOCOL_VERSION) throw new CodecError('unsupported protocol version');
  if (message.type !== type) throw new CodecError('unexpected message type');
  return message;
}

export function encodeInput(input) {
  return JSON.stringify({ v: PROTOCOL_VERSION, type: 'input', ...input });
}

// Вхід від клієнта перевіряємо так само суворо, як і в бінарному кодеку.
export function decodeInput(data) {
  const { seq, turn, thrust, brake, dash, fire } = parse(data, 'input');
  const valid =
    Number.isInteger(seq) &&
    seq >= 0 &&
    seq <= 0xffffffff &&
    (turn === -1 || turn === 0 || turn === 1) &&
    (thrust === 0 || thrust === 1) &&
    typeof brake === 'boolean' &&
    typeof dash === 'boolean' &&
    typeof fire === 'boolean';
  if (!valid) throw new CodecError('input out of range');
  return { seq, turn, thrust, brake, dash, fire };
}

export function encodeSnapshot(snapshot) {
  return JSON.stringify({ v: PROTOCOL_VERSION, type: 'snapshot', ...snapshot });
}

export function decodeSnapshot(data) {
  const { tick, ack, self, entities } = parse(data, 'snapshot');
  return { tick, ack, self, entities };
}

export const jsonCodec = Object.freeze({
  name: 'json',
  encodeInput,
  decodeInput,
  encodeSnapshot,
  decodeSnapshot,
});
