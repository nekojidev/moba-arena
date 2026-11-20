// Ігрові повідомлення на екрані: «+100», стрічка подій. Як і звук, HUD лише слухає шину
// світу — симуляція його не імпортує і не знає, що він існує.

const FEED_LIFETIME = 4000; // мс
const POPUP_LIFETIME = 900;

const EFFECT_NAMES = { shield: 'щит', rapid: 'швидкий вогонь', homing: 'самонаведення' };

export function createHud(world, { playerId, signal } = {}) {
  const feed = []; // { text, at }
  const popups = []; // { text, x, y, at, color }

  const on = (type, handler) => world.events.addEventListener(type, handler, { signal });
  const nameOf = (id) => world.get(id)?.name || 'хтось';
  const say = (text) => {
    feed.push({ text, at: performance.now() });
    if (feed.length > 5) feed.shift();
  };

  on('score', ({ detail }) => {
    const ship = world.get(detail.id);
    if (!ship) return;
    popups.push({
      text: `+${detail.points}`,
      x: ship.pos.x,
      y: ship.pos.y - 44,
      at: performance.now(),
      color: detail.id === playerId ? '#7ef0c0' : '#ff9a8a',
    });
  });

  on('exploded', ({ detail }) => {
    if (detail.kind !== 'ship') return;
    const victim = nameOf(detail.id);
    say(
      detail.killerId === null
        ? `${victim} розбився об голема`
        : `${nameOf(detail.killerId)} ✦ ${victim}`,
    );
  });

  on('pickup', ({ detail }) => {
    say(
      `${nameOf(detail.shipId)} підібрав руну: ${EFFECT_NAMES[detail.effect.type] ?? detail.effect.type}`,
    );
  });

  return {
    say,

    // Спливні числа живуть у координатах арени — малюються всередині її трансформації.
    drawWorld(ctx, now) {
      ctx.save();
      ctx.font = 'bold 20px ui-monospace, Menlo, Consolas, monospace';
      ctx.textAlign = 'center';
      for (let i = popups.length - 1; i >= 0; i -= 1) {
        const popup = popups[i];
        const age = (now - popup.at) / POPUP_LIFETIME;
        if (age >= 1) {
          popups.splice(i, 1);
          continue;
        }
        ctx.globalAlpha = 1 - age;
        ctx.fillStyle = popup.color;
        ctx.fillText(popup.text, popup.x, popup.y - age * 30);
      }
      ctx.restore();
    },

    // Стрічка подій — у координатах екрана, внизу по центру.
    drawScreen(ctx, view, now) {
      while (feed.length > 0 && now - feed[0].at > FEED_LIFETIME) feed.shift();
      ctx.save();
      ctx.font = '14px ui-monospace, Menlo, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      feed.forEach((entry, index) => {
        const age = (now - entry.at) / FEED_LIFETIME;
        const y = view.height - 20 - (feed.length - 1 - index) * 22;
        const width = ctx.measureText(entry.text).width + 20;
        ctx.globalAlpha = Math.min(1, (1 - age) * 3);
        ctx.fillStyle = 'rgba(8, 14, 10, 0.78)';
        ctx.fillRect(view.width / 2 - width / 2, y - 19, width, 22);
        ctx.fillStyle = '#d7f5df';
        ctx.fillText(entry.text, view.width / 2, y);
      });
      ctx.restore();
    },
  };
}
