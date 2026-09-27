/**
 * 语音波形（PTT waveform）。
 *
 * 波形是 `msgInfo.extBizInfo.ptt.waveform` 里的一段 `PttWaveform{size, amplitudes}` ——
 * 收侧 `ParsePttWave` 按它画气泡里的振幅条。**它只是装饰**：时长走 `pttDuration`，
 * 波形不影响播放，QQ 自己也会发合成波形（AI 声聊固定 30 字节），所以这里给两条路：
 *
 *   1. 干净路径：调用方手上有 PCM/WAV 时（比如桌面端用 silk-wasm 录音转出的，
 *      或者自己解码出来的），按官方口径算真实振幅 —— 每 bin 取峰值、30 个 bin、
 *      全静音退回官方的 25 静音底噪；
 *   2. mock：手上只有 SILK/压缩音频、不想引解码依赖时，直接给一条 30 字节的合成条
 *      （数值 = 官方静音底 25）。收侧照样渲染，只是条子平的。
 *
 * 两种都合法；选择权在调用方，本模块不引任何音频解码依赖。
 */

import { decode, encode } from '../protobuf';
import { PTT_WAVEFORM } from './ntv2-schemas';

/** 官方接收端默认 bin 数（C++ `ParsePttWave` 的回退值）。 */
export const PTT_WAVEFORM_BINS = 30;
/** 官方静音底（整段无声时用的振幅值）。 */
export const PTT_WAVEFORM_SILENCE = 25;

const fourcc = (b: Uint8Array, o: number): string =>
  String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
