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

/** 把 Annex B 裸流拆成 NAL 并转成解码器要的 `EncodedVideoChunk` 数据。 */
/**
 * 把 tRPC 传过来的东西统一成真正的 `Uint8Array`。
 *
 * tRPC 的 subscription 走 JSON 序列化时，`Uint8Array` 可能变成普通对象
 * （`{0:..,1:..}`）或 Node `Buffer` 的 JSON 形态（`{type:'Buffer',data:[...]}`）。
 * 前一种还能按下标读，但**没有 `subarray` / `buffer`** —— 直接喂给
 * `EncodedVideoChunk` 会抛错。
 */
function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  // Node Buffer 的 JSON 形态
  const json = value as { type?: string; data?: number[] } | null;
  if (json && json.type === 'Buffer' && Array.isArray(json.data)) {
    return Uint8Array.from(json.data);
  }
  // 普通对象 {0:..,1:..,length:n}
  if (json && typeof (json as { length?: unknown }).length === 'number') {
    const len = (json as { length: number }).length;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = (json as unknown as Record<number, number>)[i] ?? 0;
    return out;
  }
  return null;
}

/**
 * 把 Annex B 裸流拆成 NAL 单元，同时把 VPS/SPS/PPS 抽出来当解码器配置。
 *
 * `EncodedVideoChunk` 要的是**一个 access unit**：参数集（VPS/SPS/PPS）要么放进
 * `VideoDecoderConfig.description`，要么和数据一起按 Annex B 拼接 —— 但**不能**
 * 只剥掉第一个起始码就把剩下的整块当 payload（那样 SPS/PPS 会变成数据的一部分，
 * 解码器直接拒绝）。
 *
 * 实测对端的首帧是 `VPS + SPS + PPS + IDR` 四个 NAL 拼在一起，正是这个形态。
 */
function splitAnnexB(input: unknown): {
  description: Uint8Array | null;
  data: Uint8Array | null;
  keyframe: boolean;
} {
  const bytes = toBytes(input);
  if (!bytes) return { description: null, data: null, keyframe: false };

  // 按起始码切分。
  const units: Uint8Array[] = [];
  let start = -1;
  let i = 0;
  while (i < bytes.length) {
    const four =
      i + 4 <= bytes.length &&
      bytes[i] === 0 &&
      bytes[i + 1] === 0 &&
      bytes[i + 2] === 0 &&
      bytes[i + 3] === 1;
    const three =
      !four && i + 3 <= bytes.length && bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1;
    if (four || three) {
      if (start >= 0) units.push(bytes.subarray(start, i));
      start = i + (four ? 4 : 3);
      i = start;
      continue;
    }
    i++;
  }
  if (start >= 0 && start < bytes.length) units.push(bytes.subarray(start));
  if (units.length === 0) return { description: null, data: null, keyframe: false };

  // HEVC NAL 类型：首字节 >> 1 & 0x3f。32=VPS 33=SPS 34=PPS，16..21 是 IRAP。
  const nalType = (nal: Uint8Array) => (nal[0]! >> 1) & 0x3f;
  const isParam = (t: number) => t === 32 || t === 33 || t === 34;

  const params: Uint8Array[] = [];
  const payload: Uint8Array[] = [];
  for (const nal of units) {
    if (isParam(nalType(nal))) params.push(nal);
    else payload.push(nal);
  }
  const keyframe = payload.some((nal) => {
    const t = nalType(nal);
    return t >= 16 && t <= 21;
  });
  if (payload.length === 0) return { description: null, data: null, keyframe };

  // 参数集按 Annex B 拼成 description（Chromium 的 HEVC 解码器接受这个形态）。
  const description =
    params.length > 0
      ? concatBytes(params.flatMap((nal) => [new Uint8Array([0, 0, 0, 1]), nal]))
      : null;
  const data = concatBytes(payload.flatMap((nal) => [new Uint8Array([0, 0, 0, 1]), nal]));
  return { description, data, keyframe };
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
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
  /** 收到的帧数（只用于前几帧的排查日志）。 */
  const frameCount = useRef(0);

  /** 建 / 重建解码器。 */
  const ensureDecoder = useCallback(
    async (
      width: number,
      height: number,
      description: Uint8Array | null = null,
    ): Promise<VideoDecoder | null> => {
      if (typeof VideoDecoder === 'undefined') {
        setState((prev) => ({ ...prev, supported: false }));
        return null;
      }

      // 逐个试 codec string：不同 Chromium 构建对 profile/level 的支持不一样，
      // 写死一个高 level 会被直接判「不支持」。第一个通过的就用它。
      let config: VideoDecoderConfig | null = null;
      const tried: string[] = [];
      for (const codec of HEVC_CODEC_CANDIDATES) {
        const candidate: VideoDecoderConfig = {
          codec,
          codedWidth: width || 640,
          codedHeight: height || 360,
          optimizeForLatency: true,
          // VPS/SPS/PPS 走 description：HEVC 的 out-of-band 参数集就是这个形态。
          ...(description ? { description } : {}),
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
        console.error('[call-video] 所有 HEVC 候选都不支持', tried, {
          width,
          height,
          hasDesc: Boolean(description),
        });
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
        const { description, data, keyframe } = splitAnnexB(frame.hevc);
        if (!data) return;
        if (!configured.current && !keyframe) return;

        let decoder = decoderRef.current;
        if (!decoder || decoder.state === 'closed') {
          decoder = await ensureDecoder(
            frame.info?.width ?? 640,
            frame.info?.height ?? 360,
            description,
          );
          if (!decoder) return;
          configured.current = false;
        }
        if (decoder.state !== 'configured') return;

        if (keyframe) configured.current = true;
        if (!configured.current) return;

        try {
          decoder.decode(
            new EncodedVideoChunk({
              type: keyframe ? 'key' : 'delta',
              timestamp: frame.timestamp * 1000,
              data,
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
