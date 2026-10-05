// 戦闘の状態。MatchSetup から決定論的に生成する。

import { BASE_MAX_HP, BASE_SIZE, BASE_TX, BASE_TZ, MAP_H, MAP_W } from './config';
import { OBSTACLE_DEFS, UNIT_DEFS, type Faction, type ObstacleType, type Side, type Stance, type UnitDef, type UnitType } from './defs';
import { ONE, tileCenter } from './fixed';
import { createTerrain, idx, inBounds, type Terrain } from './maps';
import type { MatchSetup } from './placement';
import { Rng } from './rng';

export interface UnitState {
  id: number;
  side: Side;
  type: UnitType;
  def: UnitDef;
  x: number;
  z: number;
  prevX: number;
  prevZ: number;
  /** 向き（最後に動いた・攻撃した方向）。描画用 */
  dirX: number;
  dirZ: number;
  hp: number;
  maxHp: number;
  stance: Stance;
  homeX: number;
  homeZ: number;
  cooldown: number;
  /** 一度でも攻撃したか（突進ボーナス用） */
  hasAttacked: boolean;
  poisonDps: number;
  poisonTicks: number;
  /** 攻撃後に姿が見えている残り tick */
  revealTicks: number;
  /** 潜伏兵：敵が近づくまで動かない */
  ambushArmed: boolean;
  path: number[];
  pathGoal: number;
  pathVersion: number;
  repathAt: number;
  moving: boolean;
  alive: boolean;
  /** 偵察兵：確認済みの潜伏ポイント */
  checkedSpots: Set<number>;
  /** 群れ長：ついていく味方 */
  followId: number;
}

export interface ObstacleState {
  id: number;
  side: Side;
  type: ObstacleType;
  tx: number;
  tz: number;
  hp: number;
  maxHp: number;
  alive: boolean;
}

