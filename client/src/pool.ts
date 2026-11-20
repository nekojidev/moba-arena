// Пул об'єктів: замість «створив → викинув → збирач сміття прибрав» —
// «взяв із запасу → повернув у запас». Після прогріву нових об'єктів не створюється зовсім.
//
// Ціна пулу: об'єкт із запасу несе старі значення — хто взяв, мусить заповнити ВСІ поля;
// і об'єкти в запасі живуть вічно, тож пам'ять тримається на піку використання.

export interface Pool<T> {
  acquire(): T;
  release(item: T): void;
  readonly created: number; // скільки об'єктів створено за весь час (для перевірки в тестах)
}

export function createPool<T>(create: () => T): Pool<T> {
  const free: T[] = [];
  let created = 0;
  return {
    acquire() {
      const item = free.pop();
      if (item !== undefined) return item;
      created += 1;
      return create();
    },
    release(item) {
      free.push(item);
    },
    get created() {
      return created;
    },
  };
}
