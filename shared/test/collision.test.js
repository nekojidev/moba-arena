// Геометрія зіткнень (collision.ts) і правила для пар (combat.ts).
import { describe, test } from 'vitest';
import assert from 'node:assert/strict';

import { ARENA } from '../src/sim/arena.ts';
import { Asteroid } from '../src/sim/asteroid.ts';
import { Bullet, BULLET_DAMAGE, BULLET_SPEED } from '../src/sim/bullet.ts';
import { circlesOverlap, findCollisions } from '../src/sim/collision.ts';
import { resolveCollision } from '../src/sim/combat.ts';
import { Entity } from '../src/sim/entity.ts';
import { Explosion } from '../src/sim/explosion.ts';
import { Pickup } from '../src/sim/pickup.ts';
import { MAX_HP, MAX_SPEED, Ship } from '../src/sim/ship.ts';
import { Vector2 } from '../src/sim/vector.ts';
import { World } from '../src/sim/world.ts';

const DT = 1 / 30;
const v = (x, y) => new Vector2(x, y);
const circle = (x, y, radius) => new Entity({ kind: 'asteroid', pos: v(x, y), radius });
const newWorld = (options) => new World({ arena: ARENA, ...options });
const bullet = (pos, vel, ownerId = 0) =>
  new Bullet({ pos, vel, angle: 0, ownerId, team: 'green' });
const ids = (pairs) => pairs.map(([a, b]) => [a.id, b.id]);

function recordEvents(world) {
  const log = [];
  for (const type of ['hit', 'exploded', 'pickup', 'score', 'respawned', 'fired']) {
    world.events.on(type, (payload) => log.push({ type, ...payload }));
  }
  return log;
}

// Відстань від точки до відрізка: чи проходив шлях снаряда крізь ціль «насправді».
function distanceToSegment(point, from, to) {
  const segment = to.sub(from);
  const t = Math.max(0, Math.min(1, point.sub(from).dot(segment) / segment.dot(segment)));
  return point.sub(from.add(segment.scale(t))).length();
}

describe('circlesOverlap', () => {
  test('перетин: відстань менша за суму радіусів', () => {
    assert.equal(circlesOverlap(circle(100, 100, 10), circle(129, 100, 20), ARENA), true);
  });

  test('рівно дотик (відстань == сума радіусів) — НЕ перетин: порівняння суворе', () => {
    assert.equal(circlesOverlap(circle(100, 100, 10), circle(130, 100, 20), ARENA), false);
    // Те саме по діагоналі: 3-4-5, відстань рівно 50 = 20 + 30.
    assert.equal(circlesOverlap(circle(100, 100, 20), circle(130, 140, 30), ARENA), false);
    assert.equal(circlesOverlap(circle(100, 100, 20), circle(130, 139, 30), ARENA), true);
  });

  test('промах: відстань більша за суму радіусів', () => {
    assert.equal(circlesOverlap(circle(100, 100, 10), circle(131, 100, 20), ARENA), false);
    assert.equal(circlesOverlap(circle(100, 100, 10), circle(800, 450, 20), ARENA), false);
  });

  test('одне коло всередині іншого і два в одній точці — перетин', () => {
    assert.equal(circlesOverlap(circle(100, 100, 50), circle(105, 100, 5), ARENA), true);
    assert.equal(circlesOverlap(circle(100, 100, 5), circle(100, 100, 5), ARENA), true);
  });

  test('симетрія: порядок аргументів не важливий', () => {
    const a = circle(1590, 450, 10);
    const b = circle(5, 450, 10);
    assert.equal(circlesOverlap(a, b, ARENA), circlesOverlap(b, a, ARENA));
  });

  test('через загорнутий край арени: по x, по y і через кут', () => {
    // x: 1595 і 5 — на торі між ними 10, а не 1590.
    assert.equal(circlesOverlap(circle(1595, 450, 10), circle(5, 450, 10), ARENA), true);
    assert.equal(circlesOverlap(circle(800, 897, 4), circle(800, 2, 4), ARENA), true);
    // кут: (1598, 898) і (2, 2) — різниця (4, 4), відстань ≈ 5.66 < 6
    assert.equal(circlesOverlap(circle(1598, 898, 3), circle(2, 2, 3), ARENA), true);
    assert.equal(circlesOverlap(circle(1598, 898, 2), circle(2, 2, 2), ARENA), false);
  });

  test('через край: рівно дотик і промах', () => {
    // 1590 і 10 — на торі рівно 20 = 10 + 10.
    assert.equal(circlesOverlap(circle(1590, 450, 10), circle(10, 450, 10), ARENA), false);
    assert.equal(circlesOverlap(circle(1589, 450, 10), circle(10, 450, 10), ARENA), false);
    assert.equal(circlesOverlap(circle(1591, 450, 10), circle(10, 450, 10), ARENA), true);
  });
});

