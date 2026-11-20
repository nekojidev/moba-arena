// Мережева гра. Світ рахує сервер; клієнт:
//   • раз на крок (30/с) надсилає input із номером seq — і НІКОЛИ координати;
//   • свого героя передбачає сам і звіряє з кожним знімком (net/prediction.js);
//   • усіх інших малює трохи в минулому, між двома знімками (net/interpolation.js);
//   • свої снаряди показує одразу, не чекаючи сервера.

import { CODECS } from '@moba-arena/shared/codec/index.js';
import { DT, TICK_MS } from '@moba-arena/shared/protocol.js';
import { BULLET_SPEED, BULLET_TTL } from '@moba-arena/shared/sim/bullet.js';
import { wrap } from '@moba-arena/shared/sim/arena.js';
import { MUZZLE_OFFSET, SHIP_RADIUS } from '@moba-arena/shared/sim/ship.js';
import { createEffects } from './effects.js';
import { createHud } from './hud.js';
import { createInput } from './input.js';
import { createLoop } from './loop.js';
import { createInjector, PRESETS } from './net/injector.js';
import { createInterpolator, createServerClock } from './net/interpolation.js';
import { createNetgraph } from './net/netgraph.js';
import { createPredictor } from './net/prediction.js';
import { fitArena } from './render/canvas.js';
import {
  drawArena,
  drawAsteroid,
  drawBullet,
  drawHud,
  drawPickup,
  drawScore,
  drawShip,
} from './render/draw.js';

const ASTEROID_RADIUS = { 1: 16, 2: 28, 3: 44 };
const HOMING = [{ tag: 'homing' }]; // draw.js упізнає самонаведення за цією позначкою
const NOT_HOMING = [];
const LAYERS = ['pickup', 'asteroid', 'bullet', 'ship'];
const DRAW = { pickup: drawPickup, asteroid: drawAsteroid, bullet: drawBullet, ship: drawShip };

