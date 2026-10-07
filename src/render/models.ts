// ローポリゴンのモデル。ジオメトリとマテリアルは共有して描画負荷を抑える。

import * as THREE from 'three';
import type { Faction, ObstacleType, UnitType } from '../sim/defs';

const geoCache = new Map<string, THREE.BufferGeometry>();
const matCache = new Map<string, THREE.Material>();

function geo<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    geoCache.set(key, g);
  }
  return g as T;
}

/** 共有マテリアル。ユニットごとに色を変えたいときは clone して使う。 */
export function mat(color: number, opts: { flat?: boolean; emissive?: number; transparent?: boolean; opacity?: number } = {}): THREE.MeshStandardMaterial {
  const key = `${color}:${opts.flat ?? true}:${opts.emissive ?? 0}:${opts.transparent ?? false}:${opts.opacity ?? 1}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      flatShading: opts.flat ?? true,
      roughness: 0.85,
      metalness: 0.05,
      emissive: opts.emissive ?? 0,
      transparent: opts.transparent ?? false,
      opacity: opts.opacity ?? 1,
    });
    matCache.set(key, m);
  }
  return m as THREE.MeshStandardMaterial;
}

function mesh(g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  o.castShadow = true;
  return o;
}

export const COLORS = {
  mongooseFur: 0xc9a46a,
  mongooseFurDark: 0x8a6237,
  mongooseScarf: 0xd8342c,
  habuScale: 0x5d6b3a,
  habuScaleDark: 0x3a4526,
  habuGold: 0xd9b23a,
  habuBelly: 0xc8c08a,
  wood: 0x9b6b3d,
  woodDark: 0x5a3c22,
  stone: 0x8d8a83,
  white: 0xf4efe6,
  black: 0x1e1a16,
} as const;

export const FACTION_COLOR: Record<Faction, number> = {
  mongoose: COLORS.mongooseScarf,
  habu: COLORS.habuGold,
};

// ---------------------------------------------------------------- マングース

function mongoose(type: UnitType): THREE.Group {
  const g = new THREE.Group();
  const leader = type === 'packLeader';
  const fur = mat(leader ? COLORS.mongooseFurDark : COLORS.mongooseFur);
  const furDark = mat(COLORS.mongooseFurDark);
  const body = mesh(geo('m-body', () => new THREE.CapsuleGeometry(0.13, 0.2, 3, 7)), fur, 0, 0.27, 0);
  g.add(body);
  const head = mesh(geo('m-head', () => new THREE.SphereGeometry(0.11, 7, 5)), fur, 0, 0.53, 0.03);
  g.add(head);
  const snout = mesh(geo('m-snout', () => new THREE.ConeGeometry(0.05, 0.12, 5).rotateX(Math.PI / 2)), fur, 0, 0.51, 0.15);
  g.add(snout);
  g.add(mesh(geo('m-nose', () => new THREE.SphereGeometry(0.022, 4, 3)), mat(COLORS.black), 0, 0.51, 0.215));
  const earSize = type === 'scout' ? 0.055 : 0.035;
  const earG = geo(`m-ear-${earSize}`, () => new THREE.SphereGeometry(earSize, 5, 4));
  g.add(mesh(earG, furDark, -0.08, 0.62, 0.0));
  g.add(mesh(earG, furDark, 0.08, 0.62, 0.0));
  const eyeG = geo('m-eye', () => new THREE.SphereGeometry(0.018, 4, 3));
  g.add(mesh(eyeG, mat(COLORS.black), -0.045, 0.56, 0.1));
  g.add(mesh(eyeG, mat(COLORS.black), 0.045, 0.56, 0.1));
  const tail = mesh(geo('m-tail', () => new THREE.ConeGeometry(0.06, 0.42, 6).rotateX(-Math.PI / 2.6)), furDark, 0, 0.12, -0.24);
  g.add(tail);
  const scarf = mesh(geo('m-scarf', () => new THREE.TorusGeometry(0.1, 0.035, 5, 10).rotateX(Math.PI / 2)), mat(COLORS.mongooseScarf), 0, 0.43, 0);
  g.add(scarf);
  const legG = geo('m-leg', () => new THREE.CylinderGeometry(0.035, 0.04, 0.14, 5));
  g.add(mesh(legG, furDark, -0.06, 0.07, 0));
  g.add(mesh(legG, furDark, 0.06, 0.07, 0));

  switch (type) {
    case 'charger': {
      const sword = mesh(geo('m-sword', () => new THREE.BoxGeometry(0.035, 0.32, 0.05)), mat(COLORS.wood), 0.17, 0.33, 0.1);
      sword.rotation.x = 0.6;
      g.add(sword);
      break;
    }
    case 'slinger': {
      g.add(mesh(geo('m-pouch', () => new THREE.SphereGeometry(0.06, 5, 4)), mat(COLORS.woodDark), 0.14, 0.22, 0.02));
      g.add(mesh(geo('m-stone', () => new THREE.DodecahedronGeometry(0.035)), mat(COLORS.stone), -0.16, 0.38, 0.06));
      break;
    }
    case 'scout': {
      g.scale.set(0.85, 1, 0.85);
      break;
    }
    case 'packLeader': {
      g.scale.setScalar(1.3);
      const staff = mesh(geo('m-staff', () => new THREE.CylinderGeometry(0.02, 0.02, 0.6, 5)), mat(COLORS.woodDark), 0.17, 0.3, 0.05);
      g.add(staff);
      g.add(mesh(geo('m-scar', () => new THREE.BoxGeometry(0.012, 0.08, 0.02)), mat(0xf2d0b0), 0.04, 0.56, 0.1));
      break;
    }
  }
  return g;
}

// ---------------------------------------------------------------- ハブ

function habu(type: UnitType): THREE.Group {
  const g = new THREE.Group();
  const scaleColor = type === 'lurker' ? COLORS.habuScaleDark : COLORS.habuScale;
  const skin = mat(scaleColor);
  const gold = mat(COLORS.habuGold);
  // とぐろ
  const coil = mesh(geo('h-coil', () => new THREE.TorusGeometry(0.17, 0.075, 6, 14).rotateX(Math.PI / 2)), skin, 0, 0.075, -0.03);
  g.add(coil);
  const coil2 = mesh(geo('h-coil2', () => new THREE.TorusGeometry(0.1, 0.065, 6, 12).rotateX(Math.PI / 2)), skin, 0, 0.18, -0.03);
  g.add(coil2);
  // 首から頭
  const neckCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.2, -0.03),
    new THREE.Vector3(0, 0.36, 0.0),
    new THREE.Vector3(0, 0.48, 0.07),
  ]);
  const neck = mesh(geo('h-neck', () => new THREE.TubeGeometry(neckCurve, 6, 0.055, 6)), skin);
  g.add(neck);
  const head = mesh(geo('h-head', () => new THREE.SphereGeometry(0.085, 7, 5).scale(1, 0.7, 1.5)), skin, 0, 0.5, 0.13);
  g.add(head);
  const eyeG = geo('h-eye', () => new THREE.SphereGeometry(0.02, 4, 3));
  g.add(mesh(eyeG, mat(0xf0d040, { emissive: 0x332200 }), -0.06, 0.53, 0.17));
  g.add(mesh(eyeG, mat(0xf0d040, { emissive: 0x332200 }), 0.06, 0.53, 0.17));
  // 金の模様
  const spotG = geo('h-spot', () => new THREE.BoxGeometry(0.05, 0.02, 0.05));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const s = mesh(spotG, gold, Math.cos(a) * 0.17, 0.14, Math.sin(a) * 0.17 - 0.03);
    s.rotation.y = -a;
    g.add(s);
  }
  // 祠の紋の首飾り
  g.add(mesh(geo('h-neck-ring', () => new THREE.TorusGeometry(0.065, 0.016, 4, 10).rotateX(Math.PI / 2.4)), gold, 0, 0.36, 0.0));

  switch (type) {
    case 'fang': {
      const fangG = geo('h-fang', () => new THREE.ConeGeometry(0.014, 0.06, 4).rotateX(Math.PI));
      g.add(mesh(fangG, mat(COLORS.white), -0.03, 0.44, 0.22));
      g.add(mesh(fangG, mat(COLORS.white), 0.03, 0.44, 0.22));
      break;
    }
    case 'spitter': {
      const crest = mesh(geo('h-crest', () => new THREE.ConeGeometry(0.05, 0.14, 4)), mat(0x7a3fa0), 0, 0.6, 0.08);
      crest.rotation.x = -0.4;
      g.add(crest);
      g.add(mesh(geo('h-sac', () => new THREE.SphereGeometry(0.045, 5, 4)), mat(0x6fd04a, { emissive: 0x1a4010 }), 0, 0.44, 0.18));
      break;
    }
    case 'lurker': {
      g.scale.set(1, 0.85, 1.05);
      break;
    }
    case 'greatHabu': {
      g.scale.setScalar(1.8);
      const horn = geo('h-horn', () => new THREE.ConeGeometry(0.02, 0.08, 4));
      g.add(mesh(horn, gold, -0.05, 0.58, 0.1));
      g.add(mesh(horn, gold, 0.05, 0.58, 0.1));
      break;
    }
  }
  return g;
}

export function createUnitModel(faction: Faction, type: UnitType): THREE.Group {
  const g = faction === 'mongoose' ? mongoose(type) : habu(type);
  g.scale.multiplyScalar(1.25);
  // 足元の陣営リング
  const ring = new THREE.Mesh(
    geo('ring', () => new THREE.RingGeometry(0.24, 0.3, 20).rotateX(-Math.PI / 2)),
    new THREE.MeshBasicMaterial({ color: FACTION_COLOR[faction], transparent: true, opacity: 0.85, depthWrite: false }),
  );
  ring.position.y = 0.02;
  ring.name = 'ring';
  ring.scale.setScalar(1 / g.scale.x);
  g.add(ring);
  return g;
}

// ---------------------------------------------------------------- 障害物

export function createObstacleModel(type: ObstacleType, faction: Faction): THREE.Group {
  const g = new THREE.Group();
  const tint = faction === 'mongoose';
  switch (type) {
    case 'fence': {
      const wood = mat(tint ? COLORS.wood : COLORS.woodDark);
      const postG = geo('f-post', () => new THREE.BoxGeometry(0.09, 0.55, 0.09));
      for (const x of [-0.38, 0, 0.38]) {
        const p = mesh(postG, wood, x, 0.27, 0);
        g.add(p);
        const tip = mesh(geo('f-tip', () => new THREE.ConeGeometry(0.065, 0.12, 4)), wood, x, 0.6, 0);
        g.add(tip);
      }
      const railG = geo('f-rail', () => new THREE.BoxGeometry(0.95, 0.07, 0.05));
      g.add(mesh(railG, wood, 0, 0.18, 0.05));
      g.add(mesh(railG, wood, 0, 0.4, 0.05));
      const mark = mesh(geo('f-mark', () => new THREE.BoxGeometry(0.12, 0.1, 0.02)), mat(tint ? COLORS.mongooseScarf : COLORS.habuGold), 0, 0.29, 0.08);
      g.add(mark);
      break;
    }
    case 'rock': {
      const r = mesh(geo('o-rock', () => new THREE.DodecahedronGeometry(0.42, 0).scale(1, 0.75, 0.9)), mat(tint ? COLORS.stone : 0x6f7a62), 0, 0.28, 0);
      r.rotation.y = 0.5;
      g.add(r);
      g.add(mesh(geo('o-rock2', () => new THREE.DodecahedronGeometry(0.2, 0)), mat(COLORS.stone), 0.3, 0.12, 0.25));
      break;
    }
    case 'moat': {
      const water = mesh(geo('o-moat', () => new THREE.BoxGeometry(0.96, 0.05, 0.96)), mat(0x2f5f7f, { emissive: 0x0a1a2a }), 0, 0.01, 0);
      water.castShadow = false;
      g.add(water);
      const edgeG = geo('o-moat-edge', () => new THREE.BoxGeometry(1, 0.06, 0.06));
      const edgeM = mat(tint ? COLORS.wood : COLORS.woodDark);
      g.add(mesh(edgeG, edgeM, 0, 0.04, 0.47));
      g.add(mesh(edgeG, edgeM, 0, 0.04, -0.47));
      break;
    }
    case 'grass': {
      const bladeG = geo('o-blade', () => new THREE.ConeGeometry(0.07, 0.5, 4));
      const m1 = mat(0x4f8a3a);
      const m2 = mat(0x6aa046);
      for (let i = 0; i < 9; i++) {
        const a = i * 2.39996;
        const r = 0.12 + (i % 3) * 0.12;
        const b = mesh(bladeG, i % 2 ? m1 : m2, Math.cos(a) * r, 0.22 + (i % 2) * 0.04, Math.sin(a) * r);
        b.rotation.z = Math.cos(a) * 0.25;
        b.rotation.x = Math.sin(a) * 0.25;
        g.add(b);
      }
      break;
    }
  }
  return g;
}

// ---------------------------------------------------------------- 拠点

export function createBaseModel(faction: Faction): THREE.Group {
  const g = new THREE.Group();
  if (faction === 'mongoose') {
    // 海岸に築いた巣穴の砦
    const mound = mesh(geo('b-mound', () => new THREE.SphereGeometry(0.95, 9, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.75, 1)), mat(0xa88454));
    g.add(mound);
    const hole = mesh(geo('b-hole', () => new THREE.CircleGeometry(0.22, 10)), mat(0x2a1d12), 0, 0.22, 0.88);
    hole.rotation.x = -0.3;
    g.add(hole);
    const stakeG = geo('b-stake', () => new THREE.ConeGeometry(0.06, 0.6, 5));
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      if (Math.abs(a - Math.PI / 2) < 0.35) continue;
      g.add(mesh(stakeG, mat(COLORS.wood), Math.cos(a) * 1.0, 0.25, Math.sin(a) * 1.0));
    }
    g.add(mesh(geo('b-pole', () => new THREE.CylinderGeometry(0.025, 0.025, 1.0, 5)), mat(COLORS.woodDark), 0, 1.1, 0));
    const flag = mesh(geo('b-flag', () => new THREE.BoxGeometry(0.4, 0.25, 0.02)), mat(COLORS.mongooseScarf), 0.2, 1.45, 0);
    flag.name = 'flag';
    g.add(flag);
  } else {
    // 森の奥にある祠
    g.add(mesh(geo('s-base', () => new THREE.BoxGeometry(1.6, 0.25, 1.6)), mat(COLORS.stone), 0, 0.125, 0));
    g.add(mesh(geo('s-floor', () => new THREE.BoxGeometry(1.1, 0.12, 1.1)), mat(COLORS.woodDark), 0, 0.31, 0));
    const pillarG = geo('s-pillar', () => new THREE.CylinderGeometry(0.06, 0.06, 0.8, 6));
    for (const [x, z] of [[-0.45, -0.45], [0.45, -0.45], [-0.45, 0.45], [0.45, 0.45]]) {
      g.add(mesh(pillarG, mat(0x9b2a22), x, 0.75, z));
    }
    const roof = mesh(geo('s-roof', () => new THREE.ConeGeometry(1.05, 0.6, 4).rotateY(Math.PI / 4)), mat(0x3d3a33), 0, 1.45, 0);
    g.add(roof);
    const emblem = mesh(geo('s-emblem', () => new THREE.TorusGeometry(0.16, 0.04, 5, 12)), mat(COLORS.habuGold, { emissive: 0x3a2a00 }), 0, 0.85, 0.5);
    emblem.name = 'flag';
    g.add(emblem);
  }
  return g;
}

/** 体力バー（カメラに向けて表示する） */
export function createHpBar(width = 0.5): THREE.Group {
  const g = new THREE.Group();
  const bg = new THREE.Mesh(
    geo(`hp-bg-${width}`, () => new THREE.PlaneGeometry(width, 0.07)),
    new THREE.MeshBasicMaterial({ color: 0x1b1b1b, transparent: true, opacity: 0.6, depthTest: false, toneMapped: false }),
  );
  const fill = new THREE.Mesh(
    geo(`hp-fill-${width}`, () => new THREE.PlaneGeometry(width, 0.07).translate(width / 2, 0, 0)),
    // 背景と同じ半透明パスで描画しないと、renderOrder に関係なく背景が上に重なって黒く見える
    new THREE.MeshBasicMaterial({ color: 0x5fd35f, transparent: true, depthTest: false, toneMapped: false }),
  );
  fill.position.x = -width / 2;
  fill.position.z = 0.001;
  fill.name = 'fill';
  bg.renderOrder = 10;
  fill.renderOrder = 11;
  g.add(bg, fill);
  return g;
}

export function setHpBar(bar: THREE.Group, ratio: number): void {
  const fill = bar.getObjectByName('fill') as THREE.Mesh;
  const r = Math.max(0, Math.min(1, ratio));
  fill.scale.x = Math.max(0.0001, r);
  const m = fill.material as THREE.MeshBasicMaterial;
  m.color.setHex(r > 0.5 ? 0x5fd35f : r > 0.25 ? 0xe0c040 : 0xe05040);
}
