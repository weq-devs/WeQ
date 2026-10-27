/**
 * 视频通话的**本端编码**（主进程半边）。
 *
 * 链路：
 *
 * ```text
 * 渲染层 getUserMedia / getDisplayMedia → 缩放 → 转 I420 → IPC pushVideoFrame
 *   → 这里排进队列 → CallSession.pumpVideo 每 10ms 取一帧
 *   → native 的 t265（QQ 自带的魔改 x265）编成 Annex B
 *   → 0x5b subType=2 发给对端
 * ```
 *
 * 为什么采集在渲染层、编码在主进程：摄像头与屏幕只能用 WebRTC 拿（主进程没有
 * `getUserMedia`），而编码必须用 QQ 自带的那一版 x265（系统 libx265 编出来的
 * 码流对端不一定能解）。两头分工，中间用 IPC 传 I420。
 *
 * **摄像头与屏幕共享共用这一个编码器**，切换时按 {@link CAMERA_PROFILE} /
 * {@link SCREEN_PROFILE} 重开（t265 是进程级单例，打开后改不了参数）。
 *
 * 队列只留 2 帧：视频是实时流，落后就丢旧的 —— 与音频那边同一个口径。
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import type { NtHelperBinding } from '@weq/native';
import type { CallVideoEncoder, VideoStreamInfo } from '@weq/service';
import { getLogger } from '@weq/service';
import {
  CAMERA_PROFILE,
  type VideoProfile,
  type VideoSource,
  profileFor,
} from '../shared/call_video_profile';

const logger = getLogger().child({ scope: 'call-video-encoder' });

/**
 * 调试开关：把送进编码器的 I420 和编码结果落盘。
 *
 * ```bash
 * WEQ_CALL_VIDEO_DUMP=/tmp/vdump pnpm --filter @weq/desktop dev
 * # 通话后：
 * ffplay -f rawvideo -pix_fmt yuv420p -s 640x360 /tmp/vdump/i420-0.raw  # 输入
 * ffplay /tmp/vdump/encoded.h265                                       # 输出
 * ```
 *
 * 两份对照看就知道问题在采集/转换（I420 就不对）还是编码（I420 对但 h265 不对）。
 * 2026-10-25 的「彩色竖纹」就是靠它定位的：I420 正常、编码输出行方差为 0。
 */
const DUMP_DIR = process.env.WEQ_CALL_VIDEO_DUMP ?? '';
const DUMP_FRAMES = Number.parseInt(process.env.WEQ_CALL_VIDEO_DUMP_FRAMES ?? '5', 10);

