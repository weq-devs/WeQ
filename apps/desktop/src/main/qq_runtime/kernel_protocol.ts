export interface QQKernelOptions {
  instanceId: string;
  nonce: string;
  wrapperPath: string;
  dataRoot: string;
  client: { appId: string; version: string; qua: string };
  device: { hostName: string; osVersion: string };
  expectedUin?: string;
}

export type QQKernelCommand =
  | { type: 'boot'; options: QQKernelOptions }
  | { type: 'login'; instanceId: string; nonce: string; uin?: string }
  | { type: 'refresh-qr' | 'stop' | 'health'; instanceId: string; nonce: string };

export type QQKernelEvent = {
  instanceId: string;
  pid: number;
} & (
  | { type: 'initialized'; exportCount: number }
  | { type: 'stopping'; stage: string }
  | { type: 'connecting' | 'connected' | 'disconnected' | 'scanned' | 'qr-expired' | 'stopped' }
  | { type: 'qr'; pngBase64: string; url: string }
  | { type: 'login'; uin: string; uid: string }
  | { type: 'session-initialized'; uin: string; uid: string; guid: string; dataRoot: string }
  | { type: 'network'; status: number }
  | { type: 'health'; connected: boolean; loggedIn: boolean }
  | { type: 'verification'; url: string | null }
  | { type: 'error'; code: string; message: string; retryable: boolean }
);
