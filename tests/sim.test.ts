import { describe, expect, it } from 'vitest';
import { generatePlacement, type Difficulty } from '../src/cpu/placementAi';
import { isqrt } from '../src/sim/fixed';
import { findPath } from '../src/sim/pathfinding';
import {
  BASE_MAX_HP, BUDGET, MAP_H, MAP_IDS, MAP_W, createTerrain, createWorld, cpuVsCpuSetup, decodeSetup,
  deployZoneIsClear, encodeSetup, hashWorld, idx, judge, Rng, runToEnd, stepWorld, totalCost,
  validateSide, type Faction, type MatchSetup,
} from '../src/sim';

function hashes(setup: MatchSetup): number[] {
  const w = createWorld(setup);
  const out: number[] = [];
  while (!w.result) {
    stepWorld(w);
    if (w.tick % 20 === 0) out.push(hashWorld(w));
  }
  out.push(hashWorld(w));
  return out;
}

describe('fixed', () => {
  it('isqrt は切り捨ての平方根', () => {
    for (const n of [0, 1, 2, 3, 4, 15, 16, 17, 999_999, 1_000_000, 1_800_000_000]) {
      const r = isqrt(n);
      expect(r * r).toBeLessThanOrEqual(n);
      expect((r + 1) * (r + 1)).toBeGreaterThan(n);
    }
  });
});

describe('決定論的シミュレーション', () => {
  it('同じ配置とシードなら毎回同じ経過になる', () => {
    const setup = cpuVsCpuSetup('river', ['mongoose', 'habu'], ['normal', 'normal'], 42);
    expect(hashes(setup)).toEqual(hashes(setup));
  });

  it('配置データを送受信（JSON化）しても同じ結果になる', () => {
    const setup = cpuVsCpuSetup('mountain', ['habu', 'mongoose'], ['hard', 'easy'], 7);
    const received = decodeSetup(encodeSetup(setup));
    expect(hashes(received)).toEqual(hashes(setup));
  });

  it('すべてのマップで制限時間内に決着する', () => {
    for (const mapId of MAP_IDS) {
      const w = createWorld(cpuVsCpuSetup(mapId, ['mongoose', 'habu'], ['normal', 'normal'], 3));
      runToEnd(w);
      expect(w.result).not.toBeNull();
    }
  });
});

describe('勝敗判定', () => {
  it('残り耐久値が多い方が勝つ', () => {
    expect(judge([500, 400], [50, 0], [50, 50])).toEqual({ winner: 0, decidedBy: 'baseHp' });
  });

  it('耐久値が同じなら、損耗率（コスト換算）が低い方が勝つ', () => {
    // 陣営0: 20/50 = 40%、陣営1: 18/40 = 45%
    expect(judge([300, 300], [20, 18], [50, 40])).toEqual({ winner: 0, decidedBy: 'lossRate' });
  });

  it('損耗率も同じなら引き分け', () => {
    expect(judge([300, 300], [10, 20], [25, 50])).toEqual({ winner: null, decidedBy: 'draw' });
  });

  it('両方の拠点が同じフレームで0になったら時間切れと同じ判定', () => {
    const w = createWorld(cpuVsCpuSetup('plain', ['mongoose', 'habu'], ['normal', 'normal'], 1));
    w.bases[0].hp = 0;
    w.bases[1].hp = 0;
    w.lostCost = [10, 0];
    stepWorld(w);
    expect(w.result?.reason).toBe('bothBases');
    expect(w.result?.winner).toBe(1);
  });

  it('拠点の耐久値が0になった側はその時点で負け', () => {
    const w = createWorld(cpuVsCpuSetup('plain', ['mongoose', 'habu'], ['normal', 'normal'], 1));
    w.bases[1].hp = 0;
    stepWorld(w);
    expect(w.result).toMatchObject({ winner: 0, reason: 'base' });
    expect(w.bases[0].hp).toBe(BASE_MAX_HP);
  });
});

describe('配置', () => {
  const terrain = createTerrain('plain');

  it('予算超過・他陣営の兵・配置エリア外を弾く', () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ kind: 'unit' as const, type: 'greatHabu' as const, tx: 2 + i, tz: 5, stance: 'defend' as const }));
    expect(validateSide(terrain, 0, { faction: 'habu', items }).join()).toContain('予算超過');
    expect(validateSide(terrain, 0, { faction: 'mongoose', items: [{ kind: 'unit', type: 'fang', tx: 3, tz: 3, stance: 'advance' }] })).toHaveLength(1);
    expect(validateSide(terrain, 0, { faction: 'mongoose', items: [{ kind: 'unit', type: 'charger', tx: 3, tz: 15, stance: 'advance' }] })).toHaveLength(1);
    expect(validateSide(terrain, 1, { faction: 'mongoose', items: [{ kind: 'unit', type: 'charger', tx: 3, tz: MAP_H - 2, stance: 'advance' }] })).toHaveLength(0);
  });

  it('草むらの上には兵を重ねられるが、柵の上には置けない', () => {
    const grass = validateSide(terrain, 0, { faction: 'habu', items: [
      { kind: 'obstacle', type: 'grass', tx: 4, tz: 4 },
      { kind: 'unit', type: 'lurker', tx: 4, tz: 4, stance: 'hold' },
    ] });
    expect(grass).toHaveLength(0);
    const fence = validateSide(terrain, 0, { faction: 'habu', items: [
      { kind: 'obstacle', type: 'fence', tx: 4, tz: 4 },
      { kind: 'unit', type: 'lurker', tx: 4, tz: 4, stance: 'hold' },
    ] });
    expect(fence).toHaveLength(1);
  });

  it('CPUの配置はどの難易度・陣営・マップでも有効', () => {
    for (const mapId of MAP_IDS) {
      const t = createTerrain(mapId);
      for (const faction of ['mongoose', 'habu'] as Faction[]) {
        for (const diff of ['easy', 'normal', 'hard'] as Difficulty[]) {
          for (const side of [0, 1] as const) {
            const items = generatePlacement(t, side, faction, diff, new Rng(5));
            expect(validateSide(t, side, { faction, items })).toEqual([]);
            expect(totalCost(items)).toBeLessThanOrEqual(BUDGET);
            if (diff !== 'easy') expect(totalCost(items)).toBeGreaterThanOrEqual(BUDGET - 3);
          }
        }
      }
    }
  });
});

describe('マップ', () => {
  for (const mapId of MAP_IDS) {
    it(`${mapId}：点対称で、配置エリアは平地、両陣営の拠点がつながっている`, () => {
      const t = createTerrain(mapId);
      for (let z = 0; z < MAP_H; z++) {
        for (let x = 0; x < MAP_W; x++) {
          const m = idx(MAP_W - 1 - x, MAP_H - 1 - z);
          expect(t.kind[idx(x, z)]).toBe(t.kind[m]);
          expect(t.height[idx(x, z)]).toBe(t.height[m]);
        }
      }
      expect(deployZoneIsClear(t, 0)).toBe(true);
      expect(deployZoneIsClear(t, 1)).toBe(true);
      const path = findPath(9, 4, 9, MAP_H - 5, (x, z) => (t.kind[idx(x, z)] === 'cliff' ? -1 : 10));
      expect(path[path.length - 1]).toBe(idx(9, MAP_H - 5));
    });
  }
});
