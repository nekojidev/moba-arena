// Спільні для клієнта й сервера константи гри та мережі.

export const PROTOCOL_VERSION = 1;

export const TICK_RATE = 30; // кроків симуляції за секунду — і на сервері, і в передбаченні
export const DT = 1 / TICK_RATE;
export const TICK_MS = 1000 / TICK_RATE;

// Типи ігрових повідомлень (другий байт бінарного кадру).
export const MESSAGE = Object.freeze({ INPUT: 1, SNAPSHOT: 2 });

// Порядок у цих списках — частина протоколу: у байті їде індекс.
export const KINDS = Object.freeze(['ship', 'bullet', 'asteroid', 'pickup']);
export const EFFECTS = Object.freeze(['shield', 'rapid', 'homing']);

// Форма повідомлень (однакова для обох кодеків):
//
// input     { seq, turn: -1|0|1, thrust: 0|1, brake, dash, fire }
// snapshot  { tick, ack, self, entities }
//   self      null | { down, shield, rapid, homing, hp, x, y, vx, vy, angle,
//                      dashCooldown, fireCooldown, respawnTimer }
//   entities  [{ id, kind, x, y, angle, … }] де «…» залежить від kind:
//     ship      { hp, score, down, shield, thrust }
//     bullet    { owner, homing }
//     asteroid  { size, homing }
//     pickup    { effect }
