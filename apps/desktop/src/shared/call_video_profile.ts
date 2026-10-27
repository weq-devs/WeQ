/**
 * 通话视频的**采集档位**：摄像头与屏幕共享各一套。
 *
 * 这一份是渲染层（采集 / 缩放 / 转 I420）与主进程（t265 编码器）之间唯一的口径，
 * 两边都从这里取，避免「渲染层按 640×360 缩放、编码器却按 720 开」这种对不上的
 * 情况 —— 尺寸不一致时 `pushFrame` 会静默丢帧，表现为「点了没反应」。
 *
 * ## 为什么这些数值
 *
 * 全部来自 2026-10-28 对 QQ 本体的抓包实测
 * （`~/Desktop/weq-call-compare/1-QQ-native__P2P-OK.pcap`）与本机编码实测：
 *
 * | 项 | QQ 本体 | WeQ 旧值 | 现在 |
 * | --- | --- | --- | --- |
 * | 分辨率 | 640×360 | 640×360 | 640×360（不变） |
 * | 帧率 | 10–12 fps | 15 fps | 12 fps |
 * | 码率（上行） | 283 kbps | **30 kbps** | 300 kbps |
 *
 * 旧值 30 kbps 的来源是个误判：它取的是**静态画面**下 ABR 的实际输出（实测静止时
 * 6 kbps、轻微运动峰值 26 kbps），却当成了目标码率。ABR 在静止画面下本来就会自己
 * 降比特率，把观察值当上限写死后，画面一有运动就严重欠码。
 *
 * 同一张屏幕截图 640×360、同一编码器的实测质量（PSNR-Y，越高越好）：
 *
 * | 目标码率 | 实际码率 | PSNR-Y |
 * | --- | --- | --- |
 * | 30 kbps（旧值） | 43 kbps | 32.6 dB |
 * | 200 kbps | 203 kbps | 40.6 dB |
 * | **300 kbps** | 286 kbps | **43.4 dB** |
 * | 700 kbps | 546 kbps | 45.2 dB |
 *
 * 30 → 300 kbps 是 10.8 dB 的差距，肉眼就是「糊成一团」和「能看清字」。300 kbps
 * 之后收益迅速递减（到 700 kbps 只多 1.8 dB，流量却翻倍），所以取 300。
 *
 * ## 分片风险
 *
 * 码率抬上去后单帧变大，UDP 分片变多；`0x5b` 的 `pkg_idx` 是单字节，上限 255。
 * 实测 640×360@300kbps 单帧平均 2.3 KB（≈3 片）、峰值 9.4 KB（≈9 片），
 * 离上限很远。屏幕共享的 720p 见 {@link SCREEN_PROFILE}。
 */

/** 视频采集 / 编码参数。 */
export interface VideoProfile {
  /** 编码宽度（偶数，I420 要求）。 */
  width: number;
  /** 编码高度（偶数）。 */
  height: number;
  /** 采集与编码帧率。 */
  fps: number;
  /** 目标码率（kbps）。 */
  bitrateKbps: number;
  /**
   * 采集时给 `getUserMedia` / `getDisplayMedia` 的宽度上限。
   *
   * **必须让采集端直接出目标尺寸**，不要拿 1920×1080 的流再 `drawImage` 缩下来：
   * 实测本机（Hyprland / Wayland / PipeWire）1920×1080 → 1280×720 的缩放要
   * 20 ms/帧，让采集端直接给 1280×720 后整个采集链路从 45 ms 降到 22 ms/帧。
   *
   * 屏幕共享时源宽高比与目标不一致（比如超宽屏），所以这里仍可能发生一次缩放，
   * 但常见 16:9 屏幕上这一趟是省掉的。
   */
  captureWidth: number;
  captureHeight: number;
}

/**
 * 摄像头档位：640×360 / 12 fps / 300 kbps。
 *
 * 帧率从 15 降到 12 是向 QQ 对齐（实测上行 10–12 fps）。降帧同时省带宽、给单帧
 * 留出更大预算，弱网下整帧被丢的概率更低。
 */
export const CAMERA_PROFILE: VideoProfile = {
  width: 640,
  height: 360,
  fps: 12,
  bitrateKbps: 300,
  captureWidth: 640,
  captureHeight: 360,
};

/**
 * 屏幕共享档位：1280×720 / 15 fps / 1200 kbps。
 *
 * 共享的诉求是**看清字**，帧率比摄像头更重要（滚动、动画要顺），分辨率更不能省。
 * 实测同一张桌面内容 1280×720@1.2 Mbps 单帧平均 10 KB（≈10 片）、p95 29 KB
 * （≈25 片），分片数安全。
 */
export const SCREEN_PROFILE: VideoProfile = {
  width: 1280,
  height: 720,
  fps: 15,
  bitrateKbps: 1200,
  captureWidth: 1280,
  captureHeight: 720,
};

/** 采集源。屏幕共享与摄像头**互斥**：同一时刻只有一路主视频流。 */
export type VideoSource = 'camera' | 'screen';

/** 按采集源取档位。 */
export function profileFor(source: VideoSource): VideoProfile {
  return source === 'screen' ? SCREEN_PROFILE : CAMERA_PROFILE;
}

/**
 * 把任意源尺寸按比例缩进 `maxWidth × maxHeight`，并对齐到偶数。
 *
 * - 保持源宽高比（不拉伸、不加黑边）；
 * - 宽高都取偶数（I420 的 U/V 平面是 2×2 下采样，奇数会越界）；
 * - **不放大**：源比目标小时原样返回（再放大只会更糊，还多耗带宽）。
 *
 * 例：1920×1080 → 1280×720；2560×1080（超宽）→ 1280×540；
 * 3840×2160 → 1280×720；800×600 → 960×720… 取的是「塞得进」的那一档。
 */
export function fitWithin(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return { width: even(maxWidth), height: even(maxHeight) };
  }
  const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight, 1);
  return {
    width: even(Math.round(sourceWidth * scale)),
    height: even(Math.round(sourceHeight * scale)),
  };
}

/** 向下取偶：I420 的色度平面按 2×2 采样，奇数宽高会越界。 */
function even(value: number): number {
  const n = Math.max(2, Math.round(value));
  return n % 2 === 0 ? n : n - 1;
}
