/**
 * 本端摄像头采集（渲染层半边）。
 *
 * 摄像头只能用 WebRTC 拿（主进程没有 `getUserMedia`），而编码必须用 QQ 自带的
 * 那一版 x265（在主进程里）。所以这里的职责很窄：
 *
 * ```text
 * getUserMedia → <video> → VideoFrame → 缩放到 640×360
 *   → 转 I420 → pushVideoFrame 推给主进程
 * ```
 *
 * 为什么转 I420 而不是直接送 RGBA：native 的 `t265` 吃 I420（YUV420P），
 * 省掉主进程侧再做一次颜色空间转换。
 *
 * 帧率由 `setTimeout` 自己控（默认 15 fps），不用 `requestVideoFrameCallback` ——
 * 后者在窗口不可见时会停，而通话窗口最小化时对端仍应看到画面。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { trpc } from '../trpc/client';

/** 编码器协商的分辨率，必须与主进程一致。 */
const ENCODE_WIDTH = 640;
const ENCODE_HEIGHT = 360;
/** 采集帧率。 */
const CAPTURE_FPS = 15;

export interface CallCameraState {
  /** 摄像头是否已打开（拿得到流）。 */
  active: boolean;
  /** 错误信息（权限拒绝 / 没有设备）。 */
  error: string | null;
  /** 采集到的视频元素（界面画本端画面用；未打开时为 null）。 */
  video: HTMLVideoElement | null;
}

/**
 * 摄像头采集。
 *
 * `enabled` 由通话窗口的摄像头按钮控制；关掉时立即停止采集并关掉轨道
 * （摄像头指示灯随之熄灭）。
 */
export function useCallCamera(options: { enabled: boolean }): CallCameraState {
  const { enabled } = options;
  const [state, setState] = useState<CallCameraState>({ active: false, error: null, video: null });

  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  const push = trpc.call.pushVideoFrame.useMutation();
  // mutation 对象每次渲染都是新的引用，放进 effect 依赖会让采集反复重启。
  // 用 ref 固定住，effect 只依赖 enabled。
  const pushRef = useRef(push);
  pushRef.current = push;
  /** 已推帧数（只用于前几帧的排查日志）。 */
  const pushCount = useRef(0);

  /** 停掉采集与定时器。 */
  const stop = useCallback(() => {
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
    setState({ active: false, error: null, video: null });
  }, []);

  useEffect(() => {
    if (!enabled) {
      stop();
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        // 测试环境（happy-dom）没有 mediaDevices，直接报错比崩掉进程好。
        if (!navigator.mediaDevices?.getUserMedia) {
          setState({ active: false, error: '当前环境不支持摄像头采集', video: null });
          return;
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: ENCODE_WIDTH },
            height: { ideal: ENCODE_HEIGHT },
            frameRate: { ideal: CAPTURE_FPS },
          },
          audio: false,
        });
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        streamRef.current = stream;

        const video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        await video.play().catch(() => {});
        videoRef.current = video;

        const canvas = document.createElement('canvas');
        canvas.width = ENCODE_WIDTH;
        canvas.height = ENCODE_HEIGHT;
        canvasRef.current = canvas;
        // `willReadFrequently` 让浏览器用 CPU 后端，避免每次 getImageData 都从
        // GPU 回读 —— 我们要的就是像素数据。
        ctxRef.current = canvas.getContext('2d', { willReadFrequently: true });

        setState({ active: true, error: null, video });
        scheduleNext();
      } catch (error) {
        if (cancelled) return;
        setState({
          active: false,
          error: error instanceof Error ? error.message : String(error),
          video: null,
        });
      }
    })();

    /** 按固定间隔取帧。用递归 setTimeout 而不是 setInterval：编码慢时自动降频。 */
    function scheduleNext(): void {
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (cancelled) return;
        try {
          captureOnce();
        } catch (error) {
          // 单帧失败不该停掉整个采集。
          console.warn('[call] 采集一帧失败', error);
        }
        if (!cancelled && streamRef.current) scheduleNext();
      }, 1000 / CAPTURE_FPS);
    }

    /** 抓一帧、转 I420、推给主进程。 */
    function captureOnce(): void {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const ctx = ctxRef.current;
      if (!video || !canvas || !ctx) return;
      if (video.readyState < 2) return;

      ctx.drawImage(video, 0, 0, ENCODE_WIDTH, ENCODE_HEIGHT);
      const rgba = ctx.getImageData(0, 0, ENCODE_WIDTH, ENCODE_HEIGHT).data;
      const { y, u, v } = rgbaToI420(rgba, ENCODE_WIDTH, ENCODE_HEIGHT);
      pushCount.current++;
      // 只在首批帧失败时报错：持续失败会刷屏，但完全静默又没法排查。
      pushRef.current.mutate(
        { y, u, v },
        {
          onError: (error) => {
            if (pushCount.current <= 5) console.error('[call] 推送视频帧失败', error);
          },
        },
      );
    }

    return () => {
      cancelled = true;
      stop();
    };
  }, [enabled, stop]);

  return state;
}

/**
 * RGBA → I420。
 *
 * 用 BT.601 的整数近似（与 x265 默认的 `colorprim=bt709` 略有差异，但通话
 * 场景下肉眼看不出；换成浮点会让每帧多几毫秒）。
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
