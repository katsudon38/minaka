// レンダラー・カメラ・地形。戦闘ロジックには依存しない（表示とロジックの分離）。

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MAP_H, MAP_W } from '../sim/config';
import type { Side } from '../sim/defs';
import { idx, inDeployZone, type Terrain } from '../sim/maps';
import { mat } from './models';

const HEIGHT_STEP = 0.6;

/** タイルの上面の高さ（描画用） */
export function tileTopY(t: Terrain, x: number, z: number): number {
  const i = idx(x, z);
  switch (t.kind[i]) {
    case 'water': return -0.28;
    case 'shallow': return -0.14;
    case 'bridge': return 0.06;
    case 'cliff': return 1.5;
    default: return t.height[i] * HEIGHT_STEP;
  }
}

/** シミュレーション座標（タイル単位の実数）→ ワールド座標 */
export function toWorldX(tx: number): number {
  return tx - MAP_W / 2;
}
export function toWorldZ(tz: number): number {
  return tz - MAP_H / 2;
}

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  terrain: Terrain | null = null;
  private terrainGroup = new THREE.Group();
  private tileMesh: THREE.InstancedMesh | null = null;
  private zoneOverlay: THREE.InstancedMesh | null = null;
  private raycaster = new THREE.Raycaster();
  private sun: THREE.DirectionalLight;
  private viewSide: Side = 0;

  constructor(private container: HTMLElement) {
    const mobile = matchMedia('(pointer: coarse)').matches;
    this.renderer = new THREE.WebGLRenderer({ antialias: !mobile, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, mobile ? 1.5 : 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x9fd3e8);
    this.scene.fog = new THREE.Fog(0x9fd3e8, 40, 90);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = 1.3;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 55;
    this.controls.screenSpacePanning = false;

    const hemi = new THREE.HemisphereLight(0xfff4dc, 0x50603a, 1.3);
    this.scene.add(hemi);
    this.sun = new THREE.DirectionalLight(0xfff0d0, 2.2);
    this.sun.position.set(-12, 26, -8);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -20;
    sc.right = 20;
    sc.top = 22;
    sc.bottom = -22;
    sc.near = 1;
    sc.far = 80;
    this.scene.add(this.sun);
    this.scene.add(this.terrainGroup);

    this.buildSurroundings();
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    // 縦長の画面（スマホ）では引いて全体が見えるようにする
    this.camera.fov = w < h ? 60 : 45;
    this.camera.updateProjectionMatrix();
  }

  /** 配置モード：左ドラッグ・1本指は配置に使い、カメラは右ドラッグ・2本指で操作 */
  setInteractionMode(mode: 'placement' | 'watch'): void {
    const c = this.controls;
    if (mode === 'placement') {
      c.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
      c.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };
    } else {
      c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      c.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    }
  }

  /** 陣営 side の手前からマップを見る */
  resetCamera(side: Side, focus: 'deploy' | 'overview' = 'overview'): void {
    this.viewSide = side;
    const dir = side === 0 ? -1 : 1;
    const portrait = this.container.clientWidth < this.container.clientHeight;
    const targetZ = focus === 'deploy' ? dir * (MAP_H / 2 - 5) : dir * 4;
    this.controls.target.set(0, 0, targetZ);
    const dist = focus === 'deploy' ? (portrait ? 17 : 13) : (portrait ? 28 : 19);
    const height = focus === 'deploy' ? (portrait ? 15 : 11) : (portrait ? 26 : 16);
    this.camera.position.set(0, height, targetZ + dir * dist);
    this.controls.update();
  }

  get side(): Side {
    return this.viewSide;
  }

  setTerrain(t: Terrain): void {
    this.terrain = t;
    this.terrainGroup.clear();
    const n = MAP_W * MAP_H;
    const box = new THREE.BoxGeometry(1, 1, 1);
    const tiles = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.95 }), n);
    tiles.receiveShadow = true;
    const m = new THREE.Matrix4();
    const color = new THREE.Color();
    const reeds: [number, number][] = [];
    const cliffs: [number, number][] = [];
    const bridges: [number, number][] = [];
    for (let z = 0; z < MAP_H; z++) {
      for (let x = 0; x < MAP_W; x++) {
        const i = idx(x, z);
        const top = tileTopY(t, x, z);
        const bottom = -0.8;
        m.compose(
          new THREE.Vector3(toWorldX(x + 0.5), (top + bottom) / 2, toWorldZ(z + 0.5)),
          new THREE.Quaternion(),
          new THREE.Vector3(1, top - bottom, 1),
        );
        tiles.setMatrixAt(i, m);
        const checker = (x + z) % 2 === 0 ? 0 : 0.03;
        switch (t.kind[i]) {
          case 'water': color.setHex(0x3a7fa8); break;
          case 'shallow': color.setHex(0x6fb0c4); break;
          case 'bridge': color.setHex(0x3a7fa8); bridges.push([x, z]); break;
          case 'cliff': color.setHex(0x7d776c); cliffs.push([x, z]); break;
          case 'reeds': color.setHex(0x8fa850); reeds.push([x, z]); break;
          default: {
            const h = t.height[i];
            color.setHex(h === 0 ? 0x7cb455 : h === 1 ? 0x8fa556 : 0x9d9460);
            if (t.slope[i]) color.offsetHSL(0.02, -0.08, -0.04);
          }
        }
        color.offsetHSL(0, 0, -checker);
        tiles.setColorAt(i, color);
      }
    }
    tiles.instanceMatrix.needsUpdate = true;
    if (tiles.instanceColor) tiles.instanceColor.needsUpdate = true;
    this.tileMesh = tiles;
    this.terrainGroup.add(tiles);

    // 岩壁のごつごつ
    if (cliffs.length > 0) {
      const rockG = new THREE.DodecahedronGeometry(0.45, 0);
      const rocks = new THREE.InstancedMesh(rockG, mat(0x6e695f), cliffs.length * 2);
      rocks.castShadow = true;
      cliffs.forEach(([x, z], k) => {
        for (let j = 0; j < 2; j++) {
          const s = 0.8 + ((x * 7 + z * 13 + j * 5) % 5) * 0.1;
          m.compose(
            new THREE.Vector3(toWorldX(x + 0.3 + j * 0.4), 1.5 + 0.15 * s, toWorldZ(z + 0.3 + ((x + j) % 2) * 0.4)),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(x + j, z, j)),
            new THREE.Vector3(s, s * 0.8, s),
          );
          rocks.setMatrixAt(k * 2 + j, m);
        }
      });
      this.terrainGroup.add(rocks);
    }
    // 葦原
    if (reeds.length > 0) {
      const reedG = new THREE.ConeGeometry(0.05, 0.75, 4);
      const per = 7;
      const reedMesh = new THREE.InstancedMesh(reedG, mat(0xb8b060), reeds.length * per);
      reedMesh.castShadow = true;
      reeds.forEach(([x, z], k) => {
        for (let j = 0; j < per; j++) {
          const a = j * 2.4 + x;
          const r = 0.15 + (j % 3) * 0.13;
          m.compose(
            new THREE.Vector3(toWorldX(x + 0.5) + Math.cos(a) * r, 0.37, toWorldZ(z + 0.5) + Math.sin(a) * r),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.sin(a) * 0.15, 0, Math.cos(a) * 0.15)),
            new THREE.Vector3(1, 0.8 + (j % 2) * 0.4, 1),
          );
          reedMesh.setMatrixAt(k * per + j, m);
        }
      });
      this.terrainGroup.add(reedMesh);
    }
    // 橋
    if (bridges.length > 0) {
      const plankG = new THREE.BoxGeometry(1, 0.12, 0.9);
      const planks = new THREE.InstancedMesh(plankG, mat(0x9b6b3d), bridges.length);
      planks.receiveShadow = true;
      planks.castShadow = true;
      bridges.forEach(([x, z], k) => {
        m.makeTranslation(toWorldX(x + 0.5), 0.02, toWorldZ(z + 0.5));
        planks.setMatrixAt(k, m);
      });
      this.terrainGroup.add(planks);
    }
    this.buildDeployOverlay();
  }

  private buildDeployOverlay(): void {
    if (!this.terrain) return;
    const plane = new THREE.PlaneGeometry(0.94, 0.94).rotateX(-Math.PI / 2);
    const overlay = new THREE.InstancedMesh(
      plane,
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false }),
      MAP_W * MAP_H,
    );
    overlay.visible = false;
    this.zoneOverlay = overlay;
    this.terrainGroup.add(overlay);
  }

  /** 配置エリアを強調表示する（null で消す） */
  showDeployZone(side: Side | null): void {
    const t = this.terrain;
    const o = this.zoneOverlay;
    if (!t || !o) return;
    if (side === null) {
      o.visible = false;
      return;
    }
    const m = new THREE.Matrix4();
    let k = 0;
    for (let z = 0; z < MAP_H; z++) {
      for (let x = 0; x < MAP_W; x++) {
        if (!inDeployZone(side, x, z)) continue;
        m.makeTranslation(toWorldX(x + 0.5), tileTopY(t, x, z) + 0.015, toWorldZ(z + 0.5));
        o.setMatrixAt(k++, m);
      }
    }
    o.count = k;
    o.instanceMatrix.needsUpdate = true;
    o.visible = true;
  }

  /** 画面座標からタイルを求める */
  pickTile(clientX: number, clientY: number): { x: number; z: number } | null {
    if (!this.tileMesh) return null;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.tileMesh, false)[0];
    if (!hit || hit.instanceId === undefined) return null;
    const x = hit.instanceId % MAP_W;
    return { x, z: (hit.instanceId - x) / MAP_W };
  }

  private buildSurroundings(): void {
    // ミナカ島：海と砂浜と森
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(240, 240).rotateX(-Math.PI / 2), mat(0x3f8fb5, { flat: false }));
    sea.position.y = -0.5;
    this.scene.add(sea);
    const sand = new THREE.Mesh(new THREE.CylinderGeometry(26, 30, 0.6, 24), mat(0xe2cf98));
    sand.position.y = -0.55;
    sand.receiveShadow = true;
    this.scene.add(sand);
    const grass = new THREE.Mesh(new THREE.CylinderGeometry(22, 24, 0.6, 24), mat(0x6fa24a));
    grass.position.y = -0.45;
    grass.receiveShadow = true;
    this.scene.add(grass);

    const trunkG = new THREE.CylinderGeometry(0.12, 0.16, 0.8, 5);
    const leafG = new THREE.ConeGeometry(0.8, 1.8, 6);
    const spots: [number, number][] = [];
    for (let i = 0; i < 70; i++) {
      const a = i * 2.399963;
      const r = 13 + (i % 7) * 1.3;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r * 1.25;
      if (Math.abs(x) < MAP_W / 2 + 1 && Math.abs(z) < MAP_H / 2 + 1) continue;
      if (Math.hypot(x, z / 1.1) > 23) continue;
      spots.push([x, z]);
    }
    const trunks = new THREE.InstancedMesh(trunkG, mat(0x6b4a2b), spots.length);
    const leaves = new THREE.InstancedMesh(leafG, mat(0x3f7a3a), spots.length);
    leaves.castShadow = true;
    const m = new THREE.Matrix4();
    spots.forEach(([x, z], i) => {
      const s = 0.8 + (i % 4) * 0.2;
      m.compose(new THREE.Vector3(x, 0.1, z), new THREE.Quaternion(), new THREE.Vector3(s, s, s));
      trunks.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(x, 0.1 + 1.3 * s, z), new THREE.Quaternion(), new THREE.Vector3(s, s, s));
      leaves.setMatrixAt(i, m);
    });
    this.scene.add(trunks, leaves);
  }

  render(): void {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
