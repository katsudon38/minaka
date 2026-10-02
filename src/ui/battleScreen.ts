// 実戦フェーズ：両軍の配置を公開し、オート戦闘を観戦する。

import { BATTLE_TIME_LIMIT_TICKS, TICKS_PER_SECOND } from '../sim/config';
import { FACTION_NAMES, type Side } from '../sim/defs';
import { lossRatePermille, stepWorld } from '../sim/battle';
import type { BattleResult, World } from '../sim/world';
import type { BoardView } from '../render/boardView';
import type { Stage } from '../render/stage';
import { clear, formatTime, h } from './dom';

const TICK_SEC = 1 / TICKS_PER_SECOND;
const SPEEDS = [1, 2, 4] as const;

export interface BattleOptions {
  stage: Stage;
  board: BoardView;
  hud: HTMLElement;
  world: World;
  /** 見えない敵を隠す陣営（null なら全員表示） */
  viewer: Side | null;
  label: string;
  onEnd: (result: BattleResult) => void;
}

export class BattleScreen {
  private acc = 0;
  private speed = 1;
  private paused = false;
  private intro = 1.2;
  private ended = false;
  private root: HTMLElement;
  private bars: HTMLElement[] = [];
  private hpText: HTMLElement[] = [];
  private lossText: HTMLElement[] = [];
  private timer!: HTMLElement;
  private controls!: HTMLElement;

  constructor(private o: BattleOptions) {
    this.root = h('div', { class: 'battle' });
    o.hud.append(this.root);
    o.stage.setInteractionMode('watch');
    o.stage.resetCamera(o.viewer ?? 0, 'overview');
    o.board.attachWorld(o.world, o.viewer);
    this.build();
  }

  private build(): void {
    const w = this.o.world;
    const sideBox = (s: Side) => {
      const bar = h('div', { class: 'hpbar-fill' });
      this.bars[s] = bar;
      this.hpText[s] = h('span', { class: 'hp-num' });
      this.lossText[s] = h('span', { class: 'loss' });
      return h('div', { class: `side side${s} ${w.factions[s]}` },
        h('div', { class: 'side-name' }, FACTION_NAMES[w.factions[s]], this.hpText[s]),
        h('div', { class: 'hpbar' }, bar),
        this.lossText[s]);
    };
    this.timer = h('div', { class: 'timer big' });
    this.controls = h('div', { class: 'speed' });
    this.root.append(
      h('div', { class: 'scoreboard' }, sideBox(0), h('div', { class: 'center' }, h('div', { class: 'muted small' }, this.o.label), this.timer), sideBox(1)),
      h('div', { class: 'battle-bottom' }, this.controls),
      h('div', { class: 'banner' }, '開戦！'),
    );
    this.renderControls();
    this.updateHud();
  }

  private renderControls(): void {
    clear(this.controls);
    this.controls.append(
      h('button', { class: this.paused ? 'on' : '', onclick: () => { this.paused = !this.paused; this.renderControls(); } }, this.paused ? '▶ 再開' : 'Ⅱ 停止'),
      ...SPEEDS.map((s) => h('button', { class: this.speed === s && !this.paused ? 'on' : '', onclick: () => { this.speed = s; this.paused = false; this.renderControls(); } }, `×${s}`)),
      h('button', { onclick: () => this.skip() }, '結果へ'),
    );
  }

  private skip(): void {
    const w = this.o.world;
    while (!w.result) stepWorld(w);
    this.acc = 0;
    this.finish();
  }

  private updateHud(): void {
    const w = this.o.world;
    for (const s of [0, 1] as const) {
      const b = w.bases[s];
      this.bars[s].style.width = `${(b.hp / b.maxHp) * 100}%`;
      this.hpText[s].textContent = `拠点 ${b.hp}`;
      const alive = w.units.filter((u) => u.alive && u.side === s).length;
      const rate = lossRatePermille(w.lostCost[s], w.startCost[s]) / 10;
      this.lossText[s].textContent = `兵 ${alive}体 · 損耗率 ${rate.toFixed(0)}%`;
    }
    this.timer.textContent = formatTime((BATTLE_TIME_LIMIT_TICKS - w.tick) / TICKS_PER_SECOND);
    this.timer.classList.toggle('urgent', BATTLE_TIME_LIMIT_TICKS - w.tick < 15 * TICKS_PER_SECOND);
  }

  frame(dt: number): void {
    const w = this.o.world;
    if (this.intro > 0) {
      this.intro -= dt;
      this.o.board.update(dt, 1);
      return;
    }
    if (!this.paused && !w.result) {
      this.acc += Math.min(dt, 0.1) * this.speed;
      while (this.acc >= TICK_SEC && !w.result) {
        stepWorld(w);
        this.o.board.handleEvents(w.events);
        this.acc -= TICK_SEC;
      }
      this.updateHud();
    }
    const alpha = w.result ? 1 : Math.min(1, this.acc / TICK_SEC);
    this.o.board.update(dt * (this.paused ? 0 : 1), alpha);
    if (w.result && !this.ended) {
      // 最後の演出を少し見せてから結果へ
      this.ended = true;
      setTimeout(() => this.finish(), 1200);
    }
  }

  private finish(): void {
    if (!this.root.isConnected) return;
    this.updateHud();
    this.root.remove();
    this.o.onEnd(this.o.world.result!);
  }

  dispose(): void {
    this.root.remove();
  }
}
