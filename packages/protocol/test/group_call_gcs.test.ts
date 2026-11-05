/**
 * 群通话 `0x28` 控制面回归测试。
 *
 * 三份抓包里 k2 只在认证成功后下发一次，所以这些样本是「协议理解」的唯一依据：
 * 一旦 `buildGroupGcsHead` 的字段顺序或默认值改错，字节立刻对不上。
 */

import { describe, expect, it } from 'vitest';
import { encode } from '../src/protobuf';
import {
  GROUP_GCS_ETX,
  GROUP_GCS_STX,
  GROUP_SESSION_KEY_LEN,
  GROUP_MULTI_TERMINAL_REQ,
  MultiTerminalSync,
  buildGroupGcsAck,
  buildGroupGcsHead,
  buildGroupGcsPacket,
  extractGroupSessionKey,
  parseGroupGcsPacket,
  parseGroupSessionKeyPush,
} from '../src/group-call';
import {
  gcsKeyPush,
  gcsKeyPushAck,
  gcsSimplifyPush,
  multiTerminalSyncReq,
} from './fixtures/group_call_capture';

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

describe('0x28 包格式', () => {
  it('起始符与结束符', () => {
    expect(gcsKeyPush[0]).toBe(GROUP_GCS_STX);
    expect(gcsKeyPush[gcsKeyPush.length - 1]).toBe(GROUP_GCS_ETX);
  });

  it('解析出 head 与 body', () => {
    const packet = parseGroupGcsPacket(gcsKeyPush)!;
    expect(packet).not.toBeNull();
    expect(packet.body.length).toBeGreaterThan(0);
  });

  it('head 是「外层 f1=1 | f2=<inner>」的嵌套结构', () => {
    const packet = parseGroupGcsPacket(gcsKeyPush)!;
    expect(packet.head.sessionId).toBeGreaterThan(0);
    expect(packet.head.selfUin).toBe(1707889225);
  });

  it('首字节不是 0x28 时返回 null', () => {
    expect(parseGroupGcsPacket(new Uint8Array([0x29, 0, 0]))).toBeNull();
  });

  it('body 长度字段与 head 长度字段都对得上实际字节', () => {
    const packet = parseGroupGcsPacket(gcsKeyPush)!;
    // 包总长 = 9 字节前缀（STX + 两个 4 字节长度）+ head + body + 1 字节结束符
    const headLen =
      (gcsKeyPush[1]! << 24) | (gcsKeyPush[2]! << 16) | (gcsKeyPush[3]! << 8) | gcsKeyPush[4]!;
    const bodyLen =
      (gcsKeyPush[5]! << 24) | (gcsKeyPush[6]! << 16) | (gcsKeyPush[7]! << 8) | gcsKeyPush[8]!;
    expect(gcsKeyPush.length).toBe(9 + headLen + bodyLen + 1);
    expect(packet.body.length).toBe(bodyLen);
  });
});

describe('会话密钥 k2', () => {
  it('从下发包的 body.f3.f2 取出 88 字节密钥', () => {
    const packet = parseGroupGcsPacket(gcsKeyPush)!;
    const key = extractGroupSessionKey(packet.body)!;
    expect(key).not.toBeNull();
    expect(key.length).toBe(GROUP_SESSION_KEY_LEN);
    expect(toHex(key).startsWith('6a74c840')).toBe(true);
  });

  it('简化头推送（hl=63，没有 f6）里没有密钥', () => {
    const packet = parseGroupGcsPacket(gcsSimplifyPush)!;
    expect(extractGroupSessionKey(packet.body)).toBeNull();
  });

  it('parseGroupSessionKeyPush 带出调试用的 streams', () => {
    const packet = parseGroupGcsPacket(gcsKeyPush)!;
    const push = parseGroupSessionKeyPush(packet.body)!;
    expect(push).not.toBeNull();
    expect(push.streams.length).toBeGreaterThan(0);
    expect(push.key.length).toBe(GROUP_SESSION_KEY_LEN);
  });

  it('body 不是下发包时返回 null', () => {
    expect(extractGroupSessionKey(new Uint8Array(0))).toBeNull();
    expect(extractGroupSessionKey(Uint8Array.from([0x0a, 0x01, 0x00]))).toBeNull();
  });
});

