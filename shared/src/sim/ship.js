// Герой (у термінах лаби — «ship»). Жодного DOM і жодних модулів Node:
// той самий файл виконується в браузері (передбачення) і на сервері (істина).

import { cos, hypot, sin } from './dmath.js';
import { Entity } from './entity.js';
import { Vector2 } from './vector.js';
import { wrap, wrapVector } from './arena.js';
import { Bullet, BULLET_SPEED } from './bullet.js';
import { withHoming } from './behaviors.js';

export const TURN_RATE = 3.6; // рад/с
export const THRUST = 900; // од/с² уздовж напрямку погляду
export const DRAG = 1.6; // 1/с — частка швидкості, що втрачається за секунду
export const BRAKE_DRAG = 5; // 1/с — додатковий опір при гальмуванні
export const MAX_SPEED = 520; // од/с
export const DASH_DISTANCE = 160; // од — ривок уперед
export const DASH_COOLDOWN = 2.5; // с
export const MAX_HP = 100;
export const FIRE_COOLDOWN = 0.28; // с між пострілами
export const RAPID_FIRE_COOLDOWN = 0.1;
export const RESPAWN_DELAY = 2; // с
export const SPAWN_SHIELD = 1.5; // с невразливості після появи
export const SHIP_RADIUS = 16;
export const MUZZLE_OFFSET = SHIP_RADIUS + 8; // звідки вилітає снаряд

// Команда гравця — прості дані; звідки вона взялась (клавіатура, мережа, бот) — не важливо.
export const NO_COMMAND = Object.freeze({
  turn: 0,
  thrust: 0,
  brake: false,
  dash: false,
  fire: false,
});

function normalizeAngle(angle) {
  const tau = Math.PI * 2;
  return ((((angle + Math.PI) % tau) + tau) % tau) - Math.PI; // [-π, π)
}

// Чиста функція руху: (стан, команда, dt, арена) → новий стан. Нічого не мутує,
// не читає годинник і не кидає кубик — тому клієнт і сервер, отримавши однакові команди,
// приходять до однакового стану. На цьому тримається передбачення на клієнті.
// Напівнеявний Ейлер: спершу швидкість, потім позиція вже з новою швидкістю.
export function integrate(state, command, dt, arena) {
  const angle = normalizeAngle(state.angle + command.turn * TURN_RATE * dt);

  let vx = state.vx + cos(angle) * THRUST * command.thrust * dt;
  let vy = state.vy + sin(angle) * THRUST * command.thrust * dt;

  const drag = DRAG + (command.brake ? BRAKE_DRAG : 0);
  const damping = Math.max(0, 1 - drag * dt);
  vx *= damping;
  vy *= damping;

  const speed = hypot(vx, vy);
  if (speed > MAX_SPEED) {
    vx *= MAX_SPEED / speed;
    vy *= MAX_SPEED / speed;
  }

  let x = wrap(state.x + vx * dt, arena.width);
  let y = wrap(state.y + vy * dt, arena.height);

  let dashCooldown = Math.max(0, state.dashCooldown - dt);
  if (command.dash && dashCooldown === 0) {
    x = wrap(x + cos(angle) * DASH_DISTANCE, arena.width);
    y = wrap(y + sin(angle) * DASH_DISTANCE, arena.height);
    dashCooldown = DASH_COOLDOWN;
  }

  return { x, y, vx, vy, angle, thrust: command.thrust, dashCooldown };
}

// Один input повністю: рух + перезарядка пострілу. `fired` каже, чи вилетів снаряд.
// Стан: { x, y, vx, vy, angle, dashCooldown, fireCooldown, rapid }.
export function stepInput(state, command, dt, arena) {
  const next = integrate(state, command, dt, arena);
  let fireCooldown = Math.max(0, state.fireCooldown - dt);
  let fired = false;
  if (command.fire && fireCooldown === 0) {
    fired = true;
    fireCooldown = state.rapid ? RAPID_FIRE_COOLDOWN : FIRE_COOLDOWN;
  }
  return { ...next, fireCooldown, rapid: state.rapid, fired };
}

export class Ship extends Entity {
  // Справжня приватність: ship.#hp поза класом — SyntaxError, а не «домовленість про _hp».
  // Змінити здоров'я можна лише через takeDamage()/respawn(), де діють правила гри.
  #hp = MAX_HP;

