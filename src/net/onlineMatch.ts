// オンライン対戦の進行。サーバーを信用せず、クライアント同士で次のことを保証する。
//
// - 配置はコミット・リビール方式で交換する：先にハッシュだけを送り、両者のハッシュがそろってから中身を公開する。
//   相手の配置を見てから自分の配置を決めることはできない。
// - 乱数シードは両者が出した乱数を混ぜて決める。どちらか一方がシードを選ぶことはできない。
// - 届いた配置は形と中身（予算・配置エリア・陣営）を検査する。
// - 戦闘後に最終状態のハッシュを照合し、同期ずれを検出する。

import { FACTION_UNITS, type Faction, type Side } from '../sim/defs';
import { createTerrain, MAP_IDS, type MapId } from '../sim/maps';
import { parseItems, validateSide, type MatchSetup, type PlacementItem } from '../sim/placement';
import type { RelayClient } from './relayClient';
import { randomHex, randomU32, sha256Hex } from './sha256';

/** 部屋を作った側が決める設定。部屋を作った側が陣営0、入った側が陣営1。 */
export interface OnlineConfig {
  mapId: MapId;
  hostFaction: Faction;
}

type PeerMessage =
  | { k: 'commit'; round: number; hash: string }
  | { k: 'reveal'; round: number; payload: string; salt: string }
  | { k: 'result'; round: number; hash: number }
  | { k: 'rematch'; round: number };

export class OnlineError extends Error {}

export function parseConfig(value: unknown): OnlineConfig {
  const c = value as Partial<OnlineConfig> | null;
  if (!c || !MAP_IDS.includes(c.mapId as MapId) || !(c.hostFaction! in FACTION_UNITS)) {
    throw new OnlineError('部屋の設定が不正です');
  }
  return { mapId: c.mapId as MapId, hostFaction: c.hostFaction as Faction };
}

/** 2つの乱数から対戦のシードを作る（陣営0の乱数が先） */
export function mixSeed(a: number, b: number): number {
  let h = Math.imul((a ^ 0x9e3779b9) >>> 0, 0x85ebca6b) ^ b;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x27d4eb2f);
  return (h ^ (h >>> 15)) >>> 0;
}

export class OnlineMatch {
  /** 何戦目か（もう一戦のたびに増える） */
  round = 0;
  readonly factions: [Faction, Faction];
  private mailbox = new Map<string, PeerMessage>();
  private waiting = new Map<string, { resolve: (m: PeerMessage) => void; reject: (e: Error) => void }>();
  private gone: Error | null = null;
  private peerLeftHandlers: (() => void)[] = [];

  constructor(private client: RelayClient, readonly side: Side, readonly config: OnlineConfig, readonly room: string) {
    this.factions = [config.hostFaction, config.hostFaction === 'mongoose' ? 'habu' : 'mongoose'];
    client.onPeer((data) => this.receive(data));
    const lost = (text: string) => () => {
      if (this.gone) return;
      this.gone = new OnlineError(text);
      for (const w of this.waiting.values()) w.reject(this.gone);
      this.waiting.clear();
      for (const h of this.peerLeftHandlers) h();
    };
    client.onPeerLeft(lost('相手が切断しました'));
    client.onClose(lost('サーバーとの接続が切れました'));
  }

  get peerSide(): Side {
    return this.side === 0 ? 1 : 0;
  }

  get connected(): boolean {
    return this.gone === null;
  }

  onPeerLeft(handler: () => void): void {
    this.peerLeftHandlers.push(handler);
  }

  private receive(data: unknown): void {
    const m = data as PeerMessage;
    if (!m || typeof m !== 'object' || typeof m.k !== 'string' || !Number.isInteger(m.round)) return;
    const key = `${m.k}:${m.round}`;
    const w = this.waiting.get(key);
    if (w) {
      this.waiting.delete(key);
      w.resolve(m);
    } else {
      this.mailbox.set(key, m);
    }
  }

