// Мережева гра. Світ рахує сервер; клієнт:
//   • раз на крок (30/с) надсилає input із номером seq — і НІКОЛИ координати;
//   • свого героя передбачає сам і звіряє з кожним знімком (net/prediction.ts);
//   • усіх інших малює трохи в минулому, між двома знімками (net/interpolation.ts);
//   • свої снаряди показує одразу, не чекаючи сервера.

import type { EntityId } from '@moba-arena/shared/brand.ts';
import { Bus } from '@moba-arena/shared/bus.ts';
import { CODECS, CodecError } from '@moba-arena/shared/codec/index.ts';
import {
  DT,
  TICK_MS,
  type Input,
  type NetEvent,
  type SelfState,
  type ServerMessageOf,
  type Snapshot,
  type SnapshotEntity,
  type SnapshotEntityOf,
  type Welcome,
} from '@moba-arena/shared/protocol.ts';
import { BULLET_SPEED, BULLET_TTL } from '@moba-arena/shared/sim/bullet.ts';
import { wrap } from '@moba-arena/shared/sim/arena.ts';
import { ASTEROID_RADIUS } from '@moba-arena/shared/sim/asteroid.ts';
import type { GameEvents } from '@moba-arena/shared/sim/events.ts';
import { MUZZLE_OFFSET, SHIP_RADIUS } from '@moba-arena/shared/sim/ship.ts';
import type { GameAudio } from './audio.ts';
import { createEffects } from './effects.ts';
import { assertNever, errorMessage } from './guards.ts';
import { createHud, type HudWorld } from './hud.ts';
import { createInput } from './input.ts';
import { createLoop } from './loop.ts';
import type { Connection } from './net/connection.ts';
import { createInjector, PRESETS, type Injector } from './net/injector.ts';
import { createInterpolator, createServerClock } from './net/interpolation.ts';
import { createNetgraph, type Netgraph } from './net/netgraph.ts';
import { createPredictor, type Perturb, type Predictor } from './net/prediction.ts';
import { fitArena, type View } from './render/canvas.ts';
import {
  drawArena,
  drawAsteroid,
  drawBullet,
  drawHud,
  drawPickup,
  drawScore,
  drawShip,
  type ShipView,
} from './render/draw.ts';
import type { Pose } from './render/lerp.ts';
import type { Sprites } from './render/sprites.ts';

// draw.ts упізнає самонаведення за цією позначкою
const HOMING: readonly { readonly tag?: string }[] = [{ tag: 'homing' }];
const NOT_HOMING: readonly { readonly tag?: string }[] = [];
// as const — не приведення типу: фіксує літерали, тож елемент — 'pickup' | 'asteroid' | …
const LAYERS = ['pickup', 'asteroid', 'bullet', 'ship'] as const;
const RUNES = ['shield', 'rapid', 'homing'] as const;

type ShipRecord = SnapshotEntityOf<'ship'>;

// Власний снаряд, показаний одразу, не чекаючи сервера.
interface Ghost {
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  readonly vx: number;
  readonly vy: number;
  readonly angle: number;
  ttl: number;
  serverId: EntityId | null;
}

export interface NetGameOptions {
  readonly ctx: CanvasRenderingContext2D;
  readonly view: View;
  readonly sprites: Sprites;
  readonly audio: GameAudio;
  readonly connection: Connection;
  readonly welcome: Welcome;
  readonly playerName: string;
  readonly params: URLSearchParams;
}

export interface NetGame {
  readonly netgraph: Netgraph;
  readonly predictor: Predictor;
  readonly injector: Injector;
  readonly state: {
    readonly self: SelfState | null;
    readonly myShipId: EntityId;
    readonly ghosts: number;
    readonly entities: number;
  };
  stop(): void;
}

