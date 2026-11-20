// Усе малювання. Функції отримують ctx і дані — ігрового стану тут немає.
// Кожна drawX(ctx, entity, pose, timeMs, sprites): pose — інтерпольовані { x, y, angle }.
// Якщо спрайта немає (не завантажився) — малюємо запасний векторний варіант з Lab 2.

import { isHoming } from '../sim/behaviors.js';
import { NO_SPRITES } from './sprites.js';

const TAU = Math.PI * 2;

const TEAMS = {
  green: { cloak: '#1f8f6a', body: '#3fd6a3', face: '#e6fff5', bolt: '#7ef0c0' },
  red: { cloak: '#a8342c', body: '#e2574c', face: '#ffe9e6', bolt: '#ff9a8a' },
};

const EFFECT_COLORS = { shield: '#6fc3ff', rapid: '#ffb347', homing: '#e07bff' };
const EFFECT_LABELS = { shield: 'щит', rapid: 'швидкий вогонь', homing: 'самонаведення' };

export function drawArena(ctx, arena) {
  const { width: w, height: h } = arena;

  ctx.fillStyle = '#15231a';
  ctx.fillRect(0, 0, w, h);

  // Сітка — щоб рух було видно навіть на порожньому місці.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.045)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= w; x += 100) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  for (let y = 0; y <= h; y += 100) {
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Річка: з лівого верхнього кута в правий нижній.
  ctx.strokeStyle = 'rgba(64, 140, 190, 0.35)';
  ctx.lineWidth = 90;
  ctx.beginPath();
  ctx.moveTo(-50, -30);
  ctx.bezierCurveTo(w * 0.3, h * 0.25, w * 0.7, h * 0.75, w + 50, h + 30);
  ctx.stroke();

  // Три лінії між базами: верхня, центральна, нижня.
  ctx.strokeStyle = 'rgba(190, 160, 110, 0.28)';
  ctx.lineWidth = 46;
  ctx.beginPath();
  ctx.moveTo(110, h - 110);
  ctx.lineTo(w - 110, 110);
  ctx.moveTo(110, h - 110);
  ctx.lineTo(110, 110);
  ctx.lineTo(w - 110, 110);
  ctx.moveTo(110, h - 110);
  ctx.lineTo(w - 110, h - 110);
  ctx.lineTo(w - 110, 110);
  ctx.stroke();

  drawBase(ctx, 110, h - 110, TEAMS.green.body);
  drawBase(ctx, w - 110, 110, TEAMS.red.body);
}

function drawBase(ctx, x, y, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, 0, 90, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(0, 0, 34, 0, TAU);
  ctx.stroke();
  ctx.restore();
}

// Герой намальований у початку координат обличчям праворуч (+x);
// на місце його ставить трансформація canvas, а не перерахунок вершин.
export function drawShip(ctx, ship, pose, timeMs, sprites = NO_SPRITES) {
  if (ship.isDown) return;
  const colors = TEAMS[ship.team] ?? TEAMS.green;

  ctx.save();
  ctx.translate(pose.x, pose.y);

  // Смужка здоров'я — не обертається разом із героєм.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(-20, -34, 40, 5);
  ctx.fillStyle = colors.body;
  ctx.fillRect(-20, -34, 40 * (ship.hp / 100), 5);
  if (ship.name) {
    ctx.font = '12px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fillText(ship.name, 0, -40);
  }

  if (ship.hasEffect('shield')) {
    ctx.strokeStyle = EFFECT_COLORS.shield;
    ctx.globalAlpha = 0.55 + 0.25 * Math.sin(timeMs * 0.01);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, ship.radius + 9, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  ctx.rotate(pose.angle);

  const frame = `hero-${ship.team}${ship.thrust > 0 ? '-thrust' : ''}`;
  if (sprites.draw(ctx, frame, ship.radius)) {
    ctx.restore();
    return;
  }

  if (ship.thrust > 0) {
    // «Полум'я тяги» — чарівний слід, що мерехтить.
    const flicker = 0.75 + 0.25 * Math.sin(timeMs * 0.045);
    const length = 46 * flicker * ship.thrust;
    const gradient = ctx.createLinearGradient(-14, 0, -14 - length, 0);
    gradient.addColorStop(0, 'rgba(120, 220, 255, 0.95)');
    gradient.addColorStop(1, 'rgba(120, 220, 255, 0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(-14, -9);
    ctx.lineTo(-14 - length, 0);
    ctx.lineTo(-14, 9);
    ctx.closePath();
    ctx.fill();
  }

  // Плащ
  ctx.fillStyle = colors.cloak;
  ctx.beginPath();
  ctx.moveTo(6, -15);
  ctx.lineTo(-24, -11);
  ctx.lineTo(-17, 0);
  ctx.lineTo(-24, 11);
  ctx.lineTo(6, 15);
  ctx.closePath();
  ctx.fill();

  // Тіло й каптур
  ctx.fillStyle = colors.body;
  ctx.beginPath();
  ctx.arc(0, 0, 13, 0, TAU);
  ctx.fill();
  ctx.fillStyle = colors.face;
  ctx.beginPath();
  ctx.arc(5, 0, 6, 0, TAU);
  ctx.fill();

  // Посох із кристалом — показує напрямок погляду; кристал гасне, поки ривок перезаряджається
  ctx.strokeStyle = '#c9a25a';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-8, 17);
  ctx.lineTo(24, 17);
  ctx.stroke();
  ctx.fillStyle = ship.dashCooldown === 0 ? '#7ef0ff' : '#4a6f78';
  ctx.beginPath();
  ctx.arc(27, 17, 5, 0, TAU);
  ctx.fill();

  ctx.restore();
}

export function drawBullet(ctx, bullet, pose, timeMs, sprites = NO_SPRITES) {
  const color = isHoming(bullet) ? EFFECT_COLORS.homing : (TEAMS[bullet.team] ?? TEAMS.green).bolt;
  ctx.save();
  ctx.translate(pose.x, pose.y);
  ctx.rotate(pose.angle);
  const frame = isHoming(bullet) ? 'bolt-homing' : `bolt-${bullet.team}`;
  if (sprites.draw(ctx, frame, bullet.radius)) {
    ctx.restore();
    return;
  }
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-16, 0);
  ctx.lineTo(0, 0);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, 0, bullet.radius, 0, TAU);
  ctx.fill();
  ctx.restore();
}

