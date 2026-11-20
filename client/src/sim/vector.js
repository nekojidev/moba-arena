// Двовимірний вектор. Усі методи чисті: повертають НОВИЙ вектор і не чіпають ні this,
// ні аргумент. Завдяки цьому вектор можна безпечно ділити між сутностями
// (prevPos = pos — це не копія, і це нормально, бо ніхто його не змінить).

export class Vector2 {
  static ZERO = Object.freeze(new Vector2(0, 0));

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  static fromAngle(angle, length = 1) {
    return new Vector2(Math.cos(angle) * length, Math.sin(angle) * length);
  }

  add(other) {
    return new Vector2(this.x + other.x, this.y + other.y);
  }

  sub(other) {
    return new Vector2(this.x - other.x, this.y - other.y);
  }

  scale(factor) {
    return new Vector2(this.x * factor, this.y * factor);
  }

  dot(other) {
    return this.x * other.x + this.y * other.y;
  }

  length() {
    return Math.hypot(this.x, this.y);
  }

  normalize() {
    const length = this.length();
    return length === 0 ? Vector2.ZERO : this.scale(1 / length);
  }

  rotate(angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return new Vector2(this.x * cos - this.y * sin, this.x * sin + this.y * cos);
  }

  angle() {
    return Math.atan2(this.y, this.x);
  }
}
