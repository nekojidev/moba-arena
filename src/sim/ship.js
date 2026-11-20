// Стан героя та його фізика. Жодного DOM, canvas чи часу «зі стіни»:
// той самий файл у Lab 5 запускатиметься на сервері під Node.js.
//
// За термінологією лаби це «ship»: звичайний об'єкт-дані { x, y, vx, vy, angle, thrust }.

export const TURN_RATE = 3.6; // рад/с
export const THRUST = 900; // од/с² уздовж напрямку погляду
export const DRAG = 1.6; // 1/с — частка швидкості, що втрачається за секунду
export const BRAKE_DRAG = 5; // 1/с — додатковий опір при гальмуванні
export const MAX_SPEED = 520; // од/с
export const DASH_DISTANCE = 160; // од — ривок уперед
export const DASH_COOLDOWN = 2.5; // с

export function createShip(x, y) {
  return { x, y, vx: 0, vy: 0, angle: -Math.PI / 4, thrust: 0, dashCooldown: 0 };
}

// Команда гравця — теж прості дані; звідки вона взялась (клавіатура, мережа, бот) — не важливо.
export const NO_COMMAND = Object.freeze({ turn: 0, thrust: 0, brake: false, dash: false });

function normalizeAngle(angle) {
  const tau = Math.PI * 2;
  return ((((angle + Math.PI) % tau) + tau) % tau) - Math.PI; // [-π, π)
}

// Чиста функція: (стан, команда, dt) → новий стан. Вхідний об'єкт не змінюється.
// Інтегратор — напівнеявний Ейлер: спершу швидкість, потім позиція вже з новою швидкістю.
export function integrate(ship, command, dt) {
  const angle = normalizeAngle(ship.angle + command.turn * TURN_RATE * dt);

  let vx = ship.vx + Math.cos(angle) * THRUST * command.thrust * dt;
  let vy = ship.vy + Math.sin(angle) * THRUST * command.thrust * dt;

  const drag = DRAG + (command.brake ? BRAKE_DRAG : 0);
  const damping = Math.max(0, 1 - drag * dt);
  vx *= damping;
  vy *= damping;

  const speed = Math.hypot(vx, vy);
  if (speed > MAX_SPEED) {
    vx *= MAX_SPEED / speed;
    vy *= MAX_SPEED / speed;
  }

  let x = ship.x + vx * dt;
  let y = ship.y + vy * dt;

  let dashCooldown = Math.max(0, ship.dashCooldown - dt);
  if (command.dash && dashCooldown === 0) {
    x += Math.cos(angle) * DASH_DISTANCE;
    y += Math.sin(angle) * DASH_DISTANCE;
    dashCooldown = DASH_COOLDOWN;
  }

  return { x, y, vx, vy, angle, thrust: command.thrust, dashCooldown };
}
