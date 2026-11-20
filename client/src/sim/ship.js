// Герой (у термінах лаби — «ship»). Фізика та сама, що в Lab 1, але тепер це метод класу.
// Жодного DOM: цей файл у Lab 5 запускатиметься на сервері під Node.js.

import { Entity } from './entity.js';
import { Vector2 } from './vector.js';
import { wrapVector } from './arena.js';
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

export class Ship extends Entity {
  // Справжня приватність: ship.#hp поза класом — SyntaxError, а не «домовленість про _hp».
  // Змінити здоров'я можна лише через takeDamage()/respawn(), де діють правила гри.
  #hp = MAX_HP;

  constructor({ pos, angle = -Math.PI / 4, team = 'green', name = '' }) {
    super({ kind: 'ship', pos, angle, radius: 16 });
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

  // Постріл із «носа» героя; снаряд успадковує швидкість героя.
  // Метод звертається до this — тому його не можна передавати як колбек «голим»
  // (див. розділ про this у README та scripts/this-bug.js).
  fire(world) {
    if (this.isDown || this.fireCooldown > 0) return null;

    const direction = Vector2.fromAngle(this.angle);
    const bullet = new Bullet({
      pos: wrapVector(this.pos.add(direction.scale(this.radius + 8)), world.arena),
      vel: this.vel.add(direction.scale(BULLET_SPEED)),
      angle: this.angle,
      ownerId: this.id,
      team: this.team,
    });
    if (this.hasEffect('homing')) {
      withHoming(bullet, { turnRate: 5, kinds: ['ship', 'asteroid'], faceVelocity: true });
    }

    this.fireCooldown = this.hasEffect('rapid') ? RAPID_FIRE_COOLDOWN : FIRE_COOLDOWN;
    world.emit('fired', { shipId: this.id, team: this.team, homing: this.hasEffect('homing') });
    return world.spawn(bullet);
  }

  update(dt, world) {
    if (this.isDown) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 1e-9) {
        this.respawn(world.findSafeSpot(this.radius));
        world.emit('respawned', { shipId: this.id });
      }
      return;
    }

    const command = this.command;

    // Напівнеявний Ейлер: спершу швидкість, потім позиція вже з новою швидкістю.
    this.angle = normalizeAngle(this.angle + command.turn * TURN_RATE * dt);

    let vx = this.vel.x + Math.cos(this.angle) * THRUST * command.thrust * dt;
    let vy = this.vel.y + Math.sin(this.angle) * THRUST * command.thrust * dt;

    const drag = DRAG + (command.brake ? BRAKE_DRAG : 0);
    const damping = Math.max(0, 1 - drag * dt);
    vx *= damping;
    vy *= damping;

    const speed = Math.hypot(vx, vy);
    if (speed > MAX_SPEED) {
      vx *= MAX_SPEED / speed;
      vy *= MAX_SPEED / speed;
    }

    this.vel = new Vector2(vx, vy);
    this.thrust = command.thrust;
    this.move(dt, world.arena);

    this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    if (command.dash && this.dashCooldown === 0) {
      const jump = Vector2.fromAngle(this.angle, DASH_DISTANCE);
      this.pos = wrapVector(this.pos.add(jump), world.arena);
      this.dashCooldown = DASH_COOLDOWN;
    }

    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    if (command.fire) this.fire(world); // виклик через крапку → this = цей герой

    for (const [type, left] of this.effects) {
      if (left - dt <= 0) this.effects.delete(type);
      else this.effects.set(type, left - dt);
    }
  }
}
