/**
 * 通话视频的**接收侧**渲染。
 *
 * 主进程把对端视频解成 Annex B 裸流推过来，这里用 WebCodecs 的 `VideoDecoder`
 * 解码，再画进一个 `<canvas>`。
 *
 * 为什么是 canvas 而不是 `<video>`：WebCodecs 吐的是 `VideoFrame`，`<video>` 只能
 * 吃容器格式（MP4 / WebM）。canvas 直接 `drawImage(frame)`，零拷贝路径，也没有
 * 缓冲 / 播放速率的额外概念 —— 通话画面只追最新一帧，不排队。
 *
 * 兼容性：Chromium 对 HEVC 的支持取决于构建选项（Linux 上常见只有 H.264）。所以
 * 这里探测 `VideoDecoder.isConfigSupported`，不支持时 `unsupported` 置位，界面
 * 退回「有声音、无画面」并说明原因，而不是留一块黑屏。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { trpc } from '../trpc/client';

/** HEVC 的 codec string：Main profile、level 1.5（实测 640×360@10fps 用这档）。 */
const HEVC_CODEC = 'hvc1.1.6.L93.B0';

export interface CallVideoState {
  /** 解码器可用。false 时界面应提示「当前环境不支持视频解码」。 */
  supported: boolean;
  /** 是否收到过可解码的帧（用来决定画 canvas 还是占位图）。 */
  active: boolean;
  /** 视频规格（来自关键帧的 SPS）。 */
  width: number;
  height: number;
  /** 最近一次错误（解码器配置失败等）。 */
  error: string | null;
}

/** 把 Annex B 裸流拆成 NAL 并转成解码器要的 `EncodedVideoChunk` 数据。 */
function stripStartCode(data: Uint8Array): Uint8Array | null {
  if (data.length > 4 && data[0] === 0 && data[1] === 0 && data[2] === 0 && data[3] === 1) {
    return data.subarray(4);
  }
  if (data.length > 3 && data[0] === 0 && data[1] === 0 && data[2] === 1) {
    return data.subarray(3);
  }
  return null;
}

/**
 * 订阅对端视频并解码到 `canvasRef`。
 *
 * `enabled` 为 false 时完全不订阅（音频通话不占这条通道）。
 */
export function useCallVideo(options: {
  enabled: boolean;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
}): CallVideoState {
  const { enabled, canvasRef } = options;
  const [state, setState] = useState<CallVideoState>({
    supported: true,
    active: false,
    width: 0,
    height: 0,
    error: null,
  });

  const decoderRef = useRef<VideoDecoder | null>(null);
  /** 是否已喂过关键帧（HEVC 必须先有 VPS/SPS/PPS + IDR 才能解后续帧）。 */
  const configured = useRef(false);
  /** 丢帧计数：连续解不动时重建解码器。 */
  const decodeFailures = useRef(0);

  /** 建 / 重建解码器。 */
  const ensureDecoder = useCallback(
    async (width: number, height: number): Promise<VideoDecoder | null> => {
      if (typeof VideoDecoder === 'undefined') {
        setState((prev) => ({ ...prev, supported: false }));
        return null;
      }
      const config: VideoDecoderConfig = {
        codec: HEVC_CODEC,
        codedWidth: width || 640,
        codedHeight: height || 360,
        optimizeForLatency: true,
      };
      try {
        const support = await VideoDecoder.isConfigSupported(config);
        if (!support.supported) {
          setState((prev) => ({
            ...prev,
            supported: false,
            error: '当前环境不支持 H.265 解码',
          }));
          return null;
        }
      } catch (error) {
        setState((prev) => ({ ...prev, supported: false, error: String(error) }));
        return null;
      }

      decoderRef.current?.close();
      const decoder = new VideoDecoder({
        output: (frame) => {
          const canvas = canvasRef.current;
          if (canvas) {
            // 按帧尺寸调整画布，避免拉伸。
            if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
              canvas.width = frame.displayWidth;
              canvas.height = frame.displayHeight;
            }
            const ctx = canvas.getContext('2d');
            ctx?.drawImage(frame, 0, 0);
          }
          frame.close();
          decodeFailures.current = 0;
          setState((prev) =>
            prev.active
              ? prev
              : { ...prev, active: true, width: frame.displayWidth, height: frame.displayHeight },
          );
        },
        error: (error) => {
          setState((prev) => ({ ...prev, error: String(error) }));
        },
      });
      decoder.configure(config);
      decoderRef.current = decoder;
      configured.current = false;
      return decoder;
    },
    [canvasRef],
  );

  useEffect(() => {
    if (!enabled) {
      decoderRef.current?.close();
      decoderRef.current = null;
      configured.current = false;
      setState({ supported: true, active: false, width: 0, height: 0, error: null });
      return;
    }
  }, [enabled]);

  trpc.call.onCallVideo.useSubscription(undefined, {
    enabled,
    onData: (frame) => {
      void (async () => {
        // ⚠️ `VideoDecoder.configure()` 之后**必须先吃一个关键帧**，否则
        // 直接抛 `DataError: A key frame is required after configure()`。
        // 所以：还没等到关键帧时，delta 帧一律丢弃（解码器都还没建）。
        if (!configured.current && !frame.keyframe) return;

        let decoder = decoderRef.current;
        if (!decoder || decoder.state === 'closed') {
          decoder = await ensureDecoder(frame.info?.width ?? 640, frame.info?.height ?? 360);
          if (!decoder) return;
          configured.current = false;
        }
        if (decoder.state !== 'configured') return;

        // 关键帧才带 VPS/SPS/PPS，用它重置解码器状态。
        if (frame.keyframe) configured.current = true;
        if (!configured.current) return;

        // Annex B 的起始码要去掉，`EncodedVideoChunk` 只要 NAL 本体。
        const data = stripStartCode(frame.hevc);
        if (!data) return;
        try {
          decoder.decode(
            new EncodedVideoChunk({
              type: frame.keyframe ? 'key' : 'delta',
              timestamp: frame.timestamp * 1000,
              data,
            }),
          );
        } catch (error) {
          decodeFailures.current++;
          setState((prev) => ({ ...prev, error: String(error) }));
          // 连续失败说明解码器状态坏了：关掉重建，并等下一个关键帧。
          if (decodeFailures.current > 3) {
            decoder.close();
            decoderRef.current = null;
            configured.current = false;
            decodeFailures.current = 0;
          }
        }
      })();
    },
    onError: (error) => setState((prev) => ({ ...prev, error: String(error) })),
  });

  useEffect(() => {
    return () => {
      decoderRef.current?.close();
      decoderRef.current = null;
    };
  }, []);

  return state;
}
