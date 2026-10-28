/**
 * 通话视频帧的**二进制 IPC 通道**。
 *
 * 为什么不用 tRPC：视频帧是原始 I420 —— 摄像头 640×360 一帧 345 KB，屏幕共享
 * 1280×720 一帧 1.3 MB。tRPC 走 superjson，`Uint8Array` 会被展开成十进制数字数组
 * （JSON 文本是原始体积的 3~4 倍），实测一帧 30 ms，帧率一高渲染层主线程就根本
 * 跑不满，采集、解码、绘制全被拖慢（表现：两端画面都极度卡顿）。
 *
 * 走 `ipcRenderer.send` 的原生通道时，`Uint8Array` 直接走结构化克隆（实测
 * 0.17 ms），比 tRPC 快两个数量级，而且不用等往返 —— 视频帧本来就该是
 * fire-and-forget。
 *
 * 只用于 **Electron**。web 构建（`apps/web` 复用同一份 renderer）没有
 * `window.weq`，调用方会回退到 tRPC 的 `pushVideoFrame`。
 */

/** 渲染层 → 主进程：一帧 I420。 */
export const CALL_VIDEO_FRAME_CHANNEL = 'call:video-frame';

/** 一帧 I420 的三个平面（Y 全尺寸、U/V 各四分之一）。 */
export interface CallVideoFrame {
  y: Uint8Array;
  u: Uint8Array;
  v: Uint8Array;
}

/** preload 暴露给渲染层的视频帧桥。 */
export interface CallVideoBridge {
  /** 推一帧 I420（不等待主进程，失败静默）。 */
  pushFrame(frame: CallVideoFrame): void;
}
