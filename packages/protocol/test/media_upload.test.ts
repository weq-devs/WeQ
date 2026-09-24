/**
 * 富媒体上传（NTV2 + highway）离线测试。
 *
 * 真正联网的部分（highway TCP PUT）用一个「服务端已持有资源」的上传响应绕开：
 * 响应里没有 uKey ⇒ fast-upload 命中 ⇒ 不需要传字节，所以整条链路可以离线跑完，
 * 同时把**请求字节**解回来断言（命令号、scene、fileInfo、extBizInfo）。
 *
 * 覆盖：
 *   - highway 帧打包/解包、head 与 extend 载荷；
 *   - 波形（真条 / 合成条）、图片格式探测、兜底封面；
 *   - uploadImage/Ptt/VideoMsgInfo：请求形状 + msgInfo 产物 + 错误路径；
 *   - buildSendElemsWithMedia / sendMessage：媒体元素的 commonElem 拼装、
 *     「校验先于联网」与场景推导（群 vs 私聊 vs 群临时会话）。
 */

import { promises as fsp } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  amplitudesFromPcmS16le,
  buildHighwayExtend,
  buildHighwayHead,
  buildPttWaveform,
  buildSendElemsWithMedia,
  decode,
  decodePttWaveform,
  detectImageFormat,
  encode,
  finalizeMediaMsgInfo,
  IMAGE_HIGHWAY_GROUP,
  makeSolidPng,
  NTV2_RICH_MEDIA_HIGHWAY_EXT,
  NTV2_UPLOAD_REQ_TOP,
  NTV2_UPLOAD_RESP_TOP,
  packHighwayFrame,
  PIC_COMMON_PB,
  PIC_FORMAT_JPEG,
  PIC_FORMAT_PNG,
  PTT_WAVEFORM_BINS,
  PTT_WAVEFORM_SILENCE,
  REQ_DATA_HIGHWAY_HEAD,
  runNtv2Upload,
  SEND_MESSAGE_REQUEST,
  SEND_MESSAGE_RESPONSE,
  sendMessage,
  UPLOAD_MSG_INFO,
  unpackHighwayFrame,
  uploadImageMsgInfo,
  uploadPttMsgInfo,
  uploadVideoMsgInfo,
  VIDEO_HIGHWAY_GROUP,
} from '../src/index';

// ───────────────────────── 测试脚手架 ─────────────────────────

interface OidbCall {
  pid: number;
  command: number;
  subCommand: number;
  body: Uint8Array;
  isUid: boolean;
}

interface PacketCall {
  pid: number;
  cmd: string;
  body: Uint8Array;
}

/** 一个只记账、不打网络的 native 绑定。 */
function makeNative(handlers: {
  oidb: (call: OidbCall) => Uint8Array;
  packet?: (call: PacketCall) => Uint8Array;
}) {
  const oidbCalls: OidbCall[] = [];
  const packetCalls: PacketCall[] = [];
  return {
    oidbCalls,
    packetCalls,
    sendOidbPacket: async (
      pid: number,
      command: number,
      subCommand: number,
      body: Buffer,
      isUid: boolean,
    ): Promise<Buffer> => {
      const call = { pid, command, subCommand, body: new Uint8Array(body), isUid };
      oidbCalls.push(call);
      return Buffer.from(handlers.oidb(call));
    },
    sendPacket: async (pid: number, cmd: string, body: Buffer): Promise<Buffer> => {
      const call = { pid, cmd, body: new Uint8Array(body) };
      packetCalls.push(call);
      if (!handlers.packet) throw new Error(`未预期的 sendPacket: ${cmd}`);
      return Buffer.from(handlers.packet(call));
    },
  };
}

/**
 * 一份上传响应：默认**没有 uKey**（服务端已持有资源）⇒ 不传字节、不连 TCP。
 * `retCode != 0` 时按失败响应构造（不带 upload 段）。
 */
function uploadResponse(
  options: {
    retCode?: number;
    message?: string;
    omitMsgInfo?: boolean;
    uKey?: string;
    fileName?: string;
  } = {},
): Uint8Array {
  if (options.retCode !== undefined && options.retCode !== 0) {
    return encode(NTV2_UPLOAD_RESP_TOP, {
      respHead: {
        retCode: options.retCode,
        ...(options.message ? { message: options.message } : {}),
      },
    });
  }
  if (options.omitMsgInfo) {
    // 有 upload 段但没 msgInfo —— 专门走「缺少 msgInfo」那条错误分支。
    return encode(NTV2_UPLOAD_RESP_TOP, { respHead: { retCode: 0 }, upload: {} });
  }
  return encode(NTV2_UPLOAD_RESP_TOP, {
    respHead: { retCode: 0 },
    upload: {
      ...(options.uKey ? { uKey: options.uKey } : {}),
      msgInfo: {
        msgInfoBody: [
          {
            index: {
              fileUuid: 'e6f0d3f0-0000-4000-8000-000000000001',
              subType: 0,
              info: {
                fileSize: 100,
                fileHash: 'md5',
                fileSha1: 'sha1',
                fileName: options.fileName ?? 'resolved.jpg',
              },
            },
            picture: { urlPath: '/download?fileid=x' },
            fileExist: true,
          },
        ],
        extBizInfo: { pic: { bizType: 0, textSummary: '[图片]' } },
      },
    },
  });
}

