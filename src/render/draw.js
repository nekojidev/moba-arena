// Усе малювання. Функції отримують ctx і дані — стану тут немає.

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

  drawBase(ctx, 110, h - 110, '#3fd6a3');
  drawBase(ctx, w - 110, 110, '#e2574c');
}

function drawBase(ctx, x, y, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, 0, 90, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(0, 0, 34, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// Герой намальований у початку координат обличчям праворуч (+x);
// на місце його ставить трансформація canvas, а не перерахунок вершин.
export function drawHero(ctx, ship, timeMs) {
  ctx.save();
  ctx.translate(ship.x, ship.y);
  ctx.rotate(ship.angle);

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
  ctx.fillStyle = '#5b3fa8';
  ctx.beginPath();
  ctx.moveTo(6, -15);
  ctx.lineTo(-24, -11);
  ctx.lineTo(-17, 0);
  ctx.lineTo(-24, 11);
  ctx.lineTo(6, 15);
  ctx.closePath();
  ctx.fill();

  // Тіло й каптур
  ctx.fillStyle = '#8f6fe0';
  ctx.beginPath();
  ctx.arc(0, 0, 13, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#e9dcff';
  ctx.beginPath();
  ctx.arc(5, 0, 6, 0, Math.PI * 2);
  ctx.fill();

  // Посох із кристалом — показує напрямок погляду
  ctx.strokeStyle = '#c9a25a';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-8, 17);
  ctx.lineTo(24, 17);
  ctx.stroke();
  ctx.fillStyle = ship.dashCooldown === 0 ? '#7ef0ff' : '#4a6f78';
  ctx.beginPath();
  ctx.arc(27, 17, 5, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
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
