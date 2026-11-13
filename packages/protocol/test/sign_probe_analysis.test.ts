import { describe, expect, it } from 'vitest';
import {
  inspectSignFrame,
  inspectProbeFrames,
  describeProbeStatus,
} from '../../../scripts/sign-probe-analysis';
import type { CapturedFrame } from '@weq/native';

const prefix = (bytes: Buffer, width = 4): Buffer => {
  const length = Buffer.alloc(width);
  if (width === 4) length.writeUInt32BE(width + bytes.length);
  else length.writeUInt16BE(width + bytes.length);
  return Buffer.concat([length, bytes]);
};

// 布局另与 nt_helper/src/sso/packer.rs 的 build_sso_layer12/13 核对。
const frame = (reserved: Buffer, protocol = 13, body = Buffer.alloc(0)): Buffer => {
  const common = [prefix(Buffer.from('fixture.command')), prefix(Buffer.alloc(0))];
  const head =
    protocol === 12
      ? [
          Buffer.alloc(24),
          prefix(Buffer.alloc(0)),
          ...common,
          prefix(Buffer.from('synthetic-guid')),
          prefix(Buffer.alloc(0)),
          prefix(Buffer.from('1.0'), 2),
        ]
      : common;
  return Buffer.concat([prefix(Buffer.concat([...head, prefix(reserved)])), prefix(body)]);
};
const signed = Buffer.from('c2010c0a04010203041201aa1a01bb', 'hex');

describe('签名探测帧判定', () => {
  it('独立硬编码的 proto 13 空 reserved 向量确认为不签名', () => {
    const bytes = Buffer.from('0000001300000007636d64000000040000000400000004', 'hex');
    expect(inspectSignFrame(bytes, 13)).toMatchObject({
      status: 'unsigned',
      secInfo: null,
      reservedTags: [],
    });
  });

  it.each([12, 13])('协议 %i 解析真实结构的 SecInfo，只输出三段长度', (protocol) => {
    expect(inspectSignFrame(frame(signed, protocol), protocol)).toMatchObject({
      status: 'signed',
      secInfo: { sign: 4, token: 1, extra: 1 },
      reservedTags: [24],
    });
  });

  it('有其他合法 reserved 字段但没有 tag 24 才判不签名', () => {
    expect(inspectSignFrame(frame(Buffer.from('08011501020304', 'hex')), 13)).toMatchObject({
      status: 'unsigned',
      reservedTags: [1, 2],
    });
  });

  it.each([
    ['长度字段截断', 'c20108'],
    ['SecInfo 子消息截断', 'c201030a04ff'],
    ['fixed64 截断', '0900'],
    ['fixed32 截断', '1500'],
    ['varint 截断', '0880'],
    ['零字段号', '00'],
    ['SecInfo 类型不符', 'c00101'],
    ['空 SecInfo', 'c20100'],
    ['重复 SecInfo', 'c201030a01ffc201030a01ff'],
    ['SecInfo 缺少 sign', 'c201031201aa'],
    ['SecInfo 的 sign 类型不符', 'c201020801'],
  ])('%s 必须报解析失败，不能当作不签名', (_label, hex) => {
    expect(inspectSignFrame(frame(Buffer.from(hex, 'hex')), 13)).toMatchObject({
      status: 'parse-error',
      secInfo: null,
    });
  });

  it.each([0, 11, 99])('未支持的协议 %i 不猜成 proto 13', (protocol) => {
    expect(inspectSignFrame(frame(Buffer.alloc(0)), protocol)).toMatchObject({
      status: 'parse-error',
    });
  });

  it('SSO head 长度越界不能被 subarray 静默裁切后判不签名', () => {
    const bytes = frame(Buffer.alloc(0));
    bytes.writeUInt32BE(bytes.length + 100);
    expect(inspectSignFrame(bytes, 13)).toMatchObject({ status: 'parse-error' });
  });

  it('字段长度小于自身前缀时解析失败', () => {
    const bytes = frame(Buffer.alloc(0));
    bytes.writeUInt32BE(3, 4);
    expect(inspectSignFrame(bytes, 13)).toMatchObject({ status: 'parse-error' });
  });

  it('正文截断不能作为有效观测', () => {
    const bytes = frame(Buffer.alloc(0), 13, Buffer.from([1, 2]));
    expect(inspectSignFrame(bytes.subarray(0, -1), 13)).toMatchObject({ status: 'parse-error' });
  });

  it('同名请求但正文不同，不算本次探测命中', () => {
    expect(
      inspectSignFrame(frame(signed, 13, Buffer.from([1])), 13, {
        wire: 'fixture.command',
        body: Buffer.from([2]),
      }),
    ).toMatchObject({ status: 'unmatched' });
  });
});

describe('探测观测汇总', () => {
  const request = { wire: 'fixture.command', body: Buffer.from([1]) };
  const sample = (reserved: Buffer, body = request.body): CapturedFrame => ({
    cursor: 1,
    ts: 1,
    seq: 10,
    direction: 'c2s',
    proto: 13,
    encryptType: 1,
    cmd: request.wire,
    plain: frame(reserved, 13, body),
    body,
    raw: Buffer.alloc(0),
  });

  it('没看到匹配请求不能报告为不签名或声称 QQ 没发出', () => {
    const result = inspectProbeFrames([sample(signed, Buffer.from([2]))], request);
    expect(result).toMatchObject({ status: 'not-captured', sent: false, unmatchedFrames: 1 });
    expect(describeProbeStatus(result)).toBe('未捕获匹配请求');
  });

  it('忽略服务端响应及其他命令，不能混入签名判断', () => {
    const value = sample(signed);
    expect(
      inspectProbeFrames(
        [
          { ...value, direction: 's2c' },
          { ...value, cmd: 'other.command' },
        ],
        request,
      ),
    ).toMatchObject({ status: 'not-captured' });
  });

  it('先有坏帧后捕获完整匹配帧，保留失败诊断并采用完整观测', () => {
    const broken = sample(Buffer.alloc(0));
    broken.plain = broken.plain!.subarray(0, -1);
    expect(inspectProbeFrames([broken, sample(signed)], request)).toMatchObject({
      status: 'signed',
      matchedFrames: 1,
      parseErrors: [expect.any(String)],
      secInfo: { sign: 4, token: 1, extra: 1 },
    });
  });

  it('同一请求签名观测矛盾时不任取第一帧', () => {
    const result = inspectProbeFrames([sample(signed), sample(Buffer.alloc(0))], request);
    expect(result).toMatchObject({ status: 'parse-error', secInfo: null });
    expect(describeProbeStatus(result)).toContain('相互矛盾');
  });
});
