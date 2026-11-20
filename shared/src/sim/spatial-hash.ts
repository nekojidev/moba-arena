// Просторовий хеш: та сама система зіткнень, що й findCollisions, але без перебору всіх пар.
//
// Арену ділимо на клітинки. Кожне тіло записуємо в усі клітинки, яких торкається його
// описаний квадрат; два кола можуть перетнутися, лише якщо мають спільну клітинку.
// Тож для тіла перевіряємо не всіх, а тільки сусідів по клітинках.
//
// Найважливіше — ПОРЯДОК. Від порядку пар залежить результат кроку (перша пара розсуває
// тіла, друга вже бачить нові координати), а отже й еталонний хеш детермінізму. Тому
// система видає рівно ті самі пари в рівно тому самому порядку, що й наївний перебір:
// рядок за рядком (i за зростанням), у рядку — j за зростанням, і перевірка перетину
// робиться ЛІНИВО, за поточними координатами, як у findCollisions.
//
// Лінивість має ціну: між двома yield споживач (resolveCollision) може зсунути тіла.
// Домовленість така сама, як у світі: після `yield [a, b]` змінюватись можуть лише a і b.
// Обох ми після кожної пари перекладаємо в сітці, а кандидатів для a збираємо заново.

import { wrap } from './arena.ts';
import { circlesOverlap, type CollisionPair, type CollisionSystem } from './collision.ts';
import type { AnyEntity } from './world.ts';

// Клітинка трохи більша за найбільший діаметр «дрібних» тіл (герой, руна, малий голем):
// більшість тіл лягає в 1–4 клітинки.
export const DEFAULT_CELL_SIZE = 64;

// Запас на похибку округлення: перетин рахується через shortestDelta, клітинки — через
// floor(). Тіло, що торкається межі клітинки «в останньому біті», має потрапити в обидві.
const PAD = 1e-6;

export interface SpatialHashOptions {
  readonly cellSize?: number;
}

const byIndex = (x: number, y: number): number => x - y;

// Сітка на торі. Клітинки по кожній осі діляться націло (cols = floor(width / cellSize)),
// тому остання клітинка не коротша за інші й загортання країв — це просто індекс за модулем.
class Grid {
  readonly #bodies: readonly AnyEntity[];
  readonly #width: number;
  readonly #height: number;
  readonly #cols: number;
  readonly #rows: number;
  readonly #cellWidth: number;
  readonly #cellHeight: number;
  readonly #cells: (number[] | undefined)[];
  // На тіло: перша клітинка й кількість клітинок по кожній осі + координати, за якими
  // його розкладено (щоб помітити, що тіло зсунули).
  readonly #span: Int32Array;
  readonly #placed: Float64Array;
  // Позначки «цього кандидата вже взято» — замість Set на кожен запит.
  readonly #seen: Int32Array;
  #stamp = 0;

  constructor(
    bodies: readonly AnyEntity[],
    arena: { readonly width: number; readonly height: number },
    cellSize: number,
  ) {
    this.#bodies = bodies;
    this.#width = arena.width;
    this.#height = arena.height;
    this.#cols = Math.max(1, Math.floor(arena.width / cellSize));
    this.#rows = Math.max(1, Math.floor(arena.height / cellSize));
    this.#cellWidth = arena.width / this.#cols;
    this.#cellHeight = arena.height / this.#rows;
    this.#cells = new Array<number[] | undefined>(this.#cols * this.#rows);
    this.#span = new Int32Array(bodies.length * 4);
    this.#placed = new Float64Array(bodies.length * 3);
    this.#seen = new Int32Array(bodies.length);
    for (const [index, body] of bodies.entries()) this.#insert(index, body);
  }

