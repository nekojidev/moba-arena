// Lab 3: головоломки порядку мікрозадач/задач — запуск у Node.
// П'ята (requestAnimationFrame) існує лише в браузері: npm run dev → /puzzles.html
import { runPuzzles } from '../src/puzzles.js';

for (const puzzle of await runPuzzles({ skipBrowserOnly: true })) {
  console.log(`\n${puzzle.title}\n  → ${puzzle.output.join(' → ')}`);
}
