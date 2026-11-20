// Панель кімнати: склад гравців, чат і стан з'єднання. Слухає з'єднання, малює DOM.
// Тексти гравців вставляються лише через textContent — HTML із чату не виконується.

import type { ServerMessageOf } from '@moba-arena/shared/protocol.ts';
import { assertNever } from './guards.ts';
import type { Connection, ConnectionStatus } from './net/connection.ts';

const MAX_LINES = 50;

// Дженерик K: element('input', …) повертає саме HTMLInputElement, а props перевіряються
// за властивостями цього елемента.
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: readonly Node[] = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// Текст для рядка стану. null — напис не змінюємо (перше підключення).
// switch за status: у кожній гілці доступні лише поля свого варіанта, а default
// з assertNever не дасть забути новий стан.
function statusText(event: ConnectionStatus): string | null {
  switch (event.status) {
    case 'open':
      return 'на зв’язку';
    case 'waiting':
      return `зв’язок втрачено — нова спроба через ${(event.waitMs / 1000).toFixed(1)} с`;
    case 'reconnecting':
      return 'підключаюсь знову…';
    case 'closed':
      return `від’єднано${event.reason ? ': ' + event.reason : ''}`;
    case 'connecting':
      return null;
    default:
      return assertNever(event);
  }
}

export function mountChat(
  connection: Connection,
  root: HTMLElement,
  { playerId, roomName }: { playerId: string; readonly roomName: string },
): { dispose(): void } {
  const controller = new AbortController();
  const { signal } = controller;

  const title = element('h2', { textContent: roomName });
  const roster = element('ul', { className: 'roster' });
  const state = element('p', { className: 'net', textContent: 'на зв’язку' });
  const log = element('ol', { className: 'log' });
  const input = element('input', {
    type: 'text',
    maxLength: 200,
    placeholder: 'Enter — написати в чат',
    autocomplete: 'off',
  });
  const form = element('form', {}, [input]);
  root.replaceChildren(title, roster, state, log, form);
  root.hidden = false;

  function addLine(text: string, className = ''): void {
    log.append(element('li', { textContent: text, className }));
    while (log.children.length > MAX_LINES) log.firstChild?.remove();
    log.scrollTop = log.scrollHeight;
  }

  let known: Map<string, string> | null = null; // id → ім'я; щоб повідомляти, хто зайшов і хто вийшов
  function renderRoster({ players }: ServerMessageOf<'roster'>): void {
    roster.replaceChildren(
      ...players.map((player) =>
        element('li', {
          textContent: player.name + (player.id === playerId ? ' (ви)' : ''),
          className: player.id === playerId ? 'me' : '',
        }),
      ),
    );
    const current = new Map(players.map((player) => [player.id, player.name]));
    if (known) {
      for (const [id, name] of current) if (!known.has(id)) addLine(`→ ${name} зайшов`, 'system');
      for (const [id, name] of known) if (!current.has(id)) addLine(`← ${name} вийшов`, 'system');
    }
    known = current;
  }

  connection.on('roster', renderRoster, { signal });
  connection.on(
    'chat',
    ({ from, text }) => addLine(`${from.name}: ${text}`, from.id === playerId ? 'mine' : ''),
    { signal },
  );
  connection.on(
    'welcome',
    (welcome) => {
      playerId = welcome.playerId; // після перепідключення сервер видає новий id
    },
    { signal },
  );
  connection.on(
    'status',
    (event) => {
      const text = statusText(event);
      if (text) state.textContent = text;
      state.classList.toggle('bad', event.status !== 'open');
    },
    { signal },
  );

  // Склад кімнати міг прийти раніше, ніж намалювалась панель.
  const lastRoster = connection.last('roster');
  if (lastRoster) renderRoster(lastRoster);

  form.addEventListener(
    'submit',
    (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (text) connection.send({ type: 'chat', text }); // без зв'язку — стане в чергу
      input.value = '';
      input.blur(); // повертаємо клавіатуру грі
    },
    { signal },
  );

  window.addEventListener(
    'keydown',
    (event) => {
      if (event.code === 'Enter' && document.activeElement !== input) {
        event.preventDefault();
        input.focus();
      } else if (event.code === 'Escape') {
        input.blur();
      }
    },
    { signal },
  );

  return {
    dispose() {
      controller.abort();
      root.hidden = true;
      root.replaceChildren();
    },
  };
}
