// Точка входу: завантаження → лобі → гра (→ знову лобі, якщо сервер зник). Кожен крок — await:
// наступний екран не почнеться, поки не завершився попередній, але потік при цьому
// не блокується — між await-ами працюють і рендер смужки, і кнопки.

import './pwa.ts';
import { createAudio } from './audio.ts';
import { mountChat } from './chat.ts';
import { isRecord, requireElement } from './guards.ts';
import { createConnection } from './net/connection.ts';
import { Lobby, type Joined } from './lobby/lobby.ts';
import { watchSession } from './lobby/session.ts';
import { mountLobbyView } from './lobby/view.ts';
import { setupCanvas } from './render/canvas.ts';
import { createSprites, parseAtlas } from './render/sprites.ts';
import { describeError, runLoadingScreen } from './screens/loading.ts';
import { startNetGame } from './netplay.ts';
import { startGame, type LocalConfig, type LocalGame } from './play.ts';

// Налагоджувальна «ручка» в консолі: window.__game. Розширюємо тип Window, щоб
// присвоєння нижче перевірялося, а не було записом у невідоме поле.
declare global {
  interface Window {
    __game?: unknown;
  }
}

// Завантажувач віддає значення як unknown (JSON, картинка, звук або null, якщо файл
// не завантажився). Перш ніж користуватися — перевіряємо, що це справді те, чого чекаємо.
function imageOrNull(value: unknown): ImageBitmap | null {
  return value instanceof ImageBitmap ? value : null;
}

function soundOrNull(value: unknown): AudioBuffer | null {
  return value instanceof AudioBuffer ? value : null;
}

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' ? value : undefined;

// arena.json: розмір арени обов'язковий, решта — необов'язкові числа.
function parseArenaConfig(value: unknown): LocalConfig {
  if (!isRecord(value) || typeof value.width !== 'number' || typeof value.height !== 'number') {
    throw new Error('arena.json: потрібні числові width і height');
  }
  return {
    width: value.width,
    height: value.height,
    seed: optionalNumber(value.seed),
    asteroids: optionalNumber(value.asteroids),
    pickups: optionalNumber(value.pickups),
  };
}

const params = new URLSearchParams(window.location.search);
// querySelector<HTMLCanvasElement> каже, якого типу елемент ми шукаємо; чи знайшовся він —
// перевіряє requireElement (у рантаймі), бо querySelector може повернути null.
const { ctx, view } = setupCanvas(
  requireElement(document.querySelector<HTMLCanvasElement>('#game'), '#game'),
);

// Контекст створюємо одразу (він потрібен, щоб декодувати буфери під час завантаження),
// а звучати йому дозволить лише жест користувача.
const audio = createAudio();
window.addEventListener('pointerdown', audio.unlock);
window.addEventListener('keydown', audio.unlock);

// 1. Ассети. Гра не стартує, доки цей await не завершиться.
const { assets, failures, elapsedMs, strategy } = await runLoadingScreen({
  ctx,
  view,
  audioContext: audio.context,
  params,
});

const sprites = createSprites(parseAtlas(assets.atlas), {
  heroes: imageOrNull(assets.heroes),
  objects: imageOrNull(assets.objects),
});
audio.setBuffers({
  shoot: soundOrNull(assets.shoot),
  hit: soundOrNull(assets.hit),
  explode: soundOrNull(assets.explode),
  pickup: soundOrNull(assets.pickup),
});
const warnings = failures.map(
  ({ id, error }) => `⚠ ${id}: ${describeError(error).toLowerCase()} — запасний варіант`,
);

// 2. Лобі. Режими експериментів Lab 1 (?exp, ?bench) його пропускають і грають без сервера.
const socketUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

// ?codec=json — ігрові повідомлення текстом, щоб порівняти з бінарним форматом.
const codec = params.get('codec') === 'json' ? 'json' : 'binary';

const offline = params.has('exp') || params.has('bench');
const modes = requireElement(document.querySelector<HTMLElement>('#modes'), '#modes');

