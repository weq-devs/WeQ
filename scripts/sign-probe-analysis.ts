/** QQ 签名探测的离线解析；不加载 native，不连接 QQ。 */
import { walkProto, type DumpEntry } from '../packages/protocol/src/msg/dump';
import { protobufSubmessage } from '../packages/protocol/src/oidb/group-album/raw-cells';
import type { CapturedFrame } from '../packages/native/src';

export interface SecInfo {
  sign: number;
  token: number;
  extra: number;
}
export type ProbeStatus = 'signed' | 'unsigned' | 'parse-error' | 'not-captured';
export interface SignInspection {
  status: 'signed' | 'unsigned' | 'parse-error' | 'unmatched';
  secInfo: SecInfo | null;
  reservedTags: number[] | null;
  error?: string;
}
export interface ExpectedRequest {
  wire: string;
  body: Buffer;
}
export interface ProbeInspection {
  status: ProbeStatus;
  sent: boolean;
  secInfo: SecInfo | null;
  reservedTags: number[] | null;
  proto?: number;
  encryptType?: number;
  seq?: number;
  matchedFrames: number;
  unmatchedFrames: number;
  parseErrors: string[];
}

function readSso(
  plain: Buffer,
  protocol: number,
): { command: string; reserved: Buffer; body: Buffer } {
  if (protocol !== 12 && protocol !== 13) throw new Error(`未支持的 SSO 协议 ${protocol}`);
  if (plain.length < 8) throw new Error('SSO 长度头不完整');
  const headLength = plain.readUInt32BE(0);
  if (headLength < 4 || headLength > 65536 || headLength > plain.length - 4) {
    throw new Error('SSO head 长度越界');
  }
  const bodyLength = plain.readUInt32BE(headLength);
  if (bodyLength < 4 || headLength + bodyLength !== plain.length) {
    throw new Error('SSO body 长度越界或存在额外字节');
  }
  const head = plain.subarray(4, headLength);
  // head 有两种布局，方向不同：
  //   请求（c2s）：[seq][subAppId][const][0][0][a2len][a2][0][cmd][cookies][guid][empty][ver(2B)][reserved]
  //   应答（s2c）：[seq][0][0][cmd][cookies][reserved]
  // 早先只认请求布局，把应答帧（cmd 在 offset 12）当请求解，从 offset 24 读到的
  // 是命令串中间字节，于是抛「SSO 字段长度越界」。这里先按两种候选探测 cmd 位置。
  const readerAt = (start: number) => {
    let offset = start;
    const prefixed = (width = 4, label = '?'): Buffer => {
      if (offset + width > head.length)
        throw new Error(
          `SSO 字段前缀截断 [${label}] offset=${offset} width=${width} headLen=${head.length}`,
        );
      const size = width === 4 ? head.readUInt32BE(offset) : head.readUInt16BE(offset);
      if (size < width || size > head.length - offset)
        throw new Error(
          `SSO 字段长度越界 [${label}] offset=${offset} size=${size} remain=${
            head.length - offset
          }`,
        );
      const value = head.subarray(offset + width, offset + size);
      offset += size;
      return value;
    };
    return {
      prefixed,
      get offset() {
        return offset;
      },
      remaining: () => head.length - offset,
    };
  };
  const decoder = new TextDecoder('utf-8', { fatal: true });

  // 候选一：请求布局（proto 12 才有 a2 段；proto 13 从 0 开始）。
  const tryRequest = (): { command: string; reserved: Buffer } => {
    const r = readerAt(protocol === 12 ? 24 : 0);
    if (protocol === 12) r.prefixed(4, 'a2');
    const command = decoder.decode(r.prefixed(4, 'command'));
    r.prefixed(4, 'cookies');
    if (protocol === 12) {
      r.prefixed(4, 'guid');
      r.prefixed(4, 'empty');
      r.prefixed(2, 'version');
    }
    const reserved = r.prefixed(4, 'reserved');
    if (r.offset !== head.length) throw new Error('SSO head 含未解析字段');
    return { command, reserved };
  };

  // 候选二：应答布局 —— [seq][0][0][cmd][cookies][reserved]。
  const tryResponse = (): { command: string; reserved: Buffer } => {
    const r = readerAt(12);
    const command = decoder.decode(r.prefixed(4, 'command'));
    r.prefixed(4, 'cookies');
    const reserved = r.prefixed(4, 'reserved');
    if (r.offset !== head.length) throw new Error('SSO head 含未解析字段');
    return { command, reserved };
  };

  let parsed: { command: string; reserved: Buffer } | undefined;
  let firstError: Error | undefined;
  for (const attempt of [tryRequest, tryResponse]) {
    try {
      parsed = attempt();
      break;
    } catch (error) {
      firstError ??= error instanceof Error ? error : new Error(String(error));
    }
  }
  if (!parsed) throw firstError ?? new Error('SSO head 无法解析');
  return {
    command: parsed.command,
    reserved: parsed.reserved,
    body: plain.subarray(headLength + 4),
  };
}