describe('findCollisions', () => {
  test('кожна пара — рівно один раз, у порядку появи у світі', () => {
    const world = newWorld();
    const a = world.spawn(new Asteroid({ pos: v(400, 400), vel: v(0, 0), size: 1 }));
    const b = world.spawn(new Asteroid({ pos: v(410, 400), vel: v(0, 0), size: 1 }));
    const c = world.spawn(new Asteroid({ pos: v(405, 410), vel: v(0, 0), size: 1 }));
    world.spawn(new Asteroid({ pos: v(1200, 700), vel: v(0, 0), size: 1 })); // осторонь
    assert.deepEqual(ids([...findCollisions(world)]), [
      [a.id, b.id],
      [a.id, c.id],
      [b.id, c.id],
    ]);
  });

  test('порожній світ і одна сутність — пар немає', () => {
    const world = newWorld();
    assert.deepEqual([...findCollisions(world)], []);
    world.spawn(new Ship({ pos: v(100, 100) }));
    assert.deepEqual([...findCollisions(world)], []);
  });

  test('мертві, «лежачі» герої та вибухи в зіткненнях участі не беруть', () => {
    const world = newWorld();
    const ship = world.spawn(new Ship({ pos: v(400, 400) }));
    const rock = world.spawn(new Asteroid({ pos: v(410, 400), vel: v(0, 0), size: 1 }));
    world.spawn(new Explosion({ pos: v(400, 400), rng: world.rng }));
    assert.equal([...findCollisions(world)].length, 1, 'вибух не колізиться');

    ship.goDown();
    assert.deepEqual([...findCollisions(world)], [], 'герой лежить');

    ship.respawn(v(400, 400));
    world.despawn(rock.id);
    assert.deepEqual([...findCollisions(world)], [], 'голема позначено мертвим');
  });

  test('пару через край арени теж знайдено', () => {
    const world = newWorld();
    world.spawn(new Asteroid({ pos: v(1595, 450), vel: v(0, 0), size: 1 }));
    world.spawn(new Asteroid({ pos: v(5, 450), vel: v(0, 0), size: 1 }));
    assert.equal([...findCollisions(world)].length, 1);
  });
});

