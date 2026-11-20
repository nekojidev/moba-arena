// Мережева гра. Світ рахує сервер; клієнт:
//   • раз на крок (30/с) надсилає input із номером seq — і НІКОЛИ координати;
//   • свого героя передбачає сам і звіряє з кожним знімком (net/prediction.ts);
//   • усіх інших малює трохи в минулому, між двома знімками (net/interpolation.ts);
//   • свої снаряди показує одразу, не чекаючи сервера.

import { entityId, type EntityId } from '@moba-arena/shared/brand.ts';
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
import type { EffectType, GameEvents, Team } from '@moba-arena/shared/sim/events.ts';
import { MUZZLE_OFFSET, SHIP_RADIUS } from '@moba-arena/shared/sim/ship.ts';
import type { GameAudio } from './audio.ts';
import { createEffects } from './effects.ts';
import { createPool } from './pool.ts';
import { assertNever, errorMessage } from './guards.ts';
import { createHud, type HudWorld } from './hud.ts';
import { createInput } from './input.ts';
import { createLoop } from './loop.ts';
import type { Connection } from './net/connection.ts';
import { createInjector, PRESETS, type Injector } from './net/injector.ts';
import { createInterpolator, createSampleBuffer, createServerClock } from './net/interpolation.ts';
import { createPerf, type Perf } from './perf.ts';
import { createNetgraph, type Netgraph } from './net/netgraph.ts';
import { createPredictor, type Perturb, type Predictor } from './net/prediction.ts';
import { fitArena, type View } from './render/canvas.ts';
import {
  createTextPanel,
  drawArena,
  drawAsteroid,
  drawBullet,
  drawPickup,
  drawScore,
  drawShip,
  hudStatLines,
} from './render/draw.ts';
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
  vx: number;
  vy: number;
  angle: number;
  ttl: number;
  serverId: EntityId | null;
}

