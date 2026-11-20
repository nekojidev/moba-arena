// «Зламай навмисно»: підміна маніфесту для галереї збоїв і порівняння стратегій.
// Параметри ?delay= і ?failTimes= розуміє middleware у vite.config.js (dev і preview).
//
//   ?fail=404      спрайт героїв не існує         → гра стартує, герої малюються вектором
//   ?fail=flaky    сервер двічі відповідає 503    → третя спроба вдала (видно повтори)
//   ?fail=timeout  arena.json «висить»            → таймаут → кнопка «Спробувати ще раз»
//   ?fail=json     arena.json — битий JSON        → без повторів → кнопка
//   ?fail=abort    усе повільне, скасування       → кнопка
//   ?net=slow      кожен файл із затримкою        → видно прогрес; для заміру стратегій
//
// Збій підмішується лише в першу спробу: «Спробувати ще раз» вантажить справжній маніфест.

function withQuery(url, query) {
  return url + (url.includes('?') ? '&' : '?') + query;
}

function patch(manifest, id, change) {
  return {
    ...manifest,
    items: manifest.items.map((item) => (item.id === id ? { ...item, ...change(item) } : item)),
  };
}

export function applyChaos(manifest, { fail, net } = {}) {
  let result = manifest;
  const options = {};
  let autoAbortMs = null;

  if (net === 'slow') {
    // Різні затримки (200…1000 мс), щоб смужка рухалась нерівномірно, як у житті.
    result = {
      ...result,
      items: result.items.map((item, index) => ({
        ...item,
        url: withQuery(item.url, `delay=${200 + ((index * 3) % 5) * 200}`),
      })),
    };
  }

  switch (fail) {
    case '404':
      result = patch(result, 'heroes', () => ({ url: 'sprites/heroes-missing.png' }));
      break;
    case 'flaky':
      result = patch(result, 'heroes', (item) => ({ url: withQuery(item.url, 'failTimes=2') }));
      break;
    case 'timeout':
      result = patch(result, 'arena', (item) => ({ url: withQuery(item.url, 'delay=60000') }));
      options.timeoutMs = 1500;
      options.attempts = 2;
      break;
    case 'json':
      result = patch(result, 'arena', () => ({ url: 'test/broken.json' }));
      break;
    case 'abort':
      result = {
        ...result,
        items: result.items.map((item) => ({ ...item, url: withQuery(item.url, 'delay=3000') })),
      };
      autoAbortMs = 800;
      break;
    default:
  }

  return { manifest: result, options, autoAbortMs };
}