/** 1×1 的合法 PNG（真像素，能被 detectImageFormat 读出 1×1）。 */
const TINY_PNG = makeSolidPng(1, 1);
/** 640×360 的合法 PNG（探测尺寸用）。 */
const PNG_640x360 = makeSolidPng(640, 360);

const GROUP_TARGET = { uin: '10001', isGroup: true, groupId: 2863253201 };
const C2C_TARGET = { uin: '10001', isGroup: false, userUid: 'u_mGIBTBW7gF4Wocw8zapc6w' };

// ───────────────────────── highway 帧 ─────────────────────────

describe('highway 帧打包 / 解包', () => {
  it('round-trip：0x28 | headLen | bodyLen | head | body | 0x29', () => {
    const head = new Uint8Array([1, 2, 3]);
    const body = new Uint8Array([4, 5, 6, 7]);
    const frame = packHighwayFrame(head, body);
    expect(frame[0]).toBe(0x28);
    expect(frame[frame.length - 1]).toBe(0x29);
    expect(frame.length).toBe(9 + head.length + body.length + 1);
    const unpacked = unpackHighwayFrame(frame);
    expect(Array.from(unpacked.head)).toEqual([1, 2, 3]);
    expect(Array.from(unpacked.body)).toEqual([4, 5, 6, 7]);
  });

  it('非 highway 帧直接报错', () => {
    expect(() => unpackHighwayFrame(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))).toThrow(
      /帧非法/,
    );
  });

  it('请求头带 uin / commandId / 分块 md5 + fileMd5 / sig_session', () => {
    const built = buildHighwayHead({
      uin: '10001',
      commandId: VIDEO_HIGHWAY_GROUP,
      fileSize: 3 * 1024 * 1024,
      offset: 1024 * 1024,
      length: 1024 * 1024,
      chunkMd5: new Uint8Array([9]),
      fileMd5: new Uint8Array([8]),
      sigSession: new Uint8Array([7, 7]),
      extend: new Uint8Array([1]),
    });
    const parsed = decode(REQ_DATA_HIGHWAY_HEAD, built) as {
      msgBaseHead?: { uin?: string; commandId?: number; dataFlag?: number };
      msgSegHead?: {
        filesize?: bigint;
        dataOffset?: bigint;
        dataLength?: number;
        serviceTicket?: Uint8Array;
        md5?: Uint8Array;
        fileMd5?: Uint8Array;
      };
      bytesReqExtendInfo?: Uint8Array;
    };
    expect(parsed.msgBaseHead?.uin).toBe('10001');
    expect(parsed.msgBaseHead?.commandId).toBe(VIDEO_HIGHWAY_GROUP);
    expect(parsed.msgBaseHead?.dataFlag).toBe(16);
    expect(Number(parsed.msgSegHead?.filesize)).toBe(3 * 1024 * 1024);
    expect(Number(parsed.msgSegHead?.dataOffset)).toBe(1024 * 1024);
    expect(parsed.msgSegHead?.dataLength).toBe(1024 * 1024);
    expect(Array.from(parsed.msgSegHead?.serviceTicket ?? [])).toEqual([7, 7]);
    expect(Array.from(parsed.msgSegHead?.md5 ?? [])).toEqual([9]);
    expect(Array.from(parsed.msgSegHead?.fileMd5 ?? [])).toEqual([8]);
    expect(Array.from(parsed.bytesReqExtendInfo ?? [])).toEqual([1]);
  });
});

describe('highway 载荷（NTV2RichMediaHighwayExt）', () => {
  it('带 uKey / fileUuid / msgInfoBody / 1MiB blockSize / 分块 sha1 数组', () => {
    const extend = buildHighwayExtend(
      'ukey-1',
      { msgInfoBody: [{ index: { fileUuid: 'uuid-1' }, fileExist: true }], extBizInfo: {} },
      // ServerAddr.ip / IPv4.outIP 是 FIXED32（线上小端）：0x04030201 = 1.2.3.4
      [{ outIp: 0x04030201, outPort: 8080 }],
      [new Uint8Array([1]), new Uint8Array([2])],
      0,
    );
    const parsed = decode(NTV2_RICH_MEDIA_HIGHWAY_EXT, extend) as {
      uKey?: string;
      fileUuid?: string;
      blockSize?: number;
      hash?: { fileSha1?: Uint8Array[] };
      network?: { ipv4s?: { domain?: { ip?: string }; port?: number }[] };
    };
    expect(parsed.uKey).toBe('ukey-1');
    expect(parsed.fileUuid).toBe('uuid-1');
    expect(parsed.blockSize).toBe(1024 * 1024);
    expect(parsed.hash?.fileSha1?.map((b) => Array.from(b))).toEqual([[1], [2]]);
    expect(parsed.network?.ipv4s?.[0]?.domain?.ip).toBe('1.2.3.4');
    expect(parsed.network?.ipv4s?.[0]?.port).toBe(8080);
  });

  it('msgInfoBody 为空时报错', () => {
    expect(() =>
      buildHighwayExtend('k', { msgInfoBody: [], extBizInfo: {} }, [], new Uint8Array(1)),
    ).toThrow(/msgInfoBody/);
  });
});

// ───────────────────────── 波形 ─────────────────────────