const u16le = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const u32le = (b: Uint8Array, o: number): number =>
  (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const s16le = (b: Uint8Array, o: number): number => {
  const raw = u16le(b, o);
  return raw >= 0x8000 ? raw - 0x10000 : raw;
};

/** 从 RIFF/WAVE 容器里取出 s16le PCM（非 PCM / 非 16bit 直接报错，免得凭猜测画条）。 */
export function pcmS16leFromWav(wav: Uint8Array): {
  pcm: Uint8Array;
  channels: number;
  sampleRate: number;
} {
  if (wav.length < 12) throw new Error('WAV 太短');
  if (fourcc(wav, 0) !== 'RIFF' || fourcc(wav, 8) !== 'WAVE') throw new Error('不是 RIFF/WAVE');

  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;
  let data: Uint8Array | undefined;

  while (offset + 8 <= wav.length) {
    const id = fourcc(wav, offset);
    const size = u32le(wav, offset + 4);
    const start = offset + 8;
    if (start + size > wav.length) throw new Error('WAV 分片被截断');
    if (id === 'fmt ') {
      if (size < 16) throw new Error('WAV fmt 段太短');
      audioFormat = u16le(wav, start);
      channels = u16le(wav, start + 2);
      sampleRate = u32le(wav, start + 4);
      bitsPerSample = u16le(wav, start + 14);
    } else if (id === 'data') {
      data = wav.subarray(start, start + size);
    }
    offset = start + size + (size & 1);
  }

  if (!data) throw new Error('WAV 没有 data 段');
  if (audioFormat !== 1) throw new Error(`WAV 格式 ${audioFormat} 不是 PCM`);
  if (channels < 1) throw new Error('WAV 声道数非法');
  if (bitsPerSample !== 16) throw new Error(`WAV 位深 ${bitsPerSample} 不是 s16le`);
  return { pcm: data, channels, sampleRate };
}

/** 全静音条（官方底噪值）。 */
export function silentWaveform(bins = PTT_WAVEFORM_BINS): Uint8Array {
  return new Uint8Array(bins).fill(PTT_WAVEFORM_SILENCE);
}

/**
 * s16le PCM → 振幅条：把整段按 bin 分窗、每窗取峰值（0..255）。
 * 静音窗留 0（形成波谷）；整段全静音时用官方静音底，免得私聊客户端画不出轨道。
 */
export function amplitudesFromPcmS16le(
  pcm: Uint8Array,
  options: { channels?: number; bins?: number } = {},
): Uint8Array {
  const channels = options.channels ?? 1;
  const bins = options.bins ?? PTT_WAVEFORM_BINS;
  if (channels < 1 || bins < 1) throw new Error('波形 channels/bins 必须 >= 1');

  const frameSize = channels * 2;
  const frames = Math.floor(pcm.length / frameSize);
  if (frames === 0) return silentWaveform(bins);

  const out = new Uint8Array(bins);
  let any = false;
  for (let bin = 0; bin < bins; bin++) {
    const start = Math.floor((bin * frames) / bins);
    let end = Math.floor(((bin + 1) * frames) / bins);
    if (end <= start) end = start + 1;
    let peak = 0;
    for (let frame = start; frame < end && frame < frames; frame++) {
      const base = frame * frameSize;
      for (let channel = 0; channel < channels; channel++) {
        const sample = Math.abs(s16le(pcm, base + channel * 2));
        if (sample > peak) peak = sample;
      }
    }
    const amplitude = Math.min(255, Math.round((peak * 255) / 32767));
    if (amplitude > 0) any = true;
    out[bin] = amplitude;
  }
  return any ? out : silentWaveform(bins);
}

/** 振幅条 → `PttWaveform` 字节（size 必须等于 amplitudes 长度）。 */
export function encodePttWaveform(amplitudes: Uint8Array): Uint8Array {
  if (amplitudes.length === 0) throw new Error('波幅不能为空');
  return encode(PTT_WAVEFORM, { size: amplitudes.length, amplitudes });
}

/** `PttWaveform` 字节 → { size, amplitudes }，size 与长度不符时报错。 */
export function decodePttWaveform(bytes: Uint8Array): { size: number; amplitudes: Uint8Array } {
  const decoded = decode(PTT_WAVEFORM, bytes) as { size?: number; amplitudes?: Uint8Array };
  const amplitudes = decoded.amplitudes ?? new Uint8Array(0);
  const size = decoded.size ?? 0;
  if (size !== amplitudes.length) {
    throw new Error(`波形 size ${size} != amplitudes ${amplitudes.length}`);
  }
  return { size, amplitudes };
}

/** 波形来源：给 WAV（自动解出 PCM）或裸 PCM 就出真条，都不给就 mock。 */
export interface PttWaveformSource {
  /** 完整 WAV 文件字节（优先）。 */
  wav?: Uint8Array;
  /** 裸 s16le PCM 字节（wav 缺省时用）。 */
  pcm?: Uint8Array;
  /** 裸 PCM 的声道数，缺省 1。 */
  channels?: number;
  /** bin 数，缺省 30（官方值）。 */
  bins?: number;
}

/** 是否 mock（`true` = 没有真音频数据，给的是合成条）。 */
export interface PttWaveformBuild {
  /** 已编码的 `PttWaveform` 字节，直接塞进 extBizInfo.ptt.waveform。 */
  bytes: Uint8Array;
  mocked: boolean;
}

/**
 * 得到要上传的波形。
 *
 * 给得出 PCM/WAV → 真振幅；给不出（或解析失败）→ mock 一条 30 字节合成条。
 * **不抛异常**：波形只是装饰，不值得为它让整条语音发送失败。
 */
export function buildPttWaveform(source: PttWaveformSource = {}): PttWaveformBuild {
  try {
    const bins = source.bins ?? PTT_WAVEFORM_BINS;
    if (source.wav && source.wav.length > 0) {
      const { pcm, channels } = pcmS16leFromWav(source.wav);
      return {
        bytes: encodePttWaveform(amplitudesFromPcmS16le(pcm, { channels, bins })),
        mocked: false,
      };
    }
    if (source.pcm && source.pcm.length > 0) {
      return {
        bytes: encodePttWaveform(
          amplitudesFromPcmS16le(source.pcm, { channels: source.channels ?? 1, bins }),
        ),
        mocked: false,
      };
    }
  } catch {
    // 落回 mock（波形是装饰，不因此失败）
  }
  return {
    bytes: encodePttWaveform(silentWaveform(source.bins ?? PTT_WAVEFORM_BINS)),
    mocked: true,
  };
}
