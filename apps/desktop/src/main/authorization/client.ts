import { open } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import type { SessionMaterial, KeyScanResult, KeyScanProgress } from '@weq/native';
import { CredentialRepairRequiredError, getLogger } from '@weq/service';
import {
  AUTHORIZATION_INTERFACE,
  AUTHORIZATION_PROTOCOL,
} from '../../shared/long_term_authorization';
import type { ElevatedCaptureWorker } from '../capture_elevation';
import {
  MAX_AUTHORIZATION_REPLY,
  type AuthorizationRequest,
  type AuthorizationHelperInfo,
} from './protocol';

let configuration: {
  endpoint: () => Promise<string>;
  development?: () => Promise<boolean>;
  /**
   * 是否已经安装过长期授权（manifest 存在）。仅在握手失败时用来区分
   * “旧助手协议不兼容”和“本机根本没装助手”，后者仍应回退临时授权。
   */
  repairRequired?: () => Promise<boolean>;
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

const logger = getLogger().child({ scope: 'authorization' });

/**
 * 助手真的存在、但需要用户修复的错误码。连接失败 /授权 / 未安装仍应
 * 保留临时授权回退；这几种说明“配置本身已不可用”，继续静默回退会让界面
 * 永远停在准备状态。
 */
const REPAIR_CODES = new Set([
  'incompatible',
  'interface-changed',
  'component-expired',
  'channel-mismatch',
]);

export function isAuthorizationRepairError(error: unknown): error is AuthorizationError {
  return error instanceof AuthorizationError && REPAIR_CODES.has(error.code);
}

function repairMessage(error: AuthorizationError): string {
  return `长期授权需要修复：${error.message}`;
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
    return this.exchange(
      0,
      { protocol: AUTHORIZATION_PROTOCOL, interface: AUTHORIZATION_INTERFACE },
      3000,
    ).catch((error: unknown) => {
      // 本地 socket 在握手阶段直接断开，最常见的原因是装的是旧协议助手（它看到
      // 不认识的握手会主动关闭），不要把它伪装成「连接超时」。
      if (error instanceof AuthorizationError && error.code !== 'unavailable') throw error;
      throw new AuthorizationError('权限助手协议不兼容或未响应，请修复长期授权', 'incompatible');
    });
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
    // 接口版本才是「请求/响应契约」的判据。只比 protocol 会让字段已经漂移的旧助手
    // 继续显示 ready，直到某个新功能默默失败。
    if (info.interface !== AUTHORIZATION_INTERFACE)
      throw new AuthorizationError(
        '权限助手接口已更新，请在设置中修复长期授权后重试',
        'interface-changed',
      );
    if (info.validity === 'expired')
      throw new AuthorizationError(
        '原生权限助手已过期，请更新原生组件后修复授权',
        'component-expired',
      );
    const development = await configuration.development?.();
    if (development !== undefined && info.development !== development)
      throw new AuthorizationError('权限助手的开发/正式通道不匹配', 'channel-mismatch');
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
export interface TryLongTermAttachOptions {
  /**
   * 助手存在但需要修复时直接抛 {@link CredentialRepairRequiredError}，而不是
   * 静默返回 null 走临时授权。默认 false，保持抓包/密钥扫描等调用方的回退语义。
   */
  throwOnRepair?: boolean;
}

export async function tryLongTermAttach(
  pid: number,
  signal?: AbortSignal,
  options: TryLongTermAttachOptions = {},
): Promise<SessionMaterial | null> {
  signal?.throwIfAborted();
  let connection: AuthorizationConnection;
  try {
    connection = (await openLongTermAuthorization()).connection;
  } catch (error) {
    signal?.throwIfAborted();
    if (options.throwOnRepair && isAuthorizationRepairError(error)) {
      // 只有确实装过长期授权时才报“需要修复”；否则保留临时 sudo 回退。
      const installed = configuration?.repairRequired ? await configuration.repairRequired() : true;
      if (installed) {
        logger.warn('long-term authorization needs repair; not falling back', {
          event: 'authorization-repair-required',
          pid,
          code: error.code,
          errorMessage: error.message,
        });
        throw new CredentialRepairRequiredError(repairMessage(error), error.code);
      }
    }
    logger.debug('long-term authorization unavailable; using temporary elevation', {
      event: 'authorization-unavailable',
      pid,
      code: error instanceof AuthorizationError ? error.code : 'unknown',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  const cancel = () => connection.close();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    return await connection.request<SessionMaterial>({ op: 'attach', pid });
  } catch (error) {
    signal?.throwIfAborted();
    if (options.throwOnRepair && isAuthorizationRepairError(error)) {
      logger.warn('long-term authorization attach needs repair', {
        event: 'authorization-attach-repair-required',
        pid,
        code: error.code,
        errorMessage: error.message,
      });
      throw new CredentialRepairRequiredError(repairMessage(error), error.code);
    }
    logger.warn('long-term authorization attach failed; using temporary elevation', {
      event: 'authorization-attach-failed',
      pid,
      code: error instanceof AuthorizationError ? error.code : 'unknown',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
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
