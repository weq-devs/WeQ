/**
 * 视频通话的**本端编码**（主进程半边）。
 *
 * 链路：
 *
 * ```text
 * 渲染层 getUserMedia → VideoFrame → 转 I420 → IPC pushVideoFrame
 *   → 这里排进队列 → CallSession.pumpVideo 每 10ms 取一帧
 *   → native 的 t265（QQ 自带的魔改 x265）编成 Annex B
 *   → 0x5b subType=2 发给对端
 * ```
 *
 * 为什么采集在渲染层、编码在主进程：摄像头只能用 WebRTC 拿（主进程没有
 * `getUserMedia`），而编码必须用 QQ 自带的那一版 x265（系统 libx265 编出来的
 * 码流对端不一定能解）。两头分工，中间用 IPC 传 I420。
 *
 * 队列只留 2 帧：视频是实时流，落后就丢旧的 —— 与音频那边同一个口径。
 */

import type { NtHelperBinding } from '@weq/native';
import type { CallVideoEncoder, VideoStreamInfo } from '@weq/service';
import { getLogger } from '@weq/service';

const logger = getLogger().child({ scope: 'call-video-encoder' });

/** 队列上限：2 帧（约 130 ms @ 15 fps）。 */
const MAX_QUEUED = 2;

interface I420Frame {
  y: Uint8Array;
  u: Uint8Array;
  v: Uint8Array;
}

/**
 * 用 native `t265` 编码。
 *
 * `next()` 被 `CallSession` 的发送循环按 10 ms 轮询；队列空时返回 null，
 * 调用方不发包。
 */
export class NativeVideoEncoder implements CallVideoEncoder {
  private readonly queue: I420Frame[] = [];
  private readonly width: number;
  private readonly height: number;

  constructor(
    private readonly nt: NtHelperBinding,
    private readonly modulesDir: string,
    options: { width?: number; height?: number; fps?: number; bitrateKbps?: number } = {},
  ) {
    this.width = options.width ?? 640;
    this.height = options.height ?? 360;
    this.fps = options.fps ?? 15;
    this.bitrateKbps = options.bitrateKbps ?? 400;
  }

  private readonly fps: number;
  private readonly bitrateKbps: number;
  private opened = false;

  /** 打开 native 编码器。`CallSession.start` 里调。 */
  async open(): Promise<void> {
    await this.nt.openVideoEncoder(
      this.modulesDir,
      this.width,
      this.height,
      this.fps,
      this.bitrateKbps,
    );
    this.opened = true;
    logger.info('视频编码器已打开', {
      width: this.width,
      height: this.height,
      fps: this.fps,
      bitrate: this.bitrateKbps,
    });
  }

  /** 渲染层推来一帧 I420。 */
  pushFrame(frame: I420Frame): void {
    if (!this.opened) return;
    // 尺寸不对直接丢：多半是渲染层缩放没对齐，硬塞会踩 native 的越界检查。
    const ySize = this.width * this.height;
    const cSize = (this.width / 2) * (this.height / 2);
    if (frame.y.length !== ySize || frame.u.length !== cSize || frame.v.length !== cSize) {
      return;
    }
    if (this.queue.length >= MAX_QUEUED) this.queue.shift();
    this.queue.push(frame);
  }

  async next(): Promise<Uint8Array | null> {
    if (!this.opened) return null;
    const frame = this.queue.shift();
    if (!frame) return null;
    const result = this.nt.encodeVideoFrame(
      Buffer.from(frame.y),
      Buffer.from(frame.u),
      Buffer.from(frame.v),
    );
    // 编码器还在 lookahead 里攒帧时是 null，下一拍再取。
    if (!result) return null;
    return new Uint8Array(result.data);
  }

  info(): VideoStreamInfo {
    return { width: this.width, height: this.height, profile: 1, codec: 'hevc' };
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.queue.length = 0;
    try {
      this.nt.closeVideoEncoder();
    } catch (error) {
      logger.warn('关闭视频编码器失败', { error });
    }
  }

  /** 当前队列深度（调试用）。 */
  get pending(): number {
    return this.queue.length;
  }

  /** `CallSession` 日志里读它，看渲染层到底有没有在推帧。 */
  get pendingFrameCount(): number {
    return this.queue.length;
  }
}
