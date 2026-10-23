/**
 * 通话音频的帧格式与重采样。
 *
 * 通话协议固定 **16 kHz 单声道 16-bit、20 ms 一帧**，也就是每帧 320 个采样 /
 * 640 字节。浏览器的 `AudioContext` 通常跑在 44.1 或 48 kHz，必须重采样之后
 * 才能喂给编码器；反过来解码出来的 16 kHz PCM 也要重采样到设备采样率才能播。
 *
 * 重采样用线性插值：语音带宽在 8 kHz 以下，20 ms 的插值误差听不出来，而
 * 带限插值（sinc）在 20 ms 帧的实时链路里没有收益。
 */

/** 每帧采样数。 */
export const OPUS_FRAME_SAMPLES = 320;
/** 每帧字节数（16-bit）。 */
export const OPUS_FRAME_BYTES = OPUS_FRAME_SAMPLES * 2;
/** 帧时长。 */
export const OPUS_FRAME_MS = 20;
/** 通话的采样率。 */
export const CALL_SAMPLE_RATE = 16_000;

/**
 * 把任意采样率的 Float32 PCM 重采样到 16 kHz，并切成 640 字节的帧。
 *
 * 返回的每一帧都正好 640 字节；末尾不足一帧的补零（补零而不是丢弃，否则
 * 编码器会一直缺一帧，对端听到的节拍对不上）。
 */
export function resampleToCallFrames(input: Float32Array, inputRate: number): Int16Array[] {
  if (inputRate === CALL_SAMPLE_RATE) return splitFrames(floatToPcm16(input));
  const ratio = inputRate / CALL_SAMPLE_RATE;
  const outLength = Math.floor(input.length / ratio);
  const pcm = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const frac = position - index;
    const a = input[index] ?? 0;
    const b = input[index + 1] ?? a;
    const value = a + (b - a) * frac;
    pcm[i] = toInt16(value);
  }
  return splitFrames(pcm);
}

/** 把 16 kHz 的 PCM 重采样到目标采样率（播放用）。 */
export function resampleFromCall(pcm: Int16Array, targetRate: number): Float32Array {
  if (targetRate === CALL_SAMPLE_RATE) {
    const out = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) out[i] = (pcm[i] ?? 0) / 0x8000;
    return out;
  }
  const ratio = CALL_SAMPLE_RATE / targetRate;
  const outLength = Math.floor(pcm.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const frac = position - index;
    const a = (pcm[index] ?? 0) / 0x8000;
    const b = (pcm[index + 1] ?? pcm[index] ?? 0) / 0x8000;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** 字节（小端 16-bit）→ Int16。 */
export function bytesToPcm16(bytes: Uint8Array): Int16Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Int16Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

/** Int16 → 字节（小端）。 */
export function pcm16ToBytes(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i] ?? 0, true);
  return out;
}

function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = toInt16(input[i] ?? 0);
  return out;
}

function toInt16(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value));
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

function splitFrames(pcm: Int16Array): Int16Array[] {
  const frames: Int16Array[] = [];
  for (let offset = 0; offset < pcm.length; offset += OPUS_FRAME_SAMPLES) {
    const frame = new Int16Array(OPUS_FRAME_SAMPLES);
    frame.set(pcm.subarray(offset, Math.min(offset + OPUS_FRAME_SAMPLES, pcm.length)));
    frames.push(frame);
  }
  return frames;
}

/**
 * 一帧的响度（0..1），用来画通话界面的音量条。
 *
 * 用 RMS 而不是峰值：峰值在有背景噪声时几乎恒定，看不出「在说话」。
 */
export function frameLevel(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = (pcm[i] ?? 0) / 0x8000;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / pcm.length) * 3);
}
