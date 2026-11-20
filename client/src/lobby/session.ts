// Коли гру треба зупинити й повернути гравця в лобі. Сервер може зникнути трьома способами:
//
//   • чемно — надіслав shutdown (оновлення, перезапуск) і закрив сокет;
//   • мовчки — упав або зникла мережа: з'єднання пробує знову з дедалі довшою паузою,
//     і якщо кілька спроб поспіль не вдалися — чекати далі перед завмерлою грою немає сенсу;
//   • повернувся, але нашої кімнати вже немає — сервер відмовив у вході (код 4004 тощо).
//
// Саме рішення — чиста функція від події (returnReason): її перевіряє тест без мережі.
// watchSession лише підписує її на з'єднання і стежить, щоб спрацювати рівно один раз.

import type { ServerMessageOf } from '@moba-arena/shared/protocol.ts';
import type { ConnectionStatus, ListenOptions } from '../net/connection.ts';

export type ReturnReason = 'shutdown' | 'unreachable' | 'rejected';

export interface ReturnToLobby {
  readonly reason: ReturnReason;
  // Текст для гравця — його покаже лобі.
  readonly message: string;
}

// Те, на що дивиться рішення: подія стану з'єднання або повідомлення shutdown.
export type SessionEvent = ConnectionStatus | ServerMessageOf<'shutdown'>;

// Після скількох невдалих спроб поспіль здаємося. Паузи ростуть 0,5 → 1 → 2 → 4 с,
// тож чотири спроби — це приблизно 4–8 с: короткий збій мережі гра переживе сама.
export const DEFAULT_MAX_ATTEMPTS = 4;

export function returnReason(
  event: SessionEvent,
  { maxAttempts = DEFAULT_MAX_ATTEMPTS }: { readonly maxAttempts?: number } = {},
): ReturnToLobby | null {
  if ('type' in event) {
    return { reason: 'shutdown', message: 'Сервер перезапускається — повертаємось у лобі' };
  }
  switch (event.status) {
    case 'waiting':
      // attempt — номер НАСТУПНОЇ спроби: отже, attempt − 1 уже не вдалися.
      return event.attempt > maxAttempts
        ? { reason: 'unreachable', message: 'Сервер не відповідає — повертаємось у лобі' }
        : null;
    case 'closed':
      // Закрили самі (fatal: false) — гравець і так іде; відмова сервера — причина для лобі.
      return event.fatal
        ? {
            reason: 'rejected',
            message: `З’єднання закрито: ${event.reason ?? 'сервер розірвав з’єднання'} — повертаємось у лобі`,
          }
        : null;
    case 'connecting':
    case 'reconnecting':
    case 'open':
      return null;
    default: {
      const unhandled: never = event;
      return unhandled;
    }
  }
}

// Частина з'єднання, потрібна спостерігачеві: справжнє Connection підходить структурно.
export interface WatchedConnection {
  on(
    type: 'shutdown',
    handler: (event: ServerMessageOf<'shutdown'>) => void,
    options?: ListenOptions,
  ): void;
  onStatus(handler: (event: ConnectionStatus) => void, options?: ListenOptions): void;
  last(type: 'shutdown'): ServerMessageOf<'shutdown'> | undefined;
}

export interface WatchOptions {
  readonly maxAttempts?: number;
  // Зовнішній сигнал: гру зупинили з іншої причини — спостерігач знімає слухачів.
  readonly signal?: AbortSignal;
  readonly onReturn: (decision: ReturnToLobby) => void;
}

export function watchSession(
  connection: WatchedConnection,
  { maxAttempts, signal, onReturn }: WatchOptions,
): void {
  // Власний контролер: після рішення слухачі більше не потрібні, навіть якщо зовнішній
  // сигнал іще живий. Так onReturn не викличеться двічі (shutdown, а за ним close).
  const own = new AbortController();
  const combined = signal ? AbortSignal.any([signal, own.signal]) : own.signal;

  function consider(event: SessionEvent): void {
    if (combined.aborted) return;
    const decision = returnReason(event, maxAttempts === undefined ? {} : { maxAttempts });
    if (!decision) return;
    own.abort();
    onReturn(decision);
  }

  connection.on('shutdown', consider, { signal: combined });
  connection.onStatus(consider, { signal: combined });
  // shutdown міг прийти раніше, ніж ми підписались.
  const earlier = connection.last('shutdown');
  if (earlier) consider(earlier);
}
