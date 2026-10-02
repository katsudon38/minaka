// 戦闘ロジックはすべて整数で計算する（ブラウザ間で結果を一致させるため）。
// 座標は「ミリタイル」単位：1タイル = ONE。

export const ONE = 1000;

/** 整数の平方根（切り捨て）。Math.sqrt を使わずニュートン法で求める。 */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  let x = n;
  let y = Math.floor((x + 1) / 2);
  while (y < x) {
    x = y;
    y = Math.floor((x + Math.floor(n / x)) / 2);
  }
  return x;
}

export function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

export function dist(ax: number, az: number, bx: number, bz: number): number {
  return isqrt(dist2(ax, az, bx, bz));
}

/** base × pct / 100 を整数で（0方向に切り捨て）。 */
export function pct(base: number, percent: number): number {
  return Math.trunc((base * percent) / 100);
}

export function tileOf(v: number): number {
  return Math.floor(v / ONE);
}

export function tileCenter(t: number): number {
  return t * ONE + ONE / 2;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
