// Branded-типи: числа, які компілятор не дає переплутати.
//
// Для JavaScript id сутності, номер кроку і номер input — просто number. Для TypeScript
// структурно теж: number є number. «Бренд» — це уявна позначка в типі (у рантаймі її
// немає зовсім), через яку EntityId не можна передати туди, де чекають Seq, і навпаки.

declare const brandTag: unique symbol;

export type Brand<T, Name extends string> = T & { readonly [brandTag]: Name };

export type EntityId = Brand<number, 'EntityId'>;
export type Tick = Brand<number, 'Tick'>;
export type Seq = Brand<number, 'Seq'>;

// Єдине місце, де звичайне число стає брендованим.
export function brand<B extends Brand<number, string>>(value: number): B {
  // as: бренд існує лише в типах — «виготовити» його інакше, ніж приведенням, неможливо.
  return value as B;
}

export const entityId = (value: number): EntityId => brand<EntityId>(value);
export const tick = (value: number): Tick => brand<Tick>(value);
export const seq = (value: number): Seq => brand<Seq>(value);
