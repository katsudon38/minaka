// 1試合の経過を表示する（デバッグ用）。
// 使い方: npm run trace -- <map> <side0陣営> <seed> [難易度]

import type { Difficulty } from '../src/cpu/placementAi';
import { createWorld, cpuVsCpuSetup, stepWorld, TICKS_PER_SECOND, UNIT_DEFS, type Faction, type MapId } from '../src/sim';

const mapId = (process.argv[2] ?? 'plain') as MapId;
const f0 = (process.argv[3] ?? 'mongoose') as Faction;
const seed = Number(process.argv[4] ?? 1);
const diff = (process.argv[5] ?? 'hard') as Difficulty;
const f1: Faction = f0 === 'mongoose' ? 'habu' : 'mongoose';
const w = createWorld(cpuVsCpuSetup(mapId, [f0, f1], [diff, diff], seed));

for (const s of [0, 1] as const) {
  console.log(`陣営${s} ${w.factions[s]}:`, w.setup.sides[s].items.map((i) => `${i.kind === 'unit' ? UNIT_DEFS[i.type].name : i.type}@${i.tx},${i.tz}`).join(' '));
}
const kills: Record<string, number> = {};
while (!w.result) {
  stepWorld(w);
  for (const e of w.events) {
    if (e.t === 'attack' && e.target.kind === 'unit') {
      const a = w.units[e.attacker];
      kills[a.def.name] = (kills[a.def.name] ?? 0) + e.damage;
    }
  }
  if (w.tick % (5 * TICKS_PER_SECOND) === 0) {
    const alive = [0, 1].map((s) => w.units.filter((u) => u.alive && u.side === s).length);
    const pos = [0, 1].map((s) => {
      const us = w.units.filter((u) => u.alive && u.side === s);
      return us.length ? (us.reduce((a, u) => a + u.z, 0) / us.length / 1000).toFixed(1) : '-';
    });
    console.log(`${w.tick / TICKS_PER_SECOND}s 生存 ${alive.join('/')} 平均z ${pos.join('/')} 拠点 ${w.bases[0].hp}/${w.bases[1].hp}`);
  }
}
console.log('与ダメージ', kills);
console.log(w.result);
