/**
 * 通话视频的**采集管线**（渲染层）：`MediaStream → canvas → I420 → pushVideoFrame`。
 *
 * 摄像头（`useCallCamera`）与屏幕共享（`useCallScreen`）只有「怎么拿到 `MediaStream`」
 * 不一样，拿到之后的一切完全相同 —— 所以这一段抽在这里，两个 hook 共用，避免
 * 出现「摄像头修好了、共享那条路径还是老逻辑」这种分叉。
 *
 * ```text
 * MediaStream → <video> → 按目标尺寸 drawImage 到 canvas
 *   → getImageData(RGBA) → rgbaToI420 → pushVideoFrame 推给主进程
 * ```
 *
 * ## 为什么不直接把 MediaStreamTrack 交给主进程
 *
 * 编码必须用 QQ 自带的 `t265`（在主进程里，走 native），而渲染层拿不到它。
 * 中间就只能传像素。传 I420 而不是 RGBA，是因为 `t265` 吃 I420，省掉主进程侧
 * 再做一次颜色空间转换。
 *
 * ## 为什么用递归 setTimeout 而不是 requestVideoFrameCallback
 *
 * `requestVideoFrameCallback` 在窗口不可见时会停，而通话窗口最小化时对端仍应看到
 * 画面。固定节拍 + 递归 setTimeout 能在慢机器上自动降频，不会堆积。
 *
 * ## 采集分辨率
 *
 * `getUserMedia` / `getDisplayMedia` 都要**直接要目标尺寸**（`profile.capture*`），
 * 不要让采集端给全分辨率再在这里缩 —— 本机实测这一步在 1920×1080 → 1280×720
 * 上要 20 ms/帧，让采集端直出 1280×720 后整条链路 45 ms → 22 ms。
 * 源宽高比与目标不一致时（超宽屏、竖屏窗口）仍会缩放一次，此时用
 * {@link fitWithin} 保住宽高比，不拉伸。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { trpc } from '../trpc/client';
import type { VideoProfile } from '../../../shared/call_video_profile';
import { fitWithin } from '../../../shared/call_video_profile';

/** 单帧失败后最多连续报几次日志，避免刷屏。 */
const MAX_ERROR_LOGS = 5;

export interface CaptureState {
  /** 是否已拿到流并在推帧。 */
  active: boolean;
  /** 错误信息（权限拒绝 / 没有设备 / 用户取消）。 */
  error: string | null;
  /** 采集到的视频元素（界面画本端画面用；未打开时为 null）。 */
  video: HTMLVideoElement | null;
  /** 实际编码尺寸（按源宽高比推导，可能小于 profile 的目标值）。 */
  width: number;
  height: number;
}

export interface CaptureOptions {
  /** 是否采集。false 时立即停止并关掉轨道（摄像头指示灯随之熄灭）。 */
  enabled: boolean;
  /** 编码档位。 */
  profile: VideoProfile;
  /**
   * 拿流的函数。**必须自己把约束带给采集端**（见文件头的说明），
   * 这里的 `width` / `height` / `fps` 是已经算好的目标尺寸与帧率。
   */
  openStream: (target: { width: number; height: number; fps: number }) => Promise<MediaStream>;
  /** 环境不支持时的错误文案（摄像头与屏幕共享说法不同）。 */
  unsupportedMessage: string;
  /**
   * 流被外部终止（用户在系统栏点「停止共享」、摄像头被拔掉）时回调。
   * 用于把界面状态同步回「已关闭」。
   */
  onEnded?: () => void;
}

/**
 * 采集管线。返回值里的 `video` 同时供界面预览与这里的取帧使用。
 *
 * `enabled` 变化、或 `profile` 的尺寸变化时重启采集 —— 后者意味着切换了采集源
 * （摄像头 ↔ 屏幕共享），编码器那边也已经按新尺寸重开。
 */
