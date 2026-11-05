/**
 * 群通话媒体帧回归测试（`0x17` 上行 / `0x18` 下行）。
 *
 * 黄金样本取自 2026-11-05 的三份真实抓包。音频载荷的切法是用
 * `nt_helper.decodeCallFrame` 逐包验出来的：两种头部形态合起来 100% 解成
 * 320 个采样（20 ms @ 16 kHz），且都是真实语音而不是噪声。
 */

import { describe, expect, it } from 'vitest';
import {
  GroupAudioFragmentFlag,
  GroupTrack,
  GroupVideoAssembler,
  H264_START_CODE,
  buildGroupAudioFrame,
  buildGroupVideoFragments,
  hasIdrNal,
  isGroupMediaCmd,
  parseGroupAudioFrame,
  parseGroupMediaHeader,
  parseGroupRelay,
  parseGroupVideoFragment,
} from '../src/group-call';
import {
  audioDownExt,
  audioDownPlain,
  mediaDown,
  videoFrameFirstFragment,
  videoKeyframeFirstFragment,
} from './fixtures/group_call_capture';

/** 取 `0x02` 包里的 body（已去掉 17 字节包头与结束符）。 */
const bodyOf = (packet: Uint8Array): Uint8Array => parseGroupRelay(packet)!.body;

describe('媒体头', () => {
  it('音频与视频的 track 类型不同（1 / 2）', () => {
    expect(parseGroupMediaHeader(bodyOf(audioDownPlain))!.track).toBe(GroupTrack.audio);
    expect(parseGroupMediaHeader(bodyOf(videoKeyframeFirstFragment))!.track).toBe(GroupTrack.video);
  });

  it('方向字节：s2c 是 0x02', () => {
    expect(parseGroupMediaHeader(bodyOf(audioDownPlain))!.direction).toBe(0x02);
  });

  it('track 类型不认识时返回 null', () => {
    const body = new Uint8Array(bodyOf(audioDownPlain));
    body[16] = 0x09;
    expect(parseGroupMediaHeader(body)).toBeNull();
  });

  it('媒体命令号就是 0x17 / 0x18', () => {
    expect(isGroupMediaCmd(0x17)).toBe(true);
    expect(isGroupMediaCmd(0x18)).toBe(true);
    expect(isGroupMediaCmd(0x19)).toBe(false);
  });
});

describe('音频载荷', () => {
  it('b20 bit7 = 0：长度字段在 body[30]，载荷从 body[32] 起', () => {
    const body = bodyOf(audioDownPlain);
    const frame = parseGroupAudioFrame(body)!;
    expect(frame).not.toBeNull();
    // 抓包里 body[30] = 0x04 → 载荷 4 字节（这一包是成员信息，不是语音）
    expect(frame.declaredLength).toBe(body[30]);
    expect(frame.payload.length).toBe(frame.declaredLength);
    expect(frame.payload[0]).toBe(body[32]);
  });

  it('b20 bit7 = 1：长度字段在 body[35]，载荷从 body[37] 起', () => {
    const body = bodyOf(audioDownExt);
    expect(body[20]! & 0x80).toBe(0x80);
    const frame = parseGroupAudioFrame(body)!;
    expect(frame.declaredLength).toBe(body[35]);
    expect(frame.payload.length).toBe(frame.declaredLength);
    expect(frame.payload[0]).toBe(body[37]);
  });

  it('载荷首字节是 Opus TOC 0x00（SILK 窄带 10 ms）', () => {
    const frame = parseGroupAudioFrame(bodyOf(audioDownExt))!;
    expect(frame.payload[0]).toBe(0x00);
  });

  it('长度三元组的第二字节恒为 L-2，校验不过就返回 null', () => {
    const body = new Uint8Array(bodyOf(audioDownExt));
    body[36] = 0x00; // 破坏 L-2 校验位
    expect(parseGroupAudioFrame(body)).toBeNull();
  });

  it('成员信息包（b18 = 0x10）不会被当成音频', () => {
    const frame = parseGroupAudioFrame(bodyOf(mediaDown))!;
    // mediaDown 的 body[18] = 0x10，长度三元组不成立
    expect(frame).toBeNull();
  });

  it('长度超出 body 时返回 null', () => {
    const body = new Uint8Array(bodyOf(audioDownExt));
    body[35] = 0xff;
    expect(parseGroupAudioFrame(body)).toBeNull();
  });

  it('分片标记能读出来', () => {
    const frame = parseGroupAudioFrame(bodyOf(audioDownExt))!;
    expect(frame.fragmentFlag).toBe(GroupAudioFragmentFlag.media);
  });
});

