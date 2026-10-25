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
 *
 * ## HEVC 参数集必须**内联**，不能走 `description`
 *
 * 2026-10-25 实测（Electron 44 / Chromium 152，Linux + AMD VA-API）：
 *
 * | 配置 | 结果 |
 * | --- | --- |
 * | `hev1` / `hvc1`，**不带** `description`，参数集内联在数据里 | ✅ 正常解 |
 * | 带 `description`（Annex B 形态的参数集） | ❌ `isConfigSupported` 直接 false |
 * | 带 `description`（规范 hvcC） | ❌ 能配置成功，但首帧就 `Decoder error` |
 *
 * 三种「description」写法全灭 —— 这正是界面上「试过 6 种候选都不支持」的成因：
 * 候选列表里每一条都被同一个畸形 `description` 拖垮了。改由 {@link splitAnnexB}
 * 把 VPS/SPS/PPS 原样留在数据前面（Annex B in-band），首帧即开解。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { payloadForDecoder, toAccessUnit } from '../lib/callVideo';
import { trpc } from '../trpc/client';

/** HEVC 的 codec string：Main profile、level 1.5（实测 640×360@10fps 用这档）。 */
/**
 * HEVC 的 codec string 候选。
 *
 * `hvc1.<profile>.<compat>.L<level>.<constraints>`：
 *   - profile 1 = Main，6 = 8 位的 Main Still / 通配兼容位；
 *   - level 取**够用就行**：`L93` 是 3.1（1080p30），480×270 用 `L63`（2.0）
 *     甚至 `L30`（1.0）都行。写死高 level 时，部分 Chromium 构建会直接判不支持。
 *
 * 按「从最保守到最宽松」的顺序试，第一个 `isConfigSupported` 通过的就用它。
 */
const HEVC_CODEC_CANDIDATES = [
  'hvc1.1.6.L63.B0',
  'hvc1.1.6.L93.B0',
  'hvc1.1.6.L120.B0',
  'hvc1.1.6.L150.B0',
  'hev1.1.6.L63.B0',
  'hev1.1.6.L93.B0',
] as const;

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
  /**
   * 最近一次见到的参数集（VPS/SPS/PPS，Annex B 形态）。
   *
   * 实测（2026-10-25，Electron 44 + 真实码流）：解码器 `close()` 重建后，**必须**
   * 在下一个关键帧前面补回参数集，否则那个关键帧只含 IDR/CRA，`decode()` 会一直
   * 抛 `A key frame is required after configure()`，画面永久黑掉。不重放 ->
   * 0 帧；重放 -> 正常解出。
   */
  const paramSets = useRef<Uint8Array[]>([]);
  /**
   * 下一次真正喂帧时要不要补参数集。
   *
   * **不能只判「这一帧是不是刚重建的那一帧」**：重建点恰好落在 delta 帧上时，
   * 那帧按「未配置就跳过 delta」被丢掉，标记也跟着丢了 —— 后面的关键帧不会再补，
   * 画面永久黑掉（实测 0 帧且不报错）。所以标记要一直挂到真的喂出一帧关键帧为止。
   */
  const needsParamSets = useRef(false);
  /** 丢帧计数：连续解不动时重建解码器。 */
  const decodeFailures = useRef(0);
  /** 收到的帧数（只用于前几帧的排查日志）。 */
  const frameCount = useRef(0);

  /** 建 / 重建解码器。 */
  const ensureDecoder = useCallback(
    async (width: number, height: number): Promise<VideoDecoder | null> => {
      if (typeof VideoDecoder === 'undefined') {
        setState((prev) => ({ ...prev, supported: false }));
        return null;
      }

      // 逐个试 codec string：不同 Chromium 构建对 profile/level 的支持不一样，
      // 写死一个高 level 会被直接判「不支持」。第一个通过的就用它。
      //
      // ⚠️ **不要**给这里加 `description`：参数集内联在数据里（见 splitAnnexB）。
      // 带 description 时 Chromium 会把 config 当 out-of-band 参数集，要求 hvcC
      // 形态 —— 传 Annex B 直接判不支持，传正确的 hvcC 也会首帧 Decoder error。
      let config: VideoDecoderConfig | null = null;
      const tried: string[] = [];
      for (const codec of HEVC_CODEC_CANDIDATES) {
        const candidate: VideoDecoderConfig = {
          codec,
          codedWidth: width || 640,
          codedHeight: height || 360,
          optimizeForLatency: true,
        };
        try {
          const support = await VideoDecoder.isConfigSupported(candidate);
          tried.push(`${codec}:${support.supported ? 'ok' : 'no'}`);
          if (support.supported) {
            config = candidate;
            break;
          }
        } catch (error) {
          tried.push(`${codec}:err(${String(error)})`);
        }
      }
      if (!config) {
        // 把试过的候选连同报错一起抛给界面：只说「不支持」没法排查。
        console.error('[call-video] 所有 HEVC 候选都不支持', tried, { width, height });
        setState((prev) => ({
          ...prev,
          supported: false,
          error: `当前环境不支持 H.265 解码（试过 ${HEVC_CODEC_CANDIDATES.length} 种）`,
        }));
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
          console.error('[call-video] 解码器错误', error);
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
      paramSets.current = [];
      needsParamSets.current = false;
      setState({ supported: true, active: false, width: 0, height: 0, error: null });
      return;
    }
  }, [enabled]);

  trpc.call.onCallVideo.useSubscription(undefined, {
    enabled,
    onData: (frame) => {
      frameCount.current++;
      void (async () => {
        // 先拆 NAL 再判断关键帧。
        //
        // ⚠️ 不能用主进程传的 `frame.keyframe`：订阅是在「对端开始发视频」的
        // 状态推送之后才建立的，而**首个关键帧往往已经在那之前到达**——用它
        // 判断会导致 `!configured && !keyframe` 永远成立，解码器根本建不起来。
        // 改用自己从 NAL 类型判出来的结果：只要这一帧里真的带了 IRAP 就能起解。
        const au = toAccessUnit(frame.hevc);
        if (!au.data) return;
        // 见到参数集就记下来：解码器重建后要拿它补在最前面（见 paramSets 的注释）。
        if (au.params.length > 0) paramSets.current = au.params;
        if (!configured.current && !au.keyframe) return;

        const existing = decoderRef.current;
        const rebuilt = !existing || existing.state === 'closed';
        let decoder = existing;
        if (rebuilt) {
          decoder = await ensureDecoder(frame.info?.width ?? 640, frame.info?.height ?? 360);
          if (!decoder) return;
          configured.current = false;
          // 一直挂到真的喂出一帧为止 —— 重建点落在 delta 帧上时，那帧会被下面
          // 的「未配置跳过 delta」丢掉，标记得留着给下一个关键帧用。
          needsParamSets.current = true;
        }
        if (decoder?.state !== 'configured') return;

        if (au.keyframe) configured.current = true;
        if (!configured.current) return;

        // 这一帧自己不带参数集时补上缓存的 —— 新解码器和「只有首帧带参数集」的
        // 码流都靠它。实测缺了会一直 `A key frame is required`。
        const payload = payloadForDecoder(au, paramSets.current, needsParamSets.current);
        if (!payload) return;
        if (needsParamSets.current) needsParamSets.current = false;

        try {
          decoder.decode(
            new EncodedVideoChunk({
              type: au.keyframe ? 'key' : 'delta',
              timestamp: frame.timestamp * 1000,
              data: payload,
            }),
          );
        } catch (error) {
          decodeFailures.current++;
          setState((prev) => ({ ...prev, error: String(error) }));
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