describe('снаряд проти цілі: дискретний крок', () => {
  // Найменша ціль: голем розміру 1 (радіус 16) або герой (16). Снаряд — радіус 5.
  // «Товщина» цілі для снаряда по центру: 2·(16 + 5) = 42 одиниці.
  const REACH = 16 + 5;

  function flyAt(target, shot, dt, steps) {
    const world = newWorld({ cosmetics: false });
    world.spawn(target);
    world.spawn(shot);
    const log = recordEvents(world);
    const path = [];
    for (let i = 0; i < steps && shot.alive; i += 1) {
      const targetBefore = target.pos;
      world.step(dt);
      path.push({ from: shot.prevPos, to: shot.pos, targetBefore, targetAfter: target.pos });
    }
    return { hit: log.some((event) => event.type === 'hit'), path };
  }

  test('звичайний снаряд (620 од/с, 30 Гц, 20.7 од за крок) влучає з будь-якої фази', () => {
    for (let offset = 0; offset < 42; offset += 0.25) {
      const rock = new Asteroid({ pos: v(800, 450), vel: v(0, 0), size: 1 });
      const shot = bullet(v(700 + offset, 450), v(BULLET_SPEED, 0));
      assert.equal(flyAt(rock, shot, DT, 12).hit, true, `зсув старту ${offset}`);
    }
  });

  test('швидкий снаряд пролітає крізь малу ціль за один крок — відома межа', () => {
    // 1500 од/с · 1/30 с = 50 од за крок > 42. До кроку снаряд за 22 од від центру (ще не
    // торкається), після — за 28 од з іншого боку (вже не торкається). Перевірка лише
    // в кінцевих точках кроку, тож влучання НЕ фіксується, хоча шлях іде крізь центр цілі.
    const rock = new Asteroid({ pos: v(800, 450), vel: v(0, 0), size: 1 });
    const shot = bullet(v(778, 450), v(1500, 0));
    const { hit, path } = flyAt(rock, shot, DT, 1);

    assert.equal(hit, false, 'симуляція влучання не побачила');
    assert.equal(rock.hp, 20, 'голем цілий');
    assert.equal(shot.alive, true, 'снаряд летить далі');
    assert.ok(Math.abs(shot.pos.x - 828) < 1e-9);
    const [{ from, to }] = path;
    assert.equal(distanceToSegment(rock.pos, from, to), 0, 'а відрізок шляху йде крізь центр');
    assert.ok(distanceToSegment(rock.pos, from, to) < REACH);
  });

  test('той самий швидкий снаряд із удвічі меншим кроком уже влучає', () => {
    const rock = new Asteroid({ pos: v(800, 450), vel: v(0, 0), size: 1 });
    const shot = bullet(v(778, 450), v(1500, 0));
    assert.equal(flyAt(rock, shot, DT / 2, 2).hit, true);
  });

  test('реальні швидкості гри: постріл на повному ходу в героя, що летить назустріч, — пролітає', () => {
    // Снаряд успадковує швидкість стрільця: 620 + 520 = 1140 од/с → 38 од за крок.
    // Ціль летить назустріч: після опору 520·(1 − 1.6/30) ≈ 492 од/с → 16.4 од за крок.
    // Зближення 54.4 од за крок > 42: за невдалої фази пара «перестрибує» одна одну.
    const victim = new Ship({ pos: v(822, 450), angle: Math.PI, team: 'red' });
    victim.vel = v(-MAX_SPEED, 0);
    const shot = bullet(v(800, 450), v(BULLET_SPEED + MAX_SPEED, 0));
    const { hit, path } = flyAt(victim, shot, DT, 1);

    assert.equal(hit, false);
    assert.equal(victim.hp, MAX_HP);
    const [{ from, to, targetBefore, targetAfter }] = path;
    assert.ok(from.x < targetBefore.x && to.x > targetAfter.x, 'снаряд і герой помінялись місцями');
  });

  test('та сама зустріч на 60 Гц влучає — межа саме в довжині кроку', () => {
    const victim = new Ship({ pos: v(822, 450), angle: Math.PI, team: 'red' });
    victim.vel = v(-MAX_SPEED, 0);
    const shot = bullet(v(800, 450), v(BULLET_SPEED + MAX_SPEED, 0));
    assert.equal(flyAt(victim, shot, 1 / 60, 2).hit, true);
  });

  test('довгий крок (0.1 с, як після «зависання» кадру) — звичайний снаряд теж пролітає', () => {
    // 620·0.1 = 62 од за крок > 42.
    const rock = new Asteroid({ pos: v(800, 450), vel: v(0, 0), size: 1 });
    const shot = bullet(v(775, 450), v(BULLET_SPEED, 0));
    assert.equal(flyAt(rock, shot, 0.1, 1).hit, false);
  });
});

