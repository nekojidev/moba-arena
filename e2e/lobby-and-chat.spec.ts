// Дрібні наскрізні перевірки меж: лобі не пускає без імені й кімнати,
// а HTML у чаті лишається текстом.

import { expect, test } from '@playwright/test';
import { createRoom, joinRoom, say } from './support.ts';

test('лобі: кнопка входу активна лише з іменем і вибраною кімнатою', async ({ page, request }) => {
  const room = await createRoom(request, 'e2e-lobby');
  await page.goto('/');
  const lobby = page.locator('#lobby');
  await expect(lobby).toBeVisible({ timeout: 15_000 });

  const join = lobby.locator('button[type="submit"]');
  const name = lobby.locator('input').first();
  // постійні кімнати сервера на місці
  for (const id of ['mid', 'river', 'quarry']) {
    await expect(lobby.locator(`button.room[data-room="${id}"]`)).toBeVisible();
  }
  await expect(join).toBeDisabled();

  await name.fill('Оля');
  await expect(join, 'кімнату ще не вибрано').toBeDisabled();

  const button = lobby.locator(`button.room[data-room="${room.id}"]`);
  await button.click();
  await expect(button).toHaveClass(/selected/);
  await expect(join).toBeEnabled();

  await name.fill('О');
  await expect(join, 'ім’я з однієї літери закоротке').toBeDisabled();
});

test('чат: HTML у повідомленні показується як текст і не виконується', async ({
  page,
  request,
}) => {
  const room = await createRoom(request, 'e2e-xss');
  await joinRoom(page, room, 'Хакер');

  const payload = '<img src=x onerror="window.__pwned = 1"><b>жирний</b>';
  await say(page, payload);

  const line = page.locator('#chat ol.log li.mine');
  await expect(line).toHaveText(`Хакер: ${payload}`);
  await expect(page.locator('#chat img, #chat b')).toHaveCount(0);
  expect(await page.evaluate(() => '__pwned' in window)).toBe(false);
});