describe('视频分片', () => {
  it('首片带 Annex B 起始码，SPS 是 H.264 High 3.1', () => {
    const frag = parseGroupVideoFragment(bodyOf(videoKeyframeFirstFragment))!;
    expect(frag.pkgIdx).toBe(0);
    expect(frag.payload.subarray(0, 4)).toEqual(H264_START_CODE);
    // SPS NAL：67 | profile_idc 0x64 = 100 (High) | constraint flags 0x00 | level_idc 0x1f = 31 (3.1)
    expect(frag.payload[4]).toBe(0x67);
    expect(frag.payload[5]).toBe(0x64);
    expect(frag.payload[6]).toBe(0x00);
    expect(frag.payload[7]).toBe(0x1f);
  });

  it('普通帧首片是 NAL type 1（非 IDR）', () => {
    const frag = parseGroupVideoFragment(bodyOf(videoFrameFirstFragment))!;
    expect(frag.pkgIdx).toBe(0);
    expect(frag.payload[4]! & 0x1f).toBe(1);
  });

  it('载荷固定从 body[35] 开始', () => {
    const body = bodyOf(videoFrameFirstFragment);
    expect(parseGroupVideoFragment(body)!.payload[0]).toBe(body[35]);
  });

  it('body 太短时返回 null', () => {
    expect(parseGroupVideoFragment(new Uint8Array(20))).toBeNull();
  });
});

describe('视频重组', () => {
  it('关键帧收齐后认出是 IDR', () => {
    const assembler = new GroupVideoAssembler();
    const frag = parseGroupVideoFragment(bodyOf(videoKeyframeFirstFragment))!;
    const frame = assembler.push(2940720980, { ...frag, totalPkg: 1 })!;
    expect(frame.keyframe).toBe(true);
    expect(frame.ownerUin).toBe(2940720980);
    expect(frame.fragments).toBe(1);
  });

  it('普通帧不算关键帧', () => {
    const assembler = new GroupVideoAssembler();
    const frag = parseGroupVideoFragment(bodyOf(videoFrameFirstFragment))!;
    expect(assembler.push(2940720980, { ...frag, totalPkg: 1 })!.keyframe).toBe(false);
  });

  it('收齐 totalPkg 才输出，分片按序拼接', () => {
    const assembler = new GroupVideoAssembler();
    const first = parseGroupVideoFragment(bodyOf(videoFrameFirstFragment))!;
    // 首片：totalPkg=2，还差一片 → 不输出
    expect(assembler.push(1, { ...first, totalPkg: 2 })).toBeNull();
    const second = parseGroupVideoFragment(bodyOf(videoFrameFirstFragment))!;
    const frame = assembler.push(1, {
      ...second,
      pkgIdx: 1,
      totalPkg: 2,
      payload: new Uint8Array([0xaa]),
    })!;
    expect(frame.fragments).toBe(2);
    expect(frame.data.subarray(frame.data.length - 1)).toEqual(new Uint8Array([0xaa]));
  });

  it('不同成员的分片互不干扰', () => {
    const assembler = new GroupVideoAssembler();
    const frag = parseGroupVideoFragment(bodyOf(videoFrameFirstFragment))!;
    assembler.push(111, { ...frag, totalPkg: 1 });
    const other = assembler.push(222, { ...frag, totalPkg: 1 })!;
    expect(other.ownerUin).toBe(222);
    expect(other.fragments).toBe(1);
  });

  it('序号跳变时丢弃当前帧，等下一个首片', () => {
    const assembler = new GroupVideoAssembler();
    const frag = parseGroupVideoFragment(bodyOf(videoFrameFirstFragment))!;
    assembler.push(1, { ...frag, totalPkg: 3 });
    // 直接来 pkgIdx = 2，缺了 1 → 丢弃
    expect(assembler.push(1, { ...frag, pkgIdx: 2, totalPkg: 3 })).toBeNull();
    // 下一个首片能正常开始（totalPkg=1 收齐即输出）
    expect(assembler.push(1, { ...frag, totalPkg: 1 })).not.toBeNull();
  });

  it('没有首片就先收到续片时忽略', () => {
    const assembler = new GroupVideoAssembler();
    const frag = parseGroupVideoFragment(bodyOf(videoFrameFirstFragment))!;
    expect(assembler.push(1, { ...frag, pkgIdx: 1 })).toBeNull();
  });

  it('reset 之后重新等首片', () => {
    const assembler = new GroupVideoAssembler();
    const frag = parseGroupVideoFragment(bodyOf(videoFrameFirstFragment))!;
    assembler.push(1, frag);
    assembler.reset(1);
    expect(assembler.push(1, { ...frag, pkgIdx: 1 })).toBeNull();
  });
});

