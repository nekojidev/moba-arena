// Керувальна частина протоколу: текстові JSON-повідомлення { v, type, ...поля }.
// Ігрові повідомлення (input, snapshot) і їхні кодеки — у пакеті shared; формат описано
// в shared/PROTOCOL.md.
//
// Клієнт → сервер:  join  { room, name, codec? }   перше повідомлення, не пізніше ніж за 5 с
//                   chat  { text }
//                   ping  { t }                    сервер одразу повертає pong { t }
//                   leave {}
//                   input { seq, turn, … }         лише з codec: "json"; інакше — бінарний кадр
// Сервер → клієнт:  welcome { playerId, shipId, room, tickRate, codec }
//                   roster  { players: [{ id, name, shipId }] }
//                   chat    { from: { id, name }, text, t }
//                   pong    { t }
//                   events  { tick, events: [...] }
//
// Серверу не можна довіряти жодному байту з мережі — навіть якщо клієнта писали ми самі:
// хтось інший напише свого. Тому кожне повідомлення перевіряється повністю.

import { CODECS } from '@moba-arena/shared/codec/index.js';
import { PROTOCOL_VERSION } from '@moba-arena/shared/protocol.js';

export { PROTOCOL_VERSION };

// Коди закриття: 4000–4999 — діапазон, відданий застосункам.
export const CLOSE = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001, // сервер зупиняється
  TOO_BIG: 1009, // повідомлення більше за maxPayload (ставить сама бібліотека ws)
  BAD_MESSAGE: 4000, // не JSON, не об'єкт, не та форма
  UNKNOWN_TYPE: 4001,
  JOIN_TIMEOUT: 4002,
  RATE_LIMIT: 4003,
  JOIN_REJECTED: 4004, // кімнати немає або вона заповнена
  VERSION: 4005,
  SLOW_CLIENT: 4006,
});

const text = (min, max) => (value) =>
  typeof value === 'string' && value.trim().length >= min && value.length <= max;
const optional = (check) => (value) => value === undefined || check(value);
const oneOf =
  (...allowed) =>
  (value) =>
    allowed.includes(value);

// type → { поле: перевірка }. Зайві поля — теж помилка форми.
const CLIENT_MESSAGES = {
  join: { room: text(1, 64), name: text(2, 16), codec: optional(oneOf('binary', 'json')) },
  ping: { t: (value) => Number.isFinite(value) },
  chat: { text: text(1, 200) },
  leave: {},
};

const bad = (code, reason) => ({ ok: false, code, reason });

export function parseClientMessage(data, isBinary = false) {
  if (isBinary) return bad(CLOSE.BAD_MESSAGE, 'binary frames are not supported');

  let message;
  try {
    message = JSON.parse(data.toString());
  } catch {
    return bad(CLOSE.BAD_MESSAGE, 'invalid JSON');
  }
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return bad(CLOSE.BAD_MESSAGE, 'message must be an object');
  }
  if (message.v !== PROTOCOL_VERSION) return bad(CLOSE.VERSION, 'unsupported protocol version');

  // Input у JSON-режимі перевіряє той самий кодек, що й на клієнті.
  if (message.type === 'input') {
    try {
      return { ok: true, message: { type: 'input', input: CODECS.json.decodeInput(message) } };
    } catch (error) {
      return bad(CLOSE.BAD_MESSAGE, error.message);
    }
  }
  if (typeof message.type !== 'string' || !Object.hasOwn(CLIENT_MESSAGES, message.type)) {
    return bad(CLOSE.UNKNOWN_TYPE, 'unknown message type');
  }

  const shape = CLIENT_MESSAGES[message.type];
  for (const key of Object.keys(message)) {
    if (key !== 'v' && key !== 'type' && !Object.hasOwn(shape, key)) {
      return bad(CLOSE.BAD_MESSAGE, `unexpected field "${key.slice(0, 32)}"`);
    }
  }
  for (const [field, isValid] of Object.entries(shape)) {
    if (!isValid(message[field])) return bad(CLOSE.BAD_MESSAGE, `invalid field "${field}"`);
  }

  return { ok: true, message };
}

export function serverMessage(type, payload = {}) {
  return JSON.stringify({ v: PROTOCOL_VERSION, type, ...payload });
}
