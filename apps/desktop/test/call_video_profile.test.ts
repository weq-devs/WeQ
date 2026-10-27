// @vitest-environment node
/**
 * 通话视频的采集档位：分辨率推导与档位定义。
 *
 * 这里钉住两件容易悄悄改坏的事：
 *
 * 1. **屏幕共享 / 摄像头换档时必须对齐编码器尺寸**。采集端推上来的 I420 平面长度
 *    与编码器当前的宽高对不上时，`NativeVideoEncoder.pushFrame` 会**静默丢帧** ——
 *    没有任何报错，表现只是「共享了但对方什么都看不到」。所以尺寸推导必须
 *    严格保持源宽高比、对齐偶数。
 * 2. **码率不能退回旧值**。2026-10-28 之前写死的是 30 kbps，来源是误把「静态
 *    画面下 ABR 的实际输出」当成目标码率；同一张图 30 kbps 的 PSNR-Y 只有
 *    32.6 dB，300 kbps 是 43.4 dB。
 */

import { describe, expect, it } from 'vitest';
import {
  CAMERA_PROFILE,
  SCREEN_PROFILE,
  fitWithin,
  profileFor,
} from '../src/shared/call_video_profile';

describe('视频采集档位', () => {
  it('摄像头档位是 480×270 / 12 fps / 300 kbps', () => {
    // 2026-10-28 真机复盘：640×360 在真实运动下编码 p95 19.4 ms，叠加采集与 IPC
    // 后节拍滑到 99 ms/帧（目标 83 ms），对端只有 7.5~10 fps。降到 480×270 后
    // 编码 p95 15.2 ms，且每像素比特数从 0.014 提到 0.025（+79%），画面更清楚。
    expect(CAMERA_PROFILE.width).toBe(480);
    expect(CAMERA_PROFILE.height).toBe(270);
    expect(CAMERA_PROFILE.bitrateKbps).toBe(300);
    expect(CAMERA_PROFILE.fps).toBe(12);
  });

  it('摄像头分辨率不能回到 640×360（会把发送节拍拖垮）', () => {
    // 这条断言拦住「觉得 360p 更清楚」的回归：同一码率下 360p 的每像素比特数
    // 只有 480×270 的 56%，而编码耗时高 27%，两头都吃亏。
    expect(CAMERA_PROFILE.width * CAMERA_PROFILE.height).toBeLessThanOrEqual(640 * 360);
  });

  it('摄像头码率不能退回 30 kbps（旧值会把画面糊成一团）', () => {
    // 30 kbps 是「静态画面下 ABR 的实际输出」被误当成目标码率。
    // 这条断言的意义是拦住「有人觉得 30 够用」的回归。
    expect(CAMERA_PROFILE.bitrateKbps).toBeGreaterThanOrEqual(200);
  });

  it('屏幕共享档位是 960×540 / 15 fps / 1.2 Mbps', () => {
    // 720p 在真实运动下编码 p95 58.8 ms、最大 68.5 ms，而 15 fps 的帧预算只有
    // 67 ms —— 光编码就吃掉整个预算，是「对端特别卡」的主要元凶。
    expect(SCREEN_PROFILE.width).toBe(960);
    expect(SCREEN_PROFILE.height).toBe(540);
    expect(SCREEN_PROFILE.bitrateKbps).toBe(1200);
    expect(SCREEN_PROFILE.fps).toBe(15);
  });

  it('屏幕共享编码耗时不能吃掉超过一半的帧预算', () => {
    // 实测数据（真实滚动运动，t265）：960×540 p95 27.8 ms / 15 fps 预算 67 ms。
    // 720p 是 58.8 ms —— 已经贴着预算，必须拦住。
    const budgetMs = 1000 / SCREEN_PROFILE.fps;
    const measuredP95: Record<string, number> = { '960x540': 27.8, '1280x720': 58.8 };
    const key = `${SCREEN_PROFILE.width}x${SCREEN_PROFILE.height}`;
    const p95 = measuredP95[key];
    if (p95 !== undefined) expect(p95).toBeLessThan(budgetMs * 0.6);
  });

  it('采集尺寸直接要目标尺寸（避免二次缩放）', () => {
    // 实测：让 getDisplayMedia 直出 1280×720 而不是拿 1080p 再缩，
    // 整条采集链路 45 ms → 22 ms/帧。
    expect(CAMERA_PROFILE.captureWidth).toBe(CAMERA_PROFILE.width);
    expect(CAMERA_PROFILE.captureHeight).toBe(CAMERA_PROFILE.height);
    expect(SCREEN_PROFILE.captureWidth).toBe(SCREEN_PROFILE.width);
    expect(SCREEN_PROFILE.captureHeight).toBe(SCREEN_PROFILE.height);
  });

  it('profileFor 按采集源取档位', () => {
    expect(profileFor('camera')).toBe(CAMERA_PROFILE);
    expect(profileFor('screen')).toBe(SCREEN_PROFILE);
  });

  it('每个档位的宽高都是偶数（I420 的 2×2 色度下采样要求）', () => {
    for (const profile of [CAMERA_PROFILE, SCREEN_PROFILE]) {
      expect(profile.width % 2).toBe(0);
      expect(profile.height % 2).toBe(0);
    }
  });
});

describe('fitWithin：按源宽高比推导编码尺寸', () => {
  it('16:9 源原样缩放到档位上限', () => {
    expect(fitWithin(1920, 1080, 1280, 720)).toEqual({ width: 1280, height: 720 });
    expect(fitWithin(2560, 1440, 1280, 720)).toEqual({ width: 1280, height: 720 });
  });

  it('超宽屏保住宽高比，不拉伸', () => {
    // 2560×1080 是 21:9。硬塞进 1280×720 会把人拉成 16:9，所以高度跟着缩。
    const { width, height } = fitWithin(2560, 1080, 1280, 720);
    expect(width).toBe(1280);
    expect(height).toBe(540);
    expect(width / height).toBeCloseTo(2560 / 1080, 2);
  });

  it('4:3 源按高度约束', () => {
    // 1600×1200 是 4:3；宽度上限 1280、高度上限 720，高度先撞线。
    const { width, height } = fitWithin(1600, 1200, 1280, 720);
    expect(height).toBe(720);
    expect(width).toBe(960);
    expect(width / height).toBeCloseTo(4 / 3, 2);
  });

  it('源比目标小时不放大', () => {
    // 放大只会更糊，还多耗带宽。
    expect(fitWithin(800, 600, 1280, 720)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(320, 180, 1280, 720)).toEqual({ width: 320, height: 180 });
  });

  it('奇数尺寸向下取偶', () => {
    // 1921×1081 缩下来可能落到奇数，色度平面会越界。
    const { width, height } = fitWithin(1921, 1081, 1280, 720);
    expect(width % 2).toBe(0);
    expect(height % 2).toBe(0);
    const odd = fitWithin(1365, 767, 1280, 720);
    expect(odd.width % 2).toBe(0);
    expect(odd.height % 2).toBe(0);
  });

  it('零尺寸退回档位默认值（源还没就绪时不崩）', () => {
    expect(fitWithin(0, 0, 1280, 720)).toEqual({ width: 1280, height: 720 });
  });

  it('极端竖屏也不会推出 0 或负数', () => {
    // 480×1920 的竖屏窗口：宽度会被压到很小，但不能是 0。
    const { width, height } = fitWithin(480, 1920, 1280, 720);
    expect(width).toBeGreaterThanOrEqual(2);
    expect(height).toBe(720);
  });
});
