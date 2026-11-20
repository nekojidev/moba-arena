// Спільні помічники наскрізних тестів: кімната через REST, шлях «завантаження → лобі → гра»
// і «стрічка знімків» — те, що сервер насправді надіслав у сокет конкретної вкладки.

import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { CODECS } from '../shared/src/codec/index.ts';
import type { Snapshot, SnapshotEntityOf } from '../shared/src/protocol.ts';

export type ShipRecord = SnapshotEntityOf<'ship'>;

export interface Arena {
  readonly width: number;
  readonly height: number;
}

export interface TestRoom {
  readonly id: string;
  readonly name: string;
  readonly arena: Arena;
}

// Окрема кімната на кожен тест: без големів і рун, щоб героя ніщо не штовхало й не вбивало.
// Порожню кімнату сервер видаляє сам, тож прибирати за собою не треба.
export async function createRoom(request: APIRequestContext, label: string): Promise<TestRoom> {
  const name = `${label}-${Date.now().toString(36)}`.slice(0, 24);
  const response = await request.post('/api/rooms', {
    data: { name, arena: { asteroids: 0, pickups: 0 } },
  });
  expect(response.status(), 'POST /api/rooms').toBe(201);
  const body: unknown = await response.json();
  const room = (body as { room: TestRoom }).room;
  expect(room.id).toEqual(expect.any(String));
  return room;
}

// Завантаження → лобі → гра. Повертається, коли гра вже працює (є панель чату й window.__game).
export async function joinRoom(page: Page, room: TestRoom, name: string): Promise<void> {
  await page.goto('/');
  const lobby = page.locator('#lobby');
  await expect(lobby, 'лобі з’являється після екрана завантаження').toBeVisible({
    timeout: 15_000,
  });
  await lobby.locator('input').first().fill(name);
  await lobby.locator(`button.room[data-room="${room.id}"]`).click();
  await lobby.getByRole('button', { name: 'Приєднатися' }).click();
  await expect(page.locator('aside#chat')).toBeVisible();
  await expect(lobby).toBeHidden();
  await page.waitForFunction(() => '__game' in window && window.__game !== undefined);
}

// Рядок у чат так, як це робить гравець: Enter — фокус у поле, текст, Enter — надіслати.
export async function say(page: Page, text: string): Promise<void> {
  const input = page.locator('#chat form input');
  await page.keyboard.press('Enter');
  await expect(input).toBeFocused();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await expect(input, 'після надсилання клавіатура повертається грі').not.toBeFocused();
}

// --- власний герой очима своєї вкладки --------------------------------------------------------

// Частина налагоджувальної ручки window.__game, яку читає тест (див. client/src/main.ts).
interface DebugHandle {
  readonly game: {
    readonly state: {
      readonly myShipId: number;
      readonly self: { readonly x: number; readonly y: number; readonly down: boolean } | null;
    };
    readonly predictor: { readonly state: { readonly x: number; readonly y: number } | null };
  };
}

declare global {
  interface Window {
    __game?: unknown;
  }
}

export interface OwnShip {
  readonly shipId: number;
  // останній точний стан від сервера
  readonly server: { readonly x: number; readonly y: number; readonly down: boolean } | null;
  // передбачена позиція — саме її гравець бачить на екрані
  readonly predicted: { readonly x: number; readonly y: number } | null;
}

export function ownShip(page: Page): Promise<OwnShip> {
  return page.evaluate(() => {
    const { game } = window.__game as DebugHandle;
    const { self, myShipId } = game.state;
    const predicted = game.predictor.state;
    return {
      shipId: Number(myShipId),
      server: self ? { x: self.x, y: self.y, down: self.down } : null,
      predicted: predicted ? { x: predicted.x, y: predicted.y } : null,
    };
  });
}

// --- знімки, які отримала вкладка --------------------------------------------------------------

export interface Seen {
  readonly at: number; // performance.now() у процесі тесту на момент надходження кадру
  readonly snapshot: Snapshot;
}

// Стрічка знімків однієї вкладки. Playwright показує кадри її WebSocket; бінарні кадри
// розбираємо тим самим кодеком, що й клієнт. Отже, це рівно те, що сервер розповів ЦІЙ вкладці
// про світ, — без жодних змін у коді гри. Створювати треба до page.goto().
export class SnapshotFeed {
  latest: Seen | null = null;
  readonly #listeners = new Set<(seen: Seen) => void>();

  constructor(page: Page) {
    page.on('websocket', (socket) => {
      if (!new URL(socket.url()).pathname.endsWith('/ws')) return;
      socket.on('framereceived', ({ payload }) => {
        if (typeof payload === 'string') return; // текст — керувальні повідомлення (чат, склад)
        const seen: Seen = {
          at: performance.now(),
          snapshot: CODECS.binary.decodeSnapshot(payload),
        };
        this.latest = seen;
        for (const listener of [...this.#listeners]) listener(seen);
      });
    });
  }

  // Перший знімок (останній наявний або наступний), для якого predicate істинний.
  // Не встиг за timeoutMs — помилка з описом останнього баченого стану.
  until(
    predicate: (snapshot: Snapshot) => boolean,
    { timeoutMs, what }: { timeoutMs: number; what: string },
  ): Promise<Seen> {
    return new Promise<Seen>((resolve, reject) => {
      const check = (seen: Seen): void => {
        if (!predicate(seen.snapshot)) return;
        clearTimeout(timer);
        this.#listeners.delete(check);
        resolve(seen);
      };
      const timer = setTimeout(() => {
        this.#listeners.delete(check);
        const ships = this.latest
          ? JSON.stringify(shipsOf(this.latest.snapshot))
          : 'жодного знімка';
        reject(new Error(`за ${timeoutMs} мс не дочекалися: ${what}. Останній знімок: ${ships}`));
      }, timeoutMs);
      this.#listeners.add(check);
      if (this.latest) check(this.latest);
    });
  }
}

export function shipsOf(snapshot: Snapshot): ShipRecord[] {
  return snapshot.entities.filter((entity) => entity.kind === 'ship');
}

export function shipIn(snapshot: Snapshot, shipId: number): ShipRecord | undefined {
  return shipsOf(snapshot).find((ship) => Number(ship.id) === shipId);
}

// Арена — тор: герой, що вийшов за край, з’являється з іншого. Відстань рахуємо найкоротшим шляхом.
export function distance(
  a: { readonly x: number; readonly y: number },
  b: { readonly x: number; readonly y: number },
  arena: Arena,
): number {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  return Math.hypot(Math.min(dx, arena.width - dx), Math.min(dy, arena.height - dy));
}

// Найменший кут між двома напрямками, рад.
export function angleBetween(a: number, b: number): number {
  const tau = Math.PI * 2;
  const diff = (((a - b) % tau) + tau) % tau;
  return Math.min(diff, tau - diff);
}
