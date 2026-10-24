/**
 * 视频通话媒体层。
 *
 * 这里的字节全部来自 2026-10-25 两通真实视频通话的抓包（一收一发），
 * 属于「黄金样本」：改了编解码逻辑，这些断言会第一时间炸。
 */

import { describe, expect, it } from 'vitest';
import {
  AUDIO_HEADER_LEN,
  AUDIO_STX,
  MEDIA_PROFILE,
  VIDEO_CTRL_SUB_TYPE,
  VIDEO_KEEPALIVE_SUB_TYPE,
  VideoFrameAssembler,
  VideoSubType,
  buildVideoControl,
  buildVideoKeepalive,
  buildVideoPackets,
  buildVideoSubHeader,
  extractHevc,
  hasAnnexBStartCode,
  hevcNalName,
  isVideoSubType,
  parseVideoPacket,
  parseVideoRtpHeader,
  splitHevcNals,
} from '../src/call';

function hex(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** 真实抓包里的首个视频包（对方开摄像头后第一帧的第一个分片，gidx=0）。 */
const FIRST_VIDEO_PACKET = hex(
  '5b01e0' +
    '0200' +
    '00000000' +
    '03c4f12b' +
    '6f3de4d5' +
    '0003000b' +
    '0001' +
    '0303' +
    '00' +
    '1400' +
    '0306' +
    '0000' +
    '2428' +
    '6f3de08d' +
    '00000000' +
    '00000000' +
    '0000000140010c01ffff01600000',
);

/** 摄像头开关控制包（`subType=4`，17 字节空体）。 */
const CAMERA_CTRL = hex('5b0011040000000000' + '03c4f12b' + '6f3dd916');

describe('视频子类型', () => {
  it('认得出三个视频子类型', () => {
    expect(isVideoSubType(VideoSubType.max)).toBe(true);
    expect(isVideoSubType(VideoSubType.min)).toBe(true);
    expect(isVideoSubType(VideoSubType.screen)).toBe(true);
  });

  it('不会把音频 / 控制 / 保活 / 反馈当视频', () => {
    expect(isVideoSubType(0x01)).toBe(false);
    expect(isVideoSubType(VIDEO_CTRL_SUB_TYPE)).toBe(false);
    expect(isVideoSubType(VIDEO_KEEPALIVE_SUB_TYPE)).toBe(false);
    expect(isVideoSubType(0x0e)).toBe(false);
  });
});

describe('parseVideoPacket', () => {
  it('解出真实抓包的视频包', () => {
    const packet = parseVideoPacket(FIRST_VIDEO_PACKET);
    expect(packet).not.toBeNull();
    expect(packet!.subType).toBe(VideoSubType.max);
    expect(packet!.sessionTs).toBe(0x03c4f12b);
    expect(packet!.tick).toBe(0x6f3de4d5);
    expect(packet!.rtp).toMatchObject({
      pkgIdx: 0,
      totalPkg: 3,
      totalFec: 0,
      multiFrameFec: 0,
      gidx: 0,
      fidx: 1,
    });
  });

  it('ext_fec_byte=0x0b 解出 1 条 type=3 扩展', () => {
    const packet = parseVideoPacket(FIRST_VIDEO_PACKET)!;
    expect(packet.rtp.extensions).toHaveLength(1);
    expect(packet.rtp.extensions[0]!.type).toBe(3);
    expect([...packet.rtp.extensions[0]!.data]).toEqual([0x00]);
  });

  it('扩展段之后就是 sub-header', () => {
    const packet = parseVideoPacket(FIRST_VIDEO_PACKET)!;
    // 载荷从 RTP 头 6B + 扩展 2B 之后开始。
    expect(packet.payload[0]).toBe(20);
  });

  it('非视频子类型返回 null', () => {
    const audio = new Uint8Array(FIRST_VIDEO_PACKET);
    audio[3] = 0x01;
    expect(parseVideoPacket(audio)).toBeNull();
  });

  it('首字节不是 0x5b 返回 null', () => {
    const bad = new Uint8Array(FIRST_VIDEO_PACKET);
    bad[0] = 0x28;
    expect(parseVideoPacket(bad)).toBeNull();
  });
});

describe('parseVideoRtpHeader', () => {
  it('multi_frame_fec > 3 视为非法', () => {
    const payload = new Uint8Array(16);
    payload[3] = 0x80; // 高 3 位 = 4
    expect(parseVideoRtpHeader(payload)).toBeNull();
  });

  it('ext_val 不在 11..20 时没有扩展', () => {
    const payload = new Uint8Array(16);
    payload[3] = 0x0a; // 低 5 位 = 10
    const rtp = parseVideoRtpHeader(payload)!;
    expect(rtp.extensions).toHaveLength(0);
    expect(rtp.dataOffset).toBe(6);
  });
});

describe('VideoFrameAssembler', () => {
  /** 造一个能组出完整帧的分片序列。 */
  function packetsFor(gidx: number, fidx: number, parts: string[]): Uint8Array[] {
    return parts.map((body, i) => {
      const chunk = hex(body);
      // 17B 外层头 + 6B RTP 头 + 2B 扩展 + 载荷。
      const out = new Uint8Array(AUDIO_HEADER_LEN + 6 + 2 + chunk.length);
      out[0] = AUDIO_STX;
      out[3] = VideoSubType.max;
      out[13] = 0x6f;
      out[AUDIO_HEADER_LEN] = i;
      out[AUDIO_HEADER_LEN + 1] = parts.length;
      out[AUDIO_HEADER_LEN + 3] = 0x0b;
      out[AUDIO_HEADER_LEN + 4] = gidx;
      out[AUDIO_HEADER_LEN + 5] = fidx;
      // 扩展：len=2, type=3, 无数据。
      out[AUDIO_HEADER_LEN + 6] = 0x02;
      out[AUDIO_HEADER_LEN + 7] = 0x03;
      out.set(chunk, AUDIO_HEADER_LEN + 8);
      return out;
    });
  }

  it('凑齐分片后按 pkg_idx 顺序拼出一帧', () => {
    const assembler = new VideoFrameAssembler();
    // 20 字节 sub-header（首字节 0x14 = 20）+ 裸流，总长必须大于 20。
    // 裸流是 IDR_W_RADL（NAL 类型 19 → 首字节 0x26），关键帧判定靠它。
    const parts = ['14', '0000000000000000000000000000000000000000', '000000012601afe0'];
    const packets = packetsFor(0, 1, parts);
    let frame = null;
    for (const p of packets) {
      frame = assembler.push(parseVideoPacket(p)!, 1000);
      if (frame) break;
    }
    expect(frame).not.toBeNull();
    expect(frame!.gidx).toBe(0);
    expect(frame!.fidx).toBe(1);
    expect(frame!.isBaseLayer).toBe(true);
    expect(frame!.isKeyframe).toBe(true);
    expect(frame!.subHeaderSize).toBe(0x14);
  });

  it('乱序到达也能拼对', () => {
    const assembler = new VideoFrameAssembler();
    const parts = ['1400', '00000000', '00000001'];
    const packets = packetsFor(0, 1, parts);
    const reordered = [packets[2]!, packets[0]!, packets[1]!];
    let frame = null;
    for (const p of reordered) {
      frame = assembler.push(parseVideoPacket(p)!, 1000);
      if (frame) break;
    }
    expect(frame).not.toBeNull();
    // 拼好的数据必须按 pkg_idx 排，而不是按到达顺序。
    expect(frame!.frameData[0]).toBe(0x14);
  });

  it('重复分片被忽略', () => {
    const assembler = new VideoFrameAssembler();
    const packets = packetsFor(0, 1, ['1400', '00000000']);
    expect(assembler.push(parseVideoPacket(packets[0]!)!, 1000)).toBeNull();
    expect(assembler.push(parseVideoPacket(packets[0]!)!, 1000)).toBeNull();
    expect(assembler.pendingCount).toBe(1);
  });

  it('超时的分片组被清掉', () => {
    const assembler = new VideoFrameAssembler();
    const packets = packetsFor(0, 1, ['1400', '00000000']);
    assembler.push(parseVideoPacket(packets[0]!)!, 1000);
    expect(assembler.pendingCount).toBe(1);
    // 下一帧到达时顺带清理超时项。
    const later = packetsFor(1, 1, ['1400', '00000000']);
    assembler.push(parseVideoPacket(later[0]!)!, 1000 + 5000);
    expect(assembler.pendingCount).toBe(1);
  });

  it('增强层（fidx=2）标记为非基础层', () => {
    const assembler = new VideoFrameAssembler();
    const packets = packetsFor(3, 2, ['1400']);
    const frame = assembler.push(parseVideoPacket(packets[0]!)!, 1000);
    expect(frame!.isBaseLayer).toBe(false);
    expect(frame!.isKeyframe).toBe(false);
  });

  it('reset 清空所有等待中的帧', () => {
    const assembler = new VideoFrameAssembler();
    const packets = packetsFor(0, 1, ['1400', '00000000']);
    assembler.push(parseVideoPacket(packets[0]!)!, 1000);
    assembler.reset();
    expect(assembler.pendingCount).toBe(0);
  });
});

describe('H.265 提取', () => {
  it('识别 Annex B 起始码', () => {
    expect(hasAnnexBStartCode(hex('00000001'))).toBe(true);
    expect(hasAnnexBStartCode(hex('000001'))).toBe(true);
    expect(hasAnnexBStartCode(hex('000002'))).toBe(false);
  });

  it('剥掉 sub-header 后是裸流', () => {
    const frame = {
      gidx: 0,
      fidx: 1,
      tick: 0,
      subType: VideoSubType.max,
      isBaseLayer: true,
      isKeyframe: true,
      subHeaderSize: 20,
      timestamp: 0,
      frameData: hex('14' + '00'.repeat(19) + '0000000140010c01'),
      firstAt: 0,
    };
    const hevc = extractHevc(frame)!;
    expect(hasAnnexBStartCode(hevc)).toBe(true);
    expect(hevc[4]).toBe(0x40);
  });

  it('sub-header 长度越界返回 null', () => {
    const frame = {
      gidx: 0,
      fidx: 1,
      tick: 0,
      subType: VideoSubType.max,
      isBaseLayer: true,
      isKeyframe: true,
      subHeaderSize: 99,
      timestamp: 0,
      frameData: hex('1400000001'),
      firstAt: 0,
    };
    expect(extractHevc(frame)).toBeNull();
  });
});

describe('splitHevcNals', () => {
  it('切出 VPS / SPS / PPS / IDR', () => {
    // 真实首帧的 NAL 序列（简化了载荷）。
    const data = hex(
      '00000001 40010c01 ' + '00000001 42010101 ' + '00000001 4401c172 ' + '00000001 2601afe0',
    );
    const nals = splitHevcNals(data);
    expect(nals.map((n) => n.type)).toEqual([32, 33, 34, 19]);
    expect(nals.map((n) => hevcNalName(n.type))).toEqual(['VPS', 'SPS', 'PPS', 'IDR_W_RADL']);
  });

  it('3 字节起始码也认', () => {
    const nals = splitHevcNals(hex('000001 40010c01 000001 42010101'));
    expect(nals.map((n) => n.type)).toEqual([32, 33]);
  });

  it('没有起始码时返回空', () => {
    expect(splitHevcNals(hex('1122334455'))).toHaveLength(0);
  });
});

describe('buildVideoControl', () => {
  it('产出与真实抓包逐字节一致的空体控制包', () => {
    const packet = buildVideoControl({ sessionTs: 0x03c4f12b, tick: 0x6f3dd916 });
    expect([...packet]).toEqual([...CAMERA_CTRL]);
    expect(packet).toHaveLength(17);
    expect(packet[3]).toBe(VIDEO_CTRL_SUB_TYPE);
    expect(packet[5]).toBe(0); // seq 恒为 0
  });
});

describe('buildVideoKeepalive', () => {
  it('产出 29 字节，body 尾部是 tick 的小端副本', () => {
    const packet = buildVideoKeepalive({ sessionTs: 0x03c4f12a, tick: 0x6f3de2ae });
    expect(packet).toHaveLength(29);
    expect(packet[3]).toBe(VIDEO_KEEPALIVE_SUB_TYPE);
    expect(packet[17]).toBe(0x02);
    // [21:25] = tick 小端。
    expect([...packet.subarray(21, 25)]).toEqual([0xae, 0xe2, 0x3d, 0x6f]);
  });
});

describe('buildVideoSubHeader', () => {
  it('首帧是 03 03，后续帧是 03 06', () => {
    const first = buildVideoSubHeader({ gidx: 0, frameIndex: 0, timestampMs: 100, variant: 1 });
    expect(first[0]).toBe(20);
    expect(first[2]).toBe(0x03);
    expect(first[3]).toBe(0x03);

    const next = buildVideoSubHeader({ gidx: 1, frameIndex: 1, timestampMs: 200 });
    expect(next[1]).toBe(1);
    expect(next[2]).toBe(0x03);
    expect(next[3]).toBe(0x06);
  });

  it('时间戳写在 [8:12]', () => {
    const header = buildVideoSubHeader({ gidx: 0, frameIndex: 0, timestampMs: 0x6f2f1bee });
    expect([...header.subarray(8, 12)]).toEqual([0x6f, 0x2f, 0x1b, 0xee]);
  });
});

describe('buildVideoPackets', () => {
  it('按 maxPayload 切分，pkg_idx / total_pkg 正确', () => {
    const frameData = new Uint8Array(2500);
    const packets = buildVideoPackets({
      frameData,
      gidx: 7,
      sessionTs: 1,
      tick: 100,
      seq: 42,
      maxPayload: 1000,
    });
    expect(packets).toHaveLength(3);
    const parsed = packets.map((p) => parseVideoPacket(p)!);
    expect(parsed.map((p) => p.rtp.pkgIdx)).toEqual([0, 1, 2]);
    expect(parsed.every((p) => p.rtp.totalPkg === 3)).toBe(true);
    expect(parsed.every((p) => p.rtp.gidx === 7)).toBe(true);
    expect(parsed.every((p) => p.rtp.fidx === 1)).toBe(true);
    expect(parsed.every((p) => p.seq === 42)).toBe(true);
  });

  it('发出的包能被自己的解析器还原（收发同构）', () => {
    const original = hex('00000001 40010c01 ffffff');
    const packets = buildVideoPackets({
      frameData: original,
      gidx: 0,
      sessionTs: 9,
      tick: 1,
      seq: 1,
      maxPayload: 8,
    });
    const assembler = new VideoFrameAssembler();
    let frame = null;
    for (const p of packets) {
      frame = assembler.push(parseVideoPacket(p)!, 0) ?? frame;
    }
    expect(frame).not.toBeNull();
    expect([...frame!.frameData]).toEqual([...original]);
  });
});

describe('MEDIA_PROFILE', () => {
  it('视频与语音的信令档位不同（2026-10-25 抓包）', () => {
    expect(MEDIA_PROFILE.audio).toMatchObject({
      f3: 1,
      ipStack: 88,
      f13: 1,
      inviteF3: 5,
      inviteF4: 10056,
    });
    expect(MEDIA_PROFILE.video).toMatchObject({
      f3: 0,
      ipStack: 12656,
      f13: 3,
      inviteF3: 15,
      inviteF4: 10063,
    });
  });
});
