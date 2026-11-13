/** 复用已安装的长期授权助手；脚本本身保持普通用户身份。 */
import { isAbsolute } from 'node:path';
import type { CapturedFrame, NtHelperBinding } from '../packages/native/src';
import {
  configureLongTermAuthorization,
  openLongTermAuthorization,
  type AuthorizationConnection,
} from '../apps/desktop/src/main/authorization/client';
import type {
  CaptureBatchWire,
  CaptureSessionWire,
  CaptureStatsWire,
} from '../apps/desktop/src/main/capture_protocol';

export type SignProbeBackend = Pick<
  NtHelperBinding,
  'scanSessionMaterial' | 'startCapture' | 'takeFrames' | 'stopCapture'
>;

/** 调试器只读提取的本轮物料；不接受其他进程或损坏的 key。 */
export function parseProbeMaterial(value: unknown, pid: number): { d2Key: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('会话物料必须是 JSON 对象');
  const row = value as Record<string, unknown>;
  if (row.pid !== pid || typeof row.d2Key !== 'string' || !/^[0-9a-f]{32}$/i.test(row.d2Key))
    throw new Error('会话物料的 PID 或 d2key 无效');
  return { d2Key: row.d2Key };
}

export function decodeSignProbeBatch(batch: CaptureBatchWire): {
  frames: CapturedFrame[];
  nextCursor: number;
  dropped: number;
} {
  const bytes = (hex: string): Buffer => {
    if (typeof hex !== 'string' || !/^(?:[0-9a-f]{2})*$/i.test(hex))
      throw new Error('权限助手返回了无效的抓包 hex');
    return Buffer.from(hex, 'hex');
  };
  return {
    nextCursor: batch.nextCursor,
    dropped: batch.dropped,
    frames: batch.frames.map((frame) => ({
      cursor: frame.cursor,
      ts: frame.ts,
      direction: frame.direction,
      proto: frame.proto,
      encryptType: frame.encryptType,
      seq: frame.seq,
      cmd: frame.cmd ?? undefined,
      raw: bytes(frame.rawHex),
      plain: bytes(frame.plainHex),
      body: bytes(frame.bodyHex),
    })),
  };
}

export function authorizedSignProbeBackend(
  connection: Pick<AuthorizationConnection, 'request'>,
): SignProbeBackend {
  return {
    scanSessionMaterial: (pid) => connection.request({ op: 'attach', pid }),
    startCapture: (pid, options) =>
      connection.request<CaptureSessionWire>({
        op: 'start',
        pid,
        iface: options?.iface,
        port: options?.port,
        d2key: options?.d2Key,
        transport: options?.transport,
        ringFrames: options?.ringFrames,
      }),
    takeFrames: async (pid, options) =>
      decodeSignProbeBatch(
        await connection.request<CaptureBatchWire>({ op: 'take', pid, ...options }),
      ),
    stopCapture: (pid) => connection.request<CaptureStatsWire>({ op: 'stop', pid }),
  };
}

export async function openAuthorizedSignProbe(endpoint: string): Promise<{
  backend: SignProbeBackend;
  close: () => void;
}> {
  if (!isAbsolute(endpoint)) throw new Error('权限助手端点必须是本机绝对路径');
  configureLongTermAuthorization({ endpoint: async () => endpoint });
  const { connection } = await openLongTermAuthorization();
  return { backend: authorizedSignProbeBackend(connection), close: () => connection.close() };
}