export function startNetGame({
  ctx,
  view,
  sprites,
  audio,
  connection,
  welcome,
  playerName,
  params,
}) {
  const arena = { width: welcome.room.arena.width, height: welcome.room.arena.height };
  const codec = CODECS[welcome.codec] ?? CODECS.binary;
  let myShipId = welcome.shipId;

  // --- налаштування з адресного рядка -------------------------------------------------------
  const injector = createInjector({
    latencyMs: Number(params.get('lag') ?? 0),
    jitterMs: Number(params.get('jitter') ?? 0),
    dropRate: Number(params.get('drop') ?? 0) / 100,
  });
  let presetIndex = -1;
  let predict = params.get('predict') !== '0';
  let interpolationDelay = Number(params.get('interp') ?? 100); // мс; див. README
  // ДОСЛІД (?chaos=random): навмисно ламаємо детермінізм передбачення — підмішуємо
  // Math.random() у результат кожного кроку. У справжньому коді цього немає.
  const perturb =
    params.get('chaos') === 'random'
      ? (state) => ({
          ...state,
          vx: state.vx + (Math.random() - 0.5) * 30,
          vy: state.vy + (Math.random() - 0.5) * 30,
        })
      : null;

  const input = createInput(window);
  const predictor = createPredictor({ arena, perturb });
  const interpolator = createInterpolator({ arena });
  const clock = createServerClock();
  const netgraph = createNetgraph();
  const effects = createEffects();
  const subscriptions = new AbortController();
  const { signal } = subscriptions;

  // Шина подій для звуку й HUD — та сама схема, що в Lab 3, лише події приходять із мережі.
  const bus = new EventTarget();
  const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
  const names = new Map(); // id героя → ім'я
  const lastKnown = new Map(); // id героя → останній запис зі знімка
  const fakeWorld = {
    events: bus,
    get: (id) => {
      const record = lastKnown.get(id);
      return record ? { name: names.get(id) ?? 'Бот', pos: record } : undefined;
    },
  };
  const hud = createHud(fakeWorld, { playerId: myShipId, signal });
  audio.connect(bus, { playerId: myShipId, signal });

  let self = null; // останній точний стан власного героя від сервера
  const ghosts = []; // власні снаряди, показані одразу
  const ownBullets = new Map(); // id снаряда на сервері → привид (або null, якщо привида немає)
  const pendingEvents = []; // події сервера чекають, поки до них дійде «минуле», яке ми малюємо
  let frameAt = performance.now();

  function applyRoster({ players }) {
    names.clear();
    for (const player of players) names.set(player.shipId, player.name);
  }
  connection.on('roster', applyRoster, { signal });
  if (connection.last('roster')) applyRoster(connection.last('roster'));

  // --- вхідні повідомлення ------------------------------------------------------------------

  function onSnapshot(snapshot, bytes) {
    const now = performance.now();
    netgraph.received(bytes, now);
    if (!interpolator.push(snapshot)) return; // прийшов не по порядку
    clock.observe(snapshot.tick * TICK_MS, now);

    self = snapshot.self;
    const correction = self ? predictor.reconcile(self, snapshot.ack, { predict }) : 0;
    netgraph.snapshot(now, predict ? correction : 0);

    const seenBullets = new Set();
    for (const entity of snapshot.entities) {
      if (entity.kind === 'ship') {
        const before = lastKnown.get(entity.id);
        if (before && entity.score > before.score) {
          emit('score', {
            id: entity.id,
            points: entity.score - before.score,
            total: entity.score,
          });
        }
        lastKnown.set(entity.id, entity);
      } else if (entity.kind === 'bullet' && entity.owner === myShipId) {
        seenBullets.add(entity.id);
        // Сервер підтвердив наш постріл: прив'язуємо його снаряд до найстарішого привида.
        if (!ownBullets.has(entity.id)) {
          const ghost = ghosts.find((candidate) => candidate.serverId === null) ?? null;
          if (ghost) ghost.serverId = entity.id;
          ownBullets.set(entity.id, ghost);
        }
      }
    }
    // Снаряда на сервері більше немає (влучив або згас) — зникає і привид.
    for (const [id, ghost] of ownBullets) {
      if (seenBullets.has(id)) continue;
      ownBullets.delete(id);
      const index = ghosts.indexOf(ghost);
      if (index >= 0) ghosts.splice(index, 1);
    }
  }

  connection.onBinary(
    (data) => injector.pass('down', () => onSnapshot(codec.decodeSnapshot(data), data.byteLength)),
    { signal },
  );
  // У режимі ?codec=json знімок приходить текстом, як звичайне повідомлення.
  connection.on(
    'snapshot',
    (message) =>
      injector.pass('down', () =>
        onSnapshot(codec.decodeSnapshot(message), JSON.stringify(message).length),
      ),
    { signal },
  );
  connection.on(
    'events',
    ({ tick, events }) =>
      injector.pass(
        'down',
        () => {
          for (const event of events) pendingEvents.push({ time: tick * TICK_MS, ...event });
        },
        { droppable: false },
      ),
    { signal },
  );
  connection.on(
    'welcome',
    (next) => {
      // Після перепідключення сервер видає нового героя: починаємо з чистого аркуша.
      myShipId = next.shipId;
      predictor.reset();
      self = null;
      ghosts.length = 0;
      ownBullets.clear();
      hud.say('з’єднання відновлено');
    },
    { signal },
  );

  // RTT міряємо власним ping раз на секунду — крізь той самий інжектор, що й гра.
  connection.on(
    'pong',
    ({ t }) =>
      injector.pass('down', () => (netgraph.metrics.rtt = performance.now() - t), {
        droppable: false,
      }),
    { signal },
  );
  const pingTimer = setInterval(() => {
    const t = performance.now();
    injector.pass('up', () => connection.send({ type: 'ping', t }), { droppable: false });
  }, 1000);

  function handleEvent(event) {
    if (event.type === 'fired') {
      if (event.shipId !== myShipId) emit('fired', event); // свій постріл уже прозвучав
    } else if (event.type === 'exploded') {
      effects.explode(event.x, event.y, {
        count: event.kind === 'ship' ? 36 : 8 + (event.size ?? 1) * 6,
        speed: event.kind === 'ship' ? 260 : 220,
        color: event.kind !== 'ship' ? '#ffd27a' : event.id === myShipId ? '#7ef0c0' : '#ff8a7a',
      });
      emit('exploded', event);
    } else {
      emit(event.type, event);
    }
  }

  // --- крок (30/с): input → мережа → передбачення ------------------------------------------

  function readCommand() {
    return {
      turn: (input.isDown('ArrowRight') ? 1 : 0) - (input.isDown('ArrowLeft') ? 1 : 0),
      thrust: input.isDown('ArrowUp') ? 1 : 0,
      brake: input.isDown('ArrowDown'),
      dash: input.justPressed('KeyE'),
      fire: input.isDown('Space'),
    };
  }

  function hotkeys() {
    if (input.justPressed('KeyM')) hud.say(audio.toggleMute() ? 'звук вимкнено' : 'звук увімкнено');
    if (input.justPressed('KeyP')) {
      predict = !predict;
      hud.say(predict ? 'передбачення увімкнено' : 'передбачення ВИМКНЕНО — герой чекає сервера');
    }
    if (input.justPressed('KeyL')) {
      presetIndex = (presetIndex + 1) % PRESETS.length;
      const { name, ...preset } = PRESETS[presetIndex];
      Object.assign(injector.settings, preset);
      hud.say(`мережа: ${name}`);
    }
    if (input.justPressed('BracketLeft')) interpolationDelay = Math.max(0, interpolationDelay - 10);
    if (input.justPressed('BracketRight'))
      interpolationDelay = Math.min(500, interpolationDelay + 10);
  }

  function simulate() {
    hotkeys();
    const command = readCommand();
    input.endStep();

    const canPredict = predict && self && !self.down;
    const { seq, fired } = predictor.applyInput(command, { predict: canPredict });
    const data = codec.encodeInput({ seq, ...command });
    injector.pass('up', () => {
      if (connection.sendRaw(data)) netgraph.sent(data.length, performance.now());
    });
    netgraph.metrics.pending = predictor.pendingCount;

    // Власний снаряд — одразу, з передбаченого стану. Самонавідні не передбачаємо:
    // їхня траєкторія залежить від цілей, яких клієнт точно не знає.
    if (fired && canPredict && !self.homing) {
      const { x, y, vx, vy, angle } = predictor.state;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const ghost = {
        x: wrap(x + cos * MUZZLE_OFFSET, arena.width),
        y: wrap(y + sin * MUZZLE_OFFSET, arena.height),
        vx: vx + cos * BULLET_SPEED,
        vy: vy + sin * BULLET_SPEED,
        angle,
        ttl: BULLET_TTL,
        serverId: null,
      };
      ghost.prevX = ghost.x;
      ghost.prevY = ghost.y;
      ghosts.push(ghost);
      emit('fired', { shipId: myShipId });
    }

    for (let i = ghosts.length - 1; i >= 0; i -= 1) {
      const ghost = ghosts[i];
      ghost.ttl -= DT;
      if (ghost.ttl <= 0) {
        ghosts.splice(i, 1);
        continue;
      }
      ghost.prevX = ghost.x;
      ghost.prevY = ghost.y;
      ghost.x = wrap(ghost.x + ghost.vx * DT, arena.width);
      ghost.y = wrap(ghost.y + ghost.vy * DT, arena.height);
    }
  }

  // --- кадр --------------------------------------------------------------------------------

  function view3(record) {
    if (record.kind === 'ship') {
      return {
        team: record.id === myShipId ? 'green' : 'red',
        name: record.id === myShipId ? playerName : (names.get(record.id) ?? 'Бот'),
        hp: record.hp,
        isDown: record.down,
        radius: SHIP_RADIUS,
        thrust: record.thrust ? 1 : 0,
        dashCooldown: 0,
        hasEffect: (type) => type === 'shield' && record.shield,
      };
    }
    if (record.kind === 'bullet') {
      return {
        team: record.owner === myShipId ? 'green' : 'red',
        radius: 5,
        behaviors: record.homing ? HOMING : NOT_HOMING,
      };
    }
    if (record.kind === 'asteroid') {
      return {
        id: record.id,
        radius: ASTEROID_RADIUS[record.size],
        behaviors: record.homing ? HOMING : NOT_HOMING,
      };
    }
    return { effect: { type: record.effect }, radius: 18, ttl: 99 };
  }

  function render(alpha) {
    const now = performance.now();
    const seconds = Math.min(0.1, (now - frameAt) / 1000);
    frameAt = now;
    predictor.decay(seconds);
    effects.update(seconds);

    // «Минуле», яке малюємо: серверний час мінус затримка інтерполяції.
    const renderTime = clock.ready ? clock.now(now) - interpolationDelay : 0;
    const sample = interpolator.sample(renderTime);
    while (pendingEvents.length > 0 && pendingEvents[0].time <= renderTime) {
      handleEvent(pendingEvents.shift());
    }

    const { scale, offsetX, offsetY } = fitArena(view, arena);
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    ctx.beginPath();
    ctx.rect(0, 0, arena.width, arena.height);
    ctx.clip();
    drawArena(ctx, arena);

    const ownPose = predict && self && !self.down ? predictor.pose(alpha) : null;
    for (const kind of LAYERS) {
      for (const record of sample.entities) {
        if (record.kind !== kind) continue;
        // Свого героя малюємо з передбачення, а не з минулого.
        if (record.id === myShipId && ownPose) continue;
        // Власний снаряд, у якого є привид, сервером не дублюємо.
        if (kind === 'bullet' && ownBullets.get(record.id)) continue;
        DRAW[kind](ctx, view3(record), record, now, sprites);
      }
      if (kind === 'bullet') {
        for (const ghost of ghosts) {
          const pose = {
            x:
              ghost.prevX +
              (ghost.x - ghost.prevX) * (Math.abs(ghost.x - ghost.prevX) > 200 ? 1 : alpha),
            y:
              ghost.prevY +
              (ghost.y - ghost.prevY) * (Math.abs(ghost.y - ghost.prevY) > 200 ? 1 : alpha),
            angle: ghost.angle,
          };
          drawBullet(ctx, { team: 'green', radius: 5, behaviors: NOT_HOMING }, pose, now, sprites);
        }
      }
    }
    if (ownPose) {
      const record = lastKnown.get(myShipId) ?? { hp: self.hp, shield: self.shield };
      const own = view3({
        ...record,
        kind: 'ship',
        id: myShipId,
        hp: self.hp,
        shield: self.shield,
        down: false,
        thrust: predictor.state.thrust > 0,
      });
      drawShip(ctx, own, ownPose, now, sprites);
    }
    effects.draw(ctx);
    hud.drawWorld(ctx, now);
    ctx.restore();

    // --- поверх арени: статистика циклу, рахунок, стрічка, netgraph ------------------------
    drawHud(ctx, loop.stats(), hudLines());
    hud.drawScreen(ctx, view, now);
    let best = 0;
    for (const [id, record] of lastKnown) if (id !== myShipId) best = Math.max(best, record.score);
    drawScore(ctx, view.width, lastKnown.get(myShipId)?.score ?? 0, best);

    const { latencyMs, jitterMs, dropRate } = injector.settings;
    netgraph.draw(ctx, view, now, [
      `інтерполяція ${interpolationDelay} мс${sample.starved ? '  (буфер порожній!)' : ''}`,
      `кодек        ${codec.name}`,
      `штучно       +${latencyMs} ± ${jitterMs} мс, втрати ${(dropRate * 100).toFixed(0)} %`,
      `передбачення ${predict ? 'так' : 'НІ'}${perturb ? '   ⚠ chaos=random' : ''}`,
    ]);
  }

  function hudLines() {
    const lines = [`room      ${welcome.room.name}`];
    if (self) {
      lines.push(
        self.down
          ? `hp        відродження через ${self.respawnTimer.toFixed(1)} с`
          : `hp        ${self.hp}`,
        `dash      ${self.dashCooldown <= 0 ? 'готовий' : self.dashCooldown.toFixed(1) + ' с'}`,
      );
      const runes = ['shield', 'rapid', 'homing'].filter((type) => self[type]);
      if (runes.length > 0) lines.push(`руни      ${runes.join(', ')}`);
    }
    lines.push(
      '',
      '← → поворот  ↑ тяга  ↓ гальмо',
      'Space постріл  E ривок  Enter чат',
      'L мережа  P передбачення  [ ] інтерполяція',
    );
    return lines;
  }

  // Цикл із Lab 1 — той самий акумулятор, лише крок тепер 1/30 с, як на сервері.
  const loop = createLoop({ step: DT, simulate, render });
  loop.start();

  return {
    netgraph,
    predictor,
    injector,
    get state() {
      return {
        self,
        myShipId,
        ghosts: ghosts.length,
        entities: interpolator.latest?.entities.size ?? 0,
      };
    },
    stop() {
      loop.stop();
      clearInterval(pingTimer);
      input.dispose();
      subscriptions.abort();
    },
  };
}
