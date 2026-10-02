// グリッド上の A* 探索（8方向、角抜けなし）。整数コストのみ。

import { MAP_H, MAP_W } from './config';

export const BLOCKED = -1;

/** タイルに入るコスト（直進1歩あたり、標準=10）。BLOCKED なら通れない。 */
export type TileCost = (x: number, z: number) => number;

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
];

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, val: number): void {
    const k = this.keys;
    const v = this.vals;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] < key || (k[p] === key && v[p] <= val)) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }

  pop(): number {
    const k = this.keys;
    const v = this.vals;
    const top = v[0];
    const lastK = k.pop()!;
    const lastV = v.pop()!;
    if (k.length > 0) {
      let i = 0;
      const n = k.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        let c = l;
        if (r < n && (k[r] < k[l] || (k[r] === k[l] && v[r] < v[l]))) c = r;
        if (lastK < k[c] || (lastK === k[c] && lastV <= v[c])) break;
        k[i] = k[c];
        v[i] = v[c];
        i = c;
      }
      k[i] = lastK;
      v[i] = lastV;
    }
    return top;
  }
}

function octile(ax: number, az: number, bx: number, bz: number): number {
  const dx = Math.abs(ax - bx);
  const dz = Math.abs(az - bz);
  return dx > dz ? 10 * dx + 4 * dz : 10 * dz + 4 * dx;
}

/**
 * (sx, sz) から goal を満たすタイルまでの経路を返す（開始タイルは含まない）。
 * 到達できない場合は、目標 (gx, gz) に最も近い到達可能タイルまでの経路を返す。
 */
export function findPath(
  sx: number, sz: number,
  gx: number, gz: number,
  cost: TileCost,
  isGoal: (x: number, z: number) => boolean = (x, z) => x === gx && z === gz,
  maxExpand = MAP_W * MAP_H,
): number[] {
  const n = MAP_W * MAP_H;
  const g = new Int32Array(n).fill(-1);
  const from = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const start = sz * MAP_W + sx;
  g[start] = 0;
  const open = new MinHeap();
  open.push(octile(sx, sz, gx, gz), start);
  let best = start;
  let bestH = octile(sx, sz, gx, gz);
  let found = -1;
  let expanded = 0;
  while (open.size > 0 && expanded < maxExpand) {
    const cur = open.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    expanded++;
    const cx = cur % MAP_W;
    const cz = (cur - cx) / MAP_W;
    if (cur !== start && isGoal(cx, cz)) {
      found = cur;
      break;
    }
    const h = octile(cx, cz, gx, gz);
    if (h < bestH) {
      bestH = h;
      best = cur;
    }
    for (let d = 0; d < 8; d++) {
      const [dx, dz] = DIRS[d];
      const nx = cx + dx;
      const nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= MAP_W || nz >= MAP_H) continue;
      const ni = nz * MAP_W + nx;
      if (closed[ni]) continue;
      const goalTile = isGoal(nx, nz);
      let c = cost(nx, nz);
      if (c === BLOCKED) {
        if (!goalTile) continue;
        c = 10;
      }
      if (dx !== 0 && dz !== 0) {
        // 角抜け禁止
        if (cost(cx + dx, cz) === BLOCKED || cost(cx, cz + dz) === BLOCKED) continue;
        c = Math.trunc((c * 14) / 10);
      }
      const ng = g[cur] + c;
      if (g[ni] === -1 || ng < g[ni]) {
        g[ni] = ng;
        from[ni] = cur;
        open.push(ng + octile(nx, nz, gx, gz), ni);
      }
    }
  }
  const end = found >= 0 ? found : best;
  const path: number[] = [];
  for (let i = end; i !== start && i !== -1; i = from[i]) path.push(i);
  path.reverse();
  return path;
}