/** 复用项目 wire 遍历，并拒绝零 tag / 超范围 tag；不把解析失败转成空字段集。 */
function fields(bytes: Uint8Array): DumpEntry[] {
  const entries = walkProto(bytes).filter((entry) => !entry.path.includes('.'));
  if (entries.some((entry) => entry.tag <= 0 || entry.tag > 0x1fffffff)) {
    throw new Error('protobuf 字段号无效');
  }
  return entries;
}

export function inspectSignFrame(
  plain: Buffer,
  protocol: number,
  expected?: ExpectedRequest,
): SignInspection {
  try {
    const { command, reserved, body } = readSso(plain, protocol);
    if (expected && (command !== expected.wire || !body.equals(expected.body))) {
      return { status: 'unmatched', secInfo: null, reservedTags: null };
    }
    const outer = fields(reserved);
    const reservedTags = [...new Set(outer.map((entry) => entry.tag))].sort((a, b) => a - b);
    const secure = outer.filter((entry) => entry.tag === 24);
    if (!secure.length) return { status: 'unsigned', secInfo: null, reservedTags };
    if (secure.length !== 1 || secure[0]!.wire !== 2)
      throw new Error('SecInfo 重复或 wire 类型无效');
    const bytes = protobufSubmessage(reserved, [24]);
    if (!bytes?.length) throw new Error('SecInfo 为空，不能判定签名状态');
    const inner = fields(bytes);
    const size = (tag: number): number => {
      const entries = inner.filter((entry) => entry.tag === tag);
      if (entries.length > 1 || entries.some((entry) => entry.wire !== 2)) {
        throw new Error(`SecInfo 字段重复或类型无效：${tag}`);
      }
      return entries[0]?.len ?? 0;
    };
    const secInfo = { sign: size(1), token: size(2), extra: size(3) };
    if (!secInfo.sign) throw new Error('SecInfo 缺少非空签名字节');
    return { status: 'signed', secInfo, reservedTags };
  } catch (error) {
    return {
      status: 'parse-error',
      secInfo: null,
      reservedTags: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 同名后台请求必须正文也匹配；有效观测互相矛盾时保留未知，不能任取第一帧。 */
export function inspectProbeFrames(
  frames: readonly CapturedFrame[],
  expected: ExpectedRequest,
): ProbeInspection {
  const result: ProbeInspection = {
    status: 'not-captured',
    sent: false,
    secInfo: null,
    reservedTags: null,
    matchedFrames: 0,
    unmatchedFrames: 0,
    parseErrors: [],
  };
  const valid: { frame: CapturedFrame; inspection: SignInspection }[] = [];
  for (const frame of frames) {
    if (frame.direction !== 'c2s' || frame.cmd !== expected.wire) continue;
    if (!frame.plain?.length) continue;
    const inspection = inspectSignFrame(frame.plain, frame.proto, expected);
    if (inspection.status === 'unmatched') {
      result.unmatchedFrames += 1;
      continue;
    }
    result.sent = true;
    if (inspection.status === 'parse-error') {
      const detail = `${frame.direction} seq=${frame.seq} ${inspection.error ?? '解析失败'}`;
      if (result.parseErrors.length < 8 && !result.parseErrors.includes(detail)) {
        result.parseErrors.push(detail);
      }
      continue;
    }
    result.matchedFrames += 1;
    valid.push({ frame, inspection });
  }
  const first = valid[0];
  if (!first) {
    if (result.parseErrors.length) result.status = 'parse-error';
    return result;
  }
  if (valid.some((entry) => entry.inspection.status !== first.inspection.status)) {
    result.status = 'parse-error';
    result.parseErrors.push('同一请求捕获到相互矛盾的签名观测');
    return result;
  }
  result.status = first.inspection.status === 'signed' ? 'signed' : 'unsigned';
  result.secInfo = first.inspection.secInfo;
  result.reservedTags = first.inspection.reservedTags;
  result.proto = first.frame.proto;
  result.encryptType = first.frame.encryptType;
  result.seq = first.frame.seq;
  return result;
}

export function describeProbeStatus(
  result: Pick<ProbeInspection, 'status' | 'secInfo' | 'parseErrors'>,
): string {
  if (result.status === 'signed' && result.secInfo) {
    return (
      '签名 sign=' +
      result.secInfo.sign +
      ' token=' +
      result.secInfo.token +
      ' extra=' +
      result.secInfo.extra
    );
  }
  if (result.status === 'unsigned') return '不签名（reserved 已完整解析且无 tag 24）';
  if (result.status === 'parse-error') return `解析失败：${result.parseErrors.join('；')}`;
  return '未捕获匹配请求';
}
