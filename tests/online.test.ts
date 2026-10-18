import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachRelay, type Relay } from '../server/relay';
import { generatePlacement } from '../src/cpu/placementAi';
import { mixSeed, OnlineError, OnlineMatch, parseConfig, type OnlineConfig } from '../src/net/onlineMatch';
import { RelayClient, RelayError } from '../src/net/relayClient';
import { sha256Hex } from '../src/net/sha256';
import { createTerrain, createWorld, hashWorld, Rng, runToEnd, type PlacementItem } from '../src/sim';

let server: Server;
let relay: Relay;
let url: string;
const clients: RelayClient[] = [];

beforeEach(async () => {
  server = createServer();
  relay = attachRelay(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  relay.close();
  await new Promise((r) => server.close(r));
});

async function connect(): Promise<RelayClient> {
  const c = await RelayClient.connect(url);
  clients.push(c);
  return c;
}

const config: OnlineConfig = { mapId: 'river', hostFaction: 'habu' };

async function pair(): Promise<[OnlineMatch, OnlineMatch, RelayClient, RelayClient]> {
  const host = await connect();
  const guest = await connect();
  const room = await host.create(config);
  const waiting = host.waitForPeer();
  const got = parseConfig(await guest.join(room));
  await waiting;
  return [new OnlineMatch(host, 0, config, room), new OnlineMatch(guest, 1, got, room), host, guest];
}

function cpuItems(m: OnlineMatch, seed: number): PlacementItem[] {
  return generatePlacement(createTerrain(m.config.mapId), m.side, m.factions[m.side], 'normal', new Rng(seed));
}

const tick = () => new Promise((r) => setTimeout(r, 30));

describe('中継サーバー', () => {
  it('存在しない部屋には入れない', async () => {
    const c = await connect();
    await expect(c.join('ZZZZ')).rejects.toMatchObject({ code: 'noRoom' });
  });

  it('3人目は入れない', async () => {
    const [, , host] = await pair();
    const third = await connect();
    const room = [...relay.rooms.keys()][0];
    expect(host).toBeTruthy();
    await expect(third.join(room)).rejects.toMatchObject({ code: 'full' });
  });

  it('プロトコルのバージョンが違う部屋には入らない', async () => {
    const host = await connect();
    const guest = await connect();
    const raw = new WebSocket(url);
    await new Promise((r) => raw.addEventListener('open', r));
    raw.send(JSON.stringify({ t: 'create', config: { ...config, protocol: 999 } }));
    const room = await new Promise<string>((r) => raw.addEventListener('message', (e) => r(JSON.parse(String(e.data)).room)));
    await expect(guest.join(room)).rejects.toBeInstanceOf(RelayError);
    raw.close();
    expect(host).toBeTruthy();
  });

  it('切断すると部屋が消え、相手に通知される', async () => {
    const [a, b, host] = await pair();
    let notified = false;
    b.onPeerLeft(() => (notified = true));
    host.close();
    await tick();
    expect(notified).toBe(true);
    expect(relay.rooms.size).toBe(0);
    await expect(b.exchange(cpuItems(b, 1))).rejects.toBeInstanceOf(OnlineError);
    expect(a).toBeTruthy();
  });
});

describe('オンライン対戦', () => {
  it('両者が同じ対戦セットアップを得て、同じ結果になる', async () => {
    const [a, b] = await pair();
    const [sa, sb] = await Promise.all([a.exchange(cpuItems(a, 1)), b.exchange(cpuItems(b, 2))]);
    expect(sa).toEqual(sb);
    expect(sa.sides[0].faction).toBe('habu');
    expect(sa.sides[1].faction).toBe('mongoose');
    const wa = createWorld(sa);
    const wb = createWorld(sb);
    runToEnd(wa);
    runToEnd(wb);
    const [ra, rb] = await Promise.all([a.compareResult(hashWorld(wa)), b.compareResult(hashWorld(wb))]);
    expect(ra).toBe(true);
    expect(rb).toBe(true);
  });

  it('同期ずれを検出する', async () => {
    const [a, b] = await pair();
    const [ra, rb] = await Promise.all([a.compareResult(1), b.compareResult(2)]);
    expect(ra).toBe(false);
    expect(rb).toBe(false);
  });

  it('もう一戦では新しいシードで対戦する', async () => {
    const [a, b] = await pair();
    const first = await Promise.all([a.exchange(cpuItems(a, 1)), b.exchange(cpuItems(b, 2))]);
    await Promise.all([a.rematch(), b.rematch()]);
    expect(a.round).toBe(1);
    const second = await Promise.all([a.exchange(cpuItems(a, 3)), b.exchange(cpuItems(b, 4))]);
    expect(second[0]).toEqual(second[1]);
    expect(second[0].seed).not.toBe(first[0].seed);
  });

  it('先に確定した側はハッシュだけを送り、相手のコミットが届くまで配置を公開しない', async () => {
    const [a, , , guestClient] = await pair();
    const seen: { k: string; payload?: string }[] = [];
    guestClient.onPeer((d) => seen.push(d as { k: string }));
    let waiting = false;
    const pa = a.exchange(cpuItems(a, 1), () => (waiting = true));
    await tick();
    expect(waiting).toBe(true);
    expect(seen.map((m) => m.k)).toEqual(['commit']);
    expect(JSON.stringify(seen)).not.toContain('items');

    const payload = JSON.stringify({ items: [], nonce: 9 });
    guestClient.send({ k: 'commit', round: 0, hash: sha256Hex(payload + 's') });
    await tick();
    expect(seen.map((m) => m.k)).toEqual(['commit', 'reveal']);
    guestClient.send({ k: 'reveal', round: 0, payload, salt: 's' });
    const setup = await pa;
    expect(setup.sides[1].items).toEqual([]);
  });

  it('確定後に配置をすり替えると検出する', async () => {
    const [a, , , guestClient] = await pair();
    const pa = a.exchange(cpuItems(a, 1));
    const honest = JSON.stringify({ items: [], nonce: 5 });
    const cheat = JSON.stringify({ items: [{ kind: 'unit', type: 'charger', tx: 3, tz: 25, stance: 'advance' }], nonce: 5 });
    guestClient.send({ k: 'commit', round: 0, hash: sha256Hex(honest + 'salt') });
    guestClient.send({ k: 'reveal', round: 0, payload: cheat, salt: 'salt' });
    await expect(pa).rejects.toThrow('一致しません');
  });

  it('予算超過や他陣営の兵など、不正な配置を拒否する', async () => {
    const [a, , , guestClient] = await pair();
    const pa = a.exchange(cpuItems(a, 1));
    // 陣営1はマングース軍。予算を大きく超える配置
    const items = Array.from({ length: 16 }, (_, i) => ({ kind: 'unit', type: 'packLeader', tx: 1 + i, tz: 25, stance: 'advance' }));
    const payload = JSON.stringify({ items, nonce: 1 });
    guestClient.send({ k: 'commit', round: 0, hash: sha256Hex(payload + 's') });
    guestClient.send({ k: 'reveal', round: 0, payload, salt: 's' });
    await expect(pa).rejects.toThrow('予算超過');
  });

  it('形式が壊れた配置を拒否する', async () => {
    const [a, , , guestClient] = await pair();
    const pa = a.exchange(cpuItems(a, 1));
    const payload = JSON.stringify({ items: [{ kind: 'unit', type: '__proto__', tx: 1, tz: 25 }], nonce: 1 });
    guestClient.send({ k: 'commit', round: 0, hash: sha256Hex(payload + 's') });
    guestClient.send({ k: 'reveal', round: 0, payload, salt: 's' });
    await expect(pa).rejects.toThrow('形式が不正');
  });

  it('シードは両者の乱数で決まり、順序に依存する', () => {
    expect(mixSeed(1, 2)).not.toBe(mixSeed(2, 1));
    expect(mixSeed(1, 2)).toBe(mixSeed(1, 2));
  });
});
