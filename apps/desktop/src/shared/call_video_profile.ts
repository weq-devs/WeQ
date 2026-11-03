/**
 * 通话视频的**采集档位**：摄像头与屏幕共享各一套。
 *
 * 这一份是渲染层（采集 / 缩放 / 转 I420）与主进程（t265 编码器）之间唯一的口径，
 * 两边都从这里取，避免「渲染层按 640×360 缩放、编码器却按 720 开」这种对不上的
 * 情况 —— 尺寸不一致时 `pushFrame` 会静默丢帧，表现为「点了没反应」。
 *
 * ## 为什么这些数值
 *
 * 摄像头档位对齐 QQ 本体实测（640×360 / 15 fps / 300 kbps），屏幕共享档位
 * 来自 2026-10-28 对 QQ 本体抓包与本机编码实测
 * （`~/Desktop/weq-call-compare/1-QQ-native__P2P-OK.pcap`）：
 *
 * | 档位 | 分辨率 | 帧率 | 码率（上行） | 来历 |
 * | --- | --- | --- | --- | --- |
 * | 摄像头 | 640×360 | 15 fps | 300 kbps | 对齐 QQ 单帧大小（见下） |
 * | 屏幕共享 | 960×540 | 15 fps | 1200 kbps | 真机复盘下调（见 §8.7） |
 *
 * 2026-11-02 同一通电话逐包对齐（`weq_udp.pcapng` vs `qq_udp.pcapng`）：
 * QQ 上行单帧均值 **2123 B**、WeQ 只有 **517 B**，差 4.1 倍。原来的 30 kbps 在
 * 15 fps 下每帧只有 250 字节，640×360 压到这个大小必然糊成一片 —— 帧在动，
 * 但每帧都是马赛克，对端感知就是「又糊又卡」。
 *
 * ## 分片风险
 *
 * 码率越高单帧越大，UDP 分片越多；`0x5b` 的 `pkg_idx` 是单字节，上限 255。
 * 屏幕共享 960×540@1.2Mbps 实测 p95 26 片、最大 40 片，离上限很远。
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
   * 关键帧间隔（帧数）。
   *
   * t265（腾讯魔改 x265）实测只接受 **3 或 ≥5**：1 / 2 / 4 都会在
   * `t265_encoder_open` 里报 "Intra period must be larger than GOP size for
   * periodic IDR pictures" 并直接失败，与 `bframes` / `rc-lookahead` 无关。
   */
  keyint: number;
  /**
   * 是否**每帧都编成关键帧**（全 I 帧）。
   *
   * ## 为什么这么做
   *
   * 实测 QQ 收到 WeQ 的关键帧能正常解码显示，但**后续 P 帧一律不认** ——
   * 画面只按关键帧间隔一跳一跳地动。把每帧都变成关键帧后画面立刻连续流畅，
   * 说明问题出在 P 帧的参考链上，而不是包结构 / 网络。
   *
   * ## 带宽代价：几乎没有
   *
   * ABR 码率控制会按目标码率反推 QP，全 I 帧只是让 QP 略微升高，总码率仍贴着
   * 目标走。实测（320×184 / 15 fps / 300 kbps，真实运动画面 180 帧）：
   *
   * | 模式 | 关键帧 | avg | p90 | 实测码率 |
   * | --- | ---: | ---: | ---: | ---: |
   * | keyint=3 | 60/180 | 2613 B | 4461 B | 314 kbps |
   * | 全 I 帧 | 180/180 | 2668 B | 2932 B | **320 kbps** |
   *
   * 960×540 同样如此（1241 → 1250 kbps）。代价是单帧质量略降，但帧率与流畅度
   * 优先。
   */
  allIntra: boolean;
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
 * 摄像头档位：**320×184** / 15 fps / 300 kbps。
 *
 * ## 为什么是 320×184（2026-11-02 晚更正）
 *
 * 早先这里写 640×360，依据是「能力声明里 360p 那档」。但**能力声明只是上限
 * 协商表，不是实际编码尺寸** —— 2026-11-02 从四份抓包的 HEVC SPS 里直接解出
 * 权威客户端的真实尺寸：
 *
 * | 抓包 | 方向 | SPS 分辨率 |
 * | --- | --- | --- |
 * | dev 通 | QQ 发 | **320×184**（3 个关键帧全部） |
 * | fix 通 | QQ 发 | **320×184**（3 个关键帧全部） |
 * | QQ 主叫 | QQ 发 | 480×272 |
 * | dev / fix 通 | WeQ 发 | 640×360 |
 *
 * 也就是说 QQ 的摄像头默认只编 **320×184**（16:9 取整到 8 的倍数）。
 * WeQ 按 640×360 编，面积是它的 4 倍 —— 关键帧 5.9~8.5 KB vs QQ 的
 * 1.1~2.3 KB，切成 5~8 片 vs QQ 的 2 片。**这才是「QQ 收不到画面」的根因**：
 * 多分片的 I 帧让对端的重组/解码路径走不通。
 *
 * 480×272 那次是 QQ 主叫、对端是手机的采样，属于另一档；对端是 PC 时用
 * 320×184。要跟 PC 对齐就用这一档。
 *
 * ## 码率
 *
 * 300 kbps 保留：320×184@15fps 下每帧预算约 2.5 KB，与 QQ 实测单帧
 * 2.1 KB（fix 通 2123 B 均值）同量级，关键帧留了余量。
 */
export const CAMERA_PROFILE: VideoProfile = {
  width: 320,
  height: 184,
  fps: 30,
  bitrateKbps: 450,
  keyint: 30,
  allIntra: true,
  captureWidth: 320,
  captureHeight: 184,
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
  keyint: 30,
  // 全 I 帧在 960×540 下单帧编码 p90 36.9 ms，超过 30 fps 的 33.3 ms 预算，
  // 会把主进程事件循环卡住、连带音频和心跳。15 fps（66.7 ms 预算）留有余量。
  allIntra: true,
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