  private waitFor<K extends PeerMessage['k']>(k: K, round: number): Promise<Extract<PeerMessage, { k: K }>> {
    const key = `${k}:${round}`;
    const got = this.mailbox.get(key);
    if (got) {
      this.mailbox.delete(key);
      return Promise.resolve(got as Extract<PeerMessage, { k: K }>);
    }
    if (this.gone) return Promise.reject(this.gone);
    return new Promise((resolve, reject) => {
      this.waiting.set(key, { resolve: resolve as (m: PeerMessage) => void, reject });
    });
  }

  private send(m: PeerMessage): void {
    this.client.send(m);
  }

  /**
   * 自分の配置を送り、相手の配置を受け取って対戦セットアップを作る。
   * onWaiting は相手の確定待ちになったときに呼ばれる。
   */
  async exchange(items: PlacementItem[], onWaiting?: () => void): Promise<MatchSetup> {
    const round = this.round;
    const nonce = randomU32();
    const salt = randomHex(16);
    const payload = JSON.stringify({ items, nonce });
    this.send({ k: 'commit', round, hash: sha256Hex(payload + salt) });

    if (!this.mailbox.has(`commit:${round}`)) onWaiting?.();
    const peerCommit = (await this.waitFor('commit', round)).hash;

    // 両者のコミットがそろってから中身を公開する
    this.send({ k: 'reveal', round, payload, salt });
    const reveal = await this.waitFor('reveal', round);
    if (typeof reveal.payload !== 'string' || typeof reveal.salt !== 'string' || sha256Hex(reveal.payload + reveal.salt) !== peerCommit) {
      throw new OnlineError('相手の配置データが確定時のものと一致しません');
    }
    let peer: { items?: unknown; nonce?: unknown };
    try {
      peer = JSON.parse(reveal.payload);
    } catch {
      throw new OnlineError('相手の配置データを読み取れません');
    }
    const peerItems = parseItems(peer.items);
    if (!peerItems || !Number.isInteger(peer.nonce) || (peer.nonce as number) < 0 || (peer.nonce as number) > 0xffffffff) {
      throw new OnlineError('相手の配置データの形式が不正です');
    }
    const terrain = createTerrain(this.config.mapId);
    const errors = validateSide(terrain, this.peerSide, { faction: this.factions[this.peerSide], items: peerItems });
    if (errors.length > 0) throw new OnlineError(`相手の配置が不正です：${errors[0]}`);

    const nonces: [number, number] = this.side === 0 ? [nonce, peer.nonce as number] : [peer.nonce as number, nonce];
    const sides: [PlacementItem[], PlacementItem[]] = this.side === 0 ? [items, peerItems] : [peerItems, items];
    return {
      version: 1,
      mapId: this.config.mapId,
      seed: mixSeed(nonces[0], nonces[1]),
      sides: [
        { faction: this.factions[0], items: sides[0] },
        { faction: this.factions[1], items: sides[1] },
      ],
    };
  }

  /** 戦闘の最終状態のハッシュを照合する。相手がいなければ null */
  async compareResult(hash: number): Promise<boolean | null> {
    if (this.gone) return null;
    const round = this.round;
    this.send({ k: 'result', round, hash });
    try {
      const peer = await this.waitFor('result', round);
      return peer.hash === hash;
    } catch {
      return null;
    }
  }

  /** もう一戦を申し込み、相手も申し込むまで待つ */
  async rematch(): Promise<void> {
    const round = this.round;
    this.send({ k: 'rematch', round });
    await this.waitFor('rematch', round);
    this.round++;
  }

  /** 相手がもう一戦を申し込んでいるか */
  peerWantsRematch(): boolean {
    return this.mailbox.has(`rematch:${this.round}`);
  }

  leave(): void {
    this.gone ??= new OnlineError('退出しました');
    this.client.leave();
    this.client.close();
  }
}