export function startNetGame({
  ctx,
  view,
  sprites,
  audio,
  connection,
  welcome,
  playerName,
  params,
}: NetGameOptions): NetGame {
  const arena = { width: welcome.room.arena.width, height: welcome.room.arena.height };
  const codec = CODECS[welcome.codec];
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
  const perturb: Perturb | null =
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

  // Шина подій для звуку й HUD — та сама, що у світі симуляції (Bus<GameEvents>),
  // лише події приходять із мережі. Ім'я події визначає форму даних: emit('fired', …)
  // без потрібного поля не скомпілюється.
  const bus = new Bus<GameEvents>();
  const names = new Map<EntityId, string>(); // id героя → ім'я
  const lastKnown = new Map<EntityId, ShipRecord>(); // id героя → останній запис зі знімка
  // HUD потрібен «світ»: шина й get(id). Справжнього світу на клієнті немає — збираємо
  // об'єкт потрібної форми зі знімків. Запис зі знімка має x і y, тож годиться як pos.
  const fakeWorld: HudWorld = {
    events: bus,
    get: (id) => {
      const record = lastKnown.get(id);
      return record ? { name: names.get(id) ?? 'Бот', pos: record } : undefined;
    },
  };
  const hud = createHud(fakeWorld, { playerId: myShipId, signal });
  audio.connect(bus, { playerId: myShipId, signal });

  let self: SelfState | null = null; // останній точний стан власного героя від сервера
  const ghosts: Ghost[] = []; // власні снаряди, показані одразу
  // id снаряда на сервері → привид (або null, якщо привида немає)
  const ownBullets = new Map<EntityId, Ghost | null>();
  // події сервера чекають, поки до них дійде «минуле», яке ми малюємо
  const pendingEvents: { readonly time: number; readonly event: NetEvent }[] = [];
  let frameAt = performance.now();

  function applyRoster({ players }: ServerMessageOf<'roster'>): void {
    names.clear();
    for (const player of players) {
      // shipId у складі кімнати необов'язковий: гравець міг іще не отримати героя.
      if (player.shipId !== undefined) names.set(player.shipId, player.name);
    }
  }
  connection.on('roster', applyRoster, { signal });
  const lastRoster = connection.last('roster');
  if (lastRoster) applyRoster(lastRoster);

  // --- вхідні повідомлення ------------------------------------------------------------------

  // Байти (або текст) із мережі → перевірений знімок. Кодек кидає CodecError на зіпсований
  // кадр; такий кадр пропускаємо. error у catch — unknown, тому перевіряємо instanceof,
  // а будь-яку іншу помилку (це вже баг у коді) кидаємо далі.
  function decodeSnapshot(data: unknown): Snapshot | null {
    try {
      return codec.decodeSnapshot(data);
    } catch (error) {
      if (!(error instanceof CodecError)) throw error;
      console.warn(`[net] відкинуто знімок: ${errorMessage(error)}`);
      return null;
    }
  }

  function onSnapshot(snapshot: Snapshot | null, bytes: number): void {
    if (!snapshot) return;
    const now = performance.now();
    netgraph.received(bytes, now);
    if (!interpolator.push(snapshot)) return; // прийшов не по порядку
    clock.observe(snapshot.tick * TICK_MS, now);

    self = snapshot.self;
    const correction = snapshot.self
      ? predictor.reconcile(snapshot.self, snapshot.ack, { predict })
      : 0;
    netgraph.snapshot(now, predict ? correction : 0);

    const seenBullets = new Set<EntityId>();
    for (const entity of snapshot.entities) {
      if (entity.kind === 'ship') {
        const before = lastKnown.get(entity.id);
        if (before && entity.score > before.score) {
          bus.emit('score', {
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
      if (!ghost) continue;
      const index = ghosts.indexOf(ghost);
      if (index >= 0) ghosts.splice(index, 1);
    }
  }

  connection.onBinary(
    (data) => injector.pass('down', () => onSnapshot(decodeSnapshot(data), data.byteLength)),
    { signal },
  );
  // У режимі ?codec=json знімок приходить текстом, як звичайне повідомлення.
  connection.on(
    'snapshot',
    (message) =>
      injector.pass('down', () =>
        onSnapshot(decodeSnapshot(message), JSON.stringify(message).length),
      ),
    { signal },
  );
  connection.on(
    'events',
    ({ tick, events }) =>
      injector.pass(
        'down',
        () => {
          for (const event of events) pendingEvents.push({ time: tick * TICK_MS, event });
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

  // Подія сервера → ефекти, звук, HUD. switch за type: у кожній гілці event уже має
  // точну форму своєї події. У default він має тип never — якщо в протокол додадуть
  // нову подію й забудуть про неї тут, tsc покаже помилку саме в цьому рядку.
  function handleEvent(event: NetEvent): void {
    switch (event.type) {
      case 'fired':
        if (event.shipId !== myShipId) bus.emit('fired', event); // свій постріл уже прозвучав
        break;
      case 'exploded':
        effects.explode(event.x, event.y, {
          count: event.kind === 'ship' ? 36 : 8 + (event.size ?? 1) * 6,
          speed: event.kind === 'ship' ? 260 : 220,
          color: event.kind !== 'ship' ? '#ffd27a' : event.id === myShipId ? '#7ef0c0' : '#ff8a7a',
        });
        bus.emit('exploded', event);
        break;
      case 'hit':
        bus.emit('hit', event);
        break;
      case 'pickup':
        bus.emit('pickup', event);
        break;
      case 'respawned':
        bus.emit('respawned', event);
        break;
      default:
        assertNever(event);
    }
  }

  // --- крок (30/с): input → мережа → передбачення ------------------------------------------

  // Тип результату — команда з протоколу (Input без seq): turn може бути лише −1, 0 або 1,
  // thrust — 0 або 1. Довільне число сюди не потрапить — кодек його й не закодував би.
  function readCommand(): Omit<Input, 'seq'> {
    const right = input.isDown('ArrowRight');
    const left = input.isDown('ArrowLeft');
    return {
      turn: right === left ? 0 : right ? 1 : -1,
      thrust: input.isDown('ArrowUp') ? 1 : 0,
      brake: input.isDown('ArrowDown'),
      dash: input.justPressed('KeyE'),
      fire: input.isDown('Space'),
    };
  }

  function hotkeys(): void {
    if (input.justPressed('KeyM')) hud.say(audio.toggleMute() ? 'звук вимкнено' : 'звук увімкнено');
    if (input.justPressed('KeyP')) {
      predict = !predict;
      hud.say(predict ? 'передбачення увімкнено' : 'передбачення ВИМКНЕНО — герой чекає сервера');
    }
    if (input.justPressed('KeyL')) {
      presetIndex = (presetIndex + 1) % PRESETS.length;
      const preset = PRESETS[presetIndex];
      if (preset) {
        const { name, ...settings } = preset;
        Object.assign(injector.settings, settings);
        hud.say(`мережа: ${name}`);
      }
    }
    if (input.justPressed('BracketLeft')) interpolationDelay = Math.max(0, interpolationDelay - 10);
    if (input.justPressed('BracketRight'))
      interpolationDelay = Math.min(500, interpolationDelay + 10);
  }

  function simulate(): void {
    hotkeys();
    const command = readCommand();
    input.endStep();

    const me = self; // const-копія: за нею tsc пам'ятає перевірку на null
    const canPredict = predict && me !== null && !me.down;
    const { seq, fired } = predictor.applyInput(command, { predict: canPredict });
    const data = codec.encodeInput({ seq, ...command });
    injector.pass('up', () => {
      if (connection.sendRaw(data)) netgraph.sent(data.length, performance.now());
    });
    netgraph.metrics.pending = predictor.pendingCount;

    // Власний снаряд — одразу, з передбаченого стану. Самонавідні не передбачаємо:
    // їхня траєкторія залежить від цілей, яких клієнт точно не знає.
    const predicted = predictor.state;
    if (fired && canPredict && me && predicted && !me.homing) {
      const { x, y, vx, vy, angle } = predicted;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const startX = wrap(x + cos * MUZZLE_OFFSET, arena.width);
      const startY = wrap(y + sin * MUZZLE_OFFSET, arena.height);
      ghosts.push({
        x: startX,
        y: startY,
        prevX: startX,
        prevY: startY,
        vx: vx + cos * BULLET_SPEED,
        vy: vy + sin * BULLET_SPEED,
        angle,
        ttl: BULLET_TTL,
        serverId: null,
      });
      // Привид — свій і не самонавідний (такі не передбачаємо); свої на екрані зелені.
      bus.emit('fired', { shipId: myShipId, team: 'green', homing: false });
    }

    for (let i = ghosts.length - 1; i >= 0; i -= 1) {
      const ghost = ghosts[i];
      if (!ghost) continue;
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

  // «Картка» героя для drawShip: із запису знімка беремо лише потрібні поля.
  function shipView(
    record: Pick<ShipRecord, 'id' | 'hp' | 'down' | 'shield' | 'thrust'>,
  ): ShipView {
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

  // Запис зі знімка → малюнок. switch за kind звужує record до конкретного варіанта,
  // тож у гілці 'asteroid' є size, а в 'pickup' — effect. Новий вид сутності в протоколі
  // без гілки тут — помилка tsc (default отримує never).
  function drawRecord(record: SnapshotEntity, pose: Pose, now: number): void {
    switch (record.kind) {
      case 'ship':
        drawShip(ctx, shipView(record), pose, now, sprites);
        break;
      case 'bullet':
        drawBullet(
          ctx,
          {
            team: record.owner === myShipId ? 'green' : 'red',
            radius: 5,
            behaviors: record.homing ? HOMING : NOT_HOMING,
          },
          pose,
          now,
          sprites,
        );
        break;
      case 'asteroid':
        drawAsteroid(
          ctx,
          {
            id: record.id,
            radius: ASTEROID_RADIUS[record.size],
            behaviors: record.homing ? HOMING : NOT_HOMING,
          },
          pose,
          now,
          sprites,
        );
        break;
      case 'pickup':
        drawPickup(
          ctx,
          { effect: { type: record.effect }, radius: 18, ttl: 99 },
          pose,
          now,
          sprites,
        );
        break;
      default:
        assertNever(record);
    }
  }

  function render(alpha: number): void {
    const now = performance.now();
    const seconds = Math.min(0.1, (now - frameAt) / 1000);
    frameAt = now;
    predictor.decay(seconds);
    effects.update(seconds);

    // «Минуле», яке малюємо: серверний час мінус затримка інтерполяції.
    const renderTime = clock.ready ? clock.now(now) - interpolationDelay : 0;
    const sample = interpolator.sample(renderTime);
    for (let next = pendingEvents[0]; next && next.time <= renderTime; next = pendingEvents[0]) {
      pendingEvents.shift();
      handleEvent(next.event);
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

    const me = self;
    const ownPose = predict && me && !me.down ? predictor.pose(alpha) : null;
    for (const kind of LAYERS) {
      for (const record of sample.entities) {
        if (record.kind !== kind) continue;
        // Свого героя малюємо з передбачення, а не з минулого.
        if (record.id === myShipId && ownPose) continue;
        // Власний снаряд, у якого є привид, сервером не дублюємо.
        if (kind === 'bullet' && ownBullets.get(record.id)) continue;
        drawRecord(record, record, now); // запис має x, y, angle — він сам собі поза
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
    if (ownPose && me) {
      const own = shipView({
        id: myShipId,
        hp: me.hp,
        shield: me.shield,
        down: false,
        thrust: (predictor.state?.thrust ?? 0) > 0,
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

  function hudLines(): string[] {
    const lines = [`room      ${welcome.room.name}`];
    const me = self;
    if (me) {
      lines.push(
        me.down
          ? `hp        відродження через ${me.respawnTimer.toFixed(1)} с`
          : `hp        ${me.hp}`,
        `dash      ${me.dashCooldown <= 0 ? 'готовий' : me.dashCooldown.toFixed(1) + ' с'}`,
      );
      const runes = RUNES.filter((type) => me[type]);
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
