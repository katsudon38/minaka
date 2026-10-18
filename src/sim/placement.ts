// 準備フェーズの配置データ。オンライン対戦ではこれを交換するだけで戦闘を再現できる。

import { BUDGET } from './config';
import { FACTION_UNITS, OBSTACLE_DEFS, UNIT_DEFS, type Faction, type ObstacleType, type Side, type Stance, type UnitType } from './defs';
import { idx, inDeployZone, isAnyBaseTile, type MapId, type Terrain } from './maps';

export interface UnitPlacement {
  kind: 'unit';
  type: UnitType;
  tx: number;
  tz: number;
  stance: Stance;
}

export interface ObstaclePlacement {
  kind: 'obstacle';
  type: ObstacleType;
  tx: number;
  tz: number;
}

export type PlacementItem = UnitPlacement | ObstaclePlacement;

export interface SideSetup {
  faction: Faction;
  items: PlacementItem[];
}

/** 1回の対戦を完全に再現するためのデータ（リプレイ・オンライン対戦用）。 */
export interface MatchSetup {
  version: 1;
  mapId: MapId;
  seed: number;
  sides: [SideSetup, SideSetup];
}

export function itemCost(item: PlacementItem): number {
  return item.kind === 'unit' ? UNIT_DEFS[item.type].cost : OBSTACLE_DEFS[item.type].cost;
}

export function totalCost(items: readonly PlacementItem[]): number {
  let sum = 0;
  for (const it of items) sum += itemCost(it);
  return sum;
}

/** 草むらと堀の上には兵を重ねて置ける。それ以外は1タイルに1つ。 */
function canShareTile(a: PlacementItem['kind'], aType: string, b: PlacementItem): boolean {
  if (a === b.kind) return false;
  const obstacleType = a === 'obstacle' ? aType : b.type;
  return obstacleType === 'grass' || obstacleType === 'moat';
}

export function canPlaceAt(
  terrain: Terrain, side: Side, items: readonly PlacementItem[], tx: number, tz: number,
  kind: PlacementItem['kind'] = 'unit', type = '',
): boolean {
  if (!inDeployZone(side, tx, tz)) return false;
  if (isAnyBaseTile(tx, tz)) return false;
  if (terrain.kind[idx(tx, tz)] !== 'plain') return false;
  return items.every((it) => it.tx !== tx || it.tz !== tz || canShareTile(kind, type, it));
}

/** 配置が正しいか検証する。問題があればその内容を返す。 */
export function validateSide(terrain: Terrain, side: Side, setup: SideSetup): string[] {
  const errors: string[] = [];
  const cost = totalCost(setup.items);
  if (cost > BUDGET) errors.push(`予算超過（${cost}/${BUDGET}）`);
  const seen: PlacementItem[] = [];
  for (const it of setup.items) {
    if (it.kind === 'unit' && !FACTION_UNITS[setup.faction].includes(it.type)) {
      errors.push(`${UNIT_DEFS[it.type].name}はこの陣営の兵ではない`);
    }
    if (!canPlaceAt(terrain, side, seen, it.tx, it.tz, it.kind, it.type)) {
      errors.push(`(${it.tx}, ${it.tz}) には配置できない`);
    }
    seen.push(it);
  }
  return errors;
}

export function encodeSetup(setup: MatchSetup): string {
  return JSON.stringify(setup);
}

export function decodeSetup(text: string): MatchSetup {
  const v = JSON.parse(text) as MatchSetup;
  if (v.version !== 1) throw new Error('未対応のバージョン');
  return v;
}

const STANCE_IDS: readonly Stance[] = ['advance', 'hold', 'defend'];

/**
 * 外部（オンライン対戦の相手）から届いた配置データの形を検査する。
 * 形が正しければ、余計なプロパティを落とした配置を返す。中身の妥当性は validateSide で確かめる。
 */
export function parseItems(value: unknown): PlacementItem[] | null {
  if (!Array.isArray(value) || value.length > 200) return null;
  const out: PlacementItem[] = [];
  for (const v of value) {
    if (!v || typeof v !== 'object') return null;
    const it = v as Record<string, unknown>;
    if (!Number.isInteger(it.tx) || !Number.isInteger(it.tz)) return null;
    const tx = it.tx as number;
    const tz = it.tz as number;
    if (it.kind === 'unit') {
      if (typeof it.type !== 'string' || !Object.hasOwn(UNIT_DEFS, it.type)) return null;
      if (!STANCE_IDS.includes(it.stance as Stance)) return null;
      out.push({ kind: 'unit', type: it.type as UnitType, tx, tz, stance: it.stance as Stance });
    } else if (it.kind === 'obstacle') {
      if (typeof it.type !== 'string' || !Object.hasOwn(OBSTACLE_DEFS, it.type)) return null;
      out.push({ kind: 'obstacle', type: it.type as ObstacleType, tx, tz });
    } else {
      return null;
    }
  }
  return out;
}
