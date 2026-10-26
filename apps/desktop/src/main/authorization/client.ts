import { open } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import type { SessionMaterial, KeyScanResult, KeyScanProgress } from '@weq/native';
import { AUTHORIZATION_PROTOCOL } from '../../shared/long_term_authorization';
import type { ElevatedCaptureWorker } from '../capture_elevation';
import {
  MAX_AUTHORIZATION_REPLY,
  type AuthorizationRequest,
  type AuthorizationHelperInfo,
} from './protocol';

let configuration: {
  endpoint: () => Promise<string>;
  development?: () => Promise<boolean>;
} | null = null;
export function configureLongTermAuthorization(value: NonNullable<typeof configuration>): void {
  configuration = value;
}
export class AuthorizationError extends Error {
  constructor(
    message: string,
    readonly code = 'unavailable',
  ) {
    super(message);
  }
}
export class AuthorizationConnection {
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      progress?: (value: KeyScanProgress) => void;
    }
  >();
  constructor(private readonly socket: Socket) {
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > MAX_AUTHORIZATION_REPLY) return this.close();
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const reply = JSON.parse(line) as {
            id: number;
            ok?: boolean;
            result?: unknown;
            error?: string;
            code?: string;
            progress?: KeyScanProgress;
          };
          const pending = this.pending.get(reply.id);
          if (!pending) continue;
          if (reply.progress) {
            pending.progress?.(reply.progress);
            continue;
          }
          this.pending.delete(reply.id);
          if (reply.ok) pending.resolve(reply.result);
          else
            pending.reject(new AuthorizationError(reply.error || '长期授权操作失败', reply.code));
        } catch {
          this.close();
        }
      }
    });
    const fail = () => {
      for (const pending of this.pending.values())
        pending.reject(new AuthorizationError('长期授权连接已断开'));
      this.pending.clear();
      socket.destroy();
    };
    socket.on('error', fail);
    socket.on('close', fail);
  }
  private exchange<T>(
    id: number,
    payload: unknown,
    timeout: number,
    progress?: (value: KeyScanProgress) => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close();
        reject(new AuthorizationError('长期授权请求超时'));
      }, timeout);
      const finish = (action: () => void) => {
        clearTimeout(timer);
        action();
      };
      if (this.socket.destroyed) {
        finish(() => reject(new AuthorizationError('长期授权连接不可用')));
        return;
      }
      this.pending.set(id, {
        resolve: (value) => finish(() => resolve(value as T)),
        reject: (error) => finish(() => reject(error)),
        progress,
      });
      this.socket.write(`${JSON.stringify(payload)}\n`);
    });
  }
  authenticate(): Promise<unknown> {
    return this.exchange(0, { protocol: AUTHORIZATION_PROTOCOL }, 3000);
  }
  request<T>(
    request: Omit<AuthorizationRequest, 'id'>,
    timeout = 60_000,
    progress?: (value: KeyScanProgress) => void,
  ): Promise<T> {
    const id = ++this.sequence;
    return this.exchange(id, { ...request, id }, timeout, progress);
  }
  close(): void {
    this.socket.destroy();
  }
}

export async function openLongTermAuthorization(): Promise<{
  connection: AuthorizationConnection;
  info: AuthorizationHelperInfo;
}> {
  if (!configuration) throw new AuthorizationError('当前宿主未提供长期授权');
  const connection = new AuthorizationConnection(connect(await configuration.endpoint()));
  try {
    await connection.authenticate();
    const info = await connection.request<AuthorizationHelperInfo>({ op: 'status', pid: 0 }, 3000);
    if (
      info.protocol !== AUTHORIZATION_PROTOCOL ||
      !['attach', 'key-scan', 'capture'].every((name) => info.capabilities?.includes(name))
    )
      throw new AuthorizationError('权限助手协议不兼容，请在设置中更新助手', 'incompatible');
    if (info.validity === 'expired')
      throw new AuthorizationError(
        '原生权限助手已过期，请更新原生组件后修复授权',
        'component-expired',
      );
    const development = await configuration.development?.();
    if (
      (development === true && info.development !== true) ||
      (development === false && info.development === true)
    )
      throw new AuthorizationError('权限助手的开发/正式通道不匹配', 'incompatible');
    // 普通 app/.node 更新不使兼容的系统授权失效。
    return { connection, info };
  } catch (error) {
    connection.close();
    throw error;
  }
}
export async function connectLongTermAuthorization(): Promise<AuthorizationConnection | null> {
  try {
    return (await openLongTermAuthorization()).connection;
  } catch {
    return null;
  }
}
export async function tryLongTermAttach(
  pid: number,
  signal?: AbortSignal,
): Promise<SessionMaterial | null> {
  signal?.throwIfAborted();
  const connection = await connectLongTermAuthorization();
  if (!connection) return null;
  const cancel = () => connection.close();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    return await connection.request<SessionMaterial>({ op: 'attach', pid });
  } finally {
    signal?.removeEventListener('abort', cancel);
    connection.close();
  }
}
export async function tryLongTermKeyScan(
  dbPath: string,
  pid: number,
  progress?: (value: KeyScanProgress) => void,
): Promise<KeyScanResult | null> {
  const connection = await connectLongTermAuthorization();
  if (!connection) return null;
  try {
    const file = await open(dbPath, 'r');
    const sample = Buffer.alloc(5120);
    try {
      let position = 0;
      while (position < sample.length) {
        const { bytesRead } = await file.read(sample, position, sample.length - position, position);
        if (!bytesRead) throw new Error('数据库头不足 5120 字节，无法扫描密钥');
        position += bytesRead;
      }
    } finally {
      await file.close();
    }
    return await connection.request<KeyScanResult>(
      { op: 'key-scan', pid, databaseSample: sample.toString('base64') },
      10 * 60_000,
      progress,
    );
  } finally {
    connection.close();
  }
}
export async function tryLongTermCaptureWorker(): Promise<ElevatedCaptureWorker | null> {
  const connection = await connectLongTermAuthorization();
  if (!connection) return null;
  return {
    euid: 0,
    request: (request, timeout) => connection.request(request, timeout),
    dispose: () => connection.close(),
  };
}
