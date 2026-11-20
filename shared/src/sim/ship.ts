// Герой (у термінах лаби — «ship»). Жодного DOM і жодних модулів Node:
// той самий файл виконується в браузері (передбачення) і на сервері (істина).

import type { EntityId } from '../brand.ts';
import { wrap, wrapVector, type Arena } from './arena.ts';
import { withHoming } from './behaviors.ts';
import { Bullet, BULLET_SPEED } from './bullet.ts';
import { cos, hypot, sin } from './dmath.ts';
import { Entity } from './entity.ts';
import type { Effect, EffectType, Team } from './events.ts';
import { Vector2 } from './vector.ts';
import type { World } from './world.ts';

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
export interface Command {
  readonly turn: number; // −1…1
  readonly thrust: number; // 0…1
  readonly brake: boolean;
  readonly dash: boolean;
  readonly fire: boolean;
}

// Те, що потрібно для руху героя.
export interface MotionState {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly angle: number;
  readonly dashCooldown: number;
}

export interface Motion extends MotionState {
  readonly thrust: number;
}

// Рух + перезарядка пострілу: стан, з якого клієнт передбачає свого героя.
export interface InputState extends MotionState {
  readonly fireCooldown: number;
  readonly rapid: boolean;
}

export interface InputResult extends InputState {
  readonly thrust: number;
  readonly fired: boolean;
}

export const NO_COMMAND: Command = Object.freeze({
  turn: 0,
  thrust: 0,
  brake: false,
  dash: false,
  fire: false,
});

function normalizeAngle(angle: number): number {
  const tau = Math.PI * 2;
  return ((((angle + Math.PI) % tau) + tau) % tau) - Math.PI; // [-π, π)
}

// Чиста функція руху: (стан, команда, dt, арена) → новий стан. Нічого не мутує,
// не читає годинник і не кидає кубик — тому клієнт і сервер, отримавши однакові команди,
// приходять до однакового стану. На цьому тримається передбачення на клієнті.
// Напівнеявний Ейлер: спершу швидкість, потім позиція вже з новою швидкістю.
export function integrate(state: MotionState, command: Command, dt: number, arena: Arena): Motion {
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
export function stepInput(
  state: InputState,
  command: Command,
  dt: number,
  arena: Arena,
): InputResult {
  const next = integrate(state, command, dt, arena);
  let fireCooldown = Math.max(0, state.fireCooldown - dt);
  let fired = false;
  if (command.fire && fireCooldown === 0) {
    fired = true;
    fireCooldown = state.rapid ? RAPID_FIRE_COOLDOWN : FIRE_COOLDOWN;
  }
  return { ...next, fireCooldown, rapid: state.rapid, fired };
}

export interface ShipInit {
  readonly id?: EntityId;
  readonly pos: Vector2;
  readonly angle?: number;
  readonly team?: Team;
  readonly name?: string;
}

export class Ship extends Entity {
  declare readonly kind: 'ship';

  // Справжня приватність: ship.#hp поза класом — SyntaxError, а не «домовленість про _hp».
  // Змінити здоров'я можна лише через takeDamage()/respawn(), де діють правила гри.
  #hp = MAX_HP;

  readonly team: Team;
  readonly name: string;
  // Одна команда (локальна гра, бот) або масив команд мережевого гравця — див. update().
  command: Command | readonly Command[] = NO_COMMAND;
  thrust = 0;
  dashCooldown = 0;
  fireCooldown = 0;
  respawnTimer = 0;
  readonly effects = new Map<EffectType, number>(); // тип ефекту → скільки секунд лишилось

  constructor({ id, pos, angle = -Math.PI / 4, team = 'green', name = '' }: ShipInit) {
    super({ id, kind: 'ship', pos, angle, radius: SHIP_RADIUS });
    this.team = team;
    this.name = name;
  }

  get hp(): number {
    return this.#hp;
  }

  get isDown(): boolean {
    return this.respawnTimer > 0;
  }

  override get collidable(): boolean {
    return !this.isDown;
  }

  hasEffect(type: EffectType): boolean {
    return this.effects.has(type);
  }

  applyEffect({ type, duration }: Effect): void {
    this.effects.set(type, duration);
  }

  // Повертає true, якщо цей удар був смертельним.
  takeDamage(amount: number): boolean {
    if (this.isDown || this.hasEffect('shield')) return false;
    this.#hp = Math.max(0, this.#hp - amount);
    return this.#hp === 0;
  }

  goDown(): void {
    this.respawnTimer = RESPAWN_DELAY;
    this.vel = Vector2.ZERO;
    this.thrust = 0;
    this.effects.clear();
  }

  respawn(pos: Vector2): void {
    this.#hp = MAX_HP;
    this.pos = pos;
    this.prevPos = pos; // без інтерполяції «перельоту» з місця загибелі
    this.respawnTimer = 0;
    this.dashCooldown = 0;
    this.fireCooldown = 0;
    this.applyEffect({ type: 'shield', duration: SPAWN_SHIELD });
  }

  // Стан у вигляді простих даних — те, що споживає stepInput і що їде в знімку власнику.
  motionState(): InputState {
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
  fire(world: World): Bullet | null {
    if (this.isDown || this.fireCooldown > 0) return null;
    this.fireCooldown = this.hasEffect('rapid') ? RAPID_FIRE_COOLDOWN : FIRE_COOLDOWN;
    return this.#spawnBullet(world);
  }

  #spawnBullet(world: World): Bullet {
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
  applyCommand(command: Command, dt: number, world: World): void {
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
  override update(dt: number, world: World): void {
    if (this.isDown) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 1e-9) {
        this.respawn(world.findSafeSpot(this.radius));
        world.emit('respawned', { shipId: this.id });
      }
      return;
    }

    // isCommandList — «охоронець типу»: після нього tsc знає, масив це чи одна команда.
    const commands = isCommandList(this.command) ? this.command : [this.command];
    for (const command of commands) this.applyCommand(command, dt, world);

    for (const [type, left] of this.effects) {
      if (left - dt <= 0) this.effects.delete(type);
      else this.effects.set(type, left - dt);
    }
  }
}

function isCommandList(command: Command | readonly Command[]): command is readonly Command[] {
  return Array.isArray(command);
}
