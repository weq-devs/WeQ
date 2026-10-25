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
  VIDEO_EXT_LEN,
  VIDEO_EXT_TYPE,
  VIDEO_KEEPALIVE_SUB_TYPE,
  VideoFrameAssembler,
  VideoSubType,
  buildVideoControl,
  buildVideoKeepalive,
  buildVideoPackets,
  buildVideoSubHeader,
  sampleVideoFrameQuality,
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

/**
 * 真实 c2s 首帧的首个分片（2026-10-25 抓包原样）。
 *
 * 这一包里所有关键字段都是真实的：3 字节扩展 `03 03 00`、sub-header
 * `[2]=0x00`（c2s）、`[3]=0x06`、`[12:16]` 会话基准 tick。
 */
const REAL_C2S_PACKET = hex(
  '5b021c02000000000035be440270568ca00003000b00010303001400000600001b24000000000000000002000000' +
    '0000000140010c01ffff0160000003009000000300000300969a8090000000014201010160000003009000000300' +
    '00030096a00f080447d659aa4932e4020000030002000003001810000000014401c172b02240000000012601afe0' +
    'f9867ffe682023422c5306a54194f9585d4836620ac0dcc874877a65cc80455032869b4d880ba0fdc694e1fb17d6' +
    '0765dae878e3861f90f5d1b0691fe6e72916ae4b6b12f31a2c999a327ea3abd1647a2be6e7749e5dfbc155274af5' +
    '702a40935ba807afb07b7fc51220115e63124260c6920d9eddb9288154d2d0fd8796b5d56c12c1d5691447e169b9' +
    'e88978eeeab27dcc55e04f132cb3760dd154b9178b9297a878c9fe41242cc9f965e9efaa03a091a5429c167d38be' +
    '7ea952ceffa97655fde6f9c77d89f3fb4be6d3f5ede0860751413e9109f2f898201d2f85ad3cd79345b68a6134fb' +
    'b5877b270dc8d4bccfa5452fbd9515ddf12e187ed90b96efd1e15755d5d3b43eb562b8ef84effa0e43913dc25de4' +
    '6708964e25dd843a9be9896582bb73b96a847e37e92ef174accbba2c83c7668ef562d8e860b7a62c28ba480ee9f9' +
    '1f756d15e03d533b55a16d62cf61aad7ccece95157250b3afdb51bf36e8e3c03d96ddda6349f11a5eed9db420f1b' +
    '56ad8407e2cb3e93caf2eb1562c5ff594a2e42035fc1f63b6b3e52aaaef0d75f044f',
);