const newGhost = (): Ghost => ({
  x: 0,
  y: 0,
  prevX: 0,
  prevY: 0,
  vx: 0,
  vy: 0,
  angle: 0,
  ttl: 0,
  serverId: null,
});

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
  readonly perf: Perf;
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
  const perf = createPerf({ marks: params.get('perf') === 'marks' });
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
  const ghostPool = createPool(newGhost); // привиди беремо з пулу й повертаємо туди
  let bestOtherScore = 0;
  // id снаряда на сервері → привид (або null, якщо привида немає)
  const ownBullets = new Map<EntityId, Ghost | null>();
  const seenBullets = new Set<EntityId>(); // один Set на весь матч, очищається на кожен знімок
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
    const startedAt = perf.begin();
    try {
      const snapshot = codec.decodeSnapshot(data);
      perf.end('decode', startedAt);
      return snapshot;
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
    const reconcileAt = perf.begin();
    const correction = snapshot.self
      ? predictor.reconcile(snapshot.self, snapshot.ack, { predict })
      : 0;
    perf.end('reconcile', reconcileAt);
    netgraph.snapshot(now, predict ? correction : 0);

    seenBullets.clear();
    bestOtherScore = 0;
    for (const entity of snapshot.entities) {
      if (entity.kind === 'ship') {
        if (entity.id !== myShipId) bestOtherScore = Math.max(bestOtherScore, entity.score);
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
          let ghost: Ghost | null = null;
          for (const candidate of ghosts) {
            if (candidate.serverId === null) {
              ghost = candidate;
              break;
            }
          }
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
      if (index >= 0) removeGhost(index);
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
      interpolationDelay = Math.min(300, interpolationDelay + 10);
  }

  // Прибирає привида зі списку (зберігаючи порядок: найстаріший — перший) і повертає в пул.
  function removeGhost(index: number): void {
    const ghost = ghosts[index];
    if (!ghost) return;
    for (let i = index; i < ghosts.length - 1; i += 1) {
      const next = ghosts[i + 1];
      if (next) ghosts[i] = next;
    }
    ghosts.length -= 1;
    ghostPool.release(ghost);
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
      // Об'єкт із пулу міг уже бути снарядом — заповнюємо ВСІ поля.
      const ghost = ghostPool.acquire();
      ghost.x = startX;
      ghost.y = startY;
      ghost.prevX = startX;
      ghost.prevY = startY;
      ghost.vx = vx + cos * BULLET_SPEED;
      ghost.vy = vy + sin * BULLET_SPEED;
      ghost.angle = angle;
      ghost.ttl = BULLET_TTL;
      ghost.serverId = null;
      ghosts.push(ghost);
      // Привид — свій і не самонавідний (такі не передбачаємо); свої на екрані зелені.
      bus.emit('fired', { shipId: myShipId, team: 'green', homing: false });
    }

    for (let i = ghosts.length - 1; i >= 0; i -= 1) {
      const ghost = ghosts[i];
      if (!ghost) continue;
      ghost.ttl -= DT;
      if (ghost.ttl <= 0) {
        removeGhost(i);
        continue;
      }
      ghost.prevX = ghost.x;
      ghost.prevY = ghost.y;
      ghost.x = wrap(ghost.x + ghost.vx * DT, arena.width);
      ghost.y = wrap(ghost.y + ghost.vy * DT, arena.height);
    }
  }

  // --- кадр --------------------------------------------------------------------------------

  // «Картки» для функцій малювання. Раніше на кожну сутність у кожному кадрі створювався
  // новий об'єкт (а для героя ще й нова функція hasEffect) — сотні об'єктів на секунду.
  // Тепер карток по одній на вид: перед викликом малювання в неї записуються значення
  // поточної сутності. Малювання синхронне, тому одну картку безпечно перевикористовувати.
  interface ShipCard {
    team: Team;
    name: string;
    hp: number;
    isDown: boolean;
    radius: number;
    thrust: number;
    dashCooldown: number;
    shield: boolean;
    hasEffect(type: EffectType): boolean;
  }
  interface BulletCard {
    team: Team;
    radius: number;
    behaviors: readonly { readonly tag?: string }[];
  }
  const shipCard: ShipCard = {
    team: 'green',
    name: '',
    hp: 0,
    isDown: false,
    radius: SHIP_RADIUS,
    thrust: 0,
    dashCooldown: 0,
    shield: false,
    hasEffect: (type) => type === 'shield' && shipCard.shield,
  };
  const bulletCard: BulletCard = { team: 'green', radius: 5, behaviors: NOT_HOMING };
  const asteroidCard = { id: entityId(0), radius: 0, behaviors: NOT_HOMING };
  const pickupEffect: { type: EffectType } = { type: 'shield' };
  const pickupCard = { effect: pickupEffect, radius: 18, ttl: 99 };
  // Одна поза на весь рендер: перезаписується перед кожним малюванням.
  const pose = { x: 0, y: 0, angle: 0 };

  function drawShipCard(
    id: EntityId,
    hp: number,
    shield: boolean,
    thrust: boolean,
    now: number,
  ): void {
    shipCard.team = id === myShipId ? 'green' : 'red';
    shipCard.name = id === myShipId ? playerName : (names.get(id) ?? 'Бот');
    shipCard.hp = hp;
    shipCard.shield = shield;
    shipCard.thrust = thrust ? 1 : 0;
    drawShip(ctx, shipCard, pose, now, sprites);
  }

  // Запис зі знімка → малюнок (поза вже лежить у `pose`). switch за kind звужує record до
  // конкретного варіанта, тож у гілці 'asteroid' є size, а в 'pickup' — effect. Новий вид
  // сутності в протоколі без гілки тут — помилка tsc (default отримує never).
  function drawRecord(record: SnapshotEntity, now: number): void {
    switch (record.kind) {
      case 'ship':
        if (record.down) return;
        drawShipCard(record.id, record.hp, record.shield, record.thrust, now);
        break;
      case 'bullet':
        bulletCard.team = record.owner === myShipId ? 'green' : 'red';
        bulletCard.behaviors = record.homing ? HOMING : NOT_HOMING;
        drawBullet(ctx, bulletCard, pose, now, sprites);
        break;
      case 'asteroid':
        asteroidCard.id = record.id;
        asteroidCard.radius = ASTEROID_RADIUS[record.size];
        asteroidCard.behaviors = record.homing ? HOMING : NOT_HOMING;
        drawAsteroid(ctx, asteroidCard, pose, now, sprites);
        break;
      case 'pickup':
        pickupEffect.type = record.effect;
        drawPickup(ctx, pickupCard, pose, now, sprites);
        break;
      default:
        assertNever(record);
    }
  }

  // Масштаб арени залежить лише від розміру вікна — перераховуємо, коли він змінився.
  let fit = fitArena(view, arena);
  let fitWidth = view.width;
  let fitHeight = view.height;

  // Буфер інтерполяції й текстові панелі живуть увесь матч.
  const sample = createSampleBuffer();
  const hudPanel = createTextPanel({
    font: '13px ui-monospace, Menlo, Consolas, monospace',
    lineHeight: 17,
    extraHeight: -4,
  });
  let hudRefreshedAt = -Infinity;
  const netgraphExtra = (): string[] => {
    const { latencyMs, jitterMs, dropRate } = injector.settings;
    return [
      `інтерполяція ${interpolationDelay} мс${sample.starved ? '  (буфер порожній!)' : ''}`,
      `кодек        ${codec.name}`,
      `штучно       +${latencyMs} ± ${jitterMs} мс, втрати ${(dropRate * 100).toFixed(0)} %`,
      `передбачення ${predict ? 'так' : 'НІ'}${perturb ? '   ⚠ chaos=random' : ''}`,
    ];
  };

  function render(alpha: number): void {
    const now = performance.now();
    const seconds = Math.min(0.1, (now - frameAt) / 1000);
    frameAt = now;
    predictor.decay(seconds);
    effects.update(seconds);

    // «Минуле», яке малюємо: серверний час мінус затримка інтерполяції.
    const renderTime = clock.ready ? clock.now(now) - interpolationDelay : 0;
    interpolator.sampleInto(renderTime, sample);
    for (let next = pendingEvents[0]; next && next.time <= renderTime; next = pendingEvents[0]) {
      pendingEvents.shift();
      handleEvent(next.event);
    }

    if (view.width !== fitWidth || view.height !== fitHeight) {
      fit = fitArena(view, arena);
      fitWidth = view.width;
      fitHeight = view.height;
    }
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.save();
    ctx.translate(fit.offsetX, fit.offsetY);
    ctx.scale(fit.scale, fit.scale);
    ctx.beginPath();
    ctx.rect(0, 0, arena.width, arena.height);
    ctx.clip();
    drawArena(ctx, arena);

    const me = self;
    const ownPose = predict && me && !me.down ? predictor.pose(alpha) : null;
    for (const kind of LAYERS) {
      for (let i = 0; i < sample.count; i += 1) {
        const record = sample.records[i];
        if (!record || record.kind !== kind) continue;
        // Свого героя малюємо з передбачення, а не з минулого.
        if (record.id === myShipId && ownPose) continue;
        // Власний снаряд, у якого є привид, сервером не дублюємо.
        if (kind === 'bullet' && ownBullets.get(record.id)) continue;
        pose.x = sample.x[i] ?? record.x;
        pose.y = sample.y[i] ?? record.y;
        pose.angle = sample.angle[i] ?? record.angle;
        drawRecord(record, now);
      }
      if (kind === 'bullet') {
        bulletCard.team = 'green';
        bulletCard.behaviors = NOT_HOMING;
        for (const ghost of ghosts) {
          // Перехід через край арени (стрибок понад 200 од.) не інтерполюємо.
          const jumped =
            Math.abs(ghost.x - ghost.prevX) > 200 || Math.abs(ghost.y - ghost.prevY) > 200;
          const k = jumped ? 1 : alpha;
          pose.x = ghost.prevX + (ghost.x - ghost.prevX) * k;
          pose.y = ghost.prevY + (ghost.y - ghost.prevY) * k;
          pose.angle = ghost.angle;
          drawBullet(ctx, bulletCard, pose, now, sprites);
        }
      }
    }
    if (ownPose && me) {
      pose.x = ownPose.x;
      pose.y = ownPose.y;
      pose.angle = ownPose.angle;
      drawShipCard(myShipId, me.hp, me.shield, (predictor.state?.thrust ?? 0) > 0, now);
    }
    effects.draw(ctx);
    hud.drawWorld(ctx, now);
    ctx.restore();

    // --- поверх арени: статистика циклу, рахунок, стрічка, netgraph ------------------------
    // Текст панелей оновлюється чотири рази на секунду, а малюється щокадру з готових рядків.
    if (now - hudRefreshedAt >= 250) {
      hudRefreshedAt = now;
      hudPanel.update(ctx, [...hudStatLines(loop.stats()), ...hudLines()]);
    }
    hudPanel.draw(ctx, 12, 12);
    hud.drawScreen(ctx, view, now);
    drawScore(ctx, view.width, lastKnown.get(myShipId)?.score ?? 0, bestOtherScore);
    netgraph.draw(ctx, view, now, netgraphExtra);
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
  // Обгортки створюються один раз — на кадр нових функцій немає.
  const loop = createLoop({
    step: DT,
    simulate() {
      const startedAt = perf.begin();
      simulate();
      perf.end('simulate', startedAt);
    },
    render(alpha) {
      perf.frame(loop.stats().frameTime);
      const startedAt = perf.begin();
      render(alpha);
      perf.end('render', startedAt);
    },
  });
  loop.start();

  return {
    netgraph,
    predictor,
    injector,
    perf,
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
