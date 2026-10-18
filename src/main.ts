// 画面の流れ：タイトル →（オンライン対戦なら部屋の作成・参加）→ 準備（配置）→ 実戦（観戦）→ 結果。

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
import { createWorld, hashWorld, type BattleResult } from './sim/world';
import { OnlineMatch, parseConfig, type OnlineConfig } from './net/onlineMatch';
import { normalizeRoomCode, ROOM_CODE_LENGTH } from './net/protocol';
import { RelayClient } from './net/relayClient';
import { BattleScreen } from './ui/battleScreen';
import { clear, h } from './ui/dom';
import { PlacementScreen } from './ui/placementScreen';

type Mode = 'cpu' | 'local' | 'online';

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
/** オンライン対戦中の接続 */
let online: OnlineMatch | null = null;
/** 相手が切断したときの処理（画面ごとに差し替える） */
let onPeerLeft: () => void = () => {};

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

function resolveMap(): MapId {
  return settings.map === 'random' ? MAP_IDS[Math.floor(Math.random() * MAP_IDS.length)] : settings.map;
}

// ---------------------------------------------------------------- タイトル

function showTitle(): void {
  placement?.dispose();
  battle?.dispose();
  placement = null;
  battle = null;
  online?.leave();
  online = null;
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
    choice('対戦', settings.mode, [['cpu', 'CPU戦'], ['local', '2人対戦（交代で配置）'], ['online', 'オンライン対戦']], (v) => (settings.mode = v)),
    choice({ cpu: 'あなたの陣営', local: 'プレイヤー1の陣営', online: 'あなたの陣営（部屋を作る場合）' }[settings.mode], settings.faction, [['mongoose', 'マングース軍'], ['habu', 'ハブ軍']], (v) => (settings.faction = v)),
    choice('マップ', settings.map, [['random', 'ランダム'], ...MAP_IDS.map((id) => [id, MAP_INFOS[id].name] as [MapId, string])], (v) => (settings.map = v)),
    settings.mode === 'cpu'
      ? choice('CPUの強さ', settings.difficulty, (['easy', 'normal', 'hard'] as Difficulty[]).map((d) => [d, DIFFICULTY_NAMES[d]] as [Difficulty, string]), (v) => (settings.difficulty = v))
      : null,
    settings.map !== 'random'
      ? h('div', { class: 'muted small' }, `${MAP_INFOS[settings.map].description}（有利になりやすい陣営：${MAP_INFOS[settings.map].favored}）`)
      : null,
    settings.mode === 'online' ? onlineButtons() : h('button', { class: 'primary big', onclick: () => startMatch() }, '出陣'),
    h('div', { class: 'muted small help' }, '操作：タップで選択・ドラッグで配置／移動・ピンチで拡大。PCでは右ドラッグで回転、ホイールで拡大。'),
  );
  hud.append(h('div', { class: 'overlay title' }, panel));
}

// ---------------------------------------------------------------- 対戦

