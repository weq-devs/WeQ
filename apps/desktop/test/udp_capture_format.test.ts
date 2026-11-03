// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildPcapng,
  pcapngEnhancedPacket,
  pcapngInterfaceDescription,
  pcapngSectionHeader,
} from '../src/main/udp_capture_format';

/**
 * pcapng 时间戳编码。
 *
 * EPB 的时间戳是**一个 64 位无符号整数**（单位由 IDB 的 `if_tsresol` 决定，
 * 默认 1e-6 秒），不是「秒 + 微秒两个 32 位字段」。
 *
 * 2026-11-02 之前的实现把秒写进高 32 位、微秒写进低 32 位，Wireshark 读出来是
 * 246079 年，`frame.time_relative` 出现 8589 秒的假跳变 —— 整份抓包没法做时序
 * 分析。这组用例钉住正确的拆法。
 */

/** 从一个 EPB block 里读出 (tsHigh, tsLow)。High 在前（pcapng 规定）。 */
function epbTimestamp(packet: Buffer): { high: number; low: number } {
  // block: type(4) + len(4) + body...
  // body: iface(4) + tsHigh(4) + tsLow(4) + caplen(4) + origlen(4) + data...
  return { high: packet.readUInt32LE(12), low: packet.readUInt32LE(16) };
}

/** 造一个最小的 IPv4 UDP 包（20 + 8 + payload）。 */
function ipv4Udp(payloadLength = 4): Buffer {
  const out = Buffer.alloc(28 + payloadLength);
  out[0] = 0x45; // version 4, IHL 5
  out[9] = 17; // UDP
  out.writeUInt16BE(out.length, 2);
  out.writeUInt16BE(1000, 20);
  out.writeUInt16BE(2000, 22);
  out.writeUInt16BE(8 + payloadLength, 24);
  return out;
}

describe('pcapngEnhancedPacket 时间戳', () => {
  it('毫秒时间戳按「微秒的 64 位整数」拆高低位', () => {
    // 1793575628809 ms = 1793575628809000 us
    //   high = floor(1793575628809000 / 2^32) = 417580
    //   low  = 1793575628809000 mod 2^32  = 2407412872
    const ts = 1793575628809;
    const block = pcapngEnhancedPacket(ts, ipv4Udp());
    const { high, low } = epbTimestamp(block);
    expect(high).toBe(Math.floor((ts * 1000) / 0x1_0000_0000));
    expect(low).toBe((ts * 1000) % 0x1_0000_0000);
    // 还原回去必须等于原值（这是 Wireshark 做的事）。
    expect(high * 0x1_0000_0000 + low).toBe(ts * 1000);
  });

  it('高 32 位是「秒级溢出」而不是「秒」', () => {
    // 旧实现会把 high 写成 floor(ts/1000) ≈ 1.79e9（相当于 246079 年）。
    const block = pcapngEnhancedPacket(1793575628809, ipv4Udp());
    expect(epbTimestamp(block).high).toBeLessThan(1_000_000);
  });

  it('毫秒内的亚秒部分不会丢', () => {
    const base = 1793575628000;
    const a = epbTimestamp(pcapngEnhancedPacket(base + 1, ipv4Udp()));
    const b = epbTimestamp(pcapngEnhancedPacket(base + 999, ipv4Udp()));
    const toMicros = (t: { high: number; low: number }): number => t.high * 0x1_0000_0000 + t.low;
    expect(toMicros(b) - toMicros(a)).toBe(998_000);
  });

  it('时间戳单调递增时，拆出来的整数也单调', () => {
    const stamps = [1793575628000, 1793575628001, 1793575630000, 1793575700000];
    const micros = stamps.map((ts) => {
      const t = epbTimestamp(pcapngEnhancedPacket(ts, ipv4Udp()));
      return t.high * 0x1_0000_0000 + t.low;
    });
    for (let i = 1; i < micros.length; i++) {
      expect(micros[i]!).toBeGreaterThan(micros[i - 1]!);
    }
  });

  it('负时间戳被夹到 0，不写出溢出值', () => {
    const t = epbTimestamp(pcapngEnhancedPacket(-1, ipv4Udp()));
    expect(t.high).toBe(0);
    expect(t.low).toBe(0);
  });
});

describe('buildPcapng', () => {
  it('生成的文件头 + IDB + EPB 结构可被顺序解析', () => {
    const out = buildPcapng(
      [
        { ts: 1793575628000, rawHex: ipv4Udp().toString('hex') },
        { ts: 1793575628016, rawHex: ipv4Udp().toString('hex') },
      ],
      'weq-test',
    );
    expect(out.readUInt32LE(0)).toBe(0x0a0d0d0a); // SHB
    expect(out.includes(Buffer.from('weq-test'))).toBe(true);
    // 至少两个 EPB（type=6）
    let count = 0;
    let off = 0;
    while (off + 12 <= out.length) {
      const type = out.readUInt32LE(off);
      const len = out.readUInt32LE(off + 4);
      if (len < 12) break;
      if (type === 6) count++;
      off += len;
    }
    expect(count).toBe(2);
  });

  it('空 rawHex 的帧被跳过', () => {
    const out = buildPcapng([{ ts: 1, rawHex: '' }], 'x');
    const headerOnly = Buffer.concat([pcapngSectionHeader(), pcapngInterfaceDescription('x')]);
    expect(out.length).toBe(headerOnly.length);
  });
});
