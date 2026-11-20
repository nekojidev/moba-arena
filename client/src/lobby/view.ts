// DOM лобі. Лише слухає події Lobby і викликає його методи — жодного fetch тут немає.

import type { RoomInfo } from '@moba-arena/shared/protocol.ts';
import { HttpError } from '../assets/loader.ts';
import { errorMessage, errorName } from '../guards.ts';
import type { Lobby } from './lobby.ts';

const NAME_KEY = 'moba-arena:name';

// Дженерик K: element('input', …) повертає саме HTMLInputElement, а props перевіряються
// за властивостями цього елемента — описка в імені властивості не скомпілюється.
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: readonly Node[] = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function savedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return ''; // приватний режим, вимкнене сховище — не привід падати
  }
}

function describe(error: unknown): string {
  const name = errorName(error);
  const message = errorMessage(error);
  if (name === 'TimeoutError') return 'сервер не відповів вчасно';
  if (error instanceof HttpError && error.status >= 500)
    return 'сервер недоступний — чи запущено npm run dev:server?';
  if (name === 'ParseError') return 'сервер надіслав пошкоджені дані';
  if (name === 'TypeError' && /fetch/i.test(message)) return 'немає з’єднання';
  return message;
}

export function mountLobbyView(lobby: Lobby, root: HTMLElement): { dispose(): void } {
  // Усі слухачі цього екрана знімаються одним abort() — і на lobby, і на DOM.
  const controller = new AbortController();
  const { signal } = controller;
  let selectedId: string | null = null;
  let joining = false;

  const nameInput = element('input', {
    type: 'text',
    maxLength: 16,
    placeholder: 'Ваше ім’я',
    value: savedName(),
    autocomplete: 'off',
  });
  const list = element('ul', { className: 'rooms' });
  const status = element('p', { className: 'status', textContent: 'Шукаю кімнати…' });
  const joinButton = element('button', {
    type: 'submit',
    textContent: 'Приєднатися',
    disabled: true,
  });
  const newRoomInput = element('input', {
    type: 'text',
    maxLength: 24,
    placeholder: 'Назва нової кімнати',
    autocomplete: 'off',
  });
  const createButton = element('button', {
    type: 'button',
    textContent: 'Створити',
    className: 'secondary',
  });
  const form = element('form', {}, [
    element('h1', { textContent: 'MOBA Arena' }),
    element('label', {}, [element('span', { textContent: 'Ім’я героя' }), nameInput]),
    element('h2', { textContent: 'Кімнати' }),
    list,
    element('div', { className: 'create' }, [newRoomInput, createButton]),
    status,
    joinButton,
  ]);

  function updateJoin(): void {
    joinButton.disabled = joining || selectedId === null || nameInput.value.trim().length < 2;
    joinButton.textContent = joining ? 'Заходжу…' : 'Приєднатися';
  }

  function renderRooms(rooms: readonly RoomInfo[]): void {
    if (!rooms.some((room) => room.id === selectedId)) selectedId = null;
    list.replaceChildren(
      ...rooms.map((room) => {
        const full = room.players >= room.maxPlayers;
        const button = element('button', {
          type: 'button',
          className: 'room' + (room.id === selectedId ? ' selected' : '') + (full ? ' full' : ''),
        });
        button.dataset.room = room.id;
        button.append(
          element('strong', { textContent: room.name }),
          element('span', {
            textContent: `${room.arena.width}×${room.arena.height} · големів: ${room.arena.asteroids}`,
          }),
          element('em', { textContent: full ? 'заповнена' : `${room.players}/${room.maxPlayers}` }),
        );
        button.addEventListener('click', () => {
          selectedId = room.id;
          renderRooms(lobby.rooms);
          updateJoin();
        });
        return element('li', {}, [button]);
      }),
    );
  }

  // lobby.on типізований: за іменем події tsc знає форму її даних.
  lobby.on(
    'rooms',
    ({ rooms }) => {
      renderRooms(rooms);
      status.textContent = `Кімнат: ${rooms.length} · оновлено о ${new Date().toLocaleTimeString()}`;
      status.classList.remove('error');
      updateJoin();
    },
    { signal },
  );

  lobby.on(
    'error',
    ({ error }) => {
      joining = false;
      status.textContent = describe(error);
      status.classList.add('error');
      updateJoin();
    },
    { signal },
  );

  lobby.on(
    'joining',
    ({ room }) => {
      joining = true;
      status.textContent = `Заходжу в «${room.name}»…`;
      status.classList.remove('error');
      updateJoin();
    },
    { signal },
  );

  nameInput.addEventListener('input', updateJoin, { signal });

  // Слухач події не чекає проміса: async-обробник, що відхилився, загубив би помилку.
  // Тому сам слухач синхронний, а асинхронну частину запускаємо явно й ловимо збій.
  async function createRoom(): Promise<void> {
    createButton.disabled = true;
    try {
      const room = await lobby.createRoom(newRoomInput.value);
      if (!room) return;
      newRoomInput.value = '';
      selectedId = room.id;
      renderRooms(lobby.rooms);
      updateJoin();
    } finally {
      createButton.disabled = false;
    }
  }

  createButton.addEventListener(
    'click',
    () => {
      createRoom().catch((error: unknown) => console.warn('[lobby]', error));
    },
    { signal },
  );

  form.addEventListener(
    'submit',
    (event) => {
      event.preventDefault();
      try {
        localStorage.setItem(NAME_KEY, nameInput.value.trim());
      } catch {
        /* сховище недоступне — ім'я просто не запам'ятається */
      }
      // Результат прийде подією joined або error; сам проміс join не відхиляється.
      void lobby.join(selectedId, nameInput.value);
    },
    { signal },
  );

  // «Поки лобі видиме»: вкладку сховали — запити зупиняємо, повернулись — відновлюємо.
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.hidden) lobby.stop();
      else lobby.start();
    },
    { signal },
  );

  root.replaceChildren(form);
  root.hidden = false;
  nameInput.focus();

  return {
    dispose() {
      controller.abort();
      root.hidden = true;
      root.replaceChildren();
    },
  };
}
