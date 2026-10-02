// マップ（地形）の定義。公平になるよう、すべて中心で点対称にする。

import { BASE_SIZE, BASE_TX, BASE_TZ, DEPLOY_DEPTH, DEPLOY_X0, DEPLOY_X1, MAP_H, MAP_W } from './config';
import type { Side } from './defs';

export type MapId = 'plain' | 'mountain' | 'river';

export type TerrainKind = 'plain' | 'cliff' | 'water' | 'shallow' | 'bridge' | 'reeds';

export interface MapInfo {
  id: MapId;
  name: string;
  description: string;
  favored: string;
}

export const MAP_INFOS: Record<MapId, MapInfo> = {
  plain: { id: 'plain', name: '平野', description: '開けた草原。障害物の置き方がそのまま戦線になる', favored: 'マングース軍' },
  mountain: { id: 'mountain', name: '山地', description: '高所は攻撃と視界が上がる。坂は遅い。山道が通り道を限定する', favored: 'ハブ軍' },
  river: { id: 'river', name: '河辺', description: '渡河中は遅く、防御が下がる。橋と浅瀬が要所。葦原では姿が隠れる', favored: '拮抗' },
};

export const MAP_IDS: readonly MapId[] = ['plain', 'mountain', 'river'];

export interface Terrain {
  id: MapId;
  w: number;
  h: number;
  kind: TerrainKind[];
  height: number[];
  /** 隣接タイルと高さが違う＝坂 */
  slope: boolean[];
}

export function idx(x: number, z: number): number {
  return z * MAP_W + x;
}

export function inBounds(x: number, z: number): boolean {
  return x >= 0 && x < MAP_W && z >= 0 && z < MAP_H;
}

export function isBaseTile(side: Side, x: number, z: number): boolean {
  const z0 = BASE_TZ[side];
  return x >= BASE_TX && x < BASE_TX + BASE_SIZE && z >= z0 && z < z0 + BASE_SIZE;
}

export function isAnyBaseTile(x: number, z: number): boolean {
  return isBaseTile(0, x, z) || isBaseTile(1, x, z);
}

export function inDeployZone(side: Side, x: number, z: number): boolean {
  if (x < DEPLOY_X0 || x >= DEPLOY_X1) return false;
  return side === 0 ? z >= 0 && z < DEPLOY_DEPTH : z >= MAP_H - DEPLOY_DEPTH && z < MAP_H;
}

export function isPassableTerrain(t: Terrain, x: number, z: number): boolean {
  return t.kind[idx(x, z)] !== 'cliff';
}

type Painter = (set: (x: number, z: number, kind: TerrainKind, height?: number) => void) => void;

function build(id: MapId, paint: Painter): Terrain {
  const n = MAP_W * MAP_H;
  const kind: TerrainKind[] = new Array(n).fill('plain');
  const height: number[] = new Array(n).fill(0);
  // 点対称に塗る
  const set = (x: number, z: number, k: TerrainKind, h = 0) => {
    for (const [px, pz] of [[x, z], [MAP_W - 1 - x, MAP_H - 1 - z]]) {
      if (!inBounds(px, pz)) continue;
      kind[idx(px, pz)] = k;
      height[idx(px, pz)] = h;
    }
  };
  paint(set);
  const slope: boolean[] = new Array(n).fill(false);
  for (let z = 0; z < MAP_H; z++) {
    for (let x = 0; x < MAP_W; x++) {
      const i = idx(x, z);
      if (kind[i] === 'cliff') continue;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const nz = z + dz;
        if (!inBounds(nx, nz)) continue;
        const j = idx(nx, nz);
        if (kind[j] !== 'cliff' && height[j] !== height[i]) slope[i] = true;
      }
    }
  }
  return { id, w: MAP_W, h: MAP_H, kind, height, slope };
}

function rect(
  set: (x: number, z: number, kind: TerrainKind, height?: number) => void,
  x0: number, z0: number, x1: number, z1: number, kind: TerrainKind, h = 0,
) {
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) set(x, z, kind, h);
}

const PAINTERS: Record<MapId, Painter> = {
  plain: () => {
    // 遮蔽物がほとんどない開けた草原
  },
  mountain: (set) => {
    // 中央の台地（高さ1、頂上は高さ2）
    rect(set, 6, 10, 11, 19, 'plain', 1);
    rect(set, 7, 12, 10, 17, 'plain', 2);
    // 中央を横切る岩壁。左右の狭い山道と台地の頂上だけが通れる
    for (let x = 0; x < MAP_W; x++) {
      if (x === 2 || x === 15 || (x >= 7 && x <= 10)) continue;
      set(x, 14, 'cliff', 1);
    }
    // 両脇の丘
    rect(set, 0, 8, 2, 10, 'plain', 1);
    rect(set, 13, 10, 15, 11, 'plain', 1);
    // 岩場
    set(4, 9, 'cliff', 1);
    set(5, 9, 'cliff', 1);
    set(12, 8, 'cliff', 1);
    set(4, 12, 'cliff', 1);
    set(13, 13, 'cliff', 1);
  },
  river: (set) => {
    // 川（中央4列）
    rect(set, 0, 13, MAP_W - 1, 16, 'water');
    // 中央の橋
    rect(set, 8, 13, 9, 16, 'bridge');
    // 左右の浅瀬
    rect(set, 2, 13, 3, 16, 'shallow');
    // 岸辺の葦原
    rect(set, 4, 11, 6, 12, 'reeds');
    rect(set, 12, 11, 14, 12, 'reeds');
  },
};

export function createTerrain(id: MapId): Terrain {
  return build(id, PAINTERS[id]);
}

/** 配置エリアが地形の影響を受けていないことを保証する（テスト用） */
export function deployZoneIsClear(t: Terrain, side: Side): boolean {
  for (let z = 0; z < MAP_H; z++) {
    for (let x = 0; x < MAP_W; x++) {
      if (inDeployZone(side, x, z) && t.kind[idx(x, z)] !== 'plain') return false;
    }
  }
  return true;
}