export function useVideoCapture(options: CaptureOptions): CaptureState {
  const { enabled, profile, openStream, unsupportedMessage, onEnded } = options;
  const [state, setState] = useState<CaptureState>({
    active: false,
    error: null,
    video: null,
    width: 0,
    height: 0,
  });

  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const timerRef = useRef<number | null>(null);
  /** 每帧都要用的尺寸，放 ref 里免得闭包读到旧值。 */
  const sizeRef = useRef({ width: 0, height: 0 });

  const push = trpc.call.pushVideoFrame.useMutation();
  // mutation 对象每次渲染都是新的引用，放进 effect 依赖会让采集反复重启。
  // 用 ref 固定住，effect 只依赖 enabled / 尺寸 / 帧率。
  const pushRef = useRef(push);
  pushRef.current = push;
  const openStreamRef = useRef(openStream);
  openStreamRef.current = openStream;
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  /** 已推帧数（只用于前几帧的排查日志）。 */
  const pushCount = useRef(0);
  /** 每次重启递增，用来判定「这次回调还属于当前这一轮」。 */
  const generation = useRef(0);

  /** 停掉采集与定时器。 */
  const stop = useCallback(() => {
    generation.current++;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) for (const track of stream.getTracks()) track.stop();
    videoRef.current = null;
    canvasRef.current = null;
    ctxRef.current = null;
    sizeRef.current = { width: 0, height: 0 };
    setState({ active: false, error: null, video: null, width: 0, height: 0 });
  }, []);

  // 重启条件：开关，以及档位里的尺寸 / 帧率。码率变化不需要重启采集，但一起
  // 列进来也无害（它变了就说明换了采集源）。
  useEffect(() => {
    if (!enabled) {
      stop();
      return;
    }

    const current = ++generation.current;
    const cancelled = () => generation.current !== current;

    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setState({ active: false, error: unsupportedMessage, video: null, width: 0, height: 0 });
          return;
        }
        const stream = await openStreamRef.current({
          width: profile.captureWidth,
          height: profile.captureHeight,
          fps: profile.fps,
        });
        if (cancelled()) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        streamRef.current = stream;

        // 用户在系统共享栏点「停止共享」时轨道会静默结束 —— 不接这个事件的话
        // 界面会一直停在「正在共享」，而且再也不会有新帧。
        for (const track of stream.getTracks()) {
          track.addEventListener('ended', () => {
            if (cancelled()) return;
            stop();
            onEndedRef.current?.();
          });
        }

        const video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        await video.play().catch(() => {});
        if (cancelled()) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        videoRef.current = video;

        // 编码尺寸按**源**宽高比推导，而不是直接用 profile 的宽高：
        // 共享一块 21:9 的屏幕时硬塞进 16:9 会把人拉扁。
        const size = video.videoWidth
          ? fitWithin(video.videoWidth, video.videoHeight, profile.width, profile.height)
          : { width: profile.width, height: profile.height };
        sizeRef.current = size;

        const canvas = document.createElement('canvas');
        canvas.width = size.width;
        canvas.height = size.height;
        canvasRef.current = canvas;
        // `willReadFrequently` 让浏览器用 CPU 后端，避免每次 getImageData 都从
        // GPU 回读 —— 我们要的就是像素数据。实测 720p 下快 3~4 ms/帧。
        ctxRef.current = canvas.getContext('2d', { willReadFrequently: true });

        setState({ active: true, error: null, video, ...size });
        scheduleNext();
      } catch (error) {
        if (cancelled()) return;
        setState({
          active: false,
          error: error instanceof Error ? error.message : String(error),
          video: null,
          width: 0,
          height: 0,
        });
      }
    })();

    /** 按固定间隔取帧。用递归 setTimeout 而不是 setInterval：编码慢时自动降频。 */
    function scheduleNext(): void {
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (cancelled()) return;
        try {
          captureOnce();
        } catch (error) {
          // 单帧失败不该停掉整个采集。
          if (pushCount.current <= MAX_ERROR_LOGS) {
            console.warn('[call] 采集一帧失败', error);
          }
        }
        if (!cancelled() && streamRef.current) scheduleNext();
      }, 1000 / profile.fps);
    }

    /** 抓一帧、转 I420、推给主进程。 */
    function captureOnce(): void {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const ctx = ctxRef.current;
      if (!video || !canvas || !ctx) return;
      if (video.readyState < 2) return;

      const { width, height } = sizeRef.current;
      if (width <= 0 || height <= 0) return;

      ctx.drawImage(video, 0, 0, width, height);
      const rgba = ctx.getImageData(0, 0, width, height).data;
      const { y, u, v } = rgbaToI420(rgba, width, height);
      pushCount.current++;
      // Electron 走二进制 IPC（结构化克隆，一帧 ~0.2 ms）；tRPC + superjson 会把
      // 平面展开成十进制文本（一帧几十 ms），帧率一高渲染层主线程就被吃满。
      // web 构建（apps/web 复用同一份 renderer）没有这个桥，回退到 tRPC。
      const bridge = window.weq?.callVideo;
      if (bridge) {
        bridge.pushFrame({ y, u, v });
        return;
      }
      // 只在首批帧失败时报错：持续失败会刷屏，但完全静默又没法排查。
      pushRef.current.mutate(
        { y, u, v },
        {
          onError: (error) => {
            if (pushCount.current <= MAX_ERROR_LOGS) console.error('[call] 推送视频帧失败', error);
          },
        },
      );
    }

    return () => {
      generation.current++;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const stream = streamRef.current;
      streamRef.current = null;
      if (stream) for (const track of stream.getTracks()) track.stop();
      videoRef.current = null;
      canvasRef.current = null;
      ctxRef.current = null;
    };
    // profile 是对象，逐字段列依赖，避免上游每次渲染新建对象导致反复重启。
  }, [
    enabled,
    profile.width,
    profile.height,
    profile.fps,
    profile.captureWidth,
    profile.captureHeight,
    stop,
    unsupportedMessage,
  ]);

  return state;
}

