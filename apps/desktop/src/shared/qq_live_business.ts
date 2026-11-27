export type QqLiveBusinessEvent =
  | { kind: 'friend-request'; uid: string }
  | { kind: 'friend-add'; uid: string }
  | { kind: 'group-request'; groupCode: string }
  | { kind: 'input-status'; uid: string; speaking: boolean; expiresAt: number }
  | { kind: 'group-mute'; groupCode: string; uid: string; duration: number; at: number }
  | { kind: 'group-essence'; groupCode: string; sequence: string; active: boolean; at: number };

export type QqLiveBusinessBatch = { events: QqLiveBusinessEvent[] } | { disconnected: true };

export interface QqLivePeer {
  peerUin?: string;
  peerName?: string;
  temporary?: true;
  tempSourceGroupCode?: string;
}
