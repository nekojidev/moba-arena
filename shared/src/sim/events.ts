// Карта подій світу: ім'я події → форма її даних. Це єдиний опис, і від нього виводяться
// типи слухачів (Bus<GameEvents>), а в protocol.ts — події, що їдуть мережею.

import type { EntityId } from '../brand.ts';

export type Team = 'green' | 'red';
export type EffectType = 'shield' | 'rapid' | 'homing';

export interface Effect {
  readonly type: EffectType;
  readonly duration: number;
}

export interface GameEvents {
  fired: { readonly shipId: EntityId; readonly team: Team; readonly homing: boolean };
  hit: {
    readonly targetKind: 'ship' | 'asteroid';
    readonly targetId: EntityId;
    readonly shielded: boolean;
  };
  exploded: {
    readonly kind: 'ship' | 'asteroid';
    readonly id: EntityId;
    readonly killerId: EntityId | null;
    readonly x: number;
    readonly y: number;
    readonly size?: number | undefined;
  };
  pickup: { readonly shipId: EntityId; readonly effect: Effect };
  score: { readonly id: EntityId; readonly points: number; readonly total: number };
  respawned: { readonly shipId: EntityId };
}