describe('правила зіткнень (combat)', () => {
  test('снаряд не ранить власника', () => {
    const world = newWorld();
    const ship = world.spawn(new Ship({ pos: v(400, 400) }));
    const shot = world.spawn(bullet(v(400, 400), v(0, 0), ship.id));
    resolveCollision(shot, ship, world);
    assert.equal(ship.hp, MAX_HP);
    assert.equal(shot.alive, true);
  });

  test('порядок аргументів не важливий: (герой, снаряд) = (снаряд, герой)', () => {
    for (const flip of [false, true]) {
      const world = newWorld();
      const ship = world.spawn(new Ship({ pos: v(400, 400) }));
      const shot = world.spawn(bullet(v(400, 400), v(0, 0)));
      if (flip) resolveCollision(ship, shot, world);
      else resolveCollision(shot, ship, world);
      assert.equal(ship.hp, MAX_HP - BULLET_DAMAGE);
      assert.equal(shot.alive, false);
    }
  });

  test('щит: снаряд зникає, подія hit із shielded: true, здоров’я ціле', () => {
    const world = newWorld();
    const log = recordEvents(world);
    const ship = world.spawn(new Ship({ pos: v(400, 400) }));
    ship.applyEffect({ type: 'shield', duration: 5 });
    const shot = world.spawn(bullet(v(400, 400), v(0, 0)));
    resolveCollision(shot, ship, world);
    assert.equal(ship.hp, MAX_HP);
    assert.equal(shot.alive, false);
    assert.deepEqual(log, [{ type: 'hit', targetKind: 'ship', targetId: ship.id, shielded: true }]);
  });

  test('п’ять влучань убивають героя: вибух, очки стрільцю, ефекти зняті', () => {
    const world = newWorld();
    const log = recordEvents(world);
    const victim = world.spawn(new Ship({ pos: v(400, 400), team: 'red' }));
    victim.applyEffect({ type: 'rapid', duration: 6 });
    victim.vel = v(50, 0);
    for (let i = 0; i < 5; i += 1) {
      resolveCollision(world.spawn(bullet(v(400, 400), v(0, 0), 77)), victim, world);
    }
    assert.equal(victim.hp, 0);
    assert.equal(victim.isDown, true);
    assert.equal(victim.collidable, false);
    assert.equal(victim.hasEffect('rapid'), false);
    assert.deepEqual({ ...victim.vel }, { x: 0, y: 0 });
    assert.equal(world.score.get(77), 100);
    assert.deepEqual(
      log.filter((event) => event.type !== 'hit'),
      [
        { type: 'exploded', kind: 'ship', id: victim.id, killerId: 77, x: 400, y: 400 },
        { type: 'score', id: 77, points: 100, total: 100 },
      ],
    );
    assert.equal(world.count('explosion'), 1);

    // Шосте влучання в лежачого — пара «застаріла», нічого не відбувається.
    const late = world.spawn(bullet(v(400, 400), v(0, 0), 77));
    resolveCollision(late, victim, world);
    assert.equal(late.alive, true);
    assert.equal(victim.takeDamage(10), false);
  });

  test('cosmetics: false — вибух не створюється, але подія є', () => {
    const world = newWorld({ cosmetics: false });
    const log = recordEvents(world);
    const rock = world.spawn(new Asteroid({ pos: v(400, 400), vel: v(0, 0), size: 1 }));
    resolveCollision(world.spawn(bullet(v(400, 400), v(0, 0), 5)), rock, world);
    assert.equal(rock.alive, false);
    assert.equal(world.count('explosion'), 0);
    assert.deepEqual(
      log.map((event) => event.type),
      ['hit', 'exploded', 'score'],
    );
    assert.equal(world.score.get(5), 10);
    assert.equal(world.count('asteroid'), 0, 'найменший голем не розпадається');
  });

  test('великий голем: 4 влучання, два уламки розміру 2 розлітаються в протилежні боки', () => {
    const world = newWorld({ cosmetics: false });
    const rock = world.spawn(new Asteroid({ pos: v(400, 400), vel: v(10, 0), size: 3 }));
    for (let i = 0; i < 4; i += 1) {
      assert.equal(rock.alive, true);
      resolveCollision(world.spawn(bullet(v(400, 400), v(0, 0), 5)), rock, world);
    }
    assert.equal(rock.hp, 0);
    assert.equal(rock.alive, false);
    assert.equal(world.score.get(5), 30);
    const pieces = [...world.ofKind('asteroid')];
    assert.deepEqual(
      pieces.map((piece) => piece.size),
      [2, 2],
    );
    const [left, right] = pieces;
    // Імпульси ±70 уздовж одного напрямку: сума швидкостей = 2 × швидкість батька.
    assert.ok(Math.abs(left.vel.x + right.vel.x - 20) < 1e-9);
    assert.ok(Math.abs(left.vel.y + right.vel.y) < 1e-9);
    assert.ok(Math.abs(left.vel.sub(v(10, 0)).length() - 70) < 1e-9);
  });

  test('таран: герой, що летить на голема, відскакує і втрачає 15 hp', () => {
    const world = newWorld();
    const log = recordEvents(world);
    const ship = world.spawn(new Ship({ pos: v(400, 400) }));
    ship.vel = v(100, 0);
    const rock = world.spawn(new Asteroid({ pos: v(420, 400), vel: v(0, 0), size: 1 }));
    resolveCollision(ship, rock, world);

    assert.equal(ship.hp, MAX_HP - 15);
    // Рівні маси (радіуси 16 і 16), лобовий пружний удар: тіла обмінюються швидкостями.
    assert.ok(Math.abs(ship.vel.x) < 1e-9);
    assert.ok(Math.abs(rock.vel.x - 100) < 1e-9);
    // Перетин 12 одиниць розсунуто порівну: після удару тіла рівно торкаються.
    assert.ok(Math.abs(ship.pos.x - 394) < 1e-9);
    assert.ok(Math.abs(rock.pos.x - 426) < 1e-9);
    assert.equal(circlesOverlap(ship, rock, ARENA), false);
    assert.deepEqual(log, [
      { type: 'hit', targetKind: 'ship', targetId: ship.id, shielded: false },
    ]);
  });

  test('тіла, що вже розлітаються, лише розсуваються: без шкоди і без зміни швидкостей', () => {
    const world = newWorld();
    const log = recordEvents(world);
    const ship = world.spawn(new Ship({ pos: v(400, 400) }));
    ship.vel = v(-100, 0);
    const rock = world.spawn(new Asteroid({ pos: v(420, 400), vel: v(30, 0), size: 1 }));
    resolveCollision(rock, ship, world);
    assert.equal(ship.hp, MAX_HP);
    assert.deepEqual({ ...ship.vel }, { x: -100, y: 0 });
    assert.deepEqual({ ...rock.vel }, { x: 30, y: 0 });
    assert.deepEqual(log, []);
  });

  test('таран добиває героя з 15 hp: убивці немає, очок ніхто не отримує', () => {
    const world = newWorld();
    const log = recordEvents(world);
    const ship = world.spawn(new Ship({ pos: v(400, 400) }));
    ship.takeDamage(MAX_HP - 15);
    ship.vel = v(100, 0);
    const rock = world.spawn(new Asteroid({ pos: v(420, 400), vel: v(0, 0), size: 3 }));
    resolveCollision(ship, rock, world);
    assert.equal(ship.isDown, true);
    assert.equal(world.score.size, 0);
    assert.equal(log.find((event) => event.type === 'exploded').killerId, null);
  });

  test('два тіла в одній точці: нормаль за домовленістю (1, 0), без NaN', () => {
    const world = newWorld();
    const a = world.spawn(new Asteroid({ pos: v(400, 400), vel: v(0, 0), size: 1 }));
    const b = world.spawn(new Asteroid({ pos: v(400, 400), vel: v(0, 0), size: 1 }));
    resolveCollision(a, b, world);
    assert.deepEqual({ ...a.pos }, { x: 384, y: 400 });
    assert.deepEqual({ ...b.pos }, { x: 416, y: 400 });
  });

  test('різні маси: імпульс зберігається (маса ∝ r²)', () => {
    const world = newWorld();
    const small = world.spawn(new Asteroid({ pos: v(400, 400), vel: v(90, 20), size: 1 }));
    const big = world.spawn(new Asteroid({ pos: v(450, 410), vel: v(-10, 0), size: 3 }));
    const momentum = () => small.vel.scale(small.radius ** 2).add(big.vel.scale(big.radius ** 2));
    const energy = () =>
      small.radius ** 2 * small.vel.dot(small.vel) + big.radius ** 2 * big.vel.dot(big.vel);
    const before = { p: momentum(), e: energy() };
    resolveCollision(small, big, world);
    assert.ok(Math.abs(momentum().x - before.p.x) < 1e-6);
    assert.ok(Math.abs(momentum().y - before.p.y) < 1e-6);
    assert.ok(Math.abs(energy() - before.e) < 1e-4, 'удар пружний: енергія та сама');
    assert.ok(small.vel.x < 0, 'малий відскочив назад');
  });

  test('зіткнення через край арени: розсунуті тіла лишаються в арені', () => {
    const world = newWorld();
    const a = world.spawn(new Asteroid({ pos: v(1595, 450), vel: v(20, 0), size: 1 }));
    const b = world.spawn(new Asteroid({ pos: v(5, 450), vel: v(-20, 0), size: 1 }));
    resolveCollision(a, b, world);
    assert.ok(Math.abs(a.pos.x - 1584) < 1e-9);
    assert.ok(Math.abs(b.pos.x - 16) < 1e-9);
    assert.ok(a.vel.x < 0 && b.vel.x > 0, 'відскочили одне від одного');
  });

  test('руна: ефект герою, подія pickup, руна зникає; снаряд і голем руну не чіпають', () => {
    const world = newWorld();
    const log = recordEvents(world);
    const effect = { type: 'homing', duration: 8 };
    const rune = world.spawn(new Pickup({ pos: v(400, 400), effect }));
    const shot = world.spawn(bullet(v(400, 400), v(0, 0)));
    const rock = world.spawn(new Asteroid({ pos: v(400, 400), vel: v(0, 0), size: 1 }));
    const other = world.spawn(new Pickup({ pos: v(400, 400), effect }));

    resolveCollision(shot, rune, world);
    resolveCollision(rune, rock, world);
    resolveCollision(rune, other, world);
    resolveCollision(shot, shot, world);
    assert.equal(rune.alive && shot.alive && rock.alive && other.alive, true);
    assert.deepEqual(log, []);

    const ship = world.spawn(new Ship({ pos: v(400, 400) }));
    resolveCollision(rune, ship, world);
    assert.equal(ship.hasEffect('homing'), true);
    assert.equal(rune.alive, false);
    assert.deepEqual(log, [{ type: 'pickup', shipId: ship.id, effect }]);
  });

  test('вибух ні з чим не взаємодіє, навіть якщо його передали в правила напряму', () => {
    const world = newWorld();
    const boom = world.spawn(new Explosion({ pos: v(400, 400), rng: world.rng, count: 3 }));
    const ship = world.spawn(new Ship({ pos: v(400, 400) }));
    resolveCollision(boom, ship, world);
    resolveCollision(ship, boom, world);
    assert.equal(ship.hp, MAX_HP);
    assert.equal(boom.particles.length, 3);
  });

  test('снаряд, що вже влучив, удруге на тому ж кроці не рахується', () => {
    const world = newWorld();
    const first = world.spawn(new Ship({ pos: v(400, 400) }));
    const second = world.spawn(new Ship({ pos: v(405, 400) }));
    const shot = world.spawn(bullet(v(402, 400), v(0, 0)));
    resolveCollision(shot, first, world);
    resolveCollision(shot, second, world);
    assert.equal(first.hp, MAX_HP - BULLET_DAMAGE);
    assert.equal(second.hp, MAX_HP);
  });
});