describe('真实 c2s 包（2026-10-25 抓包黄金样本）', () => {
  it('外层与 RTP 头解析正确', () => {
    const packet = parseVideoPacket(REAL_C2S_PACKET)!;
    expect(packet.subType).toBe(VideoSubType.max);
    expect(packet.seq).toBe(0);
    expect(packet.sessionTs).toBe(0x35be4402);
    expect(packet.tick).toBe(0x70568ca0);
    expect(packet.rtp).toMatchObject({
      pkgIdx: 0,
      totalPkg: 3,
      totalFec: 0,
      gidx: 0,
      fidx: 1,
    });
    // 扩展是完整的 3 字节：`03 03 00`。
    expect(packet.rtp.dataOffset).toBe(6 + 3);
    expect(packet.rtp.extensions).toHaveLength(1);
    expect(packet.rtp.extensions[0]!.type).toBe(3);
    expect([...packet.rtp.extensions[0]!.data]).toEqual([0x00]);
  });

  it('sub-header 是我们生成发送侧时该照抄的形态', () => {
    // 用抓包里的值重建 sub-header，必须逐字节还原。
    const rebuilt = buildVideoSubHeader({
      direction: 'c2s',
      frameIndex: 0,
      timestampMs: 0,
      baseTick: 0,
    });
    const actual = REAL_C2S_PACKET.subarray(26, 46);
    // 真实的 [12:16] 不是 0（是会话基准 tick），其余字段应一致。
    expect(rebuilt[0]).toBe(actual[0]);
    expect(rebuilt[2]).toBe(actual[2]); // [2] = 0x00，c2s 方向
    expect(rebuilt[3]).toBe(actual[3]); // [3] = 0x06
    // 抓包 [6:8] 是未解字段（0x1b24），我们填 0 —— 记为已知差异。
    expect(rebuilt[6]).toBe(0);
    expect(actual[6]).toBe(0x1b);
  });

  it('载荷是明文 Annex B（VPS + SPS + PPS + IDR）', () => {
    const packet = parseVideoPacket(REAL_C2S_PACKET)!;
    expect(hasAnnexBStartCode(packet.payload.subarray(20))).toBe(true);
    const nals = splitHevcNals(packet.payload.subarray(20));
    expect(nals.map((n) => n.type)).toEqual([32, 33, 34, 19]);
  });
});

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
      // 17B 外层头 + 6B RTP 头 + 3B 扩展 + 载荷。
      const out = new Uint8Array(AUDIO_HEADER_LEN + 6 + VIDEO_EXT_LEN + chunk.length);
      out[0] = AUDIO_STX;
      out[3] = VideoSubType.max;
      out[13] = 0x6f;
      out[AUDIO_HEADER_LEN] = i;
      out[AUDIO_HEADER_LEN + 1] = parts.length;
      out[AUDIO_HEADER_LEN + 3] = 0x0b;
      out[AUDIO_HEADER_LEN + 4] = gidx;
      out[AUDIO_HEADER_LEN + 5] = fidx;
      // 扩展：`03 03 00`（len=3 含自身、type=3、data 1 字节）。
      out[AUDIO_HEADER_LEN + 6] = VIDEO_EXT_LEN;
      out[AUDIO_HEADER_LEN + 7] = VIDEO_EXT_TYPE;
      out[AUDIO_HEADER_LEN + 8] = 0x00;
      out.set(chunk, AUDIO_HEADER_LEN + 6 + VIDEO_EXT_LEN);
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
  it('0x02 变体：29 字节，body[4:8] 是自己 tick 的小端副本，[8:12] 为 0', () => {
    const packet = buildVideoKeepalive({ sessionTs: 0x03c4f12a, tick: 0x6f3de2ae });
    expect(packet).toHaveLength(29);
    expect(packet[3]).toBe(VIDEO_KEEPALIVE_SUB_TYPE);
    expect(packet[17]).toBe(0x02);
    expect([...packet.subarray(21, 25)]).toEqual([0xae, 0xe2, 0x3d, 0x6f]);
    expect([...packet.subarray(25, 29)]).toEqual([0, 0, 0, 0]);
  });

  it('0x03 变体：body[4:8] 是对端 tick，[8:12] 是自己 tick（真实抓包 5b001d05…）', () => {
    // 样本来自 2026-10-25 抓包：s2c 一条 0x03 保活。
    const packet = buildVideoKeepalive({
      sessionTs: 0x03c4f12b,
      tick: 0x705690c5,
      variant: 0x03,
      peerTick: 0x70569377,
    });
    expect(packet[17]).toBe(0x03);
    // body[4:8] = 0x77935670（小端）
    expect([...packet.subarray(21, 25)]).toEqual([0x77, 0x93, 0x56, 0x70]);
    // body[8:12] = 0xc5905670（小端）
    expect([...packet.subarray(25, 29)]).toEqual([0xc5, 0x90, 0x56, 0x70]);
  });
});