export interface BaseState {
  side: Side;
  hp: number;
  maxHp: number;
  /** 拠点の矩形（ミリタイル） */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export type TargetRef =
  | { kind: 'unit'; id: number }
  | { kind: 'obstacle'; id: number }
  | { kind: 'base'; side: Side };

export type BattleEvent =
  | { t: 'attack'; attacker: number; target: TargetRef; x: number; z: number; tx: number; tz: number; style: 'melee' | 'stone' | 'spit'; damage: number; bonus: string | null }
  | { t: 'death'; unit: number }
  | { t: 'obstacleDestroyed'; obstacle: number }
  | { t: 'revealed'; unit: number };

export type ResultReason = 'base' | 'timeout' | 'bothBases' | 'noUnits';
export type DecidedBy = 'base' | 'baseHp' | 'lossRate' | 'draw';

export interface BattleResult {
  winner: Side | null;
  reason: ResultReason;
  decidedBy: DecidedBy;
  tick: number;
  baseHp: [number, number];
  lostCost: [number, number];
  startCost: [number, number];
}

export interface World {
  setup: MatchSetup;
  terrain: Terrain;
  factions: [Faction, Faction];
  tick: number;
  rng: Rng;
  units: UnitState[];
  obstacles: ObstacleState[];
  bases: [BaseState, BaseState];
  /** タイル → 障害物の id（なければ -1） */
  obstacleAt: Int32Array;
  /** 障害物が壊れるたびに増える（経路の再計算用） */
  obstacleVersion: number;
  /** 陣営ごとの移動コスト表 */
  moveCost: [Int32Array, Int32Array];
  /** 陣営ごとに、各ユニットが見えているか */
  visibleTo: [Uint8Array, Uint8Array];
  /** 各ユニットが潜伏中か */
  concealed: Uint8Array;
  /** 各ユニットが群れ長のオーラを受けているか */
  aura: Uint8Array;
  /** 潜伏できるタイル（偵察兵が探す場所） */
  hideSpots: number[];
  startCost: [number, number];
  lostCost: [number, number];
  events: BattleEvent[];
  result: BattleResult | null;
}

function createBase(side: Side): BaseState {
  const z0 = BASE_TZ[side] * ONE;
  return {
    side,
    hp: BASE_MAX_HP,
    maxHp: BASE_MAX_HP,
    x0: BASE_TX * ONE,
    z0,
    x1: (BASE_TX + BASE_SIZE) * ONE,
    z1: z0 + BASE_SIZE * ONE,
  };
}

export function createWorld(setup: MatchSetup): World {
  const terrain = createTerrain(setup.mapId);
  const units: UnitState[] = [];
  const obstacles: ObstacleState[] = [];
  const obstacleAt = new Int32Array(MAP_W * MAP_H).fill(-1);
  const startCost: [number, number] = [0, 0];

  for (const side of [0, 1] as const) {
    for (const it of setup.sides[side].items) {
      if (it.kind === 'unit') {
        const def = UNIT_DEFS[it.type];
        const x = tileCenter(it.tx);
        const z = tileCenter(it.tz);
        units.push({
          id: units.length, side, type: it.type, def,
          x, z, prevX: x, prevZ: z,
          dirX: 0, dirZ: side === 0 ? 1 : -1,
          hp: def.hp, maxHp: def.hp,
          stance: it.stance, homeX: x, homeZ: z,
          cooldown: 0, hasAttacked: false,
          poisonDps: 0, poisonTicks: 0, revealTicks: 0,
          ambushArmed: it.type === 'lurker',
          path: [], pathGoal: -1, pathVersion: -1, repathAt: 0,
          moving: false, alive: true,
          checkedSpots: new Set(), followId: -1,
        });
        startCost[side] += def.cost;
      } else {
        const def = OBSTACLE_DEFS[it.type];
        const id = obstacles.length;
        obstacles.push({
          id, side, type: it.type, tx: it.tx, tz: it.tz,
          hp: def.hp ?? 0, maxHp: def.hp ?? 0, alive: true,
        });
        obstacleAt[idx(it.tx, it.tz)] = id;
      }
    }
  }

  const world: World = {
    setup,
    terrain,
    factions: [setup.sides[0].faction, setup.sides[1].faction],
    tick: 0,
    rng: new Rng(setup.seed),
    units,
    obstacles,
    bases: [createBase(0), createBase(1)],
    obstacleAt,
    obstacleVersion: 0,
    moveCost: [new Int32Array(0), new Int32Array(0)],
    visibleTo: [new Uint8Array(units.length), new Uint8Array(units.length)],
    concealed: new Uint8Array(units.length),
    aura: new Uint8Array(units.length),
    hideSpots: [],
    startCost,
    lostCost: [0, 0],
    events: [],
    result: null,
  };
  rebuildMoveCost(world);
  world.hideSpots = computeHideSpots(world);
  return world;
}

export function obstacleAtTile(w: World, x: number, z: number): ObstacleState | null {
  if (!inBounds(x, z)) return null;
  const id = w.obstacleAt[idx(x, z)];
  return id >= 0 ? w.obstacles[id] : null;
}

export function isBaseTileAny(w: World, x: number, z: number): boolean {
  for (const b of w.bases) {
    const tx0 = b.x0 / ONE;
    const tz0 = b.z0 / ONE;
    if (x >= tx0 && x < tx0 + BASE_SIZE && z >= tz0 && z < tz0 + BASE_SIZE) return true;
  }
  return false;
}

/** 陣営 side のユニットにとっての移動コスト（標準10、-1は通行不可） */
export function rebuildMoveCost(w: World): void {
  const t = w.terrain;
  for (const side of [0, 1] as const) {
    const cost = new Int32Array(MAP_W * MAP_H);
    for (let z = 0; z < MAP_H; z++) {
      for (let x = 0; x < MAP_W; x++) {
        const i = idx(x, z);
        let c = 10;
        const k = t.kind[i];
        if (k === 'cliff' || isBaseTileAny(w, x, z)) c = -1;
        else if (k === 'water') c = 25;
        else if (k === 'shallow') c = 15;
        else if (t.slope[i]) c = 16;
        const o = obstacleAtTile(w, x, z);
        if (c !== -1 && o && o.alive) {
          if (o.type === 'rock') c = -1;
          else if (o.type === 'fence') c = o.side === side ? -1 : c + 60;
          else if (o.type === 'moat' && o.side !== side) c = Math.max(c, 25);
        }
        cost[i] = c;
      }
    }
    w.moveCost[side] = cost;
  }
}

function computeHideSpots(w: World): number[] {
  const spots: number[] = [];
  for (let z = 0; z < MAP_H; z++) {
    for (let x = 0; x < MAP_W; x++) {
      if (w.moveCost[0][idx(x, z)] === -1 && w.moveCost[1][idx(x, z)] === -1) continue;
      if (isConcealingTile(w, x, z) || isNextToRock(w, x, z)) spots.push(idx(x, z));
    }
  }
  return spots;
}

/** 葦原と草むら：上にいるユニットの姿を隠す */
export function isConcealingTile(w: World, x: number, z: number): boolean {
  if (!inBounds(x, z)) return false;
  if (w.terrain.kind[idx(x, z)] === 'reeds') return true;
  const o = obstacleAtTile(w, x, z);
  return !!o && o.alive && o.type === 'grass';
}

/** 岩陰（岩の障害物か岩壁に隣接）：潜伏兵が隠れられる */
export function isNextToRock(w: World, x: number, z: number): boolean {
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dz === 0) continue;
      const nx = x + dx;
      const nz = z + dz;
      if (!inBounds(nx, nz)) continue;
      if (w.terrain.kind[idx(nx, nz)] === 'cliff') return true;
      const o = obstacleAtTile(w, nx, nz);
      if (o && o.alive && o.type === 'rock') return true;
    }
  }
  return false;
}

/** 状態のハッシュ（決定論性の検証用） */
export function hashWorld(w: World): number {
  let h = 0x811c9dc5;
  const mix = (v: number) => {
    h ^= v | 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  mix(w.tick);
  for (const u of w.units) {
    mix(u.x);
    mix(u.z);
    mix(u.hp);
    mix(u.alive ? 1 : 0);
  }
  for (const o of w.obstacles) mix(o.hp);
  mix(w.bases[0].hp);
  mix(w.bases[1].hp);
  mix(w.rng.state);
  return h >>> 0;
}
