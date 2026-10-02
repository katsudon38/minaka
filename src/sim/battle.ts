// 実戦フェーズ：1tickぶんの処理。プレイヤーの入力はなく、ユニットAIが自動で戦う。
// 処理順はすべて id 順で固定し、整数演算だけを使う（決定論的シミュレーション）。

import { BATTLE_TIME_LIMIT_TICKS, MAP_H, MAP_W, TICKS_PER_SECOND } from './config';
import {
  AMBUSH_MULT_PCT, AMBUSH_TRIGGER_RANGE, AURA_ATTACK_PCT, AURA_RADIUS, AURA_SPEED_PCT,
  CHARGE_MULT_PCT, CLOSE_DETECT_RANGE, DEFEND_RADIUS, HIGH_GROUND_ATTACK_PCT, HIGH_GROUND_RANGE_BONUS,
  HIGH_GROUND_SIGHT_BONUS, HOLD_LEASH, REVEAL_AFTER_ATTACK_TICKS, SCOUT_DETECT_RANGE,
  SLINGER_FENCE_MULT_PCT, TAUNT_RANGE, UNIT_RADIUS, WATER_DAMAGE_TAKEN_PCT, type Side,
} from './defs';
import { clamp, dist, dist2, isqrt, ONE, pct, tileCenter, tileOf } from './fixed';
import { idx, inBounds, inDeployZone } from './maps';
import { BLOCKED, findPath } from './pathfinding';
import {
  isConcealingTile, isNextToRock, obstacleAtTile, rebuildMoveCost,
  type BaseState, type BattleEvent, type DecidedBy, type ObstacleState, type ResultReason,
  type UnitState, type World,
} from './world';

const REPATH_INTERVAL = 20;
const LEADER_RETHINK_INTERVAL = 10;
const DIRECT_MOVE_MAX = 3 * ONE;
const WAYPOINT_REACHED = 250;

export function stepWorld(w: World): void {
  if (w.result) return;
  w.tick++;
  w.events = [];
  for (const u of w.units) {
    u.prevX = u.x;
    u.prevZ = u.z;
    u.moving = false;
  }
  tickStatus(w);
  computeConcealment(w);
  computeVisibility(w);
  computeAura(w);
  for (const u of w.units) {
    if (u.alive) act(w, u);
  }
  separate(w);
  checkResult(w);
}

export function runToEnd(w: World, maxTicks = BATTLE_TIME_LIMIT_TICKS + 10): void {
  for (let i = 0; i < maxTicks && !w.result; i++) stepWorld(w);
}

// ---------------------------------------------------------------- 地形の参照

function tileIndexAt(x: number, z: number): number {
  return idx(clamp(tileOf(x), 0, MAP_W - 1), clamp(tileOf(z), 0, MAP_H - 1));
}

function heightAt(w: World, x: number, z: number): number {
  return w.terrain.height[tileIndexAt(x, z)];
}

/** 物理的に入れないタイル（岩壁・拠点・岩・柵） */
function isSolid(w: World, tx: number, tz: number): boolean {
  if (!inBounds(tx, tz)) return true;
  const i = idx(tx, tz);
  if (w.moveCost[0][i] === BLOCKED && w.moveCost[1][i] === BLOCKED) return true;
  const o = obstacleAtTile(w, tx, tz);
  return !!o && o.alive && o.type === 'fence';
}

/** 射線が通るか（岩壁と岩が遮る） */
function hasLineOfSight(w: World, ax: number, az: number, bx: number, bz: number): boolean {
  const d = dist(ax, az, bx, bz);
  const n = Math.max(1, Math.trunc(d / 250));
  const startTile = tileIndexAt(ax, az);
  const endTile = tileIndexAt(bx, bz);
  for (let i = 1; i < n; i++) {
    const px = ax + Math.trunc(((bx - ax) * i) / n);
    const pz = az + Math.trunc(((bz - az) * i) / n);
    const ti = tileIndexAt(px, pz);
    if (ti === startTile || ti === endTile) continue;
    if (w.terrain.kind[ti] === 'cliff') return false;
    const o = w.obstacleAt[ti] >= 0 ? w.obstacles[w.obstacleAt[ti]] : null;
    if (o && o.alive && o.type === 'rock') return false;
  }
  return true;
}

function distToBase(x: number, z: number, b: BaseState): number {
  return dist(x, z, clamp(x, b.x0, b.x1), clamp(z, b.z0, b.z1));
}

