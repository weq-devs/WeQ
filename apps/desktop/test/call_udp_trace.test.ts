// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CallUdpTrace } from '../src/main/call_udp_trace';
import { formatStamp } from '../src/main/call_recording_store';
import { synthesizeIpPacket } from '../src/main/udp_capture_format';

/**
 * 通话 UDP 落盘：IP/UDP 头合成与 pcapng 结构。
 *
 * 卷起结构真的错了的话，Wireshark 会打不开文件 —— 这里按 block 头逐段走一遍，
 * 保证「一条数据报 = 一个 EPB」且长度自洽。
 */

describe('语音通话 UDP 落盘格式', () => {
  it('按五元组合成 IPv4 数据报', () => {
    const payload = Buffer.from([0x28, 0x01, 0x02, 0x03]);
    const packet = synthesizeIpPacket({
      src: '192.168.1.5',
      srcPort: 5000,
      dst: '29.237.233.29',
      dstPort: 8000,
      payload,
    });

    expect(packet[0]! >> 4).toBe(4);
    expect(packet[9]).toBe(17);
    expect(packet.readUInt16BE(2)).toBe(packet.length);
    expect(packet.readUInt16BE(20)).toBe(5000);
    expect(packet.readUInt16BE(22)).toBe(8000);
    expect(packet.readUInt16BE(24)).toBe(8 + payload.length);
    expect(packet.subarray(28)).toEqual(payload);
    // IP 头校验和：把整头按 16 位加起来应当是 0xffff。
    let sum = 0;
    for (let i = 0; i < 20; i += 2) sum += packet.readUInt16BE(i);
    while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
    expect(sum).toBe(0xffff);
  });

  it('udp6 套接字报的可映射地址按 IPv4 处理', () => {
    const packet = synthesizeIpPacket({
      src: '::ffff:192.168.1.5',
      srcPort: 1,
      dst: '::ffff:29.237.233.29',
      dstPort: 2,
      payload: Buffer.alloc(0),
    });
    expect(packet[0]! >> 4).toBe(4);
    expect(packet.subarray(12, 16)).toEqual(Buffer.from([192, 168, 1, 5]));
    expect(packet.subarray(16, 20)).toEqual(Buffer.from([29, 237, 233, 29]));
  });

  it('双栈套接字本地地址为 `::` 时，按对端地址写成 IPv4 包', () => {
    const packet = synthesizeIpPacket({
      src: '::',
      srcPort: 5000,
      dst: '::ffff:29.237.233.29',
      dstPort: 8000,
      payload: Buffer.from([0x5b]),
    });
    expect(packet[0]! >> 4).toBe(4);
    expect(packet.subarray(12, 16)).toEqual(Buffer.from([0, 0, 0, 0]));
    expect(packet.subarray(16, 20)).toEqual(Buffer.from([29, 237, 233, 29]));
  });

  it('真正的 IPv6 目标写成 IPv6 包', () => {
    const packet = synthesizeIpPacket({
      src: '::',
      srcPort: 8800,
      dst: '2408:8000::1',
      dstPort: 8800,
      payload: Buffer.from([0x5b]),
    });
    expect(packet[0]! >> 4).toBe(6);
    expect(packet[6]).toBe(17);
    expect(packet.readUInt16BE(4)).toBe(8 + 1);
    expect(packet.readUInt16BE(40)).toBe(8800);
    expect(packet[48]).toBe(0x5b);
  });

  it('落盘是一个标准 pcapng：SHB + IDB + 一条数据报一个 EPB', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weq-call-udp-'));
    try {
      const trace = await CallUdpTrace.start({
        root,
        peerUin: '10001',
        startedAt: Date.parse('2026-10-31T12:00:00Z'),
      });
      if (!trace) throw new Error('应能打开落盘文件');
      trace.record({
        direction: 'c2s',
        payload: Buffer.from([0x28, 0xaa]),
        localAddress: '192.168.1.5',
        localPort: 5000,
        remoteAddress: '29.237.233.29',
        remotePort: 8000,
      });
      trace.record({
        direction: 's2c',
        payload: Buffer.from([0x5b, 0xbb]),
        localAddress: '192.168.1.5',
        localPort: 5000,
        remoteAddress: '29.237.233.29',
        remotePort: 8000,
      });
      const path = trace.path;
      await trace.stop();

      expect(basename(dirname(path))).toBe('udp');
      expect(path).toContain(`${formatStamp(Date.parse('2026-10-31T12:00:00Z'))}_10001.pcapng`);

      const file = await readFile(path);
      const types: number[] = [];
      let offset = 0;
      while (offset + 12 <= file.length) {
        const type = file.readUInt32LE(offset);
        const total = file.readUInt32LE(offset + 4);
        expect(total % 4).toBe(0);
        expect(file.readUInt32LE(offset + total - 4)).toBe(total);
        types.push(type);
        offset += total;
      }
      expect(types).toEqual([0x0a0d0d0a, 0x00000001, 0x00000006, 0x00000006]);
      expect(offset).toBe(file.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
