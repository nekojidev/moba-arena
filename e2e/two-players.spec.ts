// Двоє гравців в одній кімнаті: два окремі контексти браузера (як два різні комп’ютери),
// справжній сервер між ними. Перевіряємо те, що видно лише наскрізь: склад кімнати,
// рух одного героя на екрані іншого, чат в обидва боки, вихід.

import { expect, test } from '@playwright/test';
import {
  angleBetween,
  createRoom,
  distance,
  joinRoom,
  ownShip,
  say,
  shipIn,
  shipsOf,
  SnapshotFeed,
} from './support.ts';

const ALICE = 'Аліса';
const BOHDAN = 'Богдан';

// Скільки часу є в чужого клієнта, щоб побачити рух після натискання клавіші.
const OBSERVE_BUDGET_MS = 500;
// «Зрушив» — це більше за розмір самого героя (радіус 16), а не тремтіння на піксель.
const MOVE_MARGIN = 20;

test('двоє гравців бачать одне одного: склад, рух, чат, вихід', async ({ browser, request }) => {
  const room = await createRoom(request, 'e2e-duo');

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const feedB = new SnapshotFeed(pageB); // до goto: сокет відкриється вже під наглядом

  try {
    // --- завантаження → лобі → та сама кімната ---------------------------------------------
    await joinRoom(pageA, room, ALICE);
    await joinRoom(pageB, room, BOHDAN);

    await test.step('склад кімнати однаковий в обох, власне ім’я позначене', async () => {
      await expect(pageA.locator('#chat ul.roster li')).toHaveText([`${ALICE} (ви)`, BOHDAN]);
      await expect(pageB.locator('#chat ul.roster li')).toHaveText([ALICE, `${BOHDAN} (ви)`]);
      await expect(pageA.locator('#chat h2')).toHaveText(room.name);
    });

    await test.step('рух Аліси видно Богданові менш ніж за пів секунди', async () => {
      const alice = await ownShip(pageA);
      const bohdan = await ownShip(pageB);
      expect(alice.shipId).not.toBe(bohdan.shipId);

      // Чекаємо спокійного світу: бот-компаньйон пішов (героїв рівно двоє), його снаряди
      // згасли, Аліса жива й стоїть на місці — тоді будь-яке зміщення далі спричинила клавіша.
      let previous: { x: number; y: number } | null = null;
      const calm = await feedB.until(
        (snapshot) => {
          const ship = shipIn(snapshot, alice.shipId);
          const still = ship && previous && ship.x === previous.x && ship.y === previous.y;
          previous = ship ? { x: ship.x, y: ship.y } : null;
          return Boolean(
            still &&
            ship &&
            !ship.down &&
            shipsOf(snapshot).length === 2 &&
            snapshot.entities.every((entity) => entity.kind === 'ship'),
          );
        },
        { timeoutMs: 10_000, what: 'двоє нерухомих героїв без снарядів' },
      );
      const before = shipIn(calm.snapshot, alice.shipId);
      if (!before) throw new Error('героя Аліси немає у знімку Богдана');
      const ownBefore = (await ownShip(pageA)).predicted;
      if (!ownBefore) throw new Error('в Аліси ще немає передбаченого стану');

      // Слухача ставимо ДО натискання, а час рахуємо від моменту ПЕРЕД ним:
      // у бюджет входить усе — подія клавіші, input на сервер, крок світу, знімок Богданові.
      const pressedAt = performance.now();
      const moved = feedB.until(
        (snapshot) => {
          const ship = shipIn(snapshot, alice.shipId);
          return ship !== undefined && distance(ship, before, room.arena) > MOVE_MARGIN;
        },
        {
          timeoutMs: OBSERVE_BUDGET_MS,
          what: `герой Аліси зрушив більш ніж на ${MOVE_MARGIN} од. від (${before.x}, ${before.y})`,
        },
      );
      await pageA.keyboard.down('ArrowUp');
      const seen = await moved;
      const elapsed = seen.at - pressedAt;
      test.info().annotations.push({
        type: 'time-to-observe',
        description: `${elapsed.toFixed(0)} мс від натискання ↑ до знімка в Богдана`,
      });
      expect(elapsed).toBeLessThan(OBSERVE_BUDGET_MS);
      expect(shipIn(seen.snapshot, alice.shipId)?.thrust, 'Богдан бачить увімкнену тягу').toBe(
        true,
      );

      // Той самий рух у самої Аліси: передбачена позиція (її малює екран) і підтверджена сервером.
      await expect
        .poll(async () => {
          const { predicted } = await ownShip(pageA);
          return predicted ? distance(predicted, ownBefore, room.arena) : 0;
        })
        .toBeGreaterThan(MOVE_MARGIN);
      await expect
        .poll(async () => {
          const { server } = await ownShip(pageA);
          return server ? distance(server, before, room.arena) : 0;
        })
        .toBeGreaterThan(MOVE_MARGIN);

      // Поворот теж доходить: кут героя Аліси у знімках Богдана змінюється.
      const angleBefore = shipIn(feedB.latest?.snapshot ?? seen.snapshot, alice.shipId)?.angle ?? 0;
      await pageA.keyboard.down('ArrowRight');
      await feedB.until(
        (snapshot) => {
          const ship = shipIn(snapshot, alice.shipId);
          return ship !== undefined && angleBetween(ship.angle, angleBefore) > 0.3;
        },
        { timeoutMs: 2_000, what: 'герой Аліси повернув більш ніж на 0.3 рад' },
      );
      await pageA.keyboard.up('ArrowRight');
      await pageA.keyboard.up('ArrowUp');

      // Богдан увесь цей час клавіш не чіпав — і його герой нікуди не подівся.
      const latest = feedB.latest?.snapshot;
      expect(latest && shipIn(latest, bohdan.shipId)).toBeDefined();
      expect(latest && shipsOf(latest)).toHaveLength(2);
    });

    await test.step('чат в обидва боки', async () => {
      const logA = pageA.locator('#chat ol.log li');
      const logB = pageB.locator('#chat ol.log li');

      await say(pageA, 'привіт, це Аліса');
      await expect(logB.filter({ hasText: /^Аліса: привіт, це Аліса$/ })).toHaveCount(1);
      await expect(logA.filter({ hasText: /^Аліса: привіт, це Аліса$/ })).toHaveClass('mine');

      await say(pageB, 'вітаю, я Богдан');
      await expect(logA.filter({ hasText: /^Богдан: вітаю, я Богдан$/ })).toHaveCount(1);
      await expect(logB.filter({ hasText: /^Богдан: вітаю, я Богдан$/ })).toHaveClass('mine');
    });

    await test.step('Богдан виходить — Аліса лишається сама', async () => {
      await contextB.close();
      await expect(pageA.locator('#chat ul.roster li')).toHaveText([`${ALICE} (ви)`]);
      await expect(
        pageA.locator('#chat ol.log li.system').filter({ hasText: `← ${BOHDAN} вийшов` }),
      ).toHaveCount(1);
    });
  } finally {
    await contextA.close();
    await contextB.close(); // повторне закриття нічого не робить
  }
});
