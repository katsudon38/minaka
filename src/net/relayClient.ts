// 中継サーバーとの接続。部屋を作る・入る・相手にデータを送る。

import { PROTOCOL_VERSION, RELAY_PATH, type ClientMessage, type ServerErrorCode, type ServerMessage } from './protocol';

export class RelayError extends Error {
  constructor(readonly code: ServerErrorCode | 'connect' | 'closed' | 'version', message: string) {
    super(message);
  }
}

const ERROR_TEXT: Record<ServerErrorCode, string> = {
  noRoom: 'その部屋コードの部屋はありません',
  full: 'その部屋はすでに対戦中です',
  badMessage: '通信データが不正です',
  notInRoom: '部屋に入っていません',
};

/** 既定の接続先：ページと同じホストの RELAY_PATH（VITE_RELAY_URL で変更できる） */
export function defaultRelayUrl(): string {
  const env = import.meta.env?.VITE_RELAY_URL as string | undefined;
  if (env) return env;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${RELAY_PATH}`;
}

type Waiter = { types: ServerMessage['t'][]; resolve: (m: ServerMessage) => void; reject: (e: Error) => void };

export class RelayClient {
  private waiters: Waiter[] = [];
  private peerHandler: (data: unknown) => void = () => {};
  private peerLeftHandler: () => void = () => {};
  private closeHandler: () => void = () => {};
  private closed = false;

  private constructor(private ws: WebSocket) {
    ws.addEventListener('message', (e) => this.onMessage(String(e.data)));
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w.reject(new RelayError('closed', 'サーバーとの接続が切れました'));
      this.closeHandler();
    });
  }

  static connect(url = defaultRelayUrl(), timeoutMs = 8000): Promise<RelayClient> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        reject(new RelayError('connect', 'サーバーに接続できません'));
        return;
      }
      const timer = setTimeout(() => {
        ws.close();
        reject(new RelayError('connect', 'サーバーに接続できません（タイムアウト）'));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new RelayClient(ws));
      }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new RelayError('connect', 'サーバーに接続できません'));
      }, { once: true });
    });
  }

  private onMessage(raw: string): void {
    let m: ServerMessage;
    try {
      m = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    if (m.t === 'peer') return this.peerHandler(m.data);
    if (m.t === 'peerLeft') {
      for (const w of this.waiters.splice(0)) w.reject(new RelayError('closed', '相手が切断しました'));
      return this.peerLeftHandler();
    }
    const i = this.waiters.findIndex((w) => w.types.includes(m.t) || m.t === 'error');
    if (i < 0) return;
    const [w] = this.waiters.splice(i, 1);
    if (m.t === 'error') w.reject(new RelayError(m.code, ERROR_TEXT[m.code]));
    else w.resolve(m);
  }

  private request<T extends ServerMessage['t']>(msg: ClientMessage | null, ...types: T[]): Promise<Extract<ServerMessage, { t: T }>> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new RelayError('closed', 'サーバーとの接続が切れました'));
        return;
      }
      this.waiters.push({ types, resolve: resolve as (m: ServerMessage) => void, reject });
      if (msg) this.ws.send(JSON.stringify(msg));
    });
  }

  /** 部屋を作り、部屋コードを返す */
  async create(config: object): Promise<string> {
    const m = await this.request({ t: 'create', config: { ...config, protocol: PROTOCOL_VERSION } }, 'created');
    return m.room;
  }

  /** 相手が部屋に入るのを待つ（部屋を作った側） */
  async waitForPeer(): Promise<void> {
    await this.request(null, 'peerJoined');
  }

  /** 部屋に入り、部屋の設定を返す */
  async join(room: string): Promise<unknown> {
    const m = await this.request({ t: 'join', room }, 'joined');
    const config = m.config as { protocol?: number } | null;
    if (!config || config.protocol !== PROTOCOL_VERSION) {
      this.leave();
      throw new RelayError('version', '相手とゲームのバージョンが違います。ページを再読み込みしてください');
    }
    return config;
  }

  send(data: unknown): void {
    if (!this.closed) this.ws.send(JSON.stringify({ t: 'relay', data } satisfies ClientMessage));
  }

  onPeer(handler: (data: unknown) => void): void {
    this.peerHandler = handler;
  }

  onPeerLeft(handler: () => void): void {
    this.peerLeftHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  leave(): void {
    if (!this.closed) this.ws.send(JSON.stringify({ t: 'leave' } satisfies ClientMessage));
  }

  close(): void {
    this.closed = true;
    this.ws.close();
  }
}