  // Проміжок [center − reach, center + reach] на колі довжиною size → (перша клітинка, скільки).
  #axis(center: number, reach: number, size: number, cell: number, count: number, out: number) {
    const extent = 2 * reach;
    let first = 0;
    let cells = count;
    if (extent < size) {
      first = Math.min(count - 1, Math.floor(wrap(center - reach, size) / cell));
      const last = Math.min(count - 1, Math.floor(wrap(center + reach, size) / cell));
      // Та сама клітинка: або проміжок у ній і вмістився, або обійшов усе коло й повернувся.
      cells = last === first && extent > cell ? count : ((last - first + count) % count) + 1;
    }
    this.#span[out] = first;
    this.#span[out + 1] = cells;
  }

  #insert(index: number, body: AnyEntity): void {
    const { x, y } = body.pos;
    const reach = body.radius + PAD;
    this.#axis(x, reach, this.#width, this.#cellWidth, this.#cols, index * 4);
    this.#axis(y, reach, this.#height, this.#cellHeight, this.#rows, index * 4 + 2);
    this.#placed[index * 3] = x;
    this.#placed[index * 3 + 1] = y;
    this.#placed[index * 3 + 2] = body.radius;
    this.#eachCell(index, (cell) => {
      const bucket = this.#cells[cell];
      if (bucket) bucket.push(index);
      else this.#cells[cell] = [index];
    });
  }

  #eachCell(index: number, visit: (cell: number) => void): void {
    const firstCol = this.#span[index * 4] ?? 0;
    const cols = this.#span[index * 4 + 1] ?? 0;
    const firstRow = this.#span[index * 4 + 2] ?? 0;
    const rows = this.#span[index * 4 + 3] ?? 0;
    for (let r = 0; r < rows; r += 1) {
      const row = ((firstRow + r) % this.#rows) * this.#cols;
      for (let c = 0; c < cols; c += 1) visit(row + ((firstCol + c) % this.#cols));
    }
  }

  // Тіло зсунули (або змінили радіус) після того, як його розклали? Тоді перекладаємо.
  refresh(index: number): boolean {
    const body = this.#bodies[index];
    if (!body) return false;
    if (
      this.#placed[index * 3] === body.pos.x &&
      this.#placed[index * 3 + 1] === body.pos.y &&
      this.#placed[index * 3 + 2] === body.radius
    ) {
      return false;
    }
    this.#eachCell(index, (cell) => {
      const bucket = this.#cells[cell];
      const at = bucket ? bucket.indexOf(index) : -1;
      if (bucket && at >= 0) bucket.splice(at, 1);
    });
    this.#insert(index, body);
    return true;
  }

  // Кандидати для тіла index: сусіди по клітинках із номером, більшим за after, —
  // без повторів і за зростанням (саме в такому порядку їх перебрав би наївний алгоритм).
  candidates(index: number, after: number, out: number[]): void {
    out.length = 0;
    this.#stamp += 1;
    const stamp = this.#stamp;
    this.#eachCell(index, (cell) => {
      const bucket = this.#cells[cell];
      if (!bucket) return;
      for (const other of bucket) {
        if (other <= after || this.#seen[other] === stamp) continue;
        this.#seen[other] = stamp;
        out.push(other);
      }
    });
    out.sort(byIndex);
  }
}

export function createSpatialHash({
  cellSize = DEFAULT_CELL_SIZE,
}: SpatialHashOptions = {}): CollisionSystem {
  return function* findCollisionsHashed(world): Generator<CollisionPair> {
    const bodies: AnyEntity[] = [];
    for (const entity of world) {
      if (entity.alive && entity.collidable) bodies.push(entity);
    }
    if (bodies.length < 2) return;

    const grid = new Grid(bodies, world.arena, cellSize);
    const pending: number[] = [];
    for (const [i, a] of bodies.entries()) {
      grid.refresh(i);
      grid.candidates(i, i, pending);
      let next = 0;
      while (next < pending.length) {
        const j = pending[next];
        next += 1;
        if (j === undefined) continue;
        const b = bodies[j];
        if (!b || !circlesOverlap(a, b, world.arena)) continue;
        yield [a, b];
        // Споживач міг розсунути пару. b перекладаємо для наступних рядків; якщо зсунули a —
        // решту його рядка (j' > j) збираємо заново вже навколо нового місця.
        grid.refresh(j);
        if (grid.refresh(i)) {
          grid.candidates(i, j, pending);
          next = 0;
        }
      }
    }
  };
}

// Готова система з типовим розміром клітинки: new World({ collide: findCollisionsHashed }).
export const findCollisionsHashed: CollisionSystem = createSpatialHash();
