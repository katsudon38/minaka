// 準備フェーズ：自陣の配置エリアに兵と障害物を置き、兵ごとに行動方針を選ぶ。

import { generatePlacement } from '../cpu/placementAi';
import { BUDGET, PREP_TIME_LIMIT_SEC } from '../sim/config';
import { FACTION_NAMES, FACTION_UNITS, OBSTACLE_DEFS, OBSTACLE_TYPES, UNIT_DEFS, type Faction, type ObstacleType, type Side, type Stance, type UnitType } from '../sim/defs';
import { MAP_INFOS, type Terrain } from '../sim/maps';
import { canPlaceAt, itemCost, totalCost, type PlacementItem } from '../sim/placement';
import { Rng } from '../sim/rng';
import type { BoardView } from '../render/boardView';
import type { Stage } from '../render/stage';
import { clear, formatTime, h } from './dom';

type PaletteKey = { kind: 'unit'; type: UnitType } | { kind: 'obstacle'; type: ObstacleType };

const STANCES: { id: Stance; name: string; hint: string }[] = [
  { id: 'advance', name: '前進', hint: '敵の拠点へ向かい、出会った敵と戦う' },
  { id: 'hold', name: '待機', hint: '配置場所で敵を迎え撃つ' },
  { id: 'defend', name: '防衛', hint: '拠点の周辺から離れない' },
];

export interface PlacementOptions {
  stage: Stage;
  board: BoardView;
  hud: HTMLElement;
  terrain: Terrain;
  side: Side;
  faction: Faction;
  title: string;
  onConfirm: (items: PlacementItem[]) => void;
}

export class PlacementScreen {
  private items: PlacementItem[] = [];
  private palette: PaletteKey | null;
  private selected = -1;
  private remaining = PREP_TIME_LIMIT_SEC;
  private hover: { x: number; z: number } | null = null;
  private drag: { index: number; moved: boolean } | null = null;
  private down: { x: number; y: number; tile: { x: number; z: number } | null } | null = null;
  private done = false;
  private root: HTMLElement;
  private els: Record<string, HTMLElement> = {};
  private listeners: [string, EventListener][] = [];

  constructor(private o: PlacementOptions) {
    this.palette = { kind: 'unit', type: FACTION_UNITS[o.faction][0] };
    this.root = h('div', { class: 'placement' });
    o.hud.append(this.root);
    o.stage.setInteractionMode('placement');
    o.stage.resetCamera(o.side, 'deploy');
    o.stage.showDeployZone(o.side);
    this.bindPointer();
    this.render();
  }

  // ---------------------------------------------------------------- 操作

