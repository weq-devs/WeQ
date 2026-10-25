/**
 * 通话视频解码的纯逻辑：**参数集必须内联，不能走 `description`**。
 *
 * 这里钉住的是 2026-10-25 用真实抓包码流 + Electron 44 实测出来的结论。改动之前
 * 的写法是把 VPS/SPS/PPS 抽出来塞进 `VideoDecoderConfig.description`，结果界面上
 * 永远显示「当前环境不支持 H.265 解码（试过 6 种）」—— 六个候选其实都被同一份
 * 畸形 description 拖垮了：
 *
 * | 配置 | 实测结果 |
 * | --- | --- |
 * | `hev1`/`hvc1` 不带 description，参数集内联 | ✅ 52 帧全解出 |
 * | description = Annex B 参数集（旧写法） | ❌ `isConfigSupported` 恒 false |
 * | description = 规范 hvcC | ❌ 配置成功但首帧 `Decoder error` |
 *
 * 断言里不用字面量拼字节：真实的 VPS/SPS/PPS 样本来自 `call-trace` 抓包还原的首帧
 *（`VPS + SPS + PPS + IDR`，640×360 Main profile）。
 */

import { describe, expect, it } from 'vitest';
import {
  annexB,
  concatBytes,
  payloadForDecoder,
  toAccessUnit,
  toBytes,
} from '../src/renderer/src/lib/callVideo';