describe('hasIdrNal', () => {
  it('认得 IDR（type 5）与 SPS（type 7）', () => {
    expect(hasIdrNal(Uint8Array.from([0, 0, 0, 1, 0x65, 0x88]))).toBe(true);
    expect(hasIdrNal(Uint8Array.from([0, 0, 0, 1, 0x67, 0x64]))).toBe(true);
  });

  it('普通片（type 1）不算关键帧', () => {
    expect(hasIdrNal(Uint8Array.from([0, 0, 0, 1, 0x61, 0xe0]))).toBe(false);
  });

  it('空数据不炸', () => {
    expect(hasIdrNal(new Uint8Array(0))).toBe(false);
  });
});

describe('组包', () => {
  const STREAM = Uint8Array.from([0x18, 0xb6, 0x06, 0xaa, 0x47, 0x32, 0x00]);
  const OPUS = Uint8Array.from([0x00, 0x11, 0x22, 0x33, 0x44]);

  it('音频上行包能被自己的解析器读回来', () => {
    const packet = buildGroupAudioFrame({
      route: 0x1234,
      ownerUin: 1707889225,
      stream: STREAM,
      seq: 1,
      frameIndex: 2,
      sampleTs: 320,
      opus: OPUS,
    });
    const parsed = parseGroupRelay(packet)!;
    expect(parsed.cmd).toBe(0x17);
    expect(parsed.ownerUin).toBe(1707889225);

    const frame = parseGroupAudioFrame(parsed.body)!;
    expect(frame.payload).toEqual(OPUS);
    expect(frame.fragmentFlag).toBe(GroupAudioFragmentFlag.media);
  });

  it('音频上行包的头部与抓包同构（b16/b17/b18/b20）', () => {
    const body = bodyOf(
      buildGroupAudioFrame({
        route: 0,
        ownerUin: 1707889225,
        stream: STREAM,
        seq: 1,
        frameIndex: 2,
        sampleTs: 320,
        opus: OPUS,
      }),
    );
    expect(body[16]).toBe(GroupTrack.audio);
    expect(body[17]).toBe(0x01);
    expect(body[18]).toBe(GroupAudioFragmentFlag.media);
    expect(body[20]! & 0x80).toBe(0); // 长度字段在 30
  });

  it('视频分片按上限切分，首片带起始码', () => {
    const data = new Uint8Array(2500);
    data.set(H264_START_CODE, 0);
    data[4] = 0x65;
    const packets = buildGroupVideoFragments({
      route: 0,
      ownerUin: 1707889225,
      stream: STREAM,
      seq: 1,
      data,
      maxPayload: 1000,
    });
    expect(packets).toHaveLength(3);

    const frags = packets.map((p) => parseGroupVideoFragment(bodyOf(p))!);
    expect(frags.map((f) => f.pkgIdx)).toEqual([0, 1, 2]);
    expect(frags[0]!.payload.subarray(0, 4)).toEqual(H264_START_CODE);
    expect(frags[1]!.payload.length).toBe(1000);
  });

  it('视频分片能被重组回原数据', () => {
    const data = new Uint8Array(2500);
    data.set(H264_START_CODE, 0);
    data[4] = 0x65;
    const packets = buildGroupVideoFragments({
      route: 0,
      ownerUin: 1,
      stream: STREAM,
      seq: 1,
      data,
      maxPayload: 1000,
    });
    const assembler = new GroupVideoAssembler();
    let last = null;
    for (const packet of packets) {
      const frag = parseGroupVideoFragment(bodyOf(packet))!;
      last = assembler.push(1, frag) ?? last;
    }
    expect(last!.data).toEqual(data);
    expect(last!.keyframe).toBe(true);
  });

  it('流标识长度不对时抛错', () => {
    expect(() =>
      buildGroupAudioFrame({
        route: 0,
        ownerUin: 1,
        stream: new Uint8Array(5),
        seq: 0,
        frameIndex: 0,
        sampleTs: 0,
        opus: OPUS,
      }),
    ).toThrow(/流标识/);
  });

  it('Opus 帧过长时抛错', () => {
    expect(() =>
      buildGroupAudioFrame({
        route: 0,
        ownerUin: 1,
        stream: STREAM,
        seq: 0,
        frameIndex: 0,
        sampleTs: 0,
        opus: new Uint8Array(300),
      }),
    ).toThrow(/Opus/);
  });
});
