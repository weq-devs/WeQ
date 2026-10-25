/**
 * 通话窗口的波形几何与响度。
 *
 * 波形不是真正的频谱，而是「固定包络 × 音量」：哪根柱子高由包络决定，
 * 音量只做整体伸缩。抽出纯函数是为了能单测 —— 之前那段逻辑有两个毛病，
 * 都是肉眼能看出来但代码不容易读出来的：
 *
 *   1. 音量项乘在包络上（`shape * level`），包络为 0 的两端无论多大声都不动，
 *      看起来像「两端少了两根」；
 *   2. 音量取自峰值再线性放大。麦克风有回声消除 + 降噪，正常说话峰值也就
 *      0.1 左右，线性映射后柱高只涨十几像素，观感接近「没有波形」。
 */

/** 每半边的柱子数。 */
export const CALL_WAVE_BAR_COUNT = 24;

/**
 * 柱高的三段构成（占波形区高度的比例）：
 * 静音底 0.10 + 包络 0..0.26 + 音量 0..0.64，满值正好 1 —— 超过 1 会顶出
 * 波形区，带 `overflow: hidden` 时看上去就是被削平了一截。
 *
 * 包络占的份额比早先大：音量项太大时整组会一起平着涨，看起来像一排等高
 * 的竖条，反而不像波形。
 */
const BAR_BASE = 0.1;
const BAR_SHAPE = 0.26;
/**
 * 音量贡献：固定部分让两端也跟着动，形状部分让中间更明显。
 *
 * 固定项仍占大头 —— 说话时整组一起涨，而不是只有中间那几根抖，这样即便
 * 对端声音很小，两侧也能看出「有声音在动」。
 */
const BAR_LEVEL_BASE = 0.4;
const BAR_LEVEL_SHAPE = 0.24;

/**
 * 响度映射的 dBFS 区间。
 *
 * 两端是按本机实测定的（回声消除 + 降噪，默认录音源）：静音段 -55…-46 dB，
 * 正常说话 -35…-25 dB。下限取 -50 让底噪基本贴地，上限取 -24 让正常说话
 * 就能顶满 —— 区间再往上抬，说话时柱子只涨一小截，看上去仍然像「没在动」。
 */
const LEVEL_FLOOR_DB = -50;
const LEVEL_CEILING_DB = -24;

/**
 * 包络的下限：两端不取 0。`sin(0)` / `sin(π)` 恰好是 0，那两根柱子的高度只剩
 * 静音底，圆角一收就成了两个小圆点，看上去像「少了两根」。
 */
const SHAPE_FLOOR = 0.25;

/**
 * 第 `index` 根柱子的包络值（下限 0.25，中间 1）。
 *
 * 用 `(i + 0.5) / count` 让首尾落在半个格子上，柱数变化时图案也保持对称。
 */
export function callWaveShape(index: number, count = CALL_WAVE_BAR_COUNT): number {
  if (count <= 0) return 0;
  const wave = Math.sin(((index + 0.5) / count) * Math.PI);
  return SHAPE_FLOOR + (1 - SHAPE_FLOOR) * wave;
}

/**
 * 柱子的高度（`--bar`，占波形区高度的比例）。
 *
 * 音量项**不乘**包络：两端柱子也要跟着声音起伏，否则整组只在中间抖。
 */
export function callWaveBar(shape: number, level: number): number {
  // NaN 要单独挡掉：`Math.min/max` 会把 NaN 原样传下去，最后写进 CSS 变量
  // 就是个不合法的值，柱子高度退回默认。
  const clamped = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
  return BAR_BASE + shape * BAR_SHAPE + clamped * (BAR_LEVEL_BASE + shape * BAR_LEVEL_SHAPE);
}

/**
 * 一段浮点采样的响度（0..1）。
 *
 * 用 RMS 走 dBFS 映射，而不是峰值线性放大：峰值对单个采样尖刺太敏感、对
 * 持续说话又偏保守；dB 刻度更贴近「听感上有多大」，在回声消除把电平压到
 * 0.1 上下时也还能把整段波形撑起来。
 *
 * 取 -50 dBFS → 0、-24 dBFS → 1。区间按本机实测选：静音段 -55…-46 dB，
 * 正常说话 -35…-25 dB；用 0…-60 那种宽区间会让静音也顶起小半屏柱子。
 */
export function callLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i] ?? 0;
    sum += value * value;
  }
  const rms = Math.sqrt(sum / samples.length);
  const db = 20 * Math.log10(Math.max(rms, 1e-7));
  return Math.max(0, Math.min(1, (db - LEVEL_FLOOR_DB) / (LEVEL_CEILING_DB - LEVEL_FLOOR_DB)));
}

/** 平滑两帧响度；上升快、回落慢，避免柱子闪烁。 */
export function smoothLevel(previous: number, next: number): number {
  return next > previous ? previous * 0.35 + next * 0.65 : previous * 0.8 + next * 0.2;
}