function hex(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** 真实抓包首帧里的三个参数集（原样，含 2 字节 NAL 头）。 */
const VPS = hex('40010c01ffff0160000003009000000300000300969a8090');
const SPS = hex('420101016000000300900000030000030096a005020169659aa4932e402000000300200000030181');
const PPS = hex('4401c172b02240');

/** 首帧的 IDR（type 19）只取前 32 字节：够判类型，不用把 1.7 KB 贴进测试。 */
const IDR_HEAD = hex('2601afe0f9467ffe9ca635f157060ec9088a50419a42a590aa2bc843c376c33f88bc0015');

const FIRST_FRAME = annexB([VPS, SPS, PPS, IDR_HEAD]);

/** 第 2 帧：单个 TRAIL_R（type 1），不带参数集。 */
const DELTA_FRAME = annexB([hex('0201e025e2409ec163f761f19f95bff884043e92')]);

describe('toAccessUnit', () => {
  it('首帧同时带参数集和 IRAP —— 两样都要识别出来', () => {
    const au = toAccessUnit(FIRST_FRAME);
    expect(au.keyframe).toBe(true);
    expect(au.params).toHaveLength(3);
    expect(Array.from(au.params[0]!)).toEqual(Array.from(VPS));
    expect(Array.from(au.params[1]!)).toEqual(Array.from(SPS));
    expect(Array.from(au.params[2]!)).toEqual(Array.from(PPS));
  });

  it('数据里保留参数集（不剥掉）—— 剥掉就只能靠 description，而那条路走不通', () => {
    const au = toAccessUnit(FIRST_FRAME);
    // 拼回来的数据应当与输入等长：4 个 NAL × 4 字节起始码 + 各 NAL 内容。
    expect(au.data).not.toBeNull();
    expect(au.data!.length).toBe(4 * 4 + VPS.length + SPS.length + PPS.length + IDR_HEAD.length);
    // 起始码之后第一个 NAL 就是 VPS：这是 Chromium 走 in-band 参数集的前提。
    expect(Array.from(au.data!.subarray(4, 4 + VPS.length))).toEqual(Array.from(VPS));
  });

  it('后续 delta 帧：不是关键帧，也不带参数集', () => {
    const au = toAccessUnit(DELTA_FRAME);
    expect(au.keyframe).toBe(false);
    expect(au.params).toHaveLength(0);
    expect(au.data).not.toBeNull();
  });

  it('空数据 / 非 Annex B 数据返回空结果，不抛异常', () => {
    expect(toAccessUnit(new Uint8Array(0))).toEqual({ data: null, keyframe: false, params: [] });
    expect(toAccessUnit(hex('deadbeefdeadbeef'))).toEqual({
      data: null,
      keyframe: false,
      params: [],
    });
  });
});

describe('payloadForDecoder', () => {
  const au = toAccessUnit(DELTA_FRAME);
  const cached = [VPS, SPS, PPS];

  it('解码器不是新建的：原样送，不重复贴参数集', () => {
    const out = payloadForDecoder(au, cached, false);
    expect(out).not.toBeNull();
    expect(Array.from(out!)).toEqual(Array.from(au.data!));
  });

  it('解码器刚建 / 刚重建 + 这一帧没带参数集：把缓存补在最前面', () => {
    // 实测：不补 -> 那个只含 IDR/CRA 的关键帧会让 decode() 一直抛
    // `A key frame is required after configure()`，画面永久黑掉。
    const out = payloadForDecoder(au, cached, true);
    expect(out).not.toBeNull();
    const expectedHead = concatBytes([annexB(cached), au.data!]);
    expect(Array.from(out!)).toEqual(Array.from(expectedHead));
    // 参数集真的在最前面，顺序是 VPS -> SPS -> PPS -> 帧数据。
    expect(Array.from(out!.subarray(4, 4 + VPS.length))).toEqual(Array.from(VPS));
  });

  it('这一帧自己就带参数集：不重复追加', () => {
    const keyAu = toAccessUnit(FIRST_FRAME);
    const out = payloadForDecoder(keyAu, cached, true);
    expect(Array.from(out!)).toEqual(Array.from(keyAu.data!));
  });

  it('没有缓存参数集时只能原样送（首帧之前的 delta 帧本来也解不了）', () => {
    const out = payloadForDecoder(au, [], true);
    expect(Array.from(out!)).toEqual(Array.from(au.data!));
  });

  /**
   * 重建点落在 **delta 帧** 上时，那帧会被「未配置就跳过 delta」丢掉。
   *
   * 如果调用方用「这一帧是不是重建的那一帧」当 fresh 判据，标记就跟着这帧一起
   * 丢了 —— 后面的关键帧不再补参数集，实测 0 帧且**不报错**（静默黑屏）。所以
   * 判据必须换成「还欠着一份参数集没补」，挂到真的喂出一帧为止。这里钉住的是
   * `payloadForDecoder` 的接口语义：只要 `fresh` 传 true 就补，由调用方负责把
   * 标记持住。
   */
  it('重建点落在 delta 帧：后续关键帧仍要补参数集', () => {
    const keyAu = toAccessUnit(FIRST_FRAME);
    const deltaAu = toAccessUnit(DELTA_FRAME);

    // 重建后第一个能喂的帧（delta 被跳过）：关键帧自带参数集，不重复贴。
    expect(Array.from(payloadForDecoder(keyAu, cached, true)!)).toEqual(Array.from(keyAu.data!));
    // 若是「只有首帧带参数集」的码流，后续关键帧不带参数集 —— 必须补。
    const bareKeyAu = toAccessUnit(annexB([IDR_HEAD]));
    expect(bareKeyAu.keyframe).toBe(true);
    expect(bareKeyAu.params).toHaveLength(0);
    const patched = payloadForDecoder(bareKeyAu, cached, true)!;
    expect(Array.from(patched.subarray(4, 4 + VPS.length))).toEqual(Array.from(VPS));
    // delta 帧在 fresh 状态下同样会被补贴（调用方只在关键帧时才走到这里）。
    expect(payloadForDecoder(deltaAu, cached, true)!.length).toBeGreaterThan(deltaAu.data!.length);
  });
});

describe('toBytes（tRPC 序列化形态）', () => {
  it('认 Node Buffer 的 JSON 形态', () => {
    const bytes = toBytes({ type: 'Buffer', data: [0, 0, 0, 1, 0x26, 0x01] });
    expect(bytes).not.toBeNull();
    expect(Array.from(bytes!)).toEqual([0, 0, 0, 1, 0x26, 0x01]);
  });

  it('认普通对象 {0:..,1:..,length:n} —— 这种形态没有 subarray', () => {
    const bytes = toBytes({ 0: 0, 1: 0, 2: 0, 3: 1, 5: 0x26, length: 6 });
    expect(bytes).not.toBeNull();
    expect(Array.from(bytes!)).toEqual([0, 0, 0, 1, 0, 0x26]);
  });

  it('已经是 Uint8Array / ArrayBuffer / TypedArray 时直接可用', () => {
    expect(toBytes(FIRST_FRAME)).toBe(FIRST_FRAME);
    expect(toBytes(new Uint8Array([1, 2, 3]).buffer)?.length).toBe(3);
    expect(toBytes(new DataView(new Uint8Array([4, 5]).buffer))?.length).toBe(2);
  });

  it('认不出的东西返回 null', () => {
    expect(toBytes(null)).toBeNull();
    expect(toBytes('not-bytes')).toBeNull();
    expect(toBytes({})).toBeNull();
  });
});
