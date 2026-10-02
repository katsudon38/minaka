// バランス調整用の自動対戦。描画なしで大量に回す。
// 使い方: npm run autobattle -- [試合数/条件] [難易度]
// 数値の上書き: BALANCE='{"fang":{"hp":180}}' npm run autobattle

import type { Difficulty } from '../src/cpu/placementAi';
import { createWorld, cpuVsCpuSetup, lossRatePermille, MAP_IDS, runToEnd, TICKS_PER_SECOND, UNIT_DEFS, type Faction, type UnitType } from '../src/sim';

if (process.env.BALANCE) {
  const overrides = JSON.parse(process.env.BALANCE) as Partial<Record<UnitType, Record<string, number>>>;
  for (const [type, fields] of Object.entries(overrides)) Object.assign(UNIT_DEFS[type as UnitType], fields);
}

const games = Number(process.argv[2] ?? 20);
const difficulty = (process.argv[3] ?? 'hard') as Difficulty;

const rows: string[][] = [['マップ', 'マングース勝', 'ハブ勝', '引分', '拠点破壊', '平均時間', '損耗率(M/H)']];
for (const mapId of MAP_IDS) {
  let mWin = 0, hWin = 0, draw = 0, baseKills = 0, ticks = 0, mLoss = 0, hLoss = 0;
  for (let g = 0; g < games; g++) {
    // 陣営を交互に入れ替えて、上下の有利不利を打ち消す
    const factions: [Faction, Faction] = g % 2 === 0 ? ['mongoose', 'habu'] : ['habu', 'mongoose'];
    const w = createWorld(cpuVsCpuSetup(mapId, factions, [difficulty, difficulty], 1000 + g));
    runToEnd(w);
    const r = w.result!;
    const mSide = factions[0] === 'mongoose' ? 0 : 1;
    if (r.winner === null) draw++;
    else if (r.winner === mSide) mWin++;
    else hWin++;
    if (r.reason === 'base') baseKills++;
    ticks += r.tick;
    mLoss += lossRatePermille(r.lostCost[mSide], r.startCost[mSide]);
    hLoss += lossRatePermille(r.lostCost[1 - mSide], r.startCost[1 - mSide]);
  }
  rows.push([
    mapId, String(mWin), String(hWin), String(draw), String(baseKills),
    `${(ticks / games / TICKS_PER_SECOND).toFixed(1)}秒`,
    `${(mLoss / games / 10).toFixed(0)}% / ${(hLoss / games / 10).toFixed(0)}%`,
  ]);
}
for (const r of rows) console.log(r.join('\t'));