describe('buildVideoSubHeader', () => {
  it('c2s 方向：[2]=0x00，[3] 恒 0x06（首帧也是）', () => {
    const first = buildVideoSubHeader({
      direction: 'c2s',
      frameIndex: 0,
      timestampMs: 0,
      baseTick: 0x70568b61,
    });
    expect(first[0]).toBe(20);
    expect(first[2]).toBe(0x00);
    expect(first[3]).toBe(0x06);
    // [12:16] 会话基准 tick。
    expect([...first.subarray(12, 16)]).toEqual([0x70, 0x56, 0x8b, 0x61]);

    const next = buildVideoSubHeader({
      direction: 'c2s',
      frameIndex: 1,
      timestampMs: 100,
      baseTick: 0x70568b61,
    });
    expect(next[1]).toBe(1);
    expect(next[2]).toBe(0x00);
    expect(next[3]).toBe(0x06);
  });

  it('s2c 方向：[2]=0x03，[12:16] 为 0', () => {
    const header = buildVideoSubHeader({
      direction: 's2c',
      frameIndex: 7,
      timestampMs: 0x70568b61,
    });
    expect(header[1]).toBe(7);
    expect(header[2]).toBe(0x03);
    expect([...header.subarray(12, 16)]).toEqual([0, 0, 0, 0]);
  });

  it('时间戳写在 [8:12]', () => {
    const header = buildVideoSubHeader({
      direction: 'c2s',
      frameIndex: 0,
      timestampMs: 0x6f2f1bee,
      baseTick: 1,
    });
    expect([...header.subarray(8, 12)]).toEqual([0x6f, 0x2f, 0x1b, 0xee]);
  });

  it('[6:8] 写帧质量与码率档（来自 GetVideoFrameQuality 的 16 位值）', () => {
    const header = buildVideoSubHeader({
      direction: 'c2s',
      frameIndex: 3,
      timestampMs: 300,
      baseTick: 9,
      quality: { rateTier: 0x19, frameQuality: 0x26 },
    });
    expect([...header.subarray(6, 8)]).toEqual([0x19, 0x26]);
  });

  it('[16:20] 写帧内分片号（小端）', () => {
    const header = buildVideoSubHeader({
      direction: 'c2s',
      frameIndex: 3,
      timestampMs: 300,
      baseTick: 9,
      fragment: 3,
    });
    expect([...header.subarray(16, 20)]).toEqual([3, 0, 0, 0]);
  });

  it('不传 quality / fragment 时退化为全零', () => {
    const header = buildVideoSubHeader({
      direction: 'c2s',
      frameIndex: 3,
      timestampMs: 300,
      baseTick: 9,
    });
    expect([...header.subarray(6, 8)]).toEqual([0, 0]);
    expect([...header.subarray(16, 20)]).toEqual([0, 0, 0, 0]);
  });
});

describe('sampleVideoFrameQuality', () => {
  it('抽样落在真实抓包的取值区间内', () => {
    for (let i = 0; i < 200; i++) {
      const q = sampleVideoFrameQuality(false);
      // 实测 [6] 16–25（偶发 53）、[7] 31–38（偶发 198），我们只覆盖主体区间。
      expect(q.rateTier).toBeGreaterThanOrEqual(16);
      expect(q.rateTier).toBeLessThanOrEqual(25);
      expect(q.frameQuality).toBeGreaterThanOrEqual(31);
      expect(q.frameQuality).toBeLessThanOrEqual(38);
    }
  });

  it('关键帧整体低一档（实测 17/32 vs 普通帧 25/38）', () => {
    for (let i = 0; i < 100; i++) {
      const q = sampleVideoFrameQuality(true);
      expect(q.rateTier).toBeLessThanOrEqual(25);
      expect(q.rateTier).toBeGreaterThanOrEqual(16);
    }
  });

  it('不是恒定值（否则对端统计会看出异常）', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const q = sampleVideoFrameQuality(false);
      seen.add(`${q.rateTier}/${q.frameQuality}`);
    }
    expect(seen.size).toBeGreaterThan(3);
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
    // 每片 seq +1（真实抓包里整通连续递增，不按帧重置）。
    expect(parsed.map((p) => p.seq)).toEqual([42, 43, 44]);
    // 外层 tick 帧内恒定。
    expect(parsed.every((p) => p.tick === 100)).toBe(true);
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

  it('扩展段是 3 字节 `03 03 00`（少写 1 字节接收端会整体错位）', () => {
    const packets = buildVideoPackets({
      frameData: new Uint8Array(60),
      gidx: 0,
      sessionTs: 1,
      tick: 1,
      seq: 0,
      maxPayload: 200,
    });
    const p = packets[0]!;
    // 17B 外层头 + 6B RTP 头之后。
    expect([...p.subarray(23, 26)]).toEqual([0x03, 0x03, 0x00]);
    // 解析侧 dataOffset 必须跳过完整的 3 字节。
    expect(parseVideoPacket(p)!.rtp.dataOffset).toBe(6 + 3);
    expect(parseVideoPacket(p)!.rtp.extensions[0]!.data).toEqual(new Uint8Array([0x00]));
  });

  it('整帧等分：末片自然短，不补 0', () => {
    // 1000 字节、单片上限 400（扣头后 374）→ 3 片，等分后 334 / 334 / 332。
    const packets = buildVideoPackets({
      frameData: new Uint8Array(1000),
      gidx: 0,
      sessionTs: 1,
      tick: 1,
      seq: 0,
      maxPayload: 400,
    });
    expect(packets).toHaveLength(3);
    const payloadLens = packets.map((p) => parseVideoPacket(p)!.payload.length);
    expect(payloadLens).toEqual([334, 334, 332]);
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
