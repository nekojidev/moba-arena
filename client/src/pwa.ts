// Реєстрація service worker-а (public/sw.js). Лише у продакшн-збірці: у розробці сторінку
// віддає Vite з гарячим перезавантаженням, і кеш воркера йому тільки заважав би.
// Після load — щоб реєстрація не змагалася за мережу із завантаженням самої гри.

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // Без воркера гра працює так само, тож помилка реєстрації — лише рядок у консолі.
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error: unknown) => {
      console.warn('service worker не зареєстровано:', error);
    });
  });
}
