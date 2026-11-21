import { connect } from 'node:net';
import type { SyncCredential, RecallPolicy } from './proxy';

export const DEFAULT_QQ_SYNC_PORT = 19081;
export const QQ_SYNC_CONTROL_VERSION = 3;

export interface SyncProxyConfig {
  socket: string;
  token: string;
  port: number;
}
export interface SyncProxyStatus {
  running: boolean;
  tunnels: number;
  accounts: string[];
  delivered: number;
  pid: number;
  port?: number;
  error?: string;
  protocolVersion?: number;
  recallError?: string;
  filteredRecalls?: number;
}
export type SyncProxyRequest =
  | { op: 'status' }
  | { op: 'listen'; port?: number }
  | { op: 'recall-policy'; uin: string; generation: string; value: RecallPolicy }
  | { op: 'recall-events'; uin: string; generation: string; ack: string[] }
  | { op: 'credential'; value: SyncCredential }
  | { op: 'forget'; uin: string }
  | { op: 'push'; uin: string; generation: string; identity: string; body: string };

export function requestProxy<T>(
  config: SyncProxyConfig,
  request: SyncProxyRequest,
  timeoutMs = 15000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = connect(config.socket);
    let buffer = '';
    let finished = false;
    const finish = (error?: Error, value?: T) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error('QQ 同步代理响应超时')), timeoutMs);
    socket.on('error', (error) => finish(error));
    socket.on('close', () => {
      if (!finished) finish(new Error('QQ 同步代理连接中断'));
    });
    socket.once('connect', () =>
      socket.write(`${JSON.stringify({ ...request, token: config.token })}\n`),
    );
    socket.on('data', (data) => {
      buffer += data.toString();
      if (buffer.length > 4 * 1024 * 1024) return finish(new Error('QQ 同步状态响应过大'));
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, end));
        if (response.ok) finish(undefined, response.result);
        else finish(new Error(response.error || 'QQ 同步代理请求失败'));
      } catch {
        finish(new Error('QQ 同步代理响应无效'));
      }
    });
  });
}
