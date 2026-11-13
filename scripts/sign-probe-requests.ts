/** 探测请求的纯数据解析；显式请求正文与占位正文分开记录。 */
import { encode, message } from '../packages/protocol/src/protobuf';
import { posix, win32 } from 'node:path';

export function validateControlSocketPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!(platform === 'win32' ? win32 : posix).isAbsolute(path))
    throw new Error('控制 socket 必须为本机绝对路径');
  const maximum = platform === 'darwin' ? 103 : platform === 'linux' ? 107 : undefined;
  if (maximum !== undefined && Buffer.byteLength(path) > maximum) {
    throw new Error(
      `控制 socket 路径超过 ${platform} 的 ${maximum} 字节上限，请使用更短的 runtime 目录`,
    );
  }
  return path;
}

export interface ProbeCase {
  wire: string;
  body: Buffer;
  bodySource: 'explicit' | 'placeholder';
}

// 与 nt_helper/src/protocol/oidb.rs 的 OidbBase 对齐；UIN-form 是 tag 12，不是 tag 6。
const OIDB_ENVELOPE = message([
  { name: 'command', tag: 1, type: 'uint32' },
  { name: 'subCommand', tag: 2, type: 'uint32' },
  { name: 'body', tag: 4, type: 'bytes' },
  { name: 'reserved', tag: 12, type: 'int32' },
]);

export function buildOidbEnvelope(
  command: number,
  subCommand: number,
  body: Buffer,
  isUid = false,
): Buffer {
  for (const value of [command, subCommand]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
      throw new Error('OIDB 命令或子命令超出 uint32');
    }
  }
  return Buffer.from(encode(OIDB_ENVELOPE, { command, subCommand, body, reserved: isUid ? 1 : 0 }));
}

export function parseCase(spec: string, explicitBody?: Buffer, isUid = false): ProbeCase {
  if (!spec || spec !== spec.trim() || spec.length > 512 || /\s/.test(spec)) {
    throw new Error('探测命令必须为非空且不含空白的命令串');
  }
  const body = explicitBody ?? Buffer.from([0x0a, 0x00]);
  const bodySource = explicitBody === undefined ? 'placeholder' : 'explicit';
  const oidb = /^(?:OidbSvcTrpcTcp\.)?(?:0x)?([0-9a-f]+)_(\d+)$/i.exec(spec);
  if (!oidb) {
    if (isUid) throw new Error('raw 命令不能指定 OIDB isUid');
    return { wire: spec, body, bodySource };
  }
  const command = Number.parseInt(oidb[1]!, 16);
  const subCommand = Number(oidb[2]);
  return {
    wire: `OidbSvcTrpcTcp.0x${command.toString(16)}_${subCommand}`,
    body: buildOidbEnvelope(command, subCommand, body, isUid),
    bodySource,
  };
}

/** bodyHex 是业务 inner body；OIDB 信封统一组装，避免二次套壳。 */
export function parseRequestCases(value: unknown): ProbeCase[] {
  if (!Array.isArray(value) || !value.length || value.length > 256) {
    throw new Error('请求清单必须为 1 至 256 条的数组');
  }
  return value.map((entry: unknown, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('请求条目必须为对象');
    const row = entry as Record<string, unknown>;
    if (Object.keys(row).some((key) => !['cmd', 'bodyHex', 'isUid'].includes(key))) {
      throw new Error(`请求条目存在未知字段：${index + 1}`);
    }
    if (
      typeof row.cmd !== 'string' ||
      typeof row.bodyHex !== 'string' ||
      !/^(?:[0-9a-f]{2})*$/i.test(row.bodyHex)
    ) {
      throw new Error(`请求条目的 cmd 或 bodyHex 无效：${index + 1}`);
    }
    if (
      row.bodyHex.length > 2 * 1024 * 1024 ||
      (row.isUid !== undefined && typeof row.isUid !== 'boolean')
    ) {
      throw new Error('请求正文超过 1 MiB 或 isUid 类型无效');
    }
    return parseCase(row.cmd, Buffer.from(row.bodyHex, 'hex'), row.isUid === true);
  });
}
