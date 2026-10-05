// 盤面の表示：配置中のユニット、戦闘中のユニット・障害物・拠点・エフェクト。
// シミュレーションの状態を読むだけで、書き換えない。

import * as THREE from 'three';
import { BASE_SIZE, BASE_TX, BASE_TZ, TICKS_PER_SECOND } from '../sim/config';
import type { Faction, Side } from '../sim/defs';
import { ONE } from '../sim/fixed';
import type { PlacementItem } from '../sim/placement';
import type { BattleEvent, World } from '../sim/world';
import { createBaseModel, createHpBar, createObstacleModel, createUnitModel, setHpBar } from './models';
import { tileTopY, toWorldX, toWorldZ, type Stage } from './stage';

interface UnitView {
  root: THREE.Group;
  model: THREE.Group;
  hp: THREE.Group;
  materials: THREE.MeshStandardMaterial[];
  y: number;
  yaw: number;
  lunge: number;
  lungeDir: THREE.Vector3;
  deadAt: number;
  opacity: number;
}

interface Effect {
  obj: THREE.Object3D;
  age: number;
  dur: number;
  step: (e: Effect, k: number) => void;
}

const STANCE_LABEL = { advance: '前', hold: '待', defend: '守' } as const;

function cloneMaterials(g: THREE.Object3D): THREE.MeshStandardMaterial[] {
  const out: THREE.MeshStandardMaterial[] = [];
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.material instanceof THREE.MeshStandardMaterial) {
      const c = m.material.clone();
      c.transparent = true;
      m.material = c;
      out.push(c);
    }
  });
  return out;
}

/** エフェクト用に毎回作ったジオメトリとマテリアルを解放する */
function disposeEffect(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    } else if ((o as THREE.Sprite).isSprite) {
      (o as THREE.Sprite).material.dispose();
    }
  });
}

const textCache = new Map<string, THREE.SpriteMaterial>();
function textSprite(text: string, color: string, scale = 0.6): THREE.Sprite {
  const key = `${text}|${color}`;
  let m = textCache.get(key);
  if (!m) {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 96;
    const ctx = c.getContext('2d')!;
    ctx.font = 'bold 56px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 10;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(text, 128, 48);
    ctx.fillStyle = color;
    ctx.fillText(text, 128, 48);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    m = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
    textCache.set(key, m);
  }
  const s = new THREE.Sprite(m.clone());
  s.scale.set(scale * 2.67, scale, 1);
  s.renderOrder = 20;
  return s;
}

export class BoardView {
  private root = new THREE.Group();
  private placementGroup = new THREE.Group();
  private ghost: THREE.Group | null = null;
  private ghostKey = '';
  private baseGroups: THREE.Group[] = [];
  private baseBars: THREE.Group[] = [];
  private baseShake = [0, 0];
  private world: World | null = null;
  private viewer: Side | null = null;
  private units: UnitView[] = [];
  private obstacles: THREE.Group[] = [];
  private obstacleFall: number[] = [];
  private effects: Effect[] = [];
  private time = 0;

  constructor(private stage: Stage) {
    stage.scene.add(this.root);
    this.root.add(this.placementGroup);
  }

  private get terrain() {
    return this.stage.terrain!;
  }

  private groundY(x: number, z: number): number {
    const t = this.terrain;
    const tx = Math.min(t.w - 1, Math.max(0, Math.floor(x)));
    const tz = Math.min(t.h - 1, Math.max(0, Math.floor(z)));
    return tileTopY(t, tx, tz);
  }

  clear(): void {
    this.root.clear();
    this.placementGroup = new THREE.Group();
    this.root.add(this.placementGroup);
    this.ghost = null;
    this.ghostKey = '';
    this.baseGroups = [];
    this.baseBars = [];
    this.world = null;
    this.units = [];
    this.obstacles = [];
    this.effects = [];
  }

  setBases(factions: [Faction, Faction]): void {
    for (const side of [0, 1] as const) {
      const g = createBaseModel(factions[side]);
      const cx = BASE_TX + BASE_SIZE / 2;
      const cz = BASE_TZ[side] + BASE_SIZE / 2;
      g.position.set(toWorldX(cx), this.groundY(cx, cz), toWorldZ(cz));
      g.rotation.y = side === 0 ? 0 : Math.PI;
      const bar = createHpBar(1.6);
      bar.position.set(0, 2.1, 0);
      bar.visible = false;
      g.add(bar);
      this.root.add(g);
      this.baseGroups.push(g);
      this.baseBars.push(bar);
    }
  }

