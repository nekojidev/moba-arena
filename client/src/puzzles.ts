// Lab 3: п'ять головоломок на порядок виконання. Кожна — функція, що отримує log
// і повертає проміс, який виконується, коли все надруковано.
//
//   npm run puzzles        — у Node (головоломку з requestAnimationFrame пропускає)
//   /puzzles.html          — у браузері, усі п'ять

type Log = (line: string) => void;

export interface Puzzle {
  readonly title: string;
  readonly code: string;
  readonly why: string;
  readonly browserOnly?: boolean;
  run(log: Log): Promise<void>;
}

export interface PuzzleResult extends Puzzle {
  readonly output: string[];
}

const settle = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const puzzles: readonly Puzzle[] = [
  {
    title: '1. await розрізає функцію навпіл',
    code: `async function load() {
  log('load: початок');
  await null;
  log('load: після await');
}
log('старт');
load();
Promise.resolve().then(() => log('then'));
log('кінець');`,
    run(log) {
      async function load(): Promise<void> {
        log('load: початок');
        await null;
        log('load: після await');
      }
      log('старт');
      load();
      Promise.resolve().then(() => log('then'));
      log('кінець');
      return settle();
    },
    why: 'Усе до першого await виконується синхронно; хвіст функції стає мікрозадачею і стає в чергу раніше за then, бо load() викликано раніше.',
  },
  {
    title: '2. setTimeout усередині .then і .then усередині setTimeout',
    code: `setTimeout(() => {
  log('таймер 1');
  Promise.resolve().then(() => log('мікро з таймера 1'));
});
Promise.resolve().then(() => {
  log('мікро 1');
  setTimeout(() => log('таймер з мікро 1'));
});
setTimeout(() => log('таймер 2'));`,
    run(log) {
      setTimeout(() => {
        log('таймер 1');
        Promise.resolve().then(() => log('мікро з таймера 1'));
      });
      Promise.resolve().then(() => {
        log('мікро 1');
        setTimeout(() => log('таймер з мікро 1'));
      });
      setTimeout(() => log('таймер 2'));
      return settle();
    },
    why: 'Мікрозадачі зливаються до першої задачі; таймер із .then стає в чергу задач останнім; після кожної задачі черга мікрозадач зливається знову — до наступного таймера.',
  },
  {
    title: '3. return проміса з .then коштує два зайві тики',
    code: `Promise.resolve()
  .then(() => { log('A1'); return Promise.resolve(); })
  .then(() => log('A2'));
Promise.resolve()
  .then(() => log('B1'))
  .then(() => log('B2'))
  .then(() => log('B3'))
  .then(() => log('B4'));`,
    run(log) {
      Promise.resolve()
        .then(() => {
          log('A1');
          return Promise.resolve();
        })
        .then(() => log('A2'));
      Promise.resolve()
        .then(() => log('B1'))
        .then(() => log('B2'))
        .then(() => log('B3'))
        .then(() => log('B4'));
      return settle();
    },
    why: 'Коли .then повертає проміс, рушій спершу окремою мікрозадачею викликає його then, і лише наступною — виконує зовнішній проміс; ланцюжок B за цей час устигає зробити три кроки.',
  },
  {
    title: '4. dispatchEvent синхронний (наша шина подій)',
    code: `const bus = new EventTarget();
bus.addEventListener('fired', () => {
  log('слухач: fired');
  queueMicrotask(() => log('мікро зі слухача'));
});
setTimeout(() => log('таймер'));
log('перед dispatch');
bus.dispatchEvent(new Event('fired'));
log('після dispatch');`,
    run(log) {
      const bus = new EventTarget();
      bus.addEventListener('fired', () => {
        log('слухач: fired');
        queueMicrotask(() => log('мікро зі слухача'));
      });
      setTimeout(() => log('таймер'));
      log('перед dispatch');
      bus.dispatchEvent(new Event('fired'));
      log('після dispatch');
      return settle();
    },
    why: 'dispatchEvent нічого не ставить у чергу: слухачі виконуються одразу, на тому ж стеку. Тому звук пострілу стартує в тому ж кроці симуляції, а мікрозадача зі слухача чекає, поки стек спорожніє.',
  },
  {
    title: '5. requestAnimationFrame: два колбеки одного кадру',
    browserOnly: true,
    code: `requestAnimationFrame(() => {
  log('rAF A');
  Promise.resolve().then(() => log('мікро з A'));
  setTimeout(() => log('таймер з A'));
  requestAnimationFrame(() => log('rAF C (наступний кадр)'));
});
requestAnimationFrame(() => log('rAF B'));`,
    run(log) {
      return new Promise((resolve) => {
        requestAnimationFrame(() => {
          log('rAF A');
          Promise.resolve().then(() => log('мікро з A'));
          setTimeout(() => log('таймер з A'));
          requestAnimationFrame(() => {
            log('rAF C (наступний кадр)');
            resolve();
          });
        });
        requestAnimationFrame(() => log('rAF B'));
      });
    },
    why: 'Мікрозадачі зливаються після КОЖНОГО колбека, тому «мікро з A» встигає перед rAF B. rAF, запитаний усередині rAF, іде в наступний кадр, а таймер — звичайна задача, вона встигає раніше за нього.',
  },
];

export async function runPuzzles({ skipBrowserOnly = false } = {}): Promise<PuzzleResult[]> {
  const results: PuzzleResult[] = [];
  for (const puzzle of puzzles) {
    if (puzzle.browserOnly && skipBrowserOnly) continue;
    const output: string[] = [];
    await puzzle.run((line) => output.push(line));
    results.push({ ...puzzle, output });
  }
  return results;
}