  constructor({ id, pos, angle = -Math.PI / 4, team = 'green', name = '' }) {
    super({ id, kind: 'ship', pos, angle, radius: SHIP_RADIUS });
    this.team = team;
    this.name = name;
    this.command = NO_COMMAND;
    this.thrust = 0;
    this.dashCooldown = 0;
    this.fireCooldown = 0;
    this.respawnTimer = 0;
    this.effects = new Map(); // тип ефекту → скільки секунд лишилось
  }

  get hp() {
    return this.#hp;
  }

  get isDown() {
    return this.respawnTimer > 0;
  }

  get collidable() {
    return !this.isDown;
  }

  hasEffect(type) {
    return this.effects.has(type);
  }

  applyEffect({ type, duration }) {
    this.effects.set(type, duration);
  }

  // Повертає true, якщо цей удар був смертельним.
  takeDamage(amount) {
    if (this.isDown || this.hasEffect('shield')) return false;
    this.#hp = Math.max(0, this.#hp - amount);
    return this.#hp === 0;
  }

  goDown() {
    this.respawnTimer = RESPAWN_DELAY;
    this.vel = Vector2.ZERO;
    this.thrust = 0;
    this.effects.clear();
  }

  respawn(pos) {
    this.#hp = MAX_HP;
    this.pos = pos;
    this.prevPos = pos; // без інтерполяції «перельоту» з місця загибелі
    this.respawnTimer = 0;
    this.dashCooldown = 0;
    this.fireCooldown = 0;
    this.applyEffect({ type: 'shield', duration: SPAWN_SHIELD });
  }

  // Стан у вигляді простих даних — те, що споживає stepInput і що їде в знімку власнику.
  motionState() {
    return {
      x: this.pos.x,
      y: this.pos.y,
      vx: this.vel.x,
      vy: this.vel.y,
      angle: this.angle,
      dashCooldown: this.dashCooldown,
      fireCooldown: this.fireCooldown,
      rapid: this.hasEffect('rapid'),
    };
  }

  // Постріл із «носа» героя; снаряд успадковує швидкість героя.
  // Метод звертається до this — тому його не можна передавати як колбек «голим»
  // (див. розділ про this у README та client/scripts/this-bug.js).
  fire(world) {
    if (this.isDown || this.fireCooldown > 0) return null;
    this.fireCooldown = this.hasEffect('rapid') ? RAPID_FIRE_COOLDOWN : FIRE_COOLDOWN;
    return this.#spawnBullet(world);
  }

  #spawnBullet(world) {
    const direction = Vector2.fromAngle(this.angle);
    const bullet = new Bullet({
      pos: wrapVector(this.pos.add(direction.scale(MUZZLE_OFFSET)), world.arena),
      vel: this.vel.add(direction.scale(BULLET_SPEED)),
      angle: this.angle,
      ownerId: this.id,
      team: this.team,
    });
    if (this.hasEffect('homing')) {
      withHoming(bullet, { turnRate: 5, kinds: ['ship', 'asteroid'], faceVelocity: true });
    }
    world.emit('fired', { shipId: this.id, team: this.team, homing: this.hasEffect('homing') });
    return world.spawn(bullet);
  }

  // Застосовує одну команду: рух, перезарядки, постріл.
  applyCommand(command, dt, world) {
    const next = stepInput(this.motionState(), command, dt, world.arena);
    this.pos = new Vector2(next.x, next.y);
    this.vel = new Vector2(next.vx, next.vy);
    this.angle = next.angle;
    this.thrust = next.thrust;
    this.dashCooldown = next.dashCooldown;
    this.fireCooldown = next.fireCooldown;
    if (next.fired) this.#spawnBullet(world);
  }

  // this.command — або одна команда (локальна гра, бот), або масив команд мережевого гравця:
  // скільки input прийшло за цей крок сервера, стільки разів герой і рухається.
  // Порожній масив — input не прийшов, герой цього кроку стоїть: його позиція — це функція
  // лише від отриманих команд, тому клієнт може відтворити її в себе точно.
  update(dt, world) {
    if (this.isDown) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 1e-9) {
        this.respawn(world.findSafeSpot(this.radius));
        world.emit('respawned', { shipId: this.id });
      }
      return;
    }

    const commands = Array.isArray(this.command) ? this.command : [this.command];
    for (const command of commands) this.applyCommand(command, dt, world);

    for (const [type, left] of this.effects) {
      if (left - dt <= 0) this.effects.delete(type);
      else this.effects.set(type, left - dt);
    }
  }
}
