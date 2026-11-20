// Екран завантаження: справжній прогрес на canvas, скасування і повтор.
// Функція не повертає керування, доки ассети не завантажаться, — помилка не «вилітає»
// нагору, а перетворюється на екран із кнопкою «Спробувати ще раз».

import { loadAll, loadJson, withRetry } from '../assets/loader.js';
import { applyChaos } from '../assets/chaos.js';
import { once } from '../async.js';

const MANIFEST_URL = new URL('assets/manifest.json', document.baseURI).href;

export function describeError(error) {
  if (error?.name === 'AbortError') return 'Завантаження скасовано';
  if (error?.name === 'TimeoutError') return 'Сервер не відповів вчасно';
  if (error?.name === 'HttpError') return `Сервер відповів ${error.status}`;
  if (error?.name === 'ParseError') return 'Файл пошкоджено';
  return 'Немає з’єднання із сервером';
}

function drawLoading(ctx, view, state) {
  const { width, height } = view;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0b100d';
  ctx.fillRect(0, 0, width, height);

  const barWidth = Math.min(520, width - 64);
  const left = (width - barWidth) / 2;
  const top = height / 2 - 60;
  const failed = state.phase === 'error';

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#d7f5df';
  ctx.font = 'bold 30px ui-monospace, Menlo, Consolas, monospace';
  ctx.fillText('MOBA Arena', width / 2, top - 34);

  // Смужка: частка = завершені елементи / усі елементи маніфесту.
  const fraction = state.total > 0 ? state.done / state.total : 0;
  ctx.fillStyle = '#16241b';
  ctx.fillRect(left, top, barWidth, 18);
  ctx.fillStyle = failed ? '#e2574c' : '#3fd6a3';
  ctx.fillRect(left, top, barWidth * fraction, 18);
  ctx.strokeStyle = '#2f4a39';
  ctx.lineWidth = 1;
  ctx.strokeRect(left + 0.5, top + 0.5, barWidth - 1, 17);

  ctx.font = '14px ui-monospace, Menlo, Consolas, monospace';
  ctx.fillStyle = failed ? '#ff9a8a' : '#9fc7ab';
  const headline = failed
    ? describeError(state.error)
    : state.total > 0
      ? `Завантаження… ${state.done} / ${state.total}`
      : 'Читаю маніфест…';
  ctx.fillText(headline, width / 2, top + 44);
  if (failed && state.error?.message) {
    ctx.fillStyle = '#7d9886';
    ctx.font = '12px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillText(state.error.message.slice(0, 90), width / 2, top + 64);
  }

  // Журнал: останні події по окремих файлах.
  ctx.textAlign = 'left';
  ctx.font = '13px ui-monospace, Menlo, Consolas, monospace';
  state.log.slice(-7).forEach((line, index) => {
    ctx.fillStyle = line.color;
    ctx.fillText(line.text, left, top + 150 + index * 19);
  });
}

export async function runLoadingScreen({ ctx, view, audioContext, params }) {
  const cancelButton = document.querySelector('#loading-cancel');
  const retryButton = document.querySelector('#loading-retry');
  const state = { phase: 'loading', done: 0, total: 0, error: null, log: [] };

  let frame = 0;
  const paint = () => {
    drawLoading(ctx, view, state);
    frame = requestAnimationFrame(paint);
  };
  paint();

  const say = (text, color = '#9fc7ab') => state.log.push({ text, color });

  function onProgress({ type, item, done, total, error, attempt, waitMs, ms }) {
    state.done = done;
    state.total = total;
    if (type === 'loaded') say(`✓ ${item.id}  ${ms.toFixed(0)} мс`);
    if (type === 'retry') {
      console.info(
        `[loader] ↻ ${item.id}: ${error?.message} — спроба ${attempt + 1} через ${waitMs.toFixed(0)} мс`,
      );
      say(
        `↻ ${item.id}: ${describeError(error)}, спроба ${attempt + 1} через ${waitMs.toFixed(0)} мс`,
        '#f2c14e',
      );
    }
    if (type === 'failed') {
      console.info(`[loader] ✗ ${item.id}: ${error?.message} — запасний варіант`);
      say(`✗ ${item.id}: ${describeError(error)} — граємо без нього`, '#ff9a8a');
    }
  }

  try {
    for (let round = 1; ; round += 1) {
      // Новий контролер на кожну спробу: скасований сигнал не можна «розскасувати».
      const controller = new AbortController();
      const { signal } = controller;
      Object.assign(state, { phase: 'loading', done: 0, total: 0, error: null });
      if (round > 1) say('— нова спроба —', '#7d9886');

      cancelButton.hidden = false;
      cancelButton.onclick = () => controller.abort();

      try {
        const manifest = await withRetry(
          () =>
            loadJson(MANIFEST_URL, {
              signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
            }),
          { signal },
        );
        // Навмисні збої — лише в першій спробі: «ще раз» означає справжнє завантаження.
        const chaos = applyChaos(manifest, {
          fail: round === 1 ? params.get('fail') : null,
          net: params.get('net'),
        });
        if (chaos.autoAbortMs !== null) setTimeout(() => controller.abort(), chaos.autoAbortMs);

        const strategy = params.get('load') === 'sequential' ? 'sequential' : 'concurrent';
        const result = await loadAll(chaos.manifest, {
          baseUrl: MANIFEST_URL,
          audioContext,
          onProgress,
          signal,
          strategy,
          ...chaos.options,
        });
        console.log(
          `[loader] ${strategy}: ${result.elapsedMs.toFixed(0)} мс, ` +
            `файлів: ${chaos.manifest.items.length}, не завантажено: ${result.failures.length}`,
        );
        return { ...result, strategy };
      } catch (error) {
        console.warn(`[loader] ${describeError(error)} — ${error?.message}`);
        state.phase = 'error';
        state.error = error;
        cancelButton.hidden = true;
        retryButton.hidden = false;
        retryButton.focus();
        await once(retryButton, 'click'); // подія → проміс: чекаємо рішення гравця
        retryButton.hidden = true;
      }
    }
  } finally {
    cancelAnimationFrame(frame);
    ctx.fillStyle = '#0b100d'; // прибираємо смужку, щоб вона не просвічувала під лобі
    ctx.fillRect(0, 0, view.width, view.height);
    cancelButton.hidden = true;
    retryButton.hidden = true;
  }
}
