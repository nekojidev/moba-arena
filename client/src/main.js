// Точка входу: завантаження → лобі → гра. Кожен крок — await:
// наступний екран не почнеться, поки не завершився попередній, але потік при цьому
// не блокується — між await-ами працюють і рендер смужки, і кнопки.

import { createAudio } from './audio.js';
import { mountChat } from './chat.js';
import { createConnection } from './net/connection.js';
import { once } from './async.js';
import { Lobby } from './lobby/lobby.js';
import { mountLobbyView } from './lobby/view.js';
import { setupCanvas } from './render/canvas.js';
import { createSprites } from './render/sprites.js';
import { describeError, runLoadingScreen } from './screens/loading.js';
import { startNetGame } from './netplay.js';
import { startGame } from './play.js';

const params = new URLSearchParams(window.location.search);
const { ctx, view } = setupCanvas(document.querySelector('#game'));

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

const sprites = createSprites(assets.atlas, { heroes: assets.heroes, objects: assets.objects });
audio.setBuffers({
  shoot: assets.shoot,
  hit: assets.hit,
  explode: assets.explode,
  pickup: assets.pickup,
});
const warnings = failures.map(
  ({ id, error }) => `⚠ ${id}: ${describeError(error).toLowerCase()} — запасний варіант`,
);

// 2. Лобі. Режими експериментів Lab 1 (?exp, ?bench) його пропускають і грають без сервера.
const socketUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

// ?codec=json — ігрові повідомлення текстом, щоб порівняти з бінарним форматом.
const codec = params.get('codec') === 'json' ? 'json' : 'binary';

async function chooseRoom() {
  if (params.has('exp') || params.has('bench')) {
    return { name: 'Гравець', room: { name: 'локальна', arena: {} }, connection: null };
  }
  const lobby = new Lobby({
    url: new URL('api/rooms', document.baseURI).href,
    // hello надсилається після КОЖНОГО відкриття сокета — отже, і після перепідключення.
    connect: ({ roomId, name }) =>
      createConnection({
        url: socketUrl,
        hello: () => ({ type: 'join', room: roomId, name, codec }),
      }),
  });
  const lobbyView = mountLobbyView(lobby, document.querySelector('#lobby'));
  lobby.start();
  const joined = await once(lobby, 'joined'); // подія → проміс
  lobbyView.dispose(); // гравець пішов із лобі: запити й слухачі вже скасовано (lobby.stop у join)
  return joined.detail;
}

const { name, room, connection, playerId, welcome } = await chooseRoom();

// 3. Гра. З сервером — мережева (світ рахує він); без нього — локальна з Lab 1–3.
document.querySelector('#modes').hidden = false;
let game;
if (connection) {
  game = startNetGame({ ctx, view, sprites, audio, connection, welcome, playerName: name, params });
  for (const warning of warnings) console.warn(warning);
  mountChat(connection, document.querySelector('#chat'), { playerId, roomName: room.name });
  window.addEventListener('pagehide', () => connection.close());
} else {
  game = startGame({
    ctx,
    view,
    sprites,
    audio,
    config: { ...assets.arena, ...room.arena },
    playerName: name,
    roomName: room.name,
    warnings,
    params,
  });
}

console.log(`[game] кімната «${room.name}», ассети за ${elapsedMs.toFixed(0)} мс (${strategy})`);
window.__game = { game, audio, connection }; // для налагодження з консолі
