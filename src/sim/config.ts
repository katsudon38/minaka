// 対戦の基本パラメータ。（仮）の値はプロトタイプで調整する。

export const TICKS_PER_SECOND = 20;

/** マップの大きさ（タイル）。x が横、z が奥行き。陣営0が z の小さい側。 */
export const MAP_W = 18;
export const MAP_H = 30;

/** 配置エリア：全マップ共通の長方形。 */
export const DEPLOY_X0 = 1;
export const DEPLOY_X1 = MAP_W - 1; // 含まない
export const DEPLOY_DEPTH = 7;

/** 予算（仕様：50前後、各コスト1〜10）。 */
export const BUDGET = 50;

/** 拠点の最大耐久値（仮：仕様では未決）。 */
export const BASE_MAX_HP = 1500;

/** 実戦の制限時間（仮：仕様では未決）。 */
export const BATTLE_TIME_LIMIT_SEC = 120;
export const BATTLE_TIME_LIMIT_TICKS = BATTLE_TIME_LIMIT_SEC * TICKS_PER_SECOND;

/** 準備フェーズの制限時間（仮）。 */
export const PREP_TIME_LIMIT_SEC = 90;

/** 拠点は 2x2 タイル。左下タイル座標。 */
export const BASE_SIZE = 2;
export const BASE_TX = MAP_W / 2 - 1;
export const BASE_TZ: readonly [number, number] = [1, MAP_H - 1 - BASE_SIZE];
