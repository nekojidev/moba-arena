// DOM лобі. Лише слухає події Lobby і викликає його методи — жодного fetch тут немає.

const NAME_KEY = 'moba-arena:name';

function element(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function savedName() {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return ''; // приватний режим, вимкнене сховище — не привід падати
  }
}

function describe(error) {
  if (error.name === 'TimeoutError') return 'сервер не відповів вчасно';
  if (error.name === 'HttpError' && error.status >= 500)
    return 'сервер недоступний — чи запущено npm run dev:server?';
  if (error.name === 'ParseError') return 'сервер надіслав пошкоджені дані';
  if (error.name === 'TypeError' && /fetch/i.test(error.message)) return 'немає з’єднання';
  return error.message;
}

export function mountLobbyView(lobby, root) {
  // Усі слухачі цього екрана знімаються одним abort() — і на lobby, і на DOM.
  const controller = new AbortController();
  const { signal } = controller;
  let selectedId = null;
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

  function updateJoin() {
    joinButton.disabled = joining || selectedId === null || nameInput.value.trim().length < 2;
    joinButton.textContent = joining ? 'Заходжу…' : 'Приєднатися';
  }

  function renderRooms(rooms) {
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

  const on = (type, handler) => lobby.addEventListener(type, handler, { signal });

  on('rooms', ({ detail }) => {
    renderRooms(detail.rooms);
    status.textContent = `Кімнат: ${detail.rooms.length} · оновлено о ${new Date().toLocaleTimeString()}`;
    status.classList.remove('error');
    updateJoin();
  });

  on('error', ({ detail }) => {
    joining = false;
    status.textContent = describe(detail.error);
    status.classList.add('error');
    updateJoin();
  });

  on('joining', ({ detail }) => {
    joining = true;
    status.textContent = `Заходжу в «${detail.room.name}»…`;
    status.classList.remove('error');
    updateJoin();
  });

  nameInput.addEventListener('input', updateJoin, { signal });

  createButton.addEventListener(
    'click',
    async () => {
      createButton.disabled = true;
      const room = await lobby.createRoom(newRoomInput.value);
      createButton.disabled = false;
      if (!room) return;
      newRoomInput.value = '';
      selectedId = room.id;
      renderRooms(lobby.rooms);
      updateJoin();
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
      lobby.join(selectedId, nameInput.value); // результат прийде подією joined або error
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