/** 队列上限：2 帧（约 160 ms @ 12 fps 摄像头档 / 约 130 ms @ 15 fps 共享档）。 */
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
  private width: number;
  private height: number;

  constructor(
    private readonly nt: NtHelperBinding,
    private readonly modulesDir: string,
    options: { width?: number; height?: number; fps?: number; bitrateKbps?: number } = {},
  ) {
    this.width = options.width ?? CAMERA_PROFILE.width;
    this.height = options.height ?? CAMERA_PROFILE.height;
    this.fps = options.fps ?? CAMERA_PROFILE.fps;
    // 码率取 {@link CAMERA_PROFILE}，数值来由见 `shared/call_video_profile.ts`。
    // 旧值 30 kbps 是误把「静态画面下 ABR 的实际输出」当成目标码率，画面一动就
    // 严重欠码（实测同一张图 30 kbps 的 PSNR-Y 只有 32.6 dB，300 kbps 是 43.4 dB）。
    this.bitrateKbps = options.bitrateKbps ?? CAMERA_PROFILE.bitrateKbps;
  }

  private fps: number;
  private bitrateKbps: number;
  private opened = false;
  /** 当前采集源（摄像头 / 屏幕共享）。只用于日志与重配判断。 */
  private source: VideoSource = 'camera';

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
      source: this.source,
    });
  }

  /**
   * 切换采集源并**重开**编码器。
   *
   * 摄像头与屏幕共享的分辨率 / 码率不同（640×360@300kbps ↔ 1280×720@1.2Mbps），
   * 而 native 的 t265 是进程级单例、打开后不能改参数 —— 只能关掉重建。
   *
   * 实测重建很便宜：`openVideoEncoder` 在 1080p 下也只要 ~10 ms，而且这里只在
   * 用户点「共享屏幕 / 停止共享」时发生，不必为它做增量更新。
   *
   * 关键帧问题：新编码器从第一个 I 帧开始，对端本来就要等关键帧才能起解，
   * 所以这次重建不会让对端画面比平时更糟。发送侧的帧序号由 `CallSession` 维护，
   * 不受这里影响（序号连续，对端不会当成丢包）。
   *
   * 返回实际生效的档位，调用方据此告诉渲染层按什么尺寸采集。
   */
  async setSource(source: VideoSource): Promise<VideoProfile> {
    if (this.source === source) return this.profile();
    const target = profileFor(source);
    const wasOpen = this.opened;
    if (wasOpen) this.close();

    this.source = source;
    this.width = target.width;
    this.height = target.height;
    this.fps = target.fps;
    this.bitrateKbps = target.bitrateKbps;
    if (wasOpen) {
      await this.open();
    }
    logger.info('切换视频采集源', {
      source,
      width: this.width,
      height: this.height,
      fps: this.fps,
      bitrate: this.bitrateKbps,
    });
    return this.profile();
  }

  /**
   * 按**实际采集尺寸**重开编码器。
   *
   * 屏幕共享的源宽高比不一定是 16:9（超宽屏 21:9、4:3 显示器），渲染层会按源比例
   * 推导出一个不超过档位上限的尺寸再推帧。编码器必须用同一个尺寸，否则
   * `pushFrame` 会因平面长度对不上而静默丢帧 —— 表现为「共享了但对方什么都看不到」。
   *
   * 尺寸与当前一致、且编码器已打开时是空操作。
   */
  async resize(width: number, height: number): Promise<void> {
    // 对齐到偶数：I420 的色度平面按 2×2 采样，奇数会越界。
    const w = width % 2 === 0 ? width : width - 1;
    const h = height % 2 === 0 ? height : height - 1;
    if (w <= 0 || h <= 0) return;
    if (this.width === w && this.height === h && this.opened) return;
    const wasOpen = this.opened;
    if (wasOpen) this.close();
    this.width = w;
    this.height = h;
    if (wasOpen) await this.open();
    logger.info('重设视频编码尺寸', { width: this.width, height: this.height });
  }

  /** 当前档位。 */
  profile(): VideoProfile {
    return {
      width: this.width,
      height: this.height,
      fps: this.fps,
      bitrateKbps: this.bitrateKbps,
      captureWidth: this.width,
      captureHeight: this.height,
    };
  }

  /** 当前采集源。 */
  get currentSource(): VideoSource {
    return this.source;
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
    this.dumpI420(frame);
  }

  /** 调试用：把送进编码器的 I420 原样落盘。 */
  private dumpI420(frame: I420Frame): void {
    if (!DUMP_DIR || this.dumpedFrames >= DUMP_FRAMES) return;
    const index = this.dumpedFrames++;
    try {
      const all = new Uint8Array(frame.y.length + frame.u.length + frame.v.length);
      all.set(frame.y, 0);
      all.set(frame.u, frame.y.length);
      all.set(frame.v, frame.y.length + frame.u.length);
      writeFileSync(`${DUMP_DIR}/i420-${index}.raw`, all);
      logger.info('已写出 I420 帧', { index, bytes: all.length, dir: DUMP_DIR });
    } catch (error) {
      logger.warn('写出 I420 帧失败', { error });
    }
  }

  private dumpedFrames = 0;

  /** 调试用：把编码结果按帧追加进同一个 Annex B 文件。 */
  private dumpAnnexB(data: Uint8Array): void {
    if (!DUMP_DIR || this.dumpedEncoded >= DUMP_FRAMES) return;
    const index = this.dumpedEncoded++;
    try {
      appendFileSync(`${DUMP_DIR}/encoded.h265`, data);
      logger.info('已追加编码帧', { index, bytes: data.length });
    } catch (error) {
      logger.warn('写出编码帧失败', { error });
    }
  }

  private dumpedEncoded = 0;

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
    const out = new Uint8Array(result.data);
    this.dumpAnnexB(out);
    return out;
  }

  info(): VideoStreamInfo {
    return {
      width: this.width,
      height: this.height,
      profile: 1,
      codec: 'hevc',
      // `bt=77` 视频参数公告要用：对端按这里声明的规格准备解码。
      fps: this.fps,
      bitrateKbps: this.bitrateKbps,
    };
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