  private bindPointer(): void {
    const c = this.o.stage.canvas;
    const on = (type: string, fn: (e: PointerEvent) => void) => {
      const l = fn as EventListener;
      c.addEventListener(type, l);
      this.listeners.push([type, l]);
    };
    on('pointerdown', (e) => {
      if (e.button !== 0 || !e.isPrimary) return;
      const tile = this.o.stage.pickTile(e.clientX, e.clientY);
      this.down = { x: e.clientX, y: e.clientY, tile };
      const idx = tile ? this.unitIndexAt(tile.x, tile.z) : -1;
      const item = tile ? this.paletteItem(tile.x, tile.z) : null;
      // 草むらの上に兵を重ねるときは、選択ではなく配置
      const stackable = !!item && canPlaceAt(this.o.terrain, this.o.side, this.items, item.tx, item.tz, item.kind, item.type);
      if (idx >= 0 && !stackable) {
        // 置いた兵・障害物をドラッグで移動
        this.drag = { index: idx, moved: false };
        this.selected = idx;
        this.palette = null;
        this.render();
      }
    });
    on('pointermove', (e) => {
      const tile = this.o.stage.pickTile(e.clientX, e.clientY);
      this.hover = tile;
      if (this.drag && tile) {
        const it = this.items[this.drag.index];
        if (it.tx !== tile.x || it.tz !== tile.z) {
          const others = this.items.filter((_, i) => i !== this.drag!.index);
          if (canPlaceAt(this.o.terrain, this.o.side, others, tile.x, tile.z, it.kind, it.type)) {
            it.tx = tile.x;
            it.tz = tile.z;
            this.drag.moved = true;
            this.renderBoard();
          }
        }
      } else if (this.down && this.palette && e.pointerType !== 'mouse' && tile) {
        // 指でなぞって連続配置
        this.tryPlace(tile.x, tile.z);
      }
      this.updateGhost();
    });
    const up = (e: PointerEvent) => {
      const d = this.down;
      this.down = null;
      if (this.drag) {
        this.drag = null;
        this.render();
        return;
      }
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 12) return;
      const tile = this.o.stage.pickTile(e.clientX, e.clientY);
      if (!tile) return;
      if (this.palette) this.tryPlace(tile.x, tile.z);
      else {
        this.selected = -1;
        this.render();
      }
    };
    on('pointerup', up);
    on('pointerleave', () => {
      this.hover = null;
      this.updateGhost();
    });
    const key = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected >= 0) this.removeSelected();
      if (e.key === 'Escape') {
        this.palette = null;
        this.selected = -1;
        this.render();
      }
    };
    addEventListener('keydown', key);
    this.listeners.push(['keydown@window', key as EventListener]);
  }

  /** そのタイルにある兵（なければ障害物）の番号 */
  private unitIndexAt(x: number, z: number): number {
    let found = -1;
    this.items.forEach((it, i) => {
      if (it.tx === x && it.tz === z && (found < 0 || it.kind === 'unit')) found = i;
    });
    return found;
  }

  private paletteItem(x: number, z: number): PlacementItem | null {
    const p = this.palette;
    if (!p) return null;
    return p.kind === 'unit'
      ? { kind: 'unit', type: p.type, tx: x, tz: z, stance: UNIT_DEFS[p.type].defaultStance }
      : { kind: 'obstacle', type: p.type, tx: x, tz: z };
  }

  private tryPlace(x: number, z: number): void {
    const item = this.paletteItem(x, z);
    if (!item) return;
    if (!canPlaceAt(this.o.terrain, this.o.side, this.items, x, z, item.kind, item.type)) return;
    if (totalCost(this.items) + itemCost(item) > BUDGET) {
      this.flash('予算が足りません');
      return;
    }
    this.items.push(item);
    this.selected = -1;
    this.render();
  }

  private removeSelected(): void {
    if (this.selected < 0) return;
    this.items.splice(this.selected, 1);
    this.selected = -1;
    this.render();
  }

  private auto(): void {
    const rng = new Rng((Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0);
    this.items = generatePlacement(this.o.terrain, this.o.side, this.o.faction, 'normal', rng);
    this.selected = -1;
    this.render();
  }

  private confirm(): void {
    if (this.done) return;
    this.done = true;
    this.dispose();
    this.o.onConfirm(this.items.map((it) => ({ ...it })));
  }

  tick(dt: number): void {
    if (this.done) return;
    this.remaining -= dt;
    if (this.els.timer) {
      this.els.timer.textContent = formatTime(this.remaining);
      this.els.timer.classList.toggle('urgent', this.remaining < 10);
    }
    if (this.remaining <= 0) this.confirm();
  }

  dispose(): void {
    const c = this.o.stage.canvas;
    for (const [type, l] of this.listeners) {
      if (type === 'keydown@window') removeEventListener('keydown', l);
      else c.removeEventListener(type, l);
    }
    this.listeners = [];
    this.o.board.setGhost(this.o.faction, null, false);
    this.o.stage.showDeployZone(null);
    this.root.remove();
  }

  private flash(text: string): void {
    const t = h('div', { class: 'toast' }, text);
    this.root.append(t);
    setTimeout(() => t.remove(), 1400);
  }

  // ---------------------------------------------------------------- 表示

  private updateGhost(): void {
    const tile = this.hover;
    const item = tile && !this.drag ? this.paletteItem(tile.x, tile.z) : null;
    const valid = !!item
      && canPlaceAt(this.o.terrain, this.o.side, this.items, item.tx, item.tz, item.kind, item.type)
      && totalCost(this.items) + itemCost(item) <= BUDGET;
    this.o.board.setGhost(this.o.faction, item, valid);
  }

  private renderBoard(): void {
    this.o.board.setPlacement(this.o.faction, this.items, this.selected);
  }

  private render(): void {
    this.renderBoard();
    this.updateGhost();
    const used = totalCost(this.items);
    const left = BUDGET - used;
    clear(this.root);
    const info = MAP_INFOS[this.o.terrain.id];

    const top = h('div', { class: 'topbar' },
      h('div', { class: 'phase' },
        h('div', { class: 'phase-title' }, this.o.title),
        h('div', { class: 'phase-sub' }, `${FACTION_NAMES[this.o.faction]} · ${info.name}：${info.description}`)),
      h('div', { class: 'budget' },
        h('span', { class: 'label' }, '予算'),
        h('span', { class: `value ${left === 0 ? 'full' : ''}` }, String(left)),
        h('span', { class: 'of' }, `/ ${BUDGET}`)),
      (this.els.timer = h('div', { class: 'timer' }, formatTime(this.remaining))),
    );

    const cards: HTMLElement[] = [];
    for (const type of FACTION_UNITS[this.o.faction]) {
      const d = UNIT_DEFS[type];
      cards.push(this.card({ kind: 'unit', type }, d.name, d.role, d.cost, left));
    }
    for (const type of OBSTACLE_TYPES) {
      const d = OBSTACLE_DEFS[type];
      cards.push(this.card({ kind: 'obstacle', type }, d.name, '障害物', d.cost, left));
    }
    const palette = h('div', { class: 'palette' }, ...cards);

    let detail: HTMLElement;
    const sel = this.selected >= 0 ? this.items[this.selected] : null;
    if (sel) {
      const name = sel.kind === 'unit' ? UNIT_DEFS[sel.type].name : OBSTACLE_DEFS[sel.type].name;
      const desc = sel.kind === 'unit' ? UNIT_DEFS[sel.type].ability : OBSTACLE_DEFS[sel.type].effect;
      detail = h('div', { class: 'detail' },
        h('div', { class: 'detail-head' }, h('b', {}, name), h('span', { class: 'muted' }, desc)),
        sel.kind === 'unit'
          ? h('div', { class: 'stances' }, ...STANCES.map((s) => h('button', {
            class: `stance ${sel.stance === s.id ? 'on' : ''}`,
            title: s.hint,
            onclick: () => {
              sel.stance = s.id;
              this.render();
            },
          }, s.name)))
          : null,
        sel.kind === 'unit' ? h('div', { class: 'muted small' }, STANCES.find((s) => s.id === sel.stance)!.hint) : null,
        h('button', { class: 'danger', onclick: () => this.removeSelected() }, '取り除く'),
      );
    } else if (this.palette) {
      const p = this.palette;
      const name = p.kind === 'unit' ? UNIT_DEFS[p.type].name : OBSTACLE_DEFS[p.type].name;
      const desc = p.kind === 'unit' ? UNIT_DEFS[p.type].ability : OBSTACLE_DEFS[p.type].effect;
      detail = h('div', { class: 'detail' },
        h('div', { class: 'detail-head' }, h('b', {}, name), h('span', { class: 'muted' }, desc)),
        h('div', { class: 'muted small' }, '明るいマスをタップして配置。置いたものはドラッグで移動、タップで行動方針を変更'),
      );
    } else {
      detail = h('div', { class: 'detail' }, h('div', { class: 'muted small' }, '下の一覧から兵か障害物を選んでください'));
    }

    const actions = h('div', { class: 'actions' },
      h('button', { onclick: () => this.auto() }, 'おまかせ'),
      h('button', { onclick: () => { this.items = []; this.selected = -1; this.render(); } }, '全消去'),
      h('button', { class: 'primary', onclick: () => this.confirm() }, `確定（${this.items.filter((i) => i.kind === 'unit').length}体）`),
    );

    this.root.append(top, h('div', { class: 'bottom' }, detail, palette, actions));
  }

  private card(key: PaletteKey, name: string, role: string, cost: number, left: number): HTMLElement {
    const on = this.palette && this.palette.kind === key.kind && this.palette.type === key.type;
    const count = this.items.filter((i) => i.kind === key.kind && i.type === key.type).length;
    return h('button', {
      class: `card ${on ? 'on' : ''} ${cost > left ? 'poor' : ''} ${key.kind}`,
      onclick: () => {
        this.palette = key;
        this.selected = -1;
        this.render();
      },
    },
    h('span', { class: 'card-name' }, name),
    h('span', { class: 'card-role' }, role),
    h('span', { class: 'card-cost' }, String(cost)),
    count > 0 ? h('span', { class: 'card-count' }, `×${count}`) : null);
  }
}
