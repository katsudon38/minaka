// 対戦セットアップの生成ヘルパー。

import { generatePlacement, type Difficulty } from '../cpu/placementAi';
import type { Faction } from './defs';
import { createTerrain, type MapId } from './maps';
import type { MatchSetup } from './placement';
import { Rng } from './rng';

export function cpuVsCpuSetup(mapId: MapId, factions: [Faction, Faction], difficulty: [Difficulty, Difficulty], seed: number): MatchSetup {
  const terrain = createTerrain(mapId);
  const rng = new Rng(seed ^ 0x9e3779b9);
  return {
    version: 1,
    mapId,
    seed,
    sides: [
      { faction: factions[0], items: generatePlacement(terrain, 0, factions[0], difficulty[0], rng) },
      { faction: factions[1], items: generatePlacement(terrain, 1, factions[1], difficulty[1], rng) },
    ],
  };
}
