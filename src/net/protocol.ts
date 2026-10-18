// 中継サーバーとクライアントの間のメッセージ。
// サーバーは部屋の管理と転送だけを行い、ゲームの中身は見ない（検証もしない）。

export const PROTOCOL_VERSION = 1;
export const RELAY_PATH = '/ws';
export const ROOM_CODE_LENGTH = 4;
/** 読み間違えやすい文字（0/O、1/I）を除いた部屋コードの文字 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export type ClientMessage =
  | { t: 'create'; config: unknown }
  | { t: 'join'; room: string }
  | { t: 'relay'; data: unknown }
  | { t: 'leave' };

export type ServerErrorCode = 'noRoom' | 'full' | 'badMessage' | 'notInRoom';

export type ServerMessage =
  | { t: 'created'; room: string }
  | { t: 'joined'; room: string; config: unknown }
  | { t: 'peerJoined' }
  | { t: 'peer'; data: unknown }
  | { t: 'peerLeft' }
  | { t: 'error'; code: ServerErrorCode };

export function normalizeRoomCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LENGTH);
}