function startMatch(): void {
  const mapId = resolveMap();
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

function runBattle(setup: MatchSetup, viewer: Side | null, isReplay = false, match: OnlineMatch | null = null): void {
  clear(hud);
  board.clear();
  stage.setTerrain(createTerrain(setup.mapId));
  board.setBases([setup.sides[0].faction, setup.sides[1].faction]);
  const world = createWorld(setup);
  battle = new BattleScreen({
    stage, board, hud, world, viewer,
    label: `${isReplay ? 'リプレイ · ' : ''}${MAP_INFOS[setup.mapId].name}`,
    onEnd: (result) => {
      showResult(setup, result, viewer, match, isReplay ? null : hashWorld(world));
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

/** match：オンライン対戦の接続。finalHash：照合する最終状態（リプレイでは null） */
function showResult(setup: MatchSetup, r: BattleResult, viewer: Side | null, match: OnlineMatch | null = null, finalHash: number | null = null): void {
  const factions = [setup.sides[0].faction, setup.sides[1].faction];
  let headline: string;
  let tone: string;
  if (r.winner === null) {
    headline = '引き分け';
    tone = 'draw';
  } else if (viewer !== null) {
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
    match ? onlineResultFooter(match, finalHash) : null,
    h('div', { class: 'buttons' },
      h('button', { onclick: () => { battle?.dispose(); runBattle(setup, match ? match.side : null, true, match); } }, 'リプレイ'),
      match
        ? rematchButton(match)
        : h('button', { class: 'primary', onclick: () => startMatch() }, 'もう一戦'),
      h('button', { onclick: () => showTitle() }, 'タイトルへ')),
  );
  hud.append(h('div', { class: 'overlay result-overlay' }, panel));
}

// ---------------------------------------------------------------- オンライン対戦

function onlineButtons(): HTMLElement {
  const input = h('input', {
    class: 'room-input',
    placeholder: '部屋コード',
    maxlength: ROOM_CODE_LENGTH,
    autocapitalize: 'characters',
    autocomplete: 'off',
    spellcheck: 'false',
    inputmode: 'text',
  });
  const joinBtn = h('button', { disabled: true, onclick: () => joinRoom(input.value) }, '部屋に入る');
  input.addEventListener('input', () => {
    input.value = normalizeRoomCode(input.value);
    joinBtn.toggleAttribute('disabled', input.value.length !== ROOM_CODE_LENGTH);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.length === ROOM_CODE_LENGTH) joinRoom(input.value);
  });
  return h('div', { class: 'online-entry' },
    h('button', { class: 'primary big', onclick: () => hostRoom() }, '部屋を作る'),
    h('div', { class: 'join-row' }, input, joinBtn),
    h('div', { class: 'muted small' }, '部屋を作った人が陣営とマップを決めます。入った人は反対の陣営になります。'));
}

/** 接続中・待機中の画面 */
function lobby(title: string, onCancel: () => void) {
  const titleEl = h('h2', {}, title);
  const body = h('div', { class: 'lobby-body' });
  const el = h('div', { class: 'overlay title' },
    h('div', { class: 'title-panel lobby' },
      titleEl,
      body,
      h('button', { onclick: () => onCancel() }, 'やめる')));
  clear(hud);
  hud.append(el);
  return {
    set(t: string, ...children: (Node | string)[]) {
      titleEl.textContent = t;
      clear(body);
      body.append(...children);
    },
  };
}

function showOnlineError(message: string): void {
  // 切断の通知と、相手待ちの失敗が同時に来ることがある
  if (hud.querySelector('.online-error')) return;
  online?.leave();
  online = null;
  placement?.dispose();
  placement = null;
  hud.append(h('div', { class: 'overlay result-overlay online-error' },
    h('div', { class: 'title-panel' },
      h('h2', {}, 'オンライン対戦を終了しました'),
      h('p', { class: 'muted' }, message),
      h('button', { class: 'primary', onclick: () => showTitle() }, 'タイトルへ'))));
}

async function hostRoom(): Promise<void> {
  let cancelled = false;
  let client: RelayClient | null = null;
  const ui = lobby('サーバーに接続しています…', () => {
    cancelled = true;
    client?.close();
    showTitle();
  });
  const config: OnlineConfig = { mapId: resolveMap(), hostFaction: settings.faction };
  try {
    client = await RelayClient.connect();
    if (cancelled) return client.close();
    const room = await client.create(config);
    ui.set('部屋を作りました',
      h('div', { class: 'room-code' }, room),
      h('p', { class: 'muted' }, '相手にこの部屋コードを伝えてください。相手が入ると準備フェーズが始まります。'),
      h('div', { class: 'muted small' }, `${FACTION_NAMES[config.hostFaction]}（あなた） vs ${FACTION_NAMES[other(config.hostFaction)]} · ${MAP_INFOS[config.mapId].name}`));
    await client.waitForPeer();
    if (cancelled) return;
    beginOnline(new OnlineMatch(client, 0, config, room));
  } catch (e) {
    if (cancelled) return;
    client?.close();
    showOnlineError((e as Error).message);
  }
}

async function joinRoom(code: string): Promise<void> {
  let cancelled = false;
  let client: RelayClient | null = null;
  const room = normalizeRoomCode(code);
  lobby(`部屋 ${room} に入っています…`, () => {
    cancelled = true;
    client?.close();
    showTitle();
  });
  try {
    client = await RelayClient.connect();
    if (cancelled) return client.close();
    const config = parseConfig(await client.join(room));
    if (cancelled) return;
    beginOnline(new OnlineMatch(client, 1, config, room));
  } catch (e) {
    if (cancelled) return;
    client?.close();
    showOnlineError((e as Error).message);
  }
}

function beginOnline(match: OnlineMatch): void {
  online = match;
  match.onPeerLeft(() => onPeerLeft());
  startOnlineRound(match);
}

function startOnlineRound(match: OnlineMatch): void {
  battle?.dispose();
  battle = null;
  clear(hud);
  board.clear();
  const terrain = createTerrain(match.config.mapId);
  stage.setTerrain(terrain);
  board.setBases(match.factions);
  onPeerLeft = () => showOnlineError('相手が切断しました。');
  placement = new PlacementScreen({
    stage, board, hud, terrain,
    side: match.side,
    faction: match.factions[match.side],
    title: `準備フェーズ — オンライン（部屋 ${match.room}）`,
    onConfirm: async (items) => {
      placement = null;
      const wait = h('div', { class: 'overlay waiting' },
        h('div', { class: 'title-panel' },
          h('h2', {}, '配置を確定しました'),
          h('p', { class: 'muted' }, '相手の確定を待っています…')));
      hud.append(wait);
      try {
        const setup = await match.exchange(items);
        // 実戦はお互いの手元で再生するので、ここからは相手が切断しても最後まで観られる
        onPeerLeft = () => {};
        runBattle(setup, match.side, false, match);
      } catch (e) {
        showOnlineError((e as Error).message);
      }
    },
  });
}

function onlineResultFooter(match: OnlineMatch, finalHash: number | null): HTMLElement {
  const el = h('div', { class: 'sync muted small' });
  if (finalHash === null) {
    el.textContent = 'リプレイ';
    return el;
  }
  el.textContent = '相手と結果を照合しています…';
  void match.compareResult(finalHash).then((same) => {
    if (same === null) el.textContent = '相手が切断したため、結果を照合できませんでした';
    else if (same) el.textContent = '相手の画面と結果が一致しました';
    else {
      el.textContent = '相手の画面と結果が一致しません（同期ずれ）。この対戦の結果は無効です';
      el.classList.add('warn');
    }
  });
  return el;
}

function rematchButton(match: OnlineMatch): HTMLElement {
  const btn = h('button', { class: 'primary' }, 'もう一戦');
  const hint = () => {
    if (!match.connected) {
      btn.textContent = '相手が退出しました';
      btn.setAttribute('disabled', '');
    } else if (match.peerWantsRematch() && !btn.hasAttribute('disabled')) {
      btn.textContent = 'もう一戦（相手が希望）';
    }
  };
  const timer = setInterval(() => {
    if (!btn.isConnected) clearInterval(timer);
    else hint();
  }, 400);
  onPeerLeft = hint;
  hint();
  btn.addEventListener('click', async () => {
    btn.setAttribute('disabled', '');
    btn.textContent = '相手を待っています…';
    try {
      await match.rematch();
      startOnlineRound(match);
    } catch {
      hint();
    }
  });
  return btn;
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
