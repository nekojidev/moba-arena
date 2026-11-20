import { atan2, cos, hypot, sin } from './dmath.ts';

// Двовимірний вектор. Поля readonly: `v.x = 5` — помилка компіляції. Усі методи чисті —
// повертають НОВИЙ вектор. Тому вектор можна безпечно ділити між сутностями
// (prevPos = pos — це не копія, і це нормально, бо ніхто його не змінить).

export class Vector2 {
  static readonly ZERO: Vector2 = Object.freeze(new Vector2(0, 0));

  readonly x: number;
  readonly y: number;

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  static fromAngle(angle: number, length = 1): Vector2 {
    return new Vector2(cos(angle) * length, sin(angle) * length);
  }

  add(other: Vector2): Vector2 {
    return new Vector2(this.x + other.x, this.y + other.y);
  }

  sub(other: Vector2): Vector2 {
    return new Vector2(this.x - other.x, this.y - other.y);
  }

  scale(factor: number): Vector2 {
    return new Vector2(this.x * factor, this.y * factor);
  }

  dot(other: Vector2): number {
    return this.x * other.x + this.y * other.y;
  }

  length(): number {
    return hypot(this.x, this.y);
  }

  normalize(): Vector2 {
    const length = this.length();
    return length === 0 ? Vector2.ZERO : this.scale(1 / length);
  }

  rotate(angle: number): Vector2 {
    const c = cos(angle);
    const s = sin(angle);
    return new Vector2(this.x * c - this.y * s, this.x * s + this.y * c);
  }

  angle(): number {
    return atan2(this.y, this.x);
  }
}
