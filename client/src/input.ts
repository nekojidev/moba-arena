// Клавіатура як замикання: множини `down` і `pressed` недоступні ззовні,
// єдиний спосіб до них дістатися — повернуті функції.

const GAME_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

export interface Input {
  isDown(code: string): boolean;
  justPressed(code: string): boolean;
  endStep(): void;
  dispose(): void;
}

export function createInput(target: Window): Input {
  const down = new Set<string>(); // клавіші, що утримуються зараз
  const pressed = new Set<string>(); // клавіші, натиснуті після останнього кроку симуляції

  function onKeyDown(event: KeyboardEvent): void {
    // Гравець друкує в чаті — це не команди героя.
    if (event.target instanceof Element && event.target.closest('input, textarea')) return;
    if (GAME_KEYS.has(event.code)) event.preventDefault(); // не скролимо сторінку
    // event.repeat — автоповтор ОС; фронт натискання рахуємо лише один раз.
    if (!event.repeat && !down.has(event.code)) pressed.add(event.code);
    down.add(event.code);
  }

  function onKeyUp(event: KeyboardEvent): void {
    down.delete(event.code);
  }

  function onBlur(): void {
    // keyup не прийде, якщо вікно втратило фокус — інакше клавіша «залипне».
    down.clear();
    pressed.clear();
  }

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('blur', onBlur);

  return {
    isDown: (code) => down.has(code),
    // Події клавіатури — це tasks, вони приходять між кадрами. Натискання накопичуються
    // в `pressed` і живуть рівно до кінця найближчого кроку симуляції: навіть якщо кадр
    // не зробив жодного кроку (120 Гц) — натискання не загубиться, а якщо зробив два —
    // не спрацює двічі.
    justPressed: (code) => pressed.has(code),
    endStep: () => pressed.clear(),
    dispose() {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('blur', onBlur);
    },
  };
}
