import { binaryCodec } from './binary.js';
import { jsonCodec } from './json.js';

export { CodecError } from './binary.js';
export const CODECS = Object.freeze({ binary: binaryCodec, json: jsonCodec });
