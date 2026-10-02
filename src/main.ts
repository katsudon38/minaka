// 画面の流れ：タイトル → 準備（配置）→ 実戦（観戦）→ 結果。

import './ui/style.css';
import { DIFFICULTY_NAMES, generatePlacement, type Difficulty } from './cpu/placementAi';
import { BoardView } from './render/boardView';
import { Stage } from './render/stage';
import { lossRatePermille } from './sim/battle';
import { TICKS_PER_SECOND } from './sim/config';
import { FACTION_NAMES, type Faction, type Side } from './sim/defs';
import { createTerrain, MAP_IDS, MAP_INFOS, type MapId } from './sim/maps';
import { validateSide, type MatchSetup, type PlacementItem } from './sim/placement';
import { Rng } from './sim/rng';
import { createWorld, type BattleResult } from './sim/world';
import { BattleScreen } from './ui/battleScreen';
import { clear, h } from './ui/dom';
import { PlacementScreen } from './ui/placementScreen';

type Mode = 'cpu' | 'local';

interface Settings {
  mode: Mode;
  faction: Faction;
  map: MapId | 'random';
  difficulty: Difficulty;
}

const stageEl = document.getElementById('stage')!;
const hud = document.getElementById('hud')!;
const stage = new Stage(stageEl);
const board = new BoardView(stage);

let settings: Settings = loadSettings();
let placement: PlacementScreen | null = null;
let battle: BattleScreen | null = null;

function loadSettings(): Settings {
  const fallback: Settings = { mode: 'cpu', faction: 'mongoose', map: 'random', difficulty: 'normal' };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem('minaka.settings') ?? '{}') };
  } catch {
    return fallback;
  }
}

function saveSettings(): void {
  try {
    localStorage.setItem('minaka.settings', JSON.stringify(settings));
  } catch {
    // 保存できなくても遊べる
  }
}

function other(f: Faction): Faction {
  return f === 'mongoose' ? 'habu' : 'mongoose';
}

function randomSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------- タイトル

function showTitle(): void {
  placement?.dispose();
  battle?.dispose();
  placement = null;
  battle = null;
  clear(hud);
  board.clear();
  const preview = settings.map === 'random' ? 'plain' : settings.map;
  stage.setTerrain(createTerrain(preview));
  board.setBases(['mongoose', 'habu']);
  stage.setInteractionMode('watch');
  stage.resetCamera(0, 'overview');

  const choice = <T extends string>(label: string, value: T, options: [T, string][], set: (v: T) => void) =>
    h('div', { class: 'field' },
      h('div', { class: 'field-label' }, label),
      h('div', { class: 'seg' }, ...options.map(([v, name]) => h('button', {
        class: v === value ? 'on' : '',
        onclick: () => {
          set(v);
          saveSettings();
          showTitle();
        },
      }, name))));

  const panel = h('div', { class: 'title-panel' },
    h('h1', {}, 'ミナカ島戦記'),
    h('div', { class: 'subtitle' }, 'マングース vs ハブ — 配置型オートバトラー'),
    h('p', { class: 'lore' }, '南の島「ミナカ島」。森と岩場を治めてきたハブの一族のもとへ、海の向こうからマングースの群れがやって来た。相手の配置は見えない。地形と障害物を読み、兵を置け。'),
    choice('対戦', settings.mode, [['cpu', 'CPU戦'], ['local', '2人対戦（交代で配置）']], (v) => (settings.mode = v)),
    choice(settings.mode === 'cpu' ? 'あなたの陣営' : 'プレイヤー1の陣営', settings.faction, [['mongoose', 'マングース軍'], ['habu', 'ハブ軍']], (v) => (settings.faction = v)),
    choice('マップ', settings.map, [['random', 'ランダム'], ...MAP_IDS.map((id) => [id, MAP_INFOS[id].name] as [MapId, string])], (v) => (settings.map = v)),
    settings.mode === 'cpu'
      ? choice('CPUの強さ', settings.difficulty, (['easy', 'normal', 'hard'] as Difficulty[]).map((d) => [d, DIFFICULTY_NAMES[d]] as [Difficulty, string]), (v) => (settings.difficulty = v))
      : null,
    settings.map !== 'random'
      ? h('div', { class: 'muted small' }, `${MAP_INFOS[settings.map].description}（有利になりやすい陣営：${MAP_INFOS[settings.map].favored}）`)
      : null,
    h('button', { class: 'primary big', onclick: () => startMatch() }, '出陣'),
    h('div', { class: 'muted small help' }, '操作：タップで選択・ドラッグで配置／移動・ピンチで拡大。PCでは右ドラッグで回転、ホイールで拡大。'),
  );
  hud.append(h('div', { class: 'overlay title' }, panel));
}

// ---------------------------------------------------------------- 対戦

