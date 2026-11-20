import type { CodecName, Input, Snapshot } from '../protocol.ts';
import { binaryCodec } from './binary.ts';
import { jsonCodec } from './json.ts';

export { CodecError } from './error.ts';

// Кодек — інтерфейс із двома реалізаціями. Решта коду не знає, байти це чи текст:
// вона працює з Input і Snapshot, а формат на дроті — деталь, яку можна перемкнути.
export interface Codec {
  readonly name: CodecName;
  encodeInput(input: Input): Uint8Array | string;
  // unknown: на вході — що завгодно з мережі; кодек або поверне перевірене значення,
  // або кине CodecError.
  decodeInput(data: unknown): Input;
  encodeSnapshot(snapshot: Snapshot): Uint8Array | string;
  decodeSnapshot(data: unknown): Snapshot;
}

export const CODECS: Readonly<Record<CodecName, Codec>> = Object.freeze({
  binary: binaryCodec,
  json: jsonCodec,
});
