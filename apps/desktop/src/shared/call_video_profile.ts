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
 * 摄像头档位：480×270 / 12 fps / 300 kbps。
 *
 * ## 为什么从 640×360 降到 480×270
 *
 * 2026-10-28 真机抓包复盘（`~/Desktop/weq-call-compare` 之后又抓了一通）：640×360
 * 在**真实运动**下的编码 p95 是 19.4 ms、最大 24.3 ms，而 12 fps 的帧预算只有
 * 83 ms；再叠加渲染层采集（drawImage + getImageData + I420 转换约 5~10 ms）与
 * IPC，节拍就滑到了 99 ms/帧（实测上行只有 9.6~10 fps，目标 12），对端看到的是
 * 「明显掉帧」。
 *
 * 降到 480×270 后编码 p95 降到 15.2 ms，且每像素分到的比特数从 0.014 提到
 * 0.025（+79%）—— 同一码率下画面反而**更清楚**，不是变糊。
 *
 * 帧率取 12 是向 QQ 本体的上行实测对齐。
 */
export const CAMERA_PROFILE: VideoProfile = {
  width: 480,
  height: 270,
  fps: 12,
  bitrateKbps: 300,
  captureWidth: 480,
  captureHeight: 270,
};

/**
 * 屏幕共享档位：960×540 / 15 fps / 1200 kbps。
 *
 * ## 为什么从 1280×720 降到 960×540
 *
 * 720p 是这次「对端画面特别卡」的**主要元凶**：实测编码 p95 **58.8 ms**、最大
 * 68.5 ms，而 15 fps 的帧预算只有 67 ms —— 光编码就吃掉几乎整个预算，再加上采集
 * 与 IPC 必然掉帧。降到 960×540 后编码 p95 降到 27.8 ms（不到预算的一半）。
 *
 * 每像素比特数同时从 0.012 提到 0.017（+42%），文字反而更锐利。960×540 对
 * 「看清文档 / 代码」够用，对全屏视频播放不够——把帧率留给实时性比拉分辨率更值。
 *
 * 分片：p95 26 片、最大 40 片，离 `pkg_idx` 的单字节上限 255 很远。
 */
export const SCREEN_PROFILE: VideoProfile = {
  width: 960,
  height: 540,
  fps: 15,
  bitrateKbps: 1200,
  captureWidth: 960,
  captureHeight: 540,
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
