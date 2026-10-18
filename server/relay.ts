// オンライン対戦の中継サーバー。部屋コードで2人をつなぎ、メッセージを相手に転送する。
// 仕様どおり、不正対策はクライアント同期のみで、サーバーは配置も結果も検証しない。

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  RELAY_PATH, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH,
  type ClientMessage, type ServerMessage,
} from '../src/net/protocol';

interface Room {
  code: string;
  host: WebSocket;
  guest: WebSocket | null;
  config: unknown;
}

const MAX_PAYLOAD = 64 * 1024;
const HEARTBEAT_MS = 30_000;

export interface Relay {
  readonly rooms: ReadonlyMap<string, Room>;
  close(): void;
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function parse(raw: unknown): ClientMessage | null {
  try {
    const m = JSON.parse(String(raw)) as ClientMessage;
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return null;
    if (m.t === 'join' && typeof m.room !== 'string') return null;
    return m;
  } catch {
    return null;
  }
}

/** HTTP サーバーの RELAY_PATH への WebSocket 接続を引き受ける（他のパスは触らない） */
export function attachRelay(server: Server): Relay {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const rooms = new Map<string, Room>();
  const roomOf = new Map<WebSocket, Room>();
  const alive = new WeakMap<WebSocket, boolean>();

  const newCode = (): string => {
    for (;;) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
      if (!rooms.has(code)) return code;
    }
  };

  const leave = (ws: WebSocket) => {
    const room = roomOf.get(ws);
    if (!room) return;
    roomOf.delete(ws);
    const peer = room.host === ws ? room.guest : room.host;
    if (peer) {
      roomOf.delete(peer);
      send(peer, { t: 'peerLeft' });
    }
    rooms.delete(room.code);
  };

  wss.on('connection', (ws) => {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    ws.on('message', (raw) => {
      const msg = parse(raw);
      if (!msg) return send(ws, { t: 'error', code: 'badMessage' });
      switch (msg.t) {
        case 'create': {
          leave(ws);
          const room: Room = { code: newCode(), host: ws, guest: null, config: msg.config };
          rooms.set(room.code, room);
          roomOf.set(ws, room);
          return send(ws, { t: 'created', room: room.code });
        }
        case 'join': {
          const room = rooms.get(msg.room.toUpperCase());
          if (!room) return send(ws, { t: 'error', code: 'noRoom' });
          if (room.guest || room.host === ws) return send(ws, { t: 'error', code: 'full' });
          leave(ws);
          room.guest = ws;
          roomOf.set(ws, room);
          send(ws, { t: 'joined', room: room.code, config: room.config });
          return send(room.host, { t: 'peerJoined' });
        }
        case 'relay': {
          const room = roomOf.get(ws);
          const peer = room && (room.host === ws ? room.guest : room.host);
          if (!peer) return send(ws, { t: 'error', code: 'notInRoom' });
          return send(peer, { t: 'peer', data: msg.data });
        }
        case 'leave':
          return leave(ws);
        default:
          return send(ws, { t: 'error', code: 'badMessage' });
      }
    });
    ws.on('close', () => leave(ws));
    ws.on('error', () => leave(ws));
  });

  // 応答のない接続を切る（スマホのスリープなど）
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_MS);

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== RELAY_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };
  server.on('upgrade', onUpgrade);

  return {
    rooms,
    close() {
      clearInterval(heartbeat);
      server.off('upgrade', onUpgrade);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
