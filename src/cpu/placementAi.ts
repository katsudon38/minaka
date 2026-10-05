// CPU の配置AI。戦闘中のAIはユニットAIと共通で、CPU に必要なのは配置だけ。
// 難易度は予算の使い方の上手さで変える。

import { BUDGET, DEPLOY_DEPTH, DEPLOY_X0, DEPLOY_X1, MAP_H } from '../sim/config';
import { FACTION_UNITS, OBSTACLE_DEFS, OBSTACLE_TYPES, UNIT_DEFS, type Faction, type ObstacleType, type Side, type Stance, type UnitType } from '../sim/defs';
import type { MapId, Terrain } from '../sim/maps';
import { canPlaceAt, itemCost, totalCost, type PlacementItem } from '../sim/placement';
import type { Rng } from '../sim/rng';

export type Difficulty = 'easy' | 'normal' | 'hard';

export const DIFFICULTY_NAMES: Record<Difficulty, string> = {
  easy: 'やさしい',
  normal: 'ふつう',
  hard: 'むずかしい',
};

type Kind = UnitType | ObstacleType;

interface Slot {
  kind: Kind;
  count: number;
  /** 置く列（0 = 最前列 … DEPLOY_DEPTH-1 = 最後列） */
  rows: readonly number[];
  /** 'center' は中央から、'flank' は両端から埋める */
  spread?: 'center' | 'flank' | 'wide';
  stance?: Stance;
  /** 兵を草むらの上に置く（草むらも一緒に購入する） */
  onGrass?: boolean;
}

/** 陣営とマップごとの編成（合計50以内） */
const TEMPLATES: Record<Faction, Partial<Record<MapId | 'generic', Slot[]>>> = {
  mongoose: {
    generic: [
      { kind: 'charger', count: 12, rows: [0, 1], spread: 'wide' },
      { kind: 'packLeader', count: 1, rows: [2], spread: 'center' },
      { kind: 'slinger', count: 4, rows: [2, 3], spread: 'center' },
      { kind: 'scout', count: 1, rows: [0], spread: 'flank' },
      { kind: 'fence', count: 3, rows: [5], spread: 'center' },
    ],
    plain: [
      { kind: 'charger', count: 15, rows: [0, 1], spread: 'wide' },
      { kind: 'packLeader', count: 1, rows: [1], spread: 'center' },
      { kind: 'slinger', count: 3, rows: [2], spread: 'center' },
      { kind: 'scout', count: 1, rows: [0], spread: 'flank' },
    ],
    mountain: [
      { kind: 'scout', count: 2, rows: [0], spread: 'flank' },
      { kind: 'charger', count: 10, rows: [0, 1], spread: 'center' },
      { kind: 'packLeader', count: 1, rows: [2], spread: 'center' },
      { kind: 'slinger', count: 4, rows: [2, 3], spread: 'center' },
      { kind: 'fence', count: 3, rows: [5], spread: 'center' },
    ],
    river: [
      { kind: 'charger', count: 12, rows: [0, 1], spread: 'center' },
      { kind: 'packLeader', count: 1, rows: [2], spread: 'center' },
      { kind: 'slinger', count: 5, rows: [2, 3], spread: 'wide' },
      { kind: 'scout', count: 1, rows: [0], spread: 'flank' },
    ],
  },
  habu: {
    generic: [
      { kind: 'fang', count: 3, rows: [1], spread: 'center' },
      { kind: 'spitter', count: 2, rows: [3], spread: 'center' },
      { kind: 'lurker', count: 2, rows: [0], spread: 'flank', stance: 'hold' },
      { kind: 'greatHabu', count: 1, rows: [4], spread: 'center', stance: 'defend' },
      { kind: 'grass', count: 1, rows: [1], spread: 'flank' },
    ],
    plain: [
      { kind: 'fang', count: 3, rows: [2], spread: 'center' },
      { kind: 'spitter', count: 3, rows: [3], spread: 'center' },
      { kind: 'greatHabu', count: 1, rows: [4], spread: 'center', stance: 'defend' },
      { kind: 'fence', count: 4, rows: [0], spread: 'center' },
    ],
    mountain: [
      { kind: 'lurker', count: 2, rows: [0], spread: 'flank', stance: 'hold', onGrass: true },
      { kind: 'spitter', count: 2, rows: [2], spread: 'center' },
      { kind: 'fang', count: 2, rows: [1], spread: 'center' },
      { kind: 'greatHabu', count: 1, rows: [4], spread: 'center', stance: 'defend' },
    ],
    river: [
      { kind: 'spitter', count: 3, rows: [2], spread: 'wide' },
      { kind: 'fang', count: 3, rows: [1], spread: 'center' },
      { kind: 'lurker', count: 1, rows: [0], spread: 'center', stance: 'hold', onGrass: true },
      { kind: 'greatHabu', count: 1, rows: [4], spread: 'center', stance: 'defend' },
    ],
  },
};