/** 造一个最小可解析的 s16le WAV。 */
function makeWav(pcm: Uint8Array, channels: number, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

describe('语音波形', () => {
  it('真 PCM：前半段有声、后半段静音 → 前几个 bin 有值、末尾为 0', () => {
    const frames = 3000;
    const pcm = new Uint8Array(frames * 2);
    for (let i = 0; i < frames; i++) {
      const value = i < frames / 2 ? 30000 : 0;
      pcm[i * 2] = value & 0xff;
      pcm[i * 2 + 1] = (value >> 8) & 0xff;
    }
    const amps = amplitudesFromPcmS16le(pcm, { channels: 1, bins: 30 });
    expect(amps.length).toBe(30);
    expect(amps[0]).toBeGreaterThan(200);
    expect(amps[29]).toBe(0);
  });

  it('整段静音 → 官方静音底（25），不是全 0', () => {
    const amps = amplitudesFromPcmS16le(new Uint8Array(2000), { channels: 1 });
    expect(amps.length).toBe(PTT_WAVEFORM_BINS);
    expect(Array.from(amps)).toEqual(new Array(PTT_WAVEFORM_BINS).fill(PTT_WAVEFORM_SILENCE));
  });

  it('没有 PCM/WAV → mock 一条 30 字节合成条，且不抛异常', () => {
    const built = buildPttWaveform({});
    expect(built.mocked).toBe(true);
    const decoded = decodePttWaveform(built.bytes);
    expect(decoded.size).toBe(PTT_WAVEFORM_BINS);
    expect(decoded.amplitudes.length).toBe(PTT_WAVEFORM_BINS);
  });

  it('给得出 WAV → 真条（mocked=false）', () => {
    const wav = makeWav(new Uint8Array(2000).fill(0x40), 1, 24000);
    const built = buildPttWaveform({ wav });
    expect(built.mocked).toBe(false);
    expect(decodePttWaveform(built.bytes).amplitudes.some((v) => v > 0)).toBe(true);
  });

  it('给了 WAV 但格式不对（非 PCM）→ 退回 mock 而不是抛错', () => {
    const wav = makeWav(new Uint8Array(8), 1, 24000);
    wav[20] = 3; // audioFormat = IEEE float
    expect(buildPttWaveform({ wav }).mocked).toBe(true);
  });
});

// ───────────────────────── 图片格式与兜底封面 ─────────────────────────

describe('图片格式探测 / 兜底封面', () => {
  it('探测 PNG 尺寸', () => {
    expect(detectImageFormat(PNG_640x360)).toEqual({
      format: PIC_FORMAT_PNG,
      width: 640,
      height: 360,
    });
  });

  it('认不出的字节回落到 jpg 0×0', () => {
    expect(detectImageFormat(new Uint8Array([1, 2, 3, 4, 5]))).toEqual({
      format: PIC_FORMAT_JPEG,
      width: 0,
      height: 0,
    });
  });

  it('合成 PNG 的声明尺寸 = 真实像素（避免接收端判「已过期」）', () => {
    const png = makeSolidPng(64, 48);
    expect(detectImageFormat(png)).toEqual({ format: PIC_FORMAT_PNG, width: 64, height: 48 });
  });
});

// ───────────────────────── 上传 → msgInfo ─────────────────────────

describe('uploadImageMsgInfo', () => {
  it('私聊图片：OIDB 0x11C5_100 + 请求形状正确 + msgInfo 解得出', async () => {
    const native = makeNative({ oidb: () => uploadResponse({ fileName: 'remote.jpg' }) });
    const result = await uploadImageMsgInfo(native, 42, C2C_TARGET, { source: PNG_640x360 });

    expect(native.oidbCalls).toHaveLength(1);
    expect(native.oidbCalls[0]!.command).toBe(0x11c5);
    expect(native.oidbCalls[0]!.subCommand).toBe(100);
    expect(native.oidbCalls[0]!.isUid).toBe(true);

    const req = decode(NTV2_UPLOAD_REQ_TOP, native.oidbCalls[0]!.body) as {
      reqHead?: {
        common?: { requestId?: number; command?: number };
        scene?: {
          requestType?: number;
          businessType?: number;
          sceneType?: number;
          c2c?: { targetUid?: string };
        };
        client?: { agentType?: number };
      };
      upload?: {
        uploadInfo?: { fileInfo?: Record<string, unknown>; subFileType?: number }[];
        tryFastUploadCompleted?: boolean;
        compatQmsgSceneType?: number;
        extBizInfo?: {
          pic?: {
            bizType?: number;
            textSummary?: string;
            bytesPbReserveC2c?: { subType?: number };
            bytesPbReserveTroop?: { subType?: number };
          };
        };
      };
    };
    expect(req.reqHead?.common).toEqual({ requestId: 1, command: 100 });
    expect(req.reqHead?.scene?.businessType).toBe(1);
    expect(req.reqHead?.scene?.requestType).toBe(2);
    expect(req.reqHead?.scene?.sceneType).toBe(1);
    expect(req.reqHead?.scene?.c2c?.targetUid).toBe(C2C_TARGET.userUid);
    expect(req.reqHead?.client?.agentType).toBe(2);
    expect(req.upload?.tryFastUploadCompleted).toBe(true);
    expect(req.upload?.compatQmsgSceneType).toBe(1);
    // subFileType=0 是 proto3 默认值（不上 wire，与 SL/NapCat 一致）。
    expect(Number(req.upload?.uploadInfo?.[0]?.subFileType ?? 0)).toBe(0);
    const fileInfo = req.upload?.uploadInfo?.[0]?.fileInfo as {
      fileSize?: number;
      fileName?: string;
      type?: { type?: number; picFormat?: number; videoFormat?: number; voiceFormat?: number };
      width?: number;
      height?: number;
      original?: number;
    };
    expect(fileInfo.fileSize).toBe(PNG_640x360.length);
    expect(fileInfo.type).toEqual({
      type: 1,
      picFormat: PIC_FORMAT_PNG,
      videoFormat: 0,
      voiceFormat: 0,
    });
    expect(fileInfo.width).toBe(640);
    expect(fileInfo.height).toBe(360);
    // 原图标记必须在 wire 上（proto3 里 0 会被省，这里 1 不会）。
    expect(fileInfo.original).toBe(1);
    expect(fileInfo.fileName).toMatch(/\.png$/);
    expect(req.upload?.extBizInfo?.pic?.textSummary).toBe('[图片]');
    // 私聊 reserve 必须在（真机：漏了收端显示「图片已过期」）。
    // subType=0 是 proto3 默认值，编码出来是空子消息 —— 只断言「字段在」。
    expect(req.upload?.extBizInfo?.pic?.bytesPbReserveC2c).toBeDefined();
    expect(req.upload?.extBizInfo?.pic?.bytesPbReserveTroop).toBeUndefined();

    // 产物：msgInfo 就是 outgoing pbElem。
    expect(result.fastUpload).toBe(true);
    expect(result.fileName).toMatch(/\.png$/);
    expect(result.width).toBe(640);
    expect(result.md5Hex).toHaveLength(32);
    expect(result.sha1Hex).toHaveLength(40);
    const msgInfo = decode(UPLOAD_MSG_INFO, result.msgInfo) as {
      msgInfoBody?: { index?: { fileUuid?: string } }[];
      extBizInfo?: { pic?: { textSummary?: string; bytesPbReserveC2c?: { subType?: number } } };
    };
    expect(msgInfo.msgInfoBody?.[0]?.index?.fileUuid).toBe('e6f0d3f0-0000-4000-8000-000000000001');
    expect(msgInfo.extBizInfo?.pic?.textSummary).toBe('[图片]');
    // 服务端响应里有 pic 时按 key 补齐（不能把 reserve 丢掉）。
    expect(msgInfo.extBizInfo?.pic?.bytesPbReserveC2c).toBeDefined();
  });

  it('群聊图片：0x11C4_100 + sceneType=2 + 群号 + compat=2', async () => {
    const native = makeNative({ oidb: () => uploadResponse() });
    await uploadImageMsgInfo(native, 42, GROUP_TARGET, { source: TINY_PNG, subType: 1 });
    expect(native.oidbCalls[0]!.command).toBe(0x11c4);
    const req = decode(NTV2_UPLOAD_REQ_TOP, native.oidbCalls[0]!.body) as {
      reqHead?: { scene?: { sceneType?: number; group?: { groupUin?: number } } };
      upload?: {
        compatQmsgSceneType?: number;
        extBizInfo?: {
          pic?: {
            bizType?: number;
            textSummary?: string;
            bytesPbReserveC2c?: { subType?: number };
            bytesPbReserveTroop?: { subType?: number };
          };
        };
      };
    };
    expect(req.reqHead?.scene?.sceneType).toBe(2);
    expect(req.reqHead?.scene?.group?.groupUin).toBe(GROUP_TARGET.groupId);
    expect(req.upload?.compatQmsgSceneType).toBe(2);
    expect(req.upload?.extBizInfo?.pic?.bizType).toBe(1);
    expect(req.upload?.extBizInfo?.pic?.textSummary).toBe('[动画表情]');
    // 群聊走 troop reserve，且**不能**出现私聊那个 tag（两个字段互斥）。
    expect(req.upload?.extBizInfo?.pic?.bytesPbReserveTroop?.subType).toBe(1);
    expect(req.upload?.extBizInfo?.pic?.bytesPbReserveC2c).toBeUndefined();
  });

  it('覆盖尺寸/格式时按调用方给的走', async () => {
    const native = makeNative({ oidb: () => uploadResponse() });
    const result = await uploadImageMsgInfo(native, 1, GROUP_TARGET, {
      source: TINY_PNG,
      width: 800,
      height: 600,
      picFormat: 1000,
      fileName: 'custom.jpg',
    });
    expect(result.width).toBe(800);
    expect(result.height).toBe(600);
    expect(result.fileName).toBe('custom.jpg');
  });

  it('服务端 retCode != 0 → 抛错并带上信息', async () => {
    const native = makeNative({ oidb: () => uploadResponse({ retCode: 1, message: 'no quota' }) });
    await expect(uploadImageMsgInfo(native, 1, GROUP_TARGET, { source: TINY_PNG })).rejects.toThrow(
      /retCode=1 no quota/,
    );
  });

  it('响应缺 msgInfo / 缺 upload → 抛错（不静默失败）', async () => {
    const native = makeNative({ oidb: () => uploadResponse({ omitMsgInfo: true }) });
    await expect(uploadImageMsgInfo(native, 1, GROUP_TARGET, { source: TINY_PNG })).rejects.toThrow(
      /缺少 msgInfo/,
    );
    const empty = makeNative({
      oidb: () => encode(NTV2_UPLOAD_RESP_TOP, { respHead: { retCode: 0 } }),
    });
    await expect(uploadImageMsgInfo(empty, 1, GROUP_TARGET, { source: TINY_PNG })).rejects.toThrow(
      /缺少 upload/,
    );
  });

  it('群聊缺 groupId / 私聊缺 userUid → 联网前就报错', async () => {
    const native = makeNative({ oidb: () => uploadResponse() });
    await expect(
      uploadImageMsgInfo(native, 1, { uin: '1', isGroup: true }, { source: TINY_PNG }),
    ).rejects.toThrow(/需要 groupId/);
    await expect(
      uploadImageMsgInfo(native, 1, { uin: '1', isGroup: false }, { source: TINY_PNG }),
    ).rejects.toThrow(/需要 userUid/);
    expect(native.oidbCalls).toHaveLength(0);
  });

  it('空路径 / 空字节 → 报错', async () => {
    const native = makeNative({ oidb: () => uploadResponse() });
    await expect(uploadImageMsgInfo(native, 1, GROUP_TARGET, { source: '  ' })).rejects.toThrow(
      /不能是空路径/,
    );
    await expect(
      uploadImageMsgInfo(native, 1, GROUP_TARGET, { source: new Uint8Array(0) }),
    ).rejects.toThrow(/字节是空的/);
    expect(native.oidbCalls).toHaveLength(0);
  });
});

describe('uploadPttMsgInfo', () => {
  it('群聊语音：requestId=1、businessType=3、voiceFormat、time=duration、波形进 extBizInfo', async () => {
    const silk = new Uint8Array([0x02, 0x23, 0x21, 0x53, 0x49, 0x4c, 0x4b]);
    const native = makeNative({ oidb: () => uploadResponse({ fileName: 'voice.amr' }) });
    const result = await uploadPttMsgInfo(native, 9, GROUP_TARGET, { source: silk, duration: 7 });

    expect(native.oidbCalls[0]!.command).toBe(0x126e);
    const req = decode(NTV2_UPLOAD_REQ_TOP, native.oidbCalls[0]!.body) as {
      reqHead?: {
        common?: { requestId?: number };
        scene?: { businessType?: number; sceneType?: number };
      };
      upload?: {
        uploadInfo?: { fileInfo?: Record<string, unknown> }[];
        extBizInfo?: {
          ptt?: {
            waveform?: Uint8Array;
            bytesGeneralFlags?: Uint8Array;
            bytesReserve?: Uint8Array;
          };
        };
      };
    };
    expect(req.reqHead?.common?.requestId).toBe(1);
    expect(req.reqHead?.scene?.businessType).toBe(3);
    expect(req.reqHead?.scene?.sceneType).toBe(2);
    const fileInfo = req.upload?.uploadInfo?.[0]?.fileInfo as {
      time?: number;
      type?: { type?: number; picFormat?: number; videoFormat?: number; voiceFormat?: number };
      fileName?: string;
      width?: number;
      height?: number;
    };
    expect(fileInfo.time).toBe(7);
    expect(fileInfo.type).toEqual({ type: 3, picFormat: 0, videoFormat: 0, voiceFormat: 1 });
    expect(fileInfo.fileName).toMatch(/\.amr$/);
    // 尺寸 0 是 proto3 默认值（不上 wire）。
    expect(Number(fileInfo.width ?? 0)).toBe(0);
    expect(Number(fileInfo.height ?? 0)).toBe(0);
    // 波形（合成条）+ NapCat 的 group generalFlags。
    const ptt = req.upload?.extBizInfo?.ptt;
    expect(decodePttWaveform(ptt!.waveform!).amplitudes.length).toBe(PTT_WAVEFORM_BINS);
    expect(Array.from(ptt!.bytesGeneralFlags ?? [])).toEqual([
      0x9a, 0x01, 0x07, 0xaa, 0x03, 0x04, 0x08, 0x08, 0x12, 0x00,
    ]);
    expect(Array.from(ptt!.bytesReserve ?? [])).toEqual([0x08, 0x00, 0x38, 0x00]);
    expect(result.waveformMocked).toBe(true);
  });

  it('私聊语音：0x126D + requestId=4 + compat=1 + 33 字节 reserve（无 generalFlags）', async () => {
    const native = makeNative({ oidb: () => uploadResponse() });
    await uploadPttMsgInfo(native, 9, C2C_TARGET, { source: new Uint8Array([0x02, 0x01]) });
    expect(native.oidbCalls[0]!.command).toBe(0x126d);
    const req = decode(NTV2_UPLOAD_REQ_TOP, native.oidbCalls[0]!.body) as {
      reqHead?: { common?: { requestId?: number }; scene?: { sceneType?: number } };
      upload?: {
        clientRandomId?: bigint | number;
        compatQmsgSceneType?: number;
        extBizInfo?: {
          ptt?: { bytesReserve?: Uint8Array; bytesGeneralFlags?: Uint8Array };
        };
      };
    };
    expect(req.reqHead?.common?.requestId).toBe(4);
    expect(req.reqHead?.scene?.sceneType).toBe(1);
    expect(req.upload?.compatQmsgSceneType).toBe(1);
    // 安卓真机抓包：私聊不带 generalFlags。
    expect(req.upload?.extBizInfo?.ptt?.bytesGeneralFlags).toBeUndefined();
    const reserve = Array.from(req.upload?.extBizInfo?.ptt?.bytesReserve ?? []);
    expect(reserve).toHaveLength(33);
    const random = Number(req.upload?.clientRandomId ?? 0) >>> 0;
    const be32 = [
      (random >>> 24) & 0xff,
      (random >>> 16) & 0xff,
      (random >>> 8) & 0xff,
      random & 0xff,
    ];
    expect(reserve).toEqual([
      0x05,
      0x02,
      0x00,
      0x01,
      0x00,
      0x04,
      0x00,
      0x04,
      ...be32,
      0x08,
      0x00,
      0x04,
      0x00,
      0x00,
      0x00,
      0x01,
      0x09,
      0x00,
      0x04,
      0x00,
      0x00,
      0x00,
      0x03,
      0x0a,
      0x00,
      0x04,
      0x08,
      0x00,
      0x38,
      0x00,
    ]);
  });

  it('给真 WAV 时波形不是 mock', async () => {
    const native = makeNative({ oidb: () => uploadResponse() });
    const wav = makeWav(new Uint8Array(2000).fill(0x30), 1, 24000);
    const result = await uploadPttMsgInfo(native, 9, C2C_TARGET, {
      source: new Uint8Array([0x02, 0x01]),
      duration: 1,
      waveform: { wav },
    });
    expect(result.waveformMocked).toBe(false);
  });
});

describe('uploadVideoMsgInfo', () => {
  it('群聊视频：两个子文件（正文 + 封面 100）、真实尺寸、time=duration', async () => {
    const native = makeNative({ oidb: () => uploadResponse({ fileName: 'v.mp4' }) });
    const result = await uploadVideoMsgInfo(native, 3, GROUP_TARGET, {
      source: new Uint8Array(2048).fill(7),
      width: 640,
      height: 360,
      duration: 12,
    });

    expect(native.oidbCalls[0]!.command).toBe(0x11ea);
    const req = decode(NTV2_UPLOAD_REQ_TOP, native.oidbCalls[0]!.body) as {
      reqHead?: { common?: { requestId?: number }; scene?: { businessType?: number } };
      upload?: {
        compatQmsgSceneType?: number;
        uploadInfo?: { fileInfo?: Record<string, unknown>; subFileType?: number }[];
        extBizInfo?: { video?: { bytesPbReserve?: Uint8Array } };
      };
    };
    expect(req.reqHead?.common?.requestId).toBe(3);
    expect(req.reqHead?.scene?.businessType).toBe(2);
    expect(req.upload?.uploadInfo).toHaveLength(2);
    const main = req.upload?.uploadInfo?.[0]?.fileInfo as {
      time?: number;
      width?: number;
      height?: number;
      type?: { type?: number };
    };
    expect(main.time).toBe(12);
    expect(main.width).toBe(640);
    expect(main.height).toBe(360);
    expect(main.type?.type).toBe(2);
    expect(req.upload?.uploadInfo?.[1]?.subFileType).toBe(100);
    const thumb = req.upload?.uploadInfo?.[1]?.fileInfo as {
      width?: number;
      height?: number;
      type?: { type?: number };
    };
    // 没给封面 → 合成一张 640×360 的纯色 PNG。
    expect(thumb.type?.type).toBe(1);
    expect(thumb.width).toBe(640);
    expect(thumb.height).toBe(360);
    // 视频固定 compat=2（连私聊也是）。
    expect(req.upload?.compatQmsgSceneType).toBe(2);
    expect(Array.from(req.upload?.extBizInfo?.video?.bytesPbReserve ?? [])).toEqual([
      0x80, 0x01, 0x00,
    ]);
    expect(result.fileName).toMatch(/\.mp4$/);
    expect(result.width).toBe(640);
    expect(result.height).toBe(360);
  });

  it('私聊视频：0x11E9 + width/height 发 0（服务端 schema 限制）', async () => {
    const native = makeNative({ oidb: () => uploadResponse() });
    await uploadVideoMsgInfo(native, 3, C2C_TARGET, {
      source: new Uint8Array(1024).fill(1),
      width: 640,
      height: 360,
      duration: 3,
    });
    expect(native.oidbCalls[0]!.command).toBe(0x11e9);
    const req = decode(NTV2_UPLOAD_REQ_TOP, native.oidbCalls[0]!.body) as {
      upload?: { uploadInfo?: { fileInfo?: { width?: number; height?: number } }[] };
    };
    expect(Number(req.upload?.uploadInfo?.[0]?.fileInfo?.width ?? 0)).toBe(0);
    expect(Number(req.upload?.uploadInfo?.[0]?.fileInfo?.height ?? 0)).toBe(0);
  });

  it('视频走磁盘路径也能算出一致的哈希（流式，不进内存）', async () => {
    const path = `/tmp/weq-media-test-${Date.now()}.mp4`;
    const bytes = new Uint8Array(4096).fill(3);
    await fsp.writeFile(path, bytes);
    try {
      const fromFile = await uploadVideoMsgInfo(
        makeNative({ oidb: () => uploadResponse() }),
        3,
        GROUP_TARGET,
        { source: path, width: 2, height: 2 },
      );
      const fromBytes = await uploadVideoMsgInfo(
        makeNative({ oidb: () => uploadResponse() }),
        3,
        GROUP_TARGET,
        { source: bytes, width: 2, height: 2 },
      );
      expect(fromFile.md5Hex).toBe(fromBytes.md5Hex);
      expect(fromFile.sha1Hex).toBe(fromBytes.sha1Hex);
      expect(fromFile.fileSize).toBe(4096);
    } finally {
      await fsp.rm(path, { force: true });
    }
  });
});

describe('runNtv2Upload 的 fast-upload 分支', () => {
  const base = {
    uin: '10001',
    isGroup: true,
    targetIdOrUid: 100,
    oidbCmd: 0x11c4,
    requestId: 1,
    businessType: 1,
    uploadInfo: [],
    compatQmsgSceneType: 2,
    extBizInfo: {},
    label: '测试',
  };

  it('uKey 存在但没有字节 → 抛 fastOnlyError（不静默）', async () => {
    const native = makeNative({ oidb: () => uploadResponse({ uKey: 'need-bytes' }) });
    await expect(
      runNtv2Upload(native, 1, {
        ...base,
        uploads: [
          {
            source: 'top',
            cmdId: IMAGE_HIGHWAY_GROUP,
            bytes: new Uint8Array(0),
            md5: new Uint8Array(1),
            sha1: new Uint8Array(1),
            fastOnlyError: '资源不在服务端，必须传字节',
          },
        ],
      }),
    ).rejects.toThrow(/必须传字节/);
  });

  it('uKey 存在但没有字节也没有 fastOnlyError → 跳过该子文件', async () => {
    const native = makeNative({ oidb: () => uploadResponse({ uKey: 'need-bytes' }) });
    const upload = await runNtv2Upload(native, 1, {
      ...base,
      uploads: [
        {
          source: 'top',
          cmdId: IMAGE_HIGHWAY_GROUP,
          bytes: new Uint8Array(0),
          md5: new Uint8Array(1),
          sha1: new Uint8Array(1),
        },
      ],
    });
    expect(upload.uKey).toBe('need-bytes');
  });

  it('finalizeMediaMsgInfo 缺 msgInfo 时抛错', () => {
    expect(() => finalizeMediaMsgInfo({})).toThrow(/缺少 msgInfo/);
  });
});

// ───────────────────────── 元素层：媒体拼装 ─────────────────────────

/** 记账 native：OIDB 走上传响应，SSO 走 PbSendMsg 成功响应。 */
const sendNative = (response = uploadResponse()) =>
  makeNative({
    oidb: () => response,
    packet: (call) => {
      if (call.cmd !== 'MessageSvc.PbSendMsg') throw new Error(`未知命令 ${call.cmd}`);
      return encode(SEND_MESSAGE_RESPONSE, {
        result: 0,
        groupSequence: 5,
        privateSequence: 6,
        timestamp1: 1700000000,
      });
    },
  });

describe('buildSendElemsWithMedia', () => {
  it('图片元素拼成 commonElem(serviceType=48, businessType=20)，顺序保持', async () => {
    const native = sendNative();
    const elems = await buildSendElemsWithMedia(
      [
        { kind: 'text', textContent: '看图' },
        { kind: 'image', source: TINY_PNG },
      ],
      { nt: native, pid: 1, uin: '10001', scene: 'group', groupId: 2863253201 },
    );
    expect(elems).toHaveLength(2);
    expect(elems[0]).toEqual({ text: { str: '看图' } });
    const common = (
      elems[1] as { commonElem: { serviceType: number; businessType: number; pbElem: Uint8Array } }
    ).commonElem;
    expect(common.serviceType).toBe(48);
    expect(common.businessType).toBe(20);
    // pbElem 就是 msgInfo：能按收侧的 PIC_COMMON_PB 解出文件名。
    const pic = decode(PIC_COMMON_PB, common.pbElem) as {
      file?: { body?: { info?: { fileName?: string } } };
    };
    expect(pic.file?.body?.info?.fileName).toBe('resolved.jpg');
  });

  it('语音 / 视频的 businessType 分别是 22 / 21', async () => {
    const native = sendNative();
    const elems = await buildSendElemsWithMedia(
      [
        { kind: 'record', source: new Uint8Array([0x02, 0x01]), duration: 2 },
        { kind: 'video', source: new Uint8Array(512).fill(1), width: 2, height: 2 },
      ],
      { nt: native, pid: 1, uin: '10001', scene: 'group', groupId: 1 },
    );
    expect((elems[0] as { commonElem: { businessType: number } }).commonElem.businessType).toBe(22);
    expect((elems[1] as { commonElem: { businessType: number } }).commonElem.businessType).toBe(21);
    // 语音一次申请 + 视频一次申请（视频封面在同一次申请里）。
    expect(native.oidbCalls.map((c) => c.command)).toEqual([0x126e, 0x11ea]);
  });

  it('校验先于联网：后面的元素非法 → 一个包都不发', async () => {
    const native = sendNative();
    await expect(
      buildSendElemsWithMedia(
        [
          { kind: 'image', source: TINY_PNG },
          { kind: 'face', faceId: -1 },
        ],
        { nt: native, pid: 1, uin: '10001', scene: 'group', groupId: 1 },
      ),
    ).rejects.toThrow(/faceId/);
    expect(native.oidbCalls).toHaveLength(0);

    await expect(
      buildSendElemsWithMedia(
        [
          { kind: 'image', source: TINY_PNG },
          { kind: 'video', source: '' },
        ],
        { nt: native, pid: 1, uin: '10001', scene: 'group', groupId: 1 },
      ),
    ).rejects.toThrow(/source/);
    expect(native.oidbCalls).toHaveLength(0);
  });

  it('场景限制（群里的窗口抖动）依然先被拦下', async () => {
    const native = sendNative();
    await expect(
      buildSendElemsWithMedia(
        [
          { kind: 'image', source: TINY_PNG },
          { kind: 'poke', subType: 1 },
        ],
        { nt: native, pid: 1, uin: '10001', scene: 'group', groupId: 1 },
      ),
    ).rejects.toThrow(/窗口抖动/);
    expect(native.oidbCalls).toHaveLength(0);
  });

  it('群临时会话按私聊形状上传（isGroup=false + 对方 uid）', async () => {
    const native = sendNative();
    await buildSendElemsWithMedia([{ kind: 'image', source: TINY_PNG }], {
      nt: native,
      pid: 1,
      uin: '10001',
      scene: 'group-temp',
      userUid: 'u_temp',
    });
    const req = decode(NTV2_UPLOAD_REQ_TOP, native.oidbCalls[0]!.body) as {
      reqHead?: { scene?: { sceneType?: number; c2c?: { targetUid?: string } } };
    };
    expect(native.oidbCalls[0]!.command).toBe(0x11c5);
    expect(req.reqHead?.scene?.sceneType).toBe(1);
    expect(req.reqHead?.scene?.c2c?.targetUid).toBe('u_temp');
  });

  it('onUpload 逐个回调，报告里带 kind / md5 / fastUpload', async () => {
    const native = sendNative();
    const seen: unknown[] = [];
    await buildSendElemsWithMedia([{ kind: 'image', source: PNG_640x360 }], {
      nt: native,
      pid: 1,
      uin: '10001',
      scene: 'group',
      groupId: 2863253201,
      onUpload: (report) => seen.push(report),
    });
    expect(seen).toEqual([expect.objectContaining({ kind: 'image', fastUpload: true })]);
  });

  it('没有媒体元素时不碰网络（直接同步打包）', async () => {
    const native = sendNative();
    const elems = await buildSendElemsWithMedia([{ kind: 'text', textContent: 'hi' }], {
      nt: native,
      pid: 1,
      uin: '10001',
      scene: 'c2c',
      userUid: 'u_x',
    });
    expect(elems).toEqual([{ text: { str: 'hi' } }]);
    expect(native.oidbCalls).toHaveLength(0);
  });
});

describe('sendMessage 带媒体', () => {
  it('上传后请求里出现 businessType=20 的 commonElem，回执正常', async () => {
    const native = sendNative();
    const receipt = await sendMessage(native, 7, {
      groupId: 2863253201,
      elements: [
        { kind: 'text', textContent: '图来了' },
        { kind: 'image', source: PNG_640x360 },
      ],
      random: 123456,
      media: { nt: native, pid: 7, uin: '10001' },
    });

    expect(receipt.ok).toBe(true);
    expect(receipt.scene).toBe('group');
    expect(receipt.groupSequence).toBe(5);
    const sent = native.packetCalls[0]!;
    expect(sent.cmd).toBe('MessageSvc.PbSendMsg');
    const body = decode(SEND_MESSAGE_REQUEST, sent.body) as {
      routingHead?: { grp?: { groupCode?: number } };
      messageBody?: { richText?: { elems?: Record<string, unknown>[] } };
      random?: number;
    };
    expect(Number(body.routingHead?.grp?.groupCode)).toBe(2863253201);
    expect(body.random).toBe(123456);
    const elems = body.messageBody?.richText?.elems ?? [];
    expect(elems).toHaveLength(2);
    const common = elems[1]!.commonElem as { serviceType: number; businessType: number };
    expect(common.serviceType).toBe(48);
    expect(common.businessType).toBe(20);
  });

  it('回执带 uploads：秒传命中时 fastUpload=true（真实字节数一个没传）', async () => {
    const native = sendNative();
    const receipt = await sendMessage(native, 7, {
      groupId: 2863253201,
      elements: [{ kind: 'image', source: PNG_640x360 }],
      random: 123456,
      media: { nt: native, pid: 7, uin: '10001' },
    });
    // 测试的假响应不给 uKey ⇒ 服务端口径的秒传 ⇒ 连 highway 会话都不该申请。
    expect(receipt.uploads).toHaveLength(1);
    expect(receipt.uploads[0]!.kind).toBe('image');
    expect(receipt.uploads[0]!.fastUpload).toBe(true);
    expect(receipt.uploads[0]!.md5Hex).toMatch(/^[0-9a-f]{32}$/);
    expect(receipt.uploads[0]!.fileSize).toBeGreaterThan(0);
    expect(native.packetCalls.filter((call) => call.cmd.startsWith('HttpConn'))).toHaveLength(0);
  });

  it('纯文本回执的 uploads 是空数组', async () => {
    const native = sendNative();
    const receipt = await sendMessage(native, 7, {
      groupId: 2863253201,
      elements: [{ kind: 'text', textContent: 'hi' }],
      random: 1,
    });
    expect(receipt.uploads).toEqual([]);
  });

  it('含媒体却不给 media 上下文 → 明确报错', async () => {
    const native = sendNative();
    await expect(
      sendMessage(native, 7, {
        groupId: 1,
        elements: [{ kind: 'image', source: TINY_PNG }],
        random: 1,
      }),
    ).rejects.toThrow(/params\.media/);
  });

  it('纯文本走原路径（不需要 media）', async () => {
    const native = sendNative();
    const receipt = await sendMessage(native, 7, {
      userUin: 2,
      elements: [{ kind: 'text', textContent: 'hi' }],
      random: 1,
    });
    expect(receipt.ok).toBe(true);
    expect(native.oidbCalls).toHaveLength(0);
  });
});