/**
 * RGBA → I420。
 *
 * 用 BT.601 的整数近似（与 x265 默认的 `colorprim=bt709` 略有差异，但通话
 * 场景下肉眼看不出；换成浮点会让每帧多几毫秒）。
 *
 * 实测本机（1080p 源）：640×360 约 2 ms/帧、1280×720 约 9 ms、1920×1080 约 16 ms。
 */
export function rgbaToI420(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): { y: Uint8Array<ArrayBuffer>; u: Uint8Array<ArrayBuffer>; v: Uint8Array<ArrayBuffer> } {
  const ySize = width * height;
  const cSize = (width / 2) * (height / 2);
  const yPlane = new Uint8Array(ySize);
  const uPlane = new Uint8Array(cSize);
  const vPlane = new Uint8Array(cSize);

  for (let i = 0, p = 0; i < ySize; i++, p += 4) {
    const r = rgba[p]!;
    const g = rgba[p + 1]!;
    const b = rgba[p + 2]!;
    // Y = 0.299R + 0.587G + 0.114B
    yPlane[i] = (77 * r + 150 * g + 29 * b + 128) >> 8;
  }

  // 色度平面按 2×2 块取平均。
  for (let by = 0; by < height / 2; by++) {
    for (let bx = 0; bx < width / 2; bx++) {
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const p = ((by * 2 + dy) * width + (bx * 2 + dx)) * 4;
          rSum += rgba[p]!;
          gSum += rgba[p + 1]!;
          bSum += rgba[p + 2]!;
        }
      }
      const r = rSum / 4;
      const g = gSum / 4;
      const b = bSum / 4;
      const idx = by * (width / 2) + bx;
      // U = -0.169R - 0.331G + 0.5B + 128
      uPlane[idx] = (-43 * r - 85 * g + 128 * b + 32768) >> 8;
      // V = 0.5R - 0.419G - 0.081B + 128
      vPlane[idx] = (128 * r - 107 * g - 21 * b + 32768) >> 8;
    }
  }

  return { y: yPlane, u: uPlane, v: vPlane };
}