function rowToZ(side: Side, row: number): number {
  return side === 0 ? DEPLOY_DEPTH - 1 - row : MAP_H - DEPLOY_DEPTH + row;
}

function columnOrder(spread: Slot['spread'], rng: Rng, jitter: boolean): number[] {
  const xs: number[] = [];
  for (let x = DEPLOY_X0; x < DEPLOY_X1; x++) xs.push(x);
  const mid = (DEPLOY_X0 + DEPLOY_X1 - 1) / 2;
  const key = (x: number) => {
    const d = Math.abs(x - mid);
    if (spread === 'flank') return -d;
    if (spread === 'wide') return (x % 2) * 100 + d;
    return d;
  };
  xs.sort((a, b) => key(a) - key(b) || a - b);
  if (jitter) {
    for (let i = 0; i + 1 < xs.length; i += 2) if (rng.int(2) === 0) [xs[i], xs[i + 1]] = [xs[i + 1], xs[i]];
  }
  return xs;
}

function isUnitKind(k: Kind): k is UnitType {
  return k in UNIT_DEFS;
}

function placeSlot(terrain: Terrain, side: Side, items: PlacementItem[], slot: Slot, rng: Rng, jitter: boolean): void {
  let placed = 0;
  for (const row of slot.rows) {
    const z = rowToZ(side, row);
    for (const x of columnOrder(slot.spread, rng, jitter)) {
      if (placed >= slot.count) return;
      const unit = isUnitKind(slot.kind);
      const kind = unit ? 'unit' : 'obstacle';
      const extra = slot.onGrass ? OBSTACLE_DEFS.grass.cost : 0;
      const item: PlacementItem = unit
        ? { kind: 'unit', type: slot.kind as UnitType, tx: x, tz: z, stance: slot.stance ?? UNIT_DEFS[slot.kind as UnitType].defaultStance }
        : { kind: 'obstacle', type: slot.kind as ObstacleType, tx: x, tz: z };
      if (totalCost(items) + itemCost(item) + extra > BUDGET) return;
      if (!canPlaceAt(terrain, side, items, x, z, kind, slot.kind)) continue;
      if (slot.onGrass) {
        if (!canPlaceAt(terrain, side, items, x, z, 'obstacle', 'grass')) continue;
        items.push({ kind: 'obstacle', type: 'grass', tx: x, tz: z });
      }
      items.push(item);
      placed++;
    }
  }
}

/** 予算の余りを安い兵で埋め、それでも余れば最前列に柵を置く */
function fillRemainder(terrain: Terrain, side: Side, faction: Faction, items: PlacementItem[], rng: Rng): void {
  const cheapest = [...FACTION_UNITS[faction]].sort((a, b) => UNIT_DEFS[a].cost - UNIT_DEFS[b].cost);
  for (const type of cheapest) {
    const kind: Kind = type;
    placeSlot(terrain, side, items, { kind, count: 99, rows: [1, 2, 3], spread: 'center' }, rng, false);
  }
  placeSlot(terrain, side, items, { kind: 'fence', count: 99, rows: [0], spread: 'center' }, rng, false);
}

function randomPlacement(terrain: Terrain, side: Side, faction: Faction, rng: Rng): PlacementItem[] {
  const items: PlacementItem[] = [];
  // 予算の6〜9割をでたらめに使う
  const target = Math.trunc((BUDGET * (60 + rng.int(31))) / 100);
  const kinds: Kind[] = [...FACTION_UNITS[faction], ...OBSTACLE_TYPES];
  const stances: Stance[] = ['advance', 'hold', 'defend'];
  for (let tries = 0; tries < 300 && totalCost(items) < target; tries++) {
    const k = rng.pick(kinds);
    const x = DEPLOY_X0 + rng.int(DEPLOY_X1 - DEPLOY_X0);
    const z = rowToZ(side, rng.int(DEPLOY_DEPTH));
    const unit = isUnitKind(k);
    const item: PlacementItem = unit
      ? { kind: 'unit', type: k, tx: x, tz: z, stance: rng.int(3) === 0 ? rng.pick(stances) : UNIT_DEFS[k].defaultStance }
      : { kind: 'obstacle', type: k as ObstacleType, tx: x, tz: z };
    if (totalCost(items) + itemCost(item) > target) continue;
    if (!canPlaceAt(terrain, side, items, x, z, item.kind, item.type)) continue;
    items.push(item);
  }
  return items;
}

export function generatePlacement(
  terrain: Terrain, side: Side, faction: Faction, difficulty: Difficulty, rng: Rng,
): PlacementItem[] {
  if (difficulty === 'easy') return randomPlacement(terrain, side, faction, rng);
  const templates = TEMPLATES[faction];
  const slots = (difficulty === 'hard' ? templates[terrain.id] : undefined) ?? templates.generic!;
  const items: PlacementItem[] = [];
  for (const slot of slots) placeSlot(terrain, side, items, slot, rng, difficulty === 'normal');
  fillRemainder(terrain, side, faction, items, rng);
  return items;
}