function startMatch(): void {
  const mapId: MapId = settings.map === 'random' ? MAP_IDS[Math.floor(Math.random() * MAP_IDS.length)] : settings.map;
  const seed = randomSeed();
  const terrain = createTerrain(mapId);
  const factions: [Faction, Faction] = [settings.faction, other(settings.faction)];
  clear(hud);
  board.clear();
  stage.setTerrain(terrain);
  board.setBases(factions);

  const finishSetup = (items0: PlacementItem[], items1: PlacementItem[]) => {
    const setup: MatchSetup = {
      version: 1, mapId, seed,
      sides: [{ faction: factions[0], items: items0 }, { faction: factions[1], items: items1 }],
    };
    for (const s of [0, 1] as const) {
      const errors = validateSide(terrain, s, setup.sides[s]);
      if (errors.length > 0) console.warn(`陣営${s}の配置エラー`, errors);
    }
    runBattle(setup, settings.mode === 'cpu' ? 0 : null);
  };

  const place = (side: Side, title: string, next: (items: PlacementItem[]) => void) => {
    placement = new PlacementScreen({ stage, board, hud, terrain, side, faction: factions[side], title, onConfirm: (items) => {
      placement = null;
      next(items);
    } });
  };

  if (settings.mode === 'cpu') {
    place(0, '準備フェーズ', (mine) => {
      const cpu = generatePlacement(terrain, 1, factions[1], settings.difficulty, new Rng(seed ^ 0x5bd1e995));
      finishSetup(mine, cpu);
    });
  } else {
    place(0, '準備フェーズ — プレイヤー1', (p1) => {
      board.setPlacement(factions[0], [], -1);
      handOver(`プレイヤー2（${FACTION_NAMES[factions[1]]}）の番です`, 'プレイヤー1は画面を見ないでください。', () => {
        place(1, '準備フェーズ — プレイヤー2', (p2) => {
          board.setPlacement(factions[1], [], -1);
          handOver('両軍の配置が終わりました', '準備ができたら開戦します。', () => finishSetup(p1, p2));
        });
      });
    });
  }
}

/** 交代配置：相手の配置が見えないように画面を隠す */
function handOver(title: string, sub: string, next: () => void): void {
  const el = h('div', { class: 'overlay handover' },
    h('div', { class: 'title-panel' },
      h('h2', {}, title),
      h('p', { class: 'muted' }, sub),
      h('button', { class: 'primary big', onclick: () => { el.remove(); next(); } }, 'OK')));
  hud.append(el);
}

function runBattle(setup: MatchSetup, viewer: Side | null, isReplay = false): void {
  clear(hud);
  board.clear();
  stage.setTerrain(createTerrain(setup.mapId));
  board.setBases([setup.sides[0].faction, setup.sides[1].faction]);
  const world = createWorld(setup);
  battle = new BattleScreen({
    stage, board, hud, world, viewer,
    label: `${isReplay ? 'リプレイ · ' : ''}${MAP_INFOS[setup.mapId].name}`,
    onEnd: (result) => {
      showResult(setup, result, viewer);
    },
  });
}

// ---------------------------------------------------------------- 結果

const REASONS = {
  base: '拠点陥落',
  timeout: '時間切れ',
  bothBases: '両拠点が同時に陥落',
  noUnits: '両軍全滅',
} as const;

const DECIDED = {
  base: '',
  baseHp: '残り耐久値で判定',
  lossRate: '損耗率で判定',
  draw: '耐久値・損耗率とも同じ',
} as const;

function showResult(setup: MatchSetup, r: BattleResult, viewer: Side | null): void {
  const factions = [setup.sides[0].faction, setup.sides[1].faction];
  let headline: string;
  let tone: string;
  if (r.winner === null) {
    headline = '引き分け';
    tone = 'draw';
  } else if (settings.mode === 'cpu' && viewer !== null) {
    headline = r.winner === viewer ? '勝利' : '敗北';
    tone = r.winner === viewer ? 'win' : 'lose';
  } else {
    headline = `${settings.mode === 'local' ? `プレイヤー${r.winner + 1}（${FACTION_NAMES[factions[r.winner]]}）` : FACTION_NAMES[factions[r.winner]]}の勝利`;
    tone = 'win';
  }
  const reason = [REASONS[r.reason], DECIDED[r.decidedBy]].filter(Boolean).join(' — ');
  const row = (s: Side) => h('tr', {},
    h('th', {}, FACTION_NAMES[factions[s]]),
    h('td', {}, String(r.baseHp[s])),
    h('td', {}, `${(lossRatePermille(r.lostCost[s], r.startCost[s]) / 10).toFixed(1)}%`),
    h('td', { class: 'muted' }, `${r.lostCost[s]} / ${r.startCost[s]}`));
  const panel = h('div', { class: `title-panel result ${tone}` },
    h('h2', {}, headline),
    h('div', { class: 'muted' }, `${reason}（${Math.round(r.tick / TICKS_PER_SECOND)}秒）`),
    h('table', { class: 'result-table' },
      h('thead', {}, h('tr', {}, h('th', {}), h('th', {}, '残り耐久値'), h('th', {}, '損耗率'), h('th', {}, '失ったコスト'))),
      h('tbody', {}, row(0), row(1))),
    h('div', { class: 'buttons' },
      h('button', { onclick: () => { battle?.dispose(); runBattle(setup, null, true); } }, 'リプレイ'),
      h('button', { class: 'primary', onclick: () => startMatch() }, 'もう一戦'),
      h('button', { onclick: () => showTitle() }, 'タイトルへ')),
  );
  hud.append(h('div', { class: 'overlay result-overlay' }, panel));
}

// ---------------------------------------------------------------- ループ

let last = performance.now();
function loop(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  placement?.tick(dt);
  if (battle) battle.frame(dt);
  else board.update(dt, 1);
  stage.render();
  requestAnimationFrame(loop);
}

showTitle();
requestAnimationFrame(loop);