  // ------------------------------------------------------------ 配置フェーズ

  setPlacement(faction: Faction, items: readonly PlacementItem[], selected: number): void {
    this.placementGroup.clear();
    items.forEach((it, i) => {
      const g = it.kind === 'unit' ? createUnitModel(faction, it.type) : createObstacleModel(it.type, faction);
      const y = tileTopY(this.terrain, it.tx, it.tz);
      g.position.set(toWorldX(it.tx + 0.5), y + (it.kind === 'unit' ? 0.02 : 0), toWorldZ(it.tz + 0.5));
      g.rotation.y = it.tz > this.terrain.h / 2 ? Math.PI : 0;
      if (it.kind === 'unit') {
        const label = textSprite(STANCE_LABEL[it.stance], '#ffffff', 0.32);
        label.position.set(0, (0.75 * g.scale.y + 0.25) / g.scale.y, 0);
        label.scale.divideScalar(g.scale.x);
        g.add(label);
      }
      if (i === selected) {
        const sel = new THREE.Mesh(
          new THREE.RingGeometry(0.36, 0.46, 24).rotateX(-Math.PI / 2),
          new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false }),
        );
        sel.position.y = 0.03;
        sel.scale.setScalar(1 / g.scale.x);
        sel.name = 'selection';
        g.add(sel);
      }
      this.placementGroup.add(g);
    });
  }

  setGhost(faction: Faction, item: PlacementItem | null, valid: boolean): void {
    const key = item ? `${item.kind}:${item.type}:${faction}` : '';
    if (key !== this.ghostKey) {
      if (this.ghost) this.root.remove(this.ghost);
      this.ghost = null;
      this.ghostKey = key;
      if (item) {
        this.ghost = item.kind === 'unit' ? createUnitModel(faction, item.type) : createObstacleModel(item.type, faction);
        cloneMaterials(this.ghost).forEach((m) => (m.opacity = 0.55));
        this.root.add(this.ghost);
      }
    }
    if (this.ghost && item) {
      this.ghost.position.set(toWorldX(item.tx + 0.5), tileTopY(this.terrain, item.tx, item.tz) + 0.02, toWorldZ(item.tz + 0.5));
      this.ghost.rotation.y = this.stage.side === 1 ? Math.PI : 0;
      this.ghost.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (m instanceof THREE.MeshStandardMaterial) m.emissive.setHex(valid ? 0x103010 : 0x601010);
      });
    }
  }

  // ------------------------------------------------------------ 実戦フェーズ

  /** viewer：この陣営から見えない敵は隠す（null なら全員表示） */
  attachWorld(world: World, viewer: Side | null): void {
    this.placementGroup.clear();
    this.setGhost('mongoose', null, false);
    for (const g of this.obstacles) this.root.remove(g);
    for (const u of this.units) this.root.remove(u.root);
    this.world = world;
    this.viewer = viewer;
    this.effects = [];
    this.units = world.units.map((u) => {
      const root = new THREE.Group();
      const model = createUnitModel(world.factions[u.side], u.type);
      const materials = cloneMaterials(model);
      root.add(model);
      const hp = createHpBar(0.5);
      hp.position.y = 0.75 * model.scale.y + 0.15;
      root.add(hp);
      const x = u.x / ONE;
      const z = u.z / ONE;
      const y = this.groundY(x, z);
      root.position.set(toWorldX(x), y, toWorldZ(z));
      const yaw = Math.atan2(u.dirX, u.dirZ);
      root.rotation.y = yaw;
      this.root.add(root);
      return { root, model, hp, materials, y, yaw, lunge: 0, lungeDir: new THREE.Vector3(), deadAt: -1, opacity: 1 };
    });
    this.obstacles = world.obstacles.map((o) => {
      const g = createObstacleModel(o.type, world.factions[o.side]);
      g.position.set(toWorldX(o.tx + 0.5), tileTopY(this.terrain, o.tx, o.tz), toWorldZ(o.tz + 0.5));
      g.rotation.y = o.side === 1 ? Math.PI : 0;
      this.root.add(g);
      return g;
    });
    this.obstacleFall = world.obstacles.map(() => -1);
    for (const bar of this.baseBars) bar.visible = true;
  }

  /** 1tickぶんのイベントを演出に変換する */
  handleEvents(events: readonly BattleEvent[]): void {
    const w = this.world;
    if (!w) return;
    for (const e of events) {
      switch (e.t) {
        case 'attack': {
          const from = new THREE.Vector3(toWorldX(e.x / ONE), this.groundY(e.x / ONE, e.z / ONE) + 0.4, toWorldZ(e.z / ONE));
          const to = new THREE.Vector3(toWorldX(e.tx / ONE), this.groundY(e.tx / ONE, e.tz / ONE) + 0.3, toWorldZ(e.tz / ONE));
          const view = this.units[e.attacker];
          if (e.style === 'melee') {
            view.lunge = 0.18;
            view.lungeDir.copy(to).sub(from).setY(0).normalize();
            this.spark(to, w.units[e.attacker].side === 0 ? 0xfff2c0 : 0xd0ffb0);
          } else {
            this.projectile(from, to, e.style);
          }
          if (e.bonus) this.floatText(e.bonus, e.bonus === '奇襲' ? '#c8ff60' : '#ffd040', to);
          if (e.target.kind === 'base') this.baseShake[e.target.side] = 0.25;
          break;
        }
        case 'death':
          this.units[e.unit].deadAt = this.time;
          break;
        case 'obstacleDestroyed':
          this.obstacleFall[e.obstacle] = this.time;
          break;
        case 'revealed': {
          const u = w.units[e.unit];
          if (this.viewer === null || u.side !== this.viewer) {
            const p = new THREE.Vector3(toWorldX(u.x / ONE), this.groundY(u.x / ONE, u.z / ONE) + 0.9, toWorldZ(u.z / ONE));
            this.floatText('発見', '#ffe060', p);
          }
          break;
        }
      }
    }
  }

  /** alpha：前tickと現tickの間の補間係数 */
  update(dt: number, alpha: number): void {
    this.time += dt;
    const w = this.world;
    if (w) this.updateUnits(w, dt, alpha);
    this.updateEffects(dt);
    const camQ = this.stage.camera.quaternion;
    for (let s = 0; s < this.baseGroups.length; s++) {
      const g = this.baseGroups[s];
      const bar = this.baseBars[s];
      bar.quaternion.copy(g.quaternion).invert().multiply(camQ);
      if (w) setHpBar(bar, w.bases[s].hp / w.bases[s].maxHp);
      const flag = g.getObjectByName('flag');
      if (flag) flag.rotation.y = Math.sin(this.time * 3 + s) * 0.3;
      if (this.baseShake[s] > 0) {
        this.baseShake[s] = Math.max(0, this.baseShake[s] - dt);
        g.children[0].position.x = Math.sin(this.time * 80) * 0.04 * (this.baseShake[s] / 0.25);
      }
    }
    // 配置中のユニットは足踏み
    for (const g of this.placementGroup.children) {
      const sel = g.getObjectByName('selection');
      if (sel) sel.rotation.y = this.time * 2;
    }
  }

  private updateUnits(w: World, dt: number, alpha: number): void {
    const camQ = this.stage.camera.quaternion;
    for (const u of w.units) {
      const v = this.units[u.id];
      if (v.deadAt >= 0) {
        // 倒れて消える
        const k = (this.time - v.deadAt) / 1.2;
        if (k >= 1) {
          v.root.visible = false;
          continue;
        }
        v.model.rotation.z = Math.min(1, k * 3) * 1.4;
        v.root.position.y = v.y - k * 0.3;
        for (const m of v.materials) m.opacity = 1 - k;
        v.hp.visible = false;
        continue;
      }
      const x = (u.prevX + (u.x - u.prevX) * alpha) / ONE;
      const z = (u.prevZ + (u.z - u.prevZ) * alpha) / ONE;
      const targetY = this.groundY(x, z);
      v.y += (targetY - v.y) * Math.min(1, dt * 10);
      let bob = 0;
      if (u.moving) bob = Math.abs(Math.sin(this.time * 14 + u.id)) * 0.05;
      v.root.position.set(toWorldX(x), v.y + bob, toWorldZ(z));
      if (v.lunge > 0) {
        v.lunge = Math.max(0, v.lunge - dt);
        const k = Math.sin((v.lunge / 0.18) * Math.PI) * 0.18;
        v.root.position.addScaledVector(v.lungeDir, k);
      }
      const yaw = Math.atan2(u.dirX, u.dirZ);
      let d = yaw - v.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      v.yaw += d * Math.min(1, dt * 10);
      v.model.rotation.y = v.yaw;

      // 見え方：敵から見えない潜伏中のユニット
      const hiddenFromViewer = this.viewer !== null && u.side !== this.viewer && !w.visibleTo[this.viewer][u.id];
      const concealed = w.concealed[u.id] === 1 && u.revealTicks === 0;
      const targetOpacity = hiddenFromViewer ? 0 : concealed ? 0.45 : 1;
      v.opacity += (targetOpacity - v.opacity) * Math.min(1, dt * 6);
      v.root.visible = v.opacity > 0.02;
      const poisoned = u.poisonTicks > 0;
      const pulse = poisoned ? 0.25 + 0.2 * Math.sin(this.time * 8) : 0;
      for (const m of v.materials) {
        m.opacity = v.opacity;
        m.emissive.setRGB(pulse * 0.3, pulse, pulse * 0.2);
      }
      v.hp.visible = u.hp < u.maxHp;
      v.hp.quaternion.copy(camQ);
      setHpBar(v.hp, u.hp / u.maxHp);
    }
    for (let i = 0; i < this.obstacles.length; i++) {
      const t0 = this.obstacleFall[i];
      if (t0 < 0) continue;
      const g = this.obstacles[i];
      const k = (this.time - t0) / 0.8;
      if (k >= 1) {
        g.visible = false;
        continue;
      }
      g.rotation.x = k * 1.3;
      g.position.y -= dt * 0.3;
    }
  }

  private add(obj: THREE.Object3D, dur: number, step: Effect['step']): void {
    this.root.add(obj);
    this.effects.push({ obj, age: 0, dur, step });
  }

  private updateEffects(dt: number): void {
    const keep: Effect[] = [];
    for (const e of this.effects) {
      e.age += dt;
      const k = Math.min(1, e.age / e.dur);
      e.step(e, k);
      if (k >= 1) {
        this.root.remove(e.obj);
        disposeEffect(e.obj);
      } else keep.push(e);
    }
    this.effects = keep;
  }

  private projectile(from: THREE.Vector3, to: THREE.Vector3, style: 'stone' | 'spit'): void {
    const geo = style === 'stone' ? new THREE.DodecahedronGeometry(0.07) : new THREE.SphereGeometry(0.09, 6, 4);
    const m = new THREE.MeshStandardMaterial({
      color: style === 'stone' ? 0x8d8a83 : 0x7be04a,
      emissive: style === 'stone' ? 0 : 0x2a6010,
      flatShading: true,
    });
    const obj = new THREE.Mesh(geo, m);
    const distance = from.distanceTo(to);
    const dur = Math.min(0.55, Math.max(0.18, distance / 10));
    const arc = 0.3 + distance * 0.12;
    this.add(obj, dur, (_e, k) => {
      obj.position.lerpVectors(from, to, k);
      obj.position.y += Math.sin(k * Math.PI) * arc;
      obj.rotation.x += 0.3;
      if (k >= 1 && style === 'spit') this.splash(to);
      if (k >= 1 && style === 'stone') this.spark(to, 0xd8d0c0);
    });
  }

  private splash(at: THREE.Vector3): void {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.6, 1.0, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x7be04a, transparent: true, opacity: 0.6, depthWrite: false }),
    );
    ring.position.set(at.x, at.y - 0.25, at.z);
    this.add(ring, 0.5, (_e, k) => {
      ring.scale.setScalar(0.3 + k * 0.8);
      (ring.material as THREE.MeshBasicMaterial).opacity = 0.6 * (1 - k);
    });
  }

  private spark(at: THREE.Vector3, color: number): void {
    const s = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.12),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }),
    );
    s.position.copy(at);
    this.add(s, 0.2, (_e, k) => {
      s.scale.setScalar(0.5 + k * 1.5);
      (s.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - k);
    });
  }

  private floatText(text: string, color: string, at: THREE.Vector3): void {
    const s = textSprite(text, color, 0.45);
    s.position.copy(at);
    const y0 = at.y + 0.3;
    this.add(s, 1.0, (_e, k) => {
      s.position.y = y0 + k * 0.6;
      s.material.opacity = 1 - k * k;
    });
  }

  /** 1tickの長さ（秒） */
  static readonly TICK_SEC = 1 / TICKS_PER_SECOND;
}