// Нерівний контур голема залежить лише від id — однаковий у кожному кадрі.
function rockOutline(id, radius) {
  const points = [];
  const corners = 10;
  for (let i = 0; i < corners; i += 1) {
    const wobble = 0.82 + 0.18 * Math.sin(id * 12.9898 + i * 78.233);
    const angle = (i / corners) * TAU;
    points.push([Math.cos(angle) * radius * wobble, Math.sin(angle) * radius * wobble]);
  }
  return points;
}

export function drawAsteroid(ctx, asteroid, pose, timeMs, sprites = NO_SPRITES) {
  const seeking = isHoming(asteroid);
  ctx.save();
  ctx.translate(pose.x, pose.y);
  ctx.rotate(pose.angle);
  if (sprites.draw(ctx, seeking ? 'golem-homing' : 'golem', asteroid.radius)) {
    ctx.restore();
    return;
  }
  ctx.fillStyle = seeking ? '#5d4a6e' : '#6b6f66';
  ctx.strokeStyle = seeking ? EFFECT_COLORS.homing : '#9aa093';
  ctx.lineWidth = 2;
  ctx.beginPath();
  rockOutline(asteroid.id, asteroid.radius).forEach(([x, y], index) => {
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // «Око» голема
  ctx.fillStyle = seeking ? EFFECT_COLORS.homing : '#f2c14e';
  ctx.beginPath();
  ctx.arc(asteroid.radius * 0.3, 0, asteroid.radius * 0.16, 0, TAU);
  ctx.fill();
  ctx.restore();
}

export function drawPickup(ctx, pickup, pose, timeMs, sprites = NO_SPRITES) {
  const color = EFFECT_COLORS[pickup.effect.type] ?? '#ffffff';
  const pulse = 1 + 0.08 * Math.sin(timeMs * 0.006);
  ctx.save();
  ctx.translate(pose.x, pose.y);
  ctx.globalAlpha = pickup.ttl < 3 ? 0.4 + 0.4 * Math.abs(Math.sin(timeMs * 0.01)) : 1;
  ctx.scale(pulse, pulse);
  if (sprites.draw(ctx, `rune-${pickup.effect.type}`, pickup.radius)) {
    ctx.restore();
    return;
  }
  ctx.rotate(timeMs * 0.001);
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, -pickup.radius);
  ctx.lineTo(pickup.radius, 0);
  ctx.lineTo(0, pickup.radius);
  ctx.lineTo(-pickup.radius, 0);
  ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.globalAlpha *= 0.35;
  ctx.fill();
  ctx.restore();
}

export function drawExplosion(ctx, explosion, pose) {
  ctx.save();
  ctx.translate(pose.x, pose.y);
  ctx.fillStyle = explosion.color;
  for (const particle of explosion.particles) {
    if (particle.life <= 0) continue;
    ctx.globalAlpha = particle.life / particle.maxLife;
    ctx.beginPath();
    ctx.arc(particle.x, particle.y, 3, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

export function effectLabel(type) {
  return EFFECT_LABELS[type] ?? type;
}

export function drawHud(ctx, stats, extraLines = []) {
  const lines = [
    `steps/s   ${stats.stepsPerSecond.toFixed(1)}`,
    `frames/s  ${stats.framesPerSecond.toFixed(1)}`,
    `frame     ${stats.frameTime.toFixed(2)} ms  (max/s ${stats.frameTimeMax.toFixed(1)})`,
    ...extraLines,
  ];

  const lineHeight = 17;
  const padding = 10;
  ctx.save();
  ctx.font = '13px ui-monospace, Menlo, Consolas, monospace';
  ctx.textBaseline = 'top';
  const width = Math.max(...lines.map((line) => ctx.measureText(line).width)) + padding * 2;
  ctx.fillStyle = 'rgba(8, 14, 10, 0.78)';
  ctx.fillRect(12, 12, width, lines.length * lineHeight + padding * 2 - 4);
  ctx.fillStyle = '#d7f5df';
  lines.forEach((line, index) => {
    ctx.fillText(line, 12 + padding, 12 + padding + index * lineHeight);
  });
  ctx.restore();
}

export function drawScore(ctx, viewWidth, playerScore, botScore) {
  ctx.save();
  ctx.font = 'bold 22px ui-monospace, Menlo, Consolas, monospace';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  const text = `${playerScore}  :  ${botScore}`;
  const width = ctx.measureText(text).width + 28;
  ctx.fillStyle = 'rgba(8, 14, 10, 0.78)';
  ctx.fillRect(viewWidth / 2 - width / 2, 44, width, 34);
  ctx.textAlign = 'right';
  ctx.fillStyle = TEAMS.green.body;
  ctx.fillText(String(playerScore), viewWidth / 2 - 16, 50);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#d7f5df';
  ctx.fillText(':', viewWidth / 2, 50);
  ctx.textAlign = 'left';
  ctx.fillStyle = TEAMS.red.body;
  ctx.fillText(String(botScore), viewWidth / 2 + 16, 50);
  ctx.restore();
}
