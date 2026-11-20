// JSON-кодек: ті самі повідомлення текстом. Лишається за прапорцем (?codec=json),
// щоб було з чим порівнювати бінарний формат. Розбір — тими самими схемами Zod.

import type { z } from 'zod';
import {
  inputMessageSchema,
  PROTOCOL_VERSION,
  snapshotMessageSchema,
  type Input,
  type Snapshot,
} from '../protocol.ts';
import { CodecError } from './error.ts';
import type { Codec } from './index.ts';

// Рядок розбираємо як JSON; уже розібраний об'єкт (сокет міг зробити це раніше) беремо як є.
function parse<T>(data: unknown, schema: z.ZodType<T>): T {
  let raw: unknown = data;
  if (typeof data === 'string') {
    try {
      raw = JSON.parse(data);
    } catch {
      throw new CodecError('invalid JSON');
    }
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new CodecError(`invalid message: ${result.error.issues[0]?.path.join('.') ?? ''}`);
  }
  return result.data;
}

export function encodeInput(input: Input): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, type: 'input', ...input });
}

export function decodeInput(data: unknown): Input {
  const { seq, turn, thrust, brake, dash, fire } = parse(data, inputMessageSchema);
  return { seq, turn, thrust, brake, dash, fire };
}

export function encodeSnapshot(snapshot: Snapshot): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, type: 'snapshot', ...snapshot });
}

export function decodeSnapshot(data: unknown): Snapshot {
  const { tick, ack, self, entities } = parse(data, snapshotMessageSchema);
  return { tick, ack, self, entities };
}

export const jsonCodec: Codec = Object.freeze({
  name: 'json',
  encodeInput,
  decodeInput,
  encodeSnapshot,
  decodeSnapshot,
});
