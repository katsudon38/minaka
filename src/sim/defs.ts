// 兵種と障害物の定義。数値はすべて（仮）で、プロトタイプで調整する。
// 距離はミリタイル、速度はミリタイル/tick、クールダウンは tick。

export type Faction = 'mongoose' | 'habu';
export type Side = 0 | 1;
export type Stance = 'advance' | 'hold' | 'defend';

export type UnitType =
  | 'charger' // 突撃兵
  | 'slinger' // 投石兵
  | 'scout' // 偵察兵
  | 'packLeader' // 群れ長
  | 'fang' // 毒牙兵
  | 'spitter' // 毒吐き
  | 'lurker' // 潜伏兵
  | 'greatHabu'; // 大ハブ

export type ObstacleType = 'fence' | 'rock' | 'moat' | 'grass';

export interface UnitDef {
  type: UnitType;
  faction: Faction;
  name: string;
  role: string;
  ability: string;
  cost: number;
  hp: number;
  attack: number;
  /** 射程（中心間の距離） */
  range: number;
  cooldown: number;
  speed: number;
  sight: number;
  ranged: boolean;
  defaultStance: Stance;
  /** 毒（1秒あたりのダメージ、秒数） */
  poison?: { dps: number; sec: number };
  /** 範囲攻撃の半径 */
  splash?: number;
}

const T = 1000;

export const UNIT_DEFS: Record<UnitType, UnitDef> = {
  charger: {
    type: 'charger', faction: 'mongoose', name: '突撃兵', role: '近接・主力',
    ability: '突進：最初の攻撃が2倍。素早い',
    cost: 2, hp: 55, attack: 9, range: 900, cooldown: 15, speed: 95, sight: 6 * T,
    ranged: false, defaultStance: 'advance',
  },
  slinger: {
    type: 'slinger', faction: 'mongoose', name: '投石兵', role: '遠隔',
    ability: '中距離から投石。柵に3倍ダメージ',
    cost: 3, hp: 40, attack: 8, range: 4 * T, cooldown: 24, speed: 70, sight: 6 * T,
    ranged: true, defaultStance: 'advance',
  },
  scout: {
    type: 'scout', faction: 'mongoose', name: '偵察兵', role: '特殊',
    ability: '最速。5マス以内の潜伏中の敵を見つける',
    cost: 4, hp: 45, attack: 7, range: 900, cooldown: 14, speed: 135, sight: 8 * T,
    ranged: false, defaultStance: 'advance',
  },
  packLeader: {
    type: 'packLeader', faction: 'mongoose', name: '群れ長', role: '支援',
    ability: '周囲3マスの味方の攻撃+25%・速度+20%',
    cost: 7, hp: 130, attack: 12, range: 950, cooldown: 20, speed: 80, sight: 6 * T,
    ranged: false, defaultStance: 'advance',
  },
  fang: {
    type: 'fang', faction: 'habu', name: '毒牙兵', role: '近接・主力',
    ability: '噛みつきで毒（4/秒・4秒）',
    cost: 5, hp: 200, attack: 15, range: 950, cooldown: 20, speed: 60, sight: 6 * T,
    ranged: false, defaultStance: 'advance', poison: { dps: 4, sec: 4 },
  },
  spitter: {
    type: 'spitter', faction: 'habu', name: '毒吐き', role: '遠隔',
    ability: '毒液で半径1マスに範囲ダメージ＋毒',
    cost: 6, hp: 85, attack: 8, range: 4500, cooldown: 36, speed: 50, sight: 6 * T,
    ranged: true, defaultStance: 'advance', poison: { dps: 3, sec: 4 }, splash: 1000,
  },
  lurker: {
    type: 'lurker', faction: 'habu', name: '潜伏兵', role: '特殊',
    ability: '岩・草むら・葦原で姿が見えない。潜伏中の一撃が3倍',
    cost: 6, hp: 120, attack: 20, range: 950, cooldown: 18, speed: 65, sight: 6 * T,
    ranged: false, defaultStance: 'hold',
  },
  greatHabu: {
    type: 'greatHabu', faction: 'habu', name: '大ハブ', role: '支援・防衛',
    ability: '耐久値が非常に高い。近くの敵を引きつける',
    cost: 10, hp: 550, attack: 22, range: 1100, cooldown: 25, speed: 42, sight: 6 * T,
    ranged: false, defaultStance: 'defend',
  },
};

export const FACTION_UNITS: Record<Faction, readonly UnitType[]> = {
  mongoose: ['charger', 'slinger', 'scout', 'packLeader'],
  habu: ['fang', 'spitter', 'lurker', 'greatHabu'],
};

export const FACTION_NAMES: Record<Faction, string> = {
  mongoose: 'マングース軍',
  habu: 'ハブ軍',
};

export interface ObstacleDef {
  type: ObstacleType;
  name: string;
  effect: string;
  cost: number;
  /** 破壊できるなら耐久値 */
  hp?: number;
  blocksMove: boolean;
  blocksSight: boolean;
}

export const OBSTACLE_DEFS: Record<ObstacleType, ObstacleDef> = {
  fence: { type: 'fence', name: '柵', effect: '通行を遮る。破壊できる', cost: 1, hp: 120, blocksMove: true, blocksSight: false },
  rock: { type: 'rock', name: '岩', effect: '通行と射線を遮る。潜伏ポイント', cost: 3, blocksMove: true, blocksSight: true },
  moat: { type: 'moat', name: '堀', effect: '通過する敵の速度を半減', cost: 3, blocksMove: false, blocksSight: false },
  grass: { type: 'grass', name: '草むら', effect: '上にいるユニットの姿を隠す', cost: 1, blocksMove: false, blocksSight: false },
};

export const OBSTACLE_TYPES: readonly ObstacleType[] = ['fence', 'rock', 'moat', 'grass'];

/** 群れ長のオーラ */
export const AURA_RADIUS = 3 * T;
export const AURA_ATTACK_PCT = 125;
export const AURA_SPEED_PCT = 120;

/** 潜伏・索敵 */
export const SCOUT_DETECT_RANGE = 5 * T;
export const CLOSE_DETECT_RANGE = 1500;
export const REVEAL_AFTER_ATTACK_TICKS = 60;
export const AMBUSH_TRIGGER_RANGE = 3 * T;
export const AMBUSH_MULT_PCT = 300;
export const CHARGE_MULT_PCT = 200;
export const SLINGER_FENCE_MULT_PCT = 300;

/** 大ハブの引きつけ範囲 */
export const TAUNT_RANGE = 2500;

/** 地形効果 */
export const HIGH_GROUND_ATTACK_PCT = 125;
export const HIGH_GROUND_RANGE_BONUS = 1000;
export const HIGH_GROUND_SIGHT_BONUS = 2000;
export const WATER_DAMAGE_TAKEN_PCT = 125;

/** 待機・防衛の行動範囲 */
export const DEFEND_RADIUS = 6 * T;
export const HOLD_LEASH = 4 * T;

export const UNIT_RADIUS = 300;