function baseCenter(b: BaseState): [number, number] {
  return [(b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2];
}

function enemyOf(side: Side): Side {
  return side === 0 ? 1 : 0;
}

// ---------------------------------------------------------------- 状態異常・視界

function tickStatus(w: World): void {
  for (const u of w.units) {
    if (!u.alive) continue;
    if (u.cooldown > 0) u.cooldown--;
    if (u.revealTicks > 0) u.revealTicks--;
    if (u.poisonTicks > 0) {
      u.poisonTicks--;
      if (u.poisonTicks % TICKS_PER_SECOND === 0) dealDamage(w, u, u.poisonDps);
      if (u.poisonTicks === 0) u.poisonDps = 0;
    }
  }
}

function computeConcealment(w: World): void {
  for (const u of w.units) {
    if (!u.alive) {
      w.concealed[u.id] = 0;
      continue;
    }
    const tx = tileOf(u.x);
    const tz = tileOf(u.z);
    const hidden = isConcealingTile(w, tx, tz) || (u.type === 'lurker' && isNextToRock(w, tx, tz));
    w.concealed[u.id] = hidden ? 1 : 0;
  }
}

function computeVisibility(w: World): void {
  for (const side of [0, 1] as const) {
    const vis = w.visibleTo[side];
    for (const e of w.units) {
      if (!e.alive) {
        vis[e.id] = 0;
        continue;
      }
      if (e.side === side || !w.concealed[e.id] || e.revealTicks > 0) {
        vis[e.id] = 1;
        continue;
      }
      let seen = 0;
      for (const v of w.units) {
        if (!v.alive || v.side !== side) continue;
        const d2 = dist2(v.x, v.z, e.x, e.z);
        if (d2 <= CLOSE_DETECT_RANGE * CLOSE_DETECT_RANGE || (v.type === 'scout' && d2 <= SCOUT_DETECT_RANGE * SCOUT_DETECT_RANGE)) {
          seen = 1;
          break;
        }
      }
      if (seen && !vis[e.id]) w.events.push({ t: 'revealed', unit: e.id });
      vis[e.id] = seen;
    }
  }
}

function computeAura(w: World): void {
  for (const u of w.units) {
    w.aura[u.id] = 0;
    if (!u.alive) continue;
    for (const l of w.units) {
      if (l.alive && l.type === 'packLeader' && l.side === u.side && l.id !== u.id
        && dist2(l.x, l.z, u.x, u.z) <= AURA_RADIUS * AURA_RADIUS) {
        w.aura[u.id] = 1;
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- 行動

function sightOf(w: World, u: UnitState, e: UnitState): number {
  return u.def.sight + (heightAt(w, u.x, u.z) > heightAt(w, e.x, e.z) ? HIGH_GROUND_SIGHT_BONUS : 0);
}

function rangeOf(w: World, u: UnitState, tx: number, tz: number): number {
  return u.def.range + (u.def.ranged && heightAt(w, u.x, u.z) > heightAt(w, tx, tz) ? HIGH_GROUND_RANGE_BONUS : 0);
}

function inStanceArea(w: World, u: UnitState, e: UnitState): boolean {
  if (u.stance === 'hold') {
    const r = HOLD_LEASH + u.def.range;
    return dist2(u.homeX, u.homeZ, e.x, e.z) <= r * r;
  }
  if (u.stance === 'defend') {
    const [cx, cz] = baseCenter(w.bases[u.side]);
    return dist2(cx, cz, e.x, e.z) <= DEFEND_RADIUS * DEFEND_RADIUS;
  }
  if (u.type === 'packLeader' && hasHerd(w, u)) {
    // 群れ長は群れから離れて敵を追わない
    return dist2(u.x, u.z, e.x, e.z) <= 2 * ONE * 2 * ONE;
  }
  return true;
}

function candidates(w: World, u: UnitState): UnitState[] {
  const out: UnitState[] = [];
  const vis = w.visibleTo[u.side];
  for (const e of w.units) {
    if (!e.alive || e.side === u.side || !vis[e.id]) continue;
    const s = sightOf(w, u, e);
    if (dist2(u.x, u.z, e.x, e.z) > s * s) continue;
    if (!inStanceArea(w, u, e)) continue;
    out.push(e);
  }
  return out;
}

function nearest(u: UnitState, list: UnitState[]): UnitState | null {
  let best: UnitState | null = null;
  let bestD = Infinity;
  for (const e of list) {
    const d = dist2(u.x, u.z, e.x, e.z);
    if (d < bestD) {
      best = e;
      bestD = d;
    }
  }
  return best;
}

function inRange(w: World, u: UnitState, list: UnitState[]): UnitState[] {
  return list.filter((e) => {
    const r = rangeOf(w, u, e.x, e.z) + (u.def.ranged ? 0 : 500);
    return dist2(u.x, u.z, e.x, e.z) <= r * r;
  });
}

/** 兵種ごとの狙い方 */
function chooseTarget(w: World, u: UnitState, cands: UnitState[]): UnitState | null {
  if (cands.length === 0) return null;
  if (!u.def.ranged) {
    // 大ハブは近くの敵を引きつける
    const taunting = cands.filter((e) => e.type === 'greatHabu' && dist2(u.x, u.z, e.x, e.z) <= TAUNT_RANGE * TAUNT_RANGE);
    if (taunting.length > 0) return nearest(u, taunting);
  }
  switch (u.type) {
    case 'scout': {
      const hidden = cands.filter((e) => w.concealed[e.id]);
      return nearest(u, hidden.length > 0 ? hidden : cands);
    }
    case 'fang': {
      // 射程内で、まだ毒を受けていない敵を優先
      const fresh = inRange(w, u, cands).filter((e) => e.poisonTicks === 0);
      return nearest(u, fresh.length > 0 ? fresh : cands);
    }
    case 'spitter': {
      // 射程内で敵が最も密集している場所を狙う
      const reach = inRange(w, u, cands);
      if (reach.length === 0) return nearest(u, cands);
      const r2 = (u.def.splash ?? 0) * (u.def.splash ?? 0);
      let best: UnitState | null = null;
      let bestCount = -1;
      let bestD = Infinity;
      for (const e of reach) {
        let count = 0;
        for (const o of w.units) {
          if (o.alive && o.side === e.side && dist2(o.x, o.z, e.x, e.z) <= r2) count++;
        }
        const d = dist2(u.x, u.z, e.x, e.z);
        if (count > bestCount || (count === bestCount && d < bestD)) {
          best = e;
          bestCount = count;
          bestD = d;
        }
      }
      return best;
    }
    default:
      return nearest(u, cands);
  }
}

function act(w: World, u: UnitState): void {
  if (u.ambushArmed) {
    // 潜伏兵：敵が近づくまで動かない
    let near = false;
    for (const e of w.units) {
      if (e.alive && e.side !== u.side && dist2(u.x, u.z, e.x, e.z) <= AMBUSH_TRIGGER_RANGE * AMBUSH_TRIGGER_RANGE) {
        near = true;
        break;
      }
    }
    if (!near) return;
    u.ambushArmed = false;
  }

  const target = chooseTarget(w, u, candidates(w, u));
  if (target) {
    engage(w, u, target);
    return;
  }

  if (u.type === 'slinger' && attackNearbyFence(w, u)) return;

  if (u.stance === 'advance') {
    if (u.type === 'packLeader' && hasHerd(w, u)) {
      followHerd(w, u);
      return;
    }
    if (u.type === 'scout' && searchHideSpots(w, u)) return;
    advanceToBase(w, u);
    return;
  }

  // 待機・防衛：配置場所に戻る
  if (dist2(u.x, u.z, u.homeX, u.homeZ) > 100 * 100) {
    moveToward(w, u, u.homeX, u.homeZ);
  } else if (u.type === 'lurker') {
    u.ambushArmed = true;
  }
}

function engage(w: World, u: UnitState, t: UnitState): void {
  const r = rangeOf(w, u, t.x, t.z);
  const d2 = dist2(u.x, u.z, t.x, t.z);
  if (d2 <= r * r && (!u.def.ranged || hasLineOfSight(w, u.x, u.z, t.x, t.z))) {
    face(u, t.x, t.z);
    if (u.cooldown === 0) attackUnit(w, u, t);
    return;
  }
  moveToward(w, u, t.x, t.z);
}

function advanceToBase(w: World, u: UnitState): void {
  const base = w.bases[enemyOf(u.side)];
  if (distToBase(u.x, u.z, base) <= u.def.range) {
    face(u, clamp(u.x, base.x0, base.x1), clamp(u.z, base.z0, base.z1));
    if (u.cooldown === 0) attackBase(w, u, base);
    return;
  }
  const [cx, cz] = baseCenter(base);
  const bx0 = base.x0 / ONE;
  const bz0 = base.z0 / ONE;
  const bx1 = base.x1 / ONE - 1;
  const bz1 = base.z1 / ONE - 1;
  // 拠点に隣接するタイルが目標
  moveToward(w, u, cx, cz, (x, z) =>
    x >= bx0 - 1 && x <= bx1 + 1 && z >= bz0 - 1 && z <= bz1 + 1 && !(x >= bx0 && x <= bx1 && z >= bz0 && z <= bz1));
}

function hasHerd(w: World, u: UnitState): boolean {
  for (const a of w.units) {
    if (a.alive && a.side === u.side && a.type !== 'packLeader') return true;
  }
  return false;
}

/** 群れ長：味方が最も多い場所についていく */
function followHerd(w: World, u: UnitState): void {
  const current = u.followId >= 0 ? w.units[u.followId] : null;
  if (!current || !current.alive || w.tick % LEADER_RETHINK_INTERVAL === 0) {
    let best = -1;
    let bestCount = -1;
    let bestD = Infinity;
    for (const a of w.units) {
      if (!a.alive || a.side !== u.side || a.type === 'packLeader') continue;
      let count = 0;
      for (const b of w.units) {
        if (b.alive && b.side === u.side && dist2(a.x, a.z, b.x, b.z) <= AURA_RADIUS * AURA_RADIUS) count++;
      }
      const d = dist2(u.x, u.z, a.x, a.z);
      if (count > bestCount || (count === bestCount && d < bestD)) {
        best = a.id;
        bestCount = count;
        bestD = d;
      }
    }
    u.followId = best;
  }
  const f = w.units[u.followId];
  const base = w.bases[enemyOf(u.side)];
  if (distToBase(u.x, u.z, base) <= u.def.range) {
    face(u, clamp(u.x, base.x0, base.x1), clamp(u.z, base.z0, base.z1));
    if (u.cooldown === 0) attackBase(w, u, base);
    return;
  }
  if (dist2(u.x, u.z, f.x, f.z) > 1200 * 1200) moveToward(w, u, f.x, f.z);
}

/** 偵察兵：潜伏できる場所を優先して探す */
function searchHideSpots(w: World, u: UnitState): boolean {
  const checkR2 = 2 * ONE * 2 * ONE;
  let best = -1;
  let bestD = Infinity;
  for (const s of w.hideSpots) {
    if (u.checkedSpots.has(s)) continue;
    const sx = s % MAP_W;
    const sz = (s - sx) / MAP_W;
    const cx = tileCenter(sx);
    const cz = tileCenter(sz);
    const d = dist2(u.x, u.z, cx, cz);
    if (d <= checkR2) {
      u.checkedSpots.add(s);
      continue;
    }
    // 自陣側は探さない
    if (inDeployZone(u.side, sx, sz)) continue;
    if (u.side === 0 ? sz < 8 : sz > MAP_H - 9) continue;
    if (d < bestD) {
      best = s;
      bestD = d;
    }
  }
  if (best < 0) return false;
  const bx = best % MAP_W;
  const bz = (best - bx) / MAP_W;
  moveToward(w, u, tileCenter(bx), tileCenter(bz));
  // 何度も到達できない場所は諦める
  if (!u.moving) u.checkedSpots.add(best);
  return true;
}

function attackNearbyFence(w: World, u: UnitState): boolean {
  let best: ObstacleState | null = null;
  let bestD = Infinity;
  for (const o of w.obstacles) {
    if (!o.alive || o.type !== 'fence' || o.side === u.side) continue;
    const ox = tileCenter(o.tx);
    const oz = tileCenter(o.tz);
    const r = rangeOf(w, u, ox, oz);
    const d = dist2(u.x, u.z, ox, oz);
    if (d <= r * r && d < bestD) {
      best = o;
      bestD = d;
    }
  }
  if (!best) return false;
  face(u, tileCenter(best.tx), tileCenter(best.tz));
  if (u.cooldown === 0) attackObstacle(w, u, best);
  return true;
}

// ---------------------------------------------------------------- 移動

function speedOf(w: World, u: UnitState): number {
  const ti = tileIndexAt(u.x, u.z);
  const kind = w.terrain.kind[ti];
  let p = 100;
  if (kind === 'water') p = 50;
  else if (kind === 'shallow') p = 70;
  else if (w.terrain.slope[ti]) p = 65;
  const o = w.obstacleAt[ti] >= 0 ? w.obstacles[w.obstacleAt[ti]] : null;
  if (o && o.alive && o.type === 'moat' && o.side !== u.side) p = Math.min(p, 50);
  let s = pct(u.def.speed, p);
  if (w.aura[u.id]) s = pct(s, AURA_SPEED_PCT);
  return Math.max(1, s);
}

function face(u: UnitState, tx: number, tz: number): void {
  const dx = tx - u.x;
  const dz = tz - u.z;
  if (dx !== 0 || dz !== 0) {
    u.dirX = dx;
    u.dirZ = dz;
  }
}

function tryMove(w: World, u: UnitState, nx: number, nz: number): boolean {
  if (!isSolid(w, tileOf(nx), tileOf(nz))) {
    u.x = nx;
    u.z = nz;
    return true;
  }
  if (!isSolid(w, tileOf(nx), tileOf(u.z))) {
    u.x = nx;
    return true;
  }
  if (!isSolid(w, tileOf(u.x), tileOf(nz))) {
    u.z = nz;
    return true;
  }
  return false;
}

function stepToward(w: World, u: UnitState, gx: number, gz: number): void {
  const dx = gx - u.x;
  const dz = gz - u.z;
  const d = isqrt(dx * dx + dz * dz);
  if (d === 0) return;
  const sp = speedOf(w, u);
  let nx = gx;
  let nz = gz;
  if (d > sp) {
    nx = u.x + Math.trunc((dx * sp) / d);
    nz = u.z + Math.trunc((dz * sp) / d);
  }
  face(u, gx, gz);
  if (tryMove(w, u, nx, nz)) u.moving = true;
}

/** 直線で歩いて行けるか */
function straightClear(w: World, u: UnitState, gx: number, gz: number): boolean {
  const d = dist(u.x, u.z, gx, gz);
  if (d > DIRECT_MOVE_MAX) return false;
  const n = Math.max(1, Math.trunc(d / 300));
  for (let i = 1; i <= n; i++) {
    const px = u.x + Math.trunc(((gx - u.x) * i) / n);
    const pz = u.z + Math.trunc(((gz - u.z) * i) / n);
    if (isSolid(w, tileOf(px), tileOf(pz))) return false;
  }
  return true;
}

function moveToward(
  w: World, u: UnitState, gx: number, gz: number,
  isGoal?: (x: number, z: number) => boolean,
): void {
  if (!isGoal && straightClear(w, u, gx, gz)) {
    u.path = [];
    stepToward(w, u, gx, gz);
    return;
  }
  const gtx = clamp(tileOf(gx), 0, MAP_W - 1);
  const gtz = clamp(tileOf(gz), 0, MAP_H - 1);
  const goal = idx(gtx, gtz);
  if (u.pathGoal !== goal || u.pathVersion !== w.obstacleVersion || w.tick >= u.repathAt || u.path.length === 0) {
    const cost = w.moveCost[u.side];
    u.path = findPath(
      clamp(tileOf(u.x), 0, MAP_W - 1), clamp(tileOf(u.z), 0, MAP_H - 1),
      gtx, gtz,
      (x, z) => cost[idx(x, z)],
      isGoal,
    );
    u.pathGoal = goal;
    u.pathVersion = w.obstacleVersion;
    u.repathAt = w.tick + REPATH_INTERVAL;
  }
  while (u.path.length > 0) {
    const next = u.path[0];
    const nx = next % MAP_W;
    const nz = (next - nx) / MAP_W;
    if (dist2(u.x, u.z, tileCenter(nx), tileCenter(nz)) <= WAYPOINT_REACHED * WAYPOINT_REACHED) {
      u.path.shift();
      continue;
    }
    // 経路上の敵の柵は壊して進む
    const o = obstacleAtTile(w, nx, nz);
    if (o && o.alive && o.type === 'fence') {
      if (o.side !== u.side) {
        const ox = tileCenter(nx);
        const oz = tileCenter(nz);
        const r = u.def.range + 300;
        if (dist2(u.x, u.z, ox, oz) <= r * r) {
          face(u, ox, oz);
          if (u.cooldown === 0) attackObstacle(w, u, o);
          return;
        }
      } else {
        u.repathAt = w.tick;
        return;
      }
    }
    stepToward(w, u, tileCenter(nx), tileCenter(nz));
    return;
  }
  if (!isGoal) stepToward(w, u, gx, gz);
}

/** ユニット同士が重ならないように押し合う */
function separate(w: World): void {
  const minD = UNIT_RADIUS * 2;
  const us = w.units;
  for (let i = 0; i < us.length; i++) {
    const a = us[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < us.length; j++) {
      const b = us[j];
      if (!b.alive) continue;
      let dx = b.x - a.x;
      let dz = b.z - a.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= minD * minD) continue;
      let d = isqrt(d2);
      if (d === 0) {
        dx = (a.id + b.id + w.tick) % 2 === 0 ? 1 : -1;
        dz = (a.id * 7 + b.id) % 2 === 0 ? 1 : -1;
        d = 1;
      }
      const push = Math.trunc((minD - d) / 4) + 1;
      const px = Math.trunc((dx * push) / d);
      const pz = Math.trunc((dz * push) / d);
      // 待ち伏せ中の潜伏兵と大ハブは押されにくい
      const aHeavy = a.ambushArmed || a.type === 'greatHabu';
      const bHeavy = b.ambushArmed || b.type === 'greatHabu';
      if (!aHeavy) {
        const ax = a.x - (bHeavy ? 2 * px : px);
        const az = a.z - (bHeavy ? 2 * pz : pz);
        if (!isSolid(w, tileOf(ax), tileOf(az))) {
          a.x = ax;
          a.z = az;
        }
      }
      if (!bHeavy) {
        const bx = b.x + (aHeavy ? 2 * px : px);
        const bz = b.z + (aHeavy ? 2 * pz : pz);
        if (!isSolid(w, tileOf(bx), tileOf(bz))) {
          b.x = bx;
          b.z = bz;
        }
      }
    }
  }
}

// ---------------------------------------------------------------- 攻撃

function unitDamage(w: World, att: UnitState, t: UnitState, primary: boolean): { damage: number; bonus: string | null } {
  let dmg = att.def.attack;
  let bonus: string | null = null;
  if (w.aura[att.id]) dmg = pct(dmg, AURA_ATTACK_PCT);
  if (heightAt(w, att.x, att.z) > heightAt(w, t.x, t.z)) dmg = pct(dmg, HIGH_GROUND_ATTACK_PCT);
  if (w.terrain.kind[tileIndexAt(t.x, t.z)] === 'water') dmg = pct(dmg, WATER_DAMAGE_TAKEN_PCT);
  if (primary && att.type === 'charger' && !att.hasAttacked) {
    dmg = pct(dmg, CHARGE_MULT_PCT);
    bonus = '突進';
  }
  if (primary && att.type === 'lurker' && w.concealed[att.id] && att.revealTicks === 0) {
    dmg = pct(dmg, AMBUSH_MULT_PCT);
    bonus = '奇襲';
  }
  return { damage: dmg, bonus };
}

function dealDamage(w: World, u: UnitState, dmg: number): void {
  if (!u.alive || dmg <= 0) return;
  u.hp -= dmg;
  if (u.hp <= 0) {
    u.hp = 0;
    u.alive = false;
    u.path = [];
    w.lostCost[u.side] += u.def.cost;
    w.events.push({ t: 'death', unit: u.id });
  }
}

function applyPoison(u: UnitState, p: { dps: number; sec: number }): void {
  if (!u.alive) return;
  u.poisonDps = Math.max(u.poisonDps, p.dps);
  u.poisonTicks = p.sec * TICKS_PER_SECOND;
}

function afterAttack(att: UnitState): void {
  att.hasAttacked = true;
  att.revealTicks = REVEAL_AFTER_ATTACK_TICKS;
  att.cooldown = att.def.cooldown;
}

function styleOf(u: UnitState): 'melee' | 'stone' | 'spit' {
  if (u.type === 'slinger') return 'stone';
  if (u.type === 'spitter') return 'spit';
  return 'melee';
}

function attackUnit(w: World, att: UnitState, t: UnitState): void {
  const { damage, bonus } = unitDamage(w, att, t, true);
  const ev: BattleEvent = {
    t: 'attack', attacker: att.id, target: { kind: 'unit', id: t.id },
    x: att.x, z: att.z, tx: t.x, tz: t.z, style: styleOf(att), damage, bonus,
  };
  w.events.push(ev);
  if (att.def.splash) {
    const r2 = att.def.splash * att.def.splash;
    const cx = t.x;
    const cz = t.z;
    for (const v of w.units) {
      if (!v.alive || v.side === att.side || dist2(v.x, v.z, cx, cz) > r2) continue;
      const dmg = v === t ? damage : unitDamage(w, att, v, false).damage;
      dealDamage(w, v, dmg);
      if (att.def.poison) applyPoison(v, att.def.poison);
    }
  } else {
    dealDamage(w, t, damage);
    if (att.def.poison) applyPoison(t, att.def.poison);
  }
  afterAttack(att);
}

function attackObstacle(w: World, att: UnitState, o: ObstacleState): void {
  let dmg = att.def.attack;
  if (w.aura[att.id]) dmg = pct(dmg, AURA_ATTACK_PCT);
  if (att.type === 'slinger') dmg = pct(dmg, SLINGER_FENCE_MULT_PCT);
  const ox = tileCenter(o.tx);
  const oz = tileCenter(o.tz);
  w.events.push({
    t: 'attack', attacker: att.id, target: { kind: 'obstacle', id: o.id },
    x: att.x, z: att.z, tx: ox, tz: oz, style: styleOf(att), damage: dmg, bonus: null,
  });
  o.hp -= dmg;
  if (o.hp <= 0) {
    o.hp = 0;
    o.alive = false;
    w.obstacleAt[idx(o.tx, o.tz)] = -1;
    w.obstacleVersion++;
    rebuildMoveCost(w);
    w.events.push({ t: 'obstacleDestroyed', obstacle: o.id });
  }
  afterAttack(att);
}

function attackBase(w: World, att: UnitState, b: BaseState): void {
  let dmg = att.def.attack;
  if (w.aura[att.id]) dmg = pct(dmg, AURA_ATTACK_PCT);
  const tx = clamp(att.x, b.x0, b.x1);
  const tz = clamp(att.z, b.z0, b.z1);
  w.events.push({
    t: 'attack', attacker: att.id, target: { kind: 'base', side: b.side },
    x: att.x, z: att.z, tx, tz, style: styleOf(att), damage: dmg, bonus: null,
  });
  b.hp = Math.max(0, b.hp - dmg);
  afterAttack(att);
}

// ---------------------------------------------------------------- 勝敗判定

/** 損耗率 = 失った兵のコスト合計 ÷ 開始時の兵のコスト合計（‰、表示用） */
export function lossRatePermille(lost: number, start: number): number {
  return start === 0 ? 0 : Math.trunc((lost * 1000) / start);
}

/**
 * 時間切れ（または両拠点が同時に0）の判定：残り耐久値、損耗率の順に比べる。
 * 損耗率は割り算せず、交差乗算で比べる。
 */
export function judge(baseHp: [number, number], lostCost: [number, number], startCost: [number, number]): { winner: Side | null; decidedBy: DecidedBy } {
  if (baseHp[0] !== baseHp[1]) return { winner: baseHp[0] > baseHp[1] ? 0 : 1, decidedBy: 'baseHp' };
  const r0 = lostCost[0] * startCost[1];
  const r1 = lostCost[1] * startCost[0];
  if (r0 !== r1) return { winner: r0 < r1 ? 0 : 1, decidedBy: 'lossRate' };
  return { winner: null, decidedBy: 'draw' };
}

function finish(w: World, winner: Side | null, reason: ResultReason, decidedBy: DecidedBy): void {
  w.result = {
    winner, reason, decidedBy, tick: w.tick,
    baseHp: [w.bases[0].hp, w.bases[1].hp],
    lostCost: [w.lostCost[0], w.lostCost[1]],
    startCost: [w.startCost[0], w.startCost[1]],
  };
}

function checkResult(w: World): void {
  const down0 = w.bases[0].hp <= 0;
  const down1 = w.bases[1].hp <= 0;
  const judgeAs = (reason: ResultReason) => {
    const j = judge([w.bases[0].hp, w.bases[1].hp], w.lostCost, w.startCost);
    finish(w, j.winner, reason, j.decidedBy);
  };
  if (down0 && down1) return judgeAs('bothBases');
  if (down0) return finish(w, 1, 'base', 'base');
  if (down1) return finish(w, 0, 'base', 'base');
  if (w.tick >= BATTLE_TIME_LIMIT_TICKS) return judgeAs('timeout');
  if (!w.units.some((u) => u.alive)) return judgeAs('noUnits');
}