describe('应答', () => {
  it('对 k2 下发包的应答与抓包逐字节相同（f1/f2 都按本端那一路）', () => {
    const received = parseGroupGcsPacket(gcsKeyPush)!;
    const key = extractGroupSessionKey(received.body)!;
    // 抓包里下发包是 f1=23552/f2=278，应答是 f1=612176395/f2=284 —— 两条不同的流。
    const built = buildGroupGcsAck({ key, sessionId: 612176395, seq: 284 }, received.head);
    expect(toHex(built)).toBe(toHex(gcsKeyPushAck));
  });

  it('应答不照抄收到那条的 f1/f2', () => {
    const received = parseGroupGcsPacket(gcsKeyPush)!;
    const ack = parseGroupGcsPacket(buildGroupGcsAck({ sessionId: 1, seq: 2 }, received.head))!;
    expect(ack.head.sessionId).toBe(1);
    expect(ack.head.seq).toBe(2);
    expect(ack.head.sessionId).not.toBe(received.head.sessionId);
  });

  it('应答的 body 恒为 22 00（field 4 空消息）', () => {
    const received = parseGroupGcsPacket(gcsKeyPush)!;
    const ack = parseGroupGcsPacket(buildGroupGcsAck({ sessionId: 1, seq: 2 }, received.head))!;
    expect(toHex(ack.body)).toBe('2200');
  });

  it('应答把 f11 置 1、不带 f13 / f16 / f19…f23', () => {
    const received = parseGroupGcsPacket(gcsKeyPush)!;
    const ack = parseGroupGcsPacket(buildGroupGcsAck({ sessionId: 1, seq: 2 }, received.head))!;
    expect(ack.head.f11).toBe(1);
    expect(ack.head.groupId).toBe(0);
    expect(ack.head.f16).toBe(0);
    expect(ack.head.f22).toBe(0);
  });
});

describe('head 构造', () => {
  it('key 为空时不写 f6', () => {
    const head = buildGroupGcsHead({
      sessionId: 1,
      seq: 2,
      selfUin: 3,
      streamPrefix: 0,
      streamSuffix: 0,
      key: null,
      f7: 15,
      f8: 3,
      f11: 0,
      groupId: 0,
      f16: 3,
      f19: 1,
      f20: 4,
      f21: 21,
      f22: 1792462733,
      f23: 0,
      unknown: [],
    });
    // f6 的 tag 是 6 wire 2 = 0x32
    expect(head.includes(0x32)).toBe(false);
  });

  it('组包后再解析能读回同样的字段', () => {
    const inner = buildGroupGcsHead({
      sessionId: 23548,
      seq: 7,
      selfUin: 1707889225,
      streamPrefix: 0,
      streamSuffix: 0,
      key: null,
      f7: 15,
      f8: 3,
      f11: 0,
      groupId: 673646675,
      f16: 3,
      f19: 1,
      f20: 4,
      f21: 21,
      f22: 1792462733,
      f23: 0,
      unknown: [],
    });
    const packet = buildGroupGcsPacket(inner, new Uint8Array(0));
    const parsed = parseGroupGcsPacket(packet)!;
    expect(parsed.head.sessionId).toBe(23548);
    expect(parsed.head.seq).toBe(7);
    expect(parsed.head.selfUin).toBe(1707889225);
    expect(parsed.head.groupId).toBe(673646675);
  });
});

describe('SsoMultiTerminalSync', () => {
  const AUTH_KEY = Uint8Array.from(
    Buffer.from(
      '38076808cfff5bf6c85bbf68f1c194433ef4d92f0b964a53d4f1d70a55e77656ffde191459d95cfb19fa4a5c33955c8b1b6378084dad1dd0a6e5c7eb4ccf815d34103929d0bad5e824df8e7e40f1e608f8c6cf466847123e',
      'hex',
    ),
  );

  it('请求与抓包逐字节相同', () => {
    const built = encode(
      GROUP_MULTI_TERMINAL_REQ,
      MultiTerminalSync.serialize({ authKey: AUTH_KEY, groupId: 673646675 }),
    );
    expect(toHex(built)).toBe(toHex(multiTerminalSyncReq));
  });

  it('不签名', () => {
    expect(MultiTerminalSync.needSign).toBe(false);
  });

  it('应答是空 body', () => {
    expect(MultiTerminalSync.deserialize(new Uint8Array(0))).toBeUndefined();
  });
});
