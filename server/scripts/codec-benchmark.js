// JSON проти бінарного кодека на справжніх знімках: матч із 4 гравцями, 30 кроків/с.
//
//   npm run bench:codec -w server
//
// Матч рахується тим самим класом Match, що й на сервері; знімки перехоплюються
// до кодування і потім проганяються через обидва кодеки.

import { CODECS } from '@moba-arena/shared/codec/index.js';
import { TICK_RATE } from '@moba-arena/shared/protocol.js';
import { Match } from '../src/match.js';
import { Room } from '../src/rooms.js';

const PLAYERS = 4;
const TICKS = TICK_RATE * 60; // хвилина матчу
const logger = { info() {}, warn() {}, error() {} };

const room = new Room({
  id: 'bench',
  name: 'bench',
  arena: { width: 1600, height: 900, asteroids: 5, pickups: 2, seed: 1 },
  maxPlayers: 8,
});
const match = new Match({ room, logger });

const snapshots = []; // знімки для гравця 0, ще не закодовані
const inputs = [];
const capture = { encodeSnapshot: (snapshot) => (snapshots.push(snapshot), { length: 0 }) };
const discard = { encodeSnapshot: () => ({ length: 0 }) };
for (let i = 0; i < PLAYERS; i += 1) {
  match.addPlayer({ id: `p${i}`, name: `Гравець ${i}` });
  match.attach(`p${i}`, { codec: i === 0 ? capture : discard, send: () => true });
}

// Гравці весь час летять, повертають і стріляють — близько до найгіршого випадку.
for (let tick = 1; tick <= TICKS; tick += 1) {
  for (let i = 0; i < PLAYERS; i += 1) {
    const input = {
      seq: tick,
      turn:
        Math.floor((tick + i * 37) / 45) % 3 === 0
          ? 1
          : Math.floor((tick + i * 11) / 30) % 4 === 0
            ? -1
            : 0,
      thrust: (tick + i * 20) % 120 < 90 ? 1 : 0,
      brake: false,
      dash: (tick + i * 50) % 200 === 0,
      fire: (tick + i) % 2 === 0,
    };
    if (i === 0) inputs.push(input);
    match.pushInput(`p${i}`, input);
  }
  match.tick();
}

const bytes = (data) => (typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength);

function measure(codec) {
  const encodedSnapshots = snapshots.map((snapshot) => codec.encodeSnapshot(snapshot));
  const encodedInputs = inputs.map((input) => codec.encodeInput(input));
  const snapshotBytes =
    encodedSnapshots.reduce((sum, data) => sum + bytes(data), 0) / snapshots.length;
  const inputBytes = encodedInputs.reduce((sum, data) => sum + bytes(data), 0) / inputs.length;

  // Час encode + decode одного знімка: кілька проходів на прогрів, потім замір.
  const pass = () => {
    for (const snapshot of snapshots) codec.decodeSnapshot(codec.encodeSnapshot(snapshot));
  };
  for (let i = 0; i < 5; i += 1) pass();
  const rounds = 20;
  const started = performance.now();
  for (let i = 0; i < rounds; i += 1) pass();
  const micros = ((performance.now() - started) * 1000) / (rounds * snapshots.length);

  return {
    'байтів/знімок': Math.round(snapshotBytes),
    'КБ/с вниз': Number(((snapshotBytes * TICK_RATE) / 1024).toFixed(2)),
    'байтів/input': Number(inputBytes.toFixed(1)),
    'КБ/с вгору': Number(((inputBytes * TICK_RATE) / 1024).toFixed(2)),
    'encode+decode, мкс': Number(micros.toFixed(1)),
  };
}

const entities =
  snapshots.reduce((sum, snapshot) => sum + snapshot.entities.length, 0) / snapshots.length;
console.log(
  `${PLAYERS} гравці, ${TICK_RATE} знімків/с, ${TICKS} кроків; у середньому ${entities.toFixed(1)} сутностей у знімку`,
);
console.table({ JSON: measure(CODECS.json), 'Binary (DataView)': measure(CODECS.binary) });
