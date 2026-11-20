// Lab 2: баг із this, показаний навмисно, і три способи його полагодити.
//
//   npm run this-bug
//
// this визначається НЕ місцем, де функцію оголошено, а тим, ЯК її викликано.
// `ship.fire` без дужок — це просто посилання на функцію з Ship.prototype;
// зв'язок із конкретним героєм губиться в ту мить, коли метод «відривають» від об'єкта.

import { World } from '@moba-arena/shared/sim/world.ts';
import { Ship } from '@moba-arena/shared/sim/ship.ts';
import { Vector2 } from '@moba-arena/shared/sim/vector.ts';
import { ARENA } from '@moba-arena/shared/sim/arena.ts';

const world = new World({ arena: ARENA });
const ship = world.spawn(new Ship({ pos: new Vector2(100, 100) }));

function attempt(label, call) {
  ship.fireCooldown = 0;
  try {
    const bullet = call();
    console.log(`${label}\n    → OK, снаряд від героя #${bullet.ownerId}\n`);
  } catch (error) {
    console.log(`${label}\n    → ${error.constructor.name}: ${error.message}\n`);
  }
}

// --- Баг -----------------------------------------------------------------------------------

// 1. Метод відірвано й викликано як звичайну функцію: правило «за замовчуванням».
//    У модулях і класах діє strict mode, тому this === undefined.
const detached = ship.fire;
attempt('БАГ 1  const f = ship.fire; f(world)', () => detached(world));

// 2. Саме це робить браузер із наївним `window.addEventListener('keydown', ship.fire)`:
//    викликає слухача з this = елемент, на якому висить слухач, і з подією замість world.
const fakeWindow = { name: 'window' };
const fakeEvent = { code: 'Space' };
attempt("БАГ 2  addEventListener('keydown', ship.fire)  ≈  ship.fire.call(window, event)", () =>
  ship.fire.call(fakeWindow, fakeEvent),
);

// --- Фікси ---------------------------------------------------------------------------------

// A. Стрілка-обгортка: у стрілки немає свого this, а всередині — звичайний виклик через крапку.
const viaArrow = () => ship.fire(world);
attempt('ФІКС A  () => ship.fire(world)', viaArrow);

// B. bind: нова функція з навічно прив'язаним this (явне правило; сильніше за неявне).
const viaBind = ship.fire.bind(ship, world);
attempt('ФІКС B  ship.fire.bind(ship, world)', viaBind);

// C. Поле класу зі стрілкою: окрема функція в КОЖНОМУ екземплярі, this захоплено в конструкторі.
class TurretWithArrowField {
  constructor(owner) {
    this.owner = owner;
  }
  fire = () => this.owner.fire(world);
}
const turret = new TurretWithArrowField(ship);
const detachedField = turret.fire;
attempt('ФІКС C  fire = () => { … } як поле класу (відірвано від об’єкта)', detachedField);

// bind не діє на стрілку: її this узято з місця створення і його вже не змінити.
attempt('       …і навіть .bind(іншийОб’єкт) стрілці не шкодить', detachedField.bind({}));