// Лобі: чекаємо, поки гравець обере кімнату й сервер його прийме.
// notice — чому гравець знову тут («Сервер перезапускається…»); на першому вході його немає.
async function chooseRoom(notice: string | null): Promise<Joined> {
  const lobby = new Lobby({
    url: new URL('api/rooms', document.baseURI).href,
    // hello надсилається після КОЖНОГО відкриття сокета — отже, і після перепідключення.
    connect: ({ roomId, name }) =>
      createConnection({
        url: socketUrl,
        hello: () => ({ type: 'join', room: roomId, name, codec }),
      }),
  });
  const lobbyView = mountLobbyView(
    lobby,
    requireElement(document.querySelector<HTMLElement>('#lobby'), '#lobby'),
    { notice },
  );
  lobby.start();
  // подія → проміс; тип Joined виводиться з імені події 'joined'
  const joined = await new Promise<Joined>((resolve) => lobby.on('joined', resolve));
  lobbyView.dispose(); // гравець пішов із лобі: запити й слухачі вже скасовано (lobby.stop у join)
  return joined;
}

// Одна мережева гра: від входу в кімнату до повернення в лобі. Проміс виконується текстом
// для гравця — чому гра скінчилась. Усе, що гра створила (цикл, таймери, слухачі, сокет,
// панель чату), прибирається тут же: наступна гра починає з чистого аркуша.
function playOnline({ name, room, connection, playerId, welcome }: Joined): Promise<string> {
  const session = new AbortController();
  const game = startNetGame({
    ctx,
    view,
    sprites,
    audio,
    connection,
    welcome,
    playerName: name,
    params,
  });
  // ?bots=8 — попросити сервер додати ботів у цей матч (для профілювання й демонстрації).
  const bots = Number(params.get('bots') ?? 0);
  if (Number.isInteger(bots) && bots > 0) {
    fetch(new URL(`api/rooms/${encodeURIComponent(room.id)}/bots`, document.baseURI), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ count: bots }),
    }).catch((error: unknown) => console.warn('[bots]', error));
  }
  const chat = mountChat(
    connection,
    requireElement(document.querySelector<HTMLElement>('#chat'), '#chat'),
    { playerId, roomName: room.name },
  );
  window.addEventListener('pagehide', () => connection.close(), { signal: session.signal });
  modes.hidden = false;
  console.log(`[game] кімната «${room.name}», ассети за ${elapsedMs.toFixed(0)} мс (${strategy})`);
  window.__game = { game, audio, connection }; // для налагодження з консолі

  return new Promise((resolve) => {
    watchSession(connection, {
      signal: session.signal,
      onReturn({ reason, message }) {
        console.warn(`[game] повернення в лобі (${reason}): ${message}`);
        session.abort();
        game.stop();
        chat.dispose();
        connection.close(); // більше не перепідключаємось: у лобі буде нове з'єднання
        modes.hidden = true;
        window.__game = undefined; // доки гравець у лобі, гри немає
        resolve(message);
      },
    });
  });
}

// Лобі → гра → (сервер зник) → лобі з поясненням → гра… і так, доки відкрита сторінка.
async function runOnline(): Promise<never> {
  let notice: string | null = null;
  for (;;) {
    const joined = await chooseRoom(notice);
    notice = await playOnline(joined);
  }
}

// 3. Гра. З сервером — мережева (світ рахує він); без нього — локальна з Lab 1–3.
if (offline) {
  // Режими експериментів Lab 1 грають без сервера й без лобі.
  modes.hidden = false;
  const roomName = 'локальна';
  const game: LocalGame = startGame({
    ctx,
    view,
    sprites,
    audio,
    config: parseArenaConfig(assets.arena),
    playerName: 'Гравець',
    roomName,
    warnings,
    params,
  });
  console.log(`[game] кімната «${roomName}», ассети за ${elapsedMs.toFixed(0)} мс (${strategy})`);
  window.__game = { game, audio, connection: null }; // для налагодження з консолі
} else {
  for (const warning of warnings) console.warn(warning);
  await runOnline();
}
