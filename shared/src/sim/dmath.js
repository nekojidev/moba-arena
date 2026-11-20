// Детермінована тригонометрія для симуляції.
//
// Math.sin, Math.cos і Math.atan2 НЕ зобов'язані давати однаковий результат у різних
// рушіях: стандарт вимагає лише «наближення». На практиці Node і Chrome (різні версії V8)
// розходяться в останньому біті — а в симуляції, де сервер і клієнт мусять прийти
// до того самого стану, один біт за кілька секунд виростає в інший матч.
//
// Натомість +, −, ×, ÷ і Math.sqrt стандарт IEEE 754 визначає точно — біт у біт на будь-якій
// машині. Тому тут усе зібрано лише з них: зведення аргументу + многочлен Тейлора.
// Точність ≈ 1e-11 — для гри з запасом; головне, що вона ОДНАКОВА всюди.

const PI = 3.141592653589793;
const TAU = 6.283185307179586;
const HALF_PI = 1.5707963267948966;

// sin на [-π/2, π/2]: ряд Тейлора до x¹⁷ у формі Горнера.
function sinCore(x) {
  const x2 = x * x;
  return (
    x *
    (1 +
      x2 *
        (-1 / 6 +
          x2 *
            (1 / 120 +
              x2 *
                (-1 / 5040 +
                  x2 *
                    (1 / 362880 +
                      x2 *
                        (-1 / 39916800 +
                          x2 *
                            (1 / 6227020800 +
                              x2 * (-1 / 1307674368000 + x2 / 355687428096000))))))))
  );
}

export function sin(angle) {
  // Зводимо до [-π, π], потім дзеркалимо до [-π/2, π/2].
  let x = angle - TAU * Math.round(angle / TAU);
  if (x > HALF_PI) x = PI - x;
  else if (x < -HALF_PI) x = -PI - x;
  return sinCore(x);
}

export function cos(angle) {
  return sin(angle + HALF_PI);
}

// atan на [0, 1]: двічі застосовуємо atan(z) = 2·atan(z / (1 + √(1 + z²))),
// після чого z ≤ 0.2 і ряд z − z³/3 + z⁵/5 − … збігається за кілька членів.
function atanUnit(z) {
  let t = z / (1 + Math.sqrt(1 + z * z));
  t = t / (1 + Math.sqrt(1 + t * t));
  const t2 = t * t;
  const series =
    t *
    (1 +
      t2 *
        (-1 / 3 +
          t2 * (1 / 5 + t2 * (-1 / 7 + t2 * (1 / 9 + t2 * (-1 / 11 + t2 * (1 / 13 - t2 / 15)))))));
  return 4 * series;
}

export function atan2(y, x) {
  if (x === 0 && y === 0) return 0;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  // Тримаємо аргумент у [0, 1]: для кутів понад 45° рахуємо доповнення.
  let angle = ay <= ax ? atanUnit(ay / ax) : HALF_PI - atanUnit(ax / ay);
  if (x < 0) angle = PI - angle;
  return y < 0 ? -angle : angle;
}

// Довжина вектора. Math.hypot теж лише «наближення»; √(x² + y²) — точне.
export function hypot(x, y) {
  return Math.sqrt(x * x + y * y);
}
