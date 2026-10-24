import { expect, it } from 'vitest';
import {
  CALL_WAVE_BAR_COUNT,
  callLevel,
  callWaveBar,
  callWaveShape,
  smoothLevel,
} from '../src/renderer/src/lib/callWave';

/** 一段给定 RMS 的正弦波（16 kHz 单声道浮点）。 */
function tone(rms: number, length = 320): Float32Array {
  const out = new Float32Array(length);
  const amplitude = rms * Math.SQRT2;
  for (let i = 0; i < length; i++) out[i] = Math.sin((2 * Math.PI * 440 * i) / 16_000) * amplitude;
  return out;
}

it('包络首尾有明显高度，两端柱子不会缩成两个小圆点', () => {
  // 用 i/(count-1) 时首尾恰好是 sin(0)=sin(π)=0，只剩静音底，圆角一收就是圆点。
  expect(callWaveShape(0)).toBeGreaterThan(0.25);
  expect(callWaveShape(CALL_WAVE_BAR_COUNT - 1)).toBeGreaterThan(0.25);
  // 中间仍然最高，且首尾加起来明显低于中间（保住「钟形」）。
  expect(callWaveShape(0) + callWaveShape(CALL_WAVE_BAR_COUNT - 1)).toBeLessThan(
    callWaveShape(Math.floor(CALL_WAVE_BAR_COUNT / 2)) * 0.85,
  );
  // 首尾高度一致（对称）。
  expect(callWaveShape(0)).toBeCloseTo(callWaveShape(CALL_WAVE_BAR_COUNT - 1), 6);
});

it('音量不乘在包络上：两端柱子也随声音变高', () => {
  const edge = callWaveShape(0);
  const silent = callWaveBar(edge, 0);
  const loud = callWaveBar(edge, 1);
  // 两端也要有明显涨幅，否则说话时只有中间在抖。
  expect(loud).toBeGreaterThan(silent + 0.3);
  // 中间涨得更多（保留包络形状），但差距不能大到两端像没动。
  const edgeGain = loud - silent;
  const middleGain = callWaveBar(1, 1) - callWaveBar(1, 0);
  expect(middleGain).toBeGreaterThanOrEqual(edgeGain);
  expect(middleGain).toBeLessThan(edgeGain * 2);
});

it('柱高始终落在 0..1 之内，异常音量也不会溢出', () => {
  for (const shape of [0, 0.5, 1]) {
    for (const level of [-1, 0, 0.5, 1, 2, Number.NaN]) {
      const bar = callWaveBar(shape, level);
      expect(Number.isFinite(bar)).toBe(true);
      expect(bar).toBeGreaterThanOrEqual(0);
      expect(bar).toBeLessThanOrEqual(1);
    }
  }
});

it('响度按 dBFS 映射：底噪归零，正常说话顶满', () => {
  // -49 dBFS ≈ 回声消除下话筒静音段的实测电平，应该基本贴地。
  expect(callLevel(tone(0.0035))).toBeLessThan(0.1);
  // -35 dBFS：正常说话的下沿，已经要明显起来（旧实现里峰值 0.018 几乎不动）。
  expect(callLevel(tone(0.0178))).toBeGreaterThan(0.55);
  // -25 dBFS：正常说话，接近满格。
  expect(callLevel(tone(0.056))).toBeGreaterThan(0.95);
  // -24 dBFS 及以上封顶。
  expect(callLevel(tone(0.07))).toBe(1);
  expect(callLevel(tone(0.5))).toBe(1);
});

it('响度对 RMS 而不是峰值敏感：孤立的尖刺不会把整组柱子顶满', () => {
  // 320 个采样里只有 1 个 0.3 的尖刺。按峰值线性放大（旧实现）会算成 0.9，
  // 按 RMS 是 -35 dBFS 左右，明显低于正常说话。
  const sparse = new Float32Array(320);
  sparse[0] = 0.3;
  expect(callLevel(sparse)).toBeGreaterThan(0.4);
  expect(callLevel(sparse)).toBeLessThan(callLevel(tone(0.056)));
});

it('平滑：上升快、回落慢，且不会越过目标之外', () => {
  const rising = smoothLevel(0, 1);
  expect(rising).toBeGreaterThan(0.5);
  const falling = smoothLevel(1, 0);
  expect(falling).toBeGreaterThan(0.5);
  expect(falling).toBeLessThan(1);
  // 到达目标附近时稳定下来。
  let value = 0.5;
  for (let i = 0; i < 40; i++) value = smoothLevel(value, 0.5);
  expect(value).toBeCloseTo(0.5, 3);
});

it('空采样返回 0', () => {
  expect(callLevel(new Float32Array(0))).toBe(0);
  expect(callWaveShape(0, 0)).toBe(0);
});
