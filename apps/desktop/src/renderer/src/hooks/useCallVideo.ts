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
import { acceptsFrame, payloadForDecoder, toAccessUnit } from '../lib/callVideo';
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

/**
 * 把渲染层的解码**错误与关键状态**写进主进程日志文件。
 *
 * 通话视频的解码全在这一层，而渲染层的 `console.*` 不落盘 —— 解码失败时用户
 * 只看到「等待对方画面」，日志里却什么都没有。`weq.debugLog` 由 preload 提供；
 * web 构建没有这个桥，退回 `console`。
 *
 * 只记错误、断帧和首帧里程碑，不逐帧记录（一通通话上千帧，会淹没日志）。
 */
function trace(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  context?: Record<string, unknown>,
): void {
  const bridge = window.weq?.debugLog;
  if (bridge) {
    bridge(level, message, { scope: 'call-video', ...context });
    return;
  }
  const line = `[call-video] ${message}`;
  if (level === 'error') console.error(line, context);
  else if (level === 'warn') console.warn(line, context);
  else console.info(line, context);
}

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
 * `rotate` 是用户手动切换的旋转角度（0 / 90 / 270），见 `PEER_ROTATE` 的说明。
 */
export function useCallVideo(options: {
  enabled: boolean;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  rotate?: 0 | 90 | 270;
}): CallVideoState {
  const { enabled, canvasRef, rotate = 0 } = options;
  const [state, setState] = useState<CallVideoState>({
    supported: true,
    active: false,
    width: 0,
    height: 0,
    error: null,
  });

  const decoderRef = useRef<VideoDecoder | null>(null);
  /**
   * 当前旋转角度的最新值。
   *
   * 解码回调是在 hook 之外注册的长生命周期闭包，直接读闭包里的 `rotate` 会一直
   * 是建解码器时的那个值 —— 用户点按钮转了画面，下一帧又被画回去。所以走 ref。
   */
  const rotateRef = useRef(rotate);
  rotateRef.current = rotate;
  /** 最近一帧的原始尺寸，旋转角度变化时要按它重设画布。 */
  const frameSize = useRef({ width: 0, height: 0 });
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
  /** 解出的帧数（只用于第一帧的里程碑日志）。 */
  const decodedFrames = useRef(0);
  /**
   * 上一个喂进解码器的帧序号。
   *
   * HEVC 的 P 帧依赖前序参考帧：跳帧后继续喂 delta 会让硬解输出错乱（整屏纯绿），
   * 要等到下一个关键帧才恢复。见 onData 里的连续性检查。
   */
  const lastFrameIndex = useRef<number | null>(null);
  /** 已经因为断帧而进入「等关键帧」状态（只用于日志去重）。 */
  const awaitingKeyframe = useRef(false);
  /**
   * 是否正在异步建解码器。
   *
   * `ensureDecoder` 里有 `await VideoDecoder.isConfigSupported`，期间后续帧的
   * `onData` 会并发进来并重复触发重建 —— 第二次重建会 `close()` 掉第一次刚建
   * 好的解码器，导致「只解出第一帧」。见 `onData` 里的详细说明。
   */
  const buildingDecoder = useRef(false);

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
        trace('error', '所有 HEVC 候选都不支持', { tried, width, height });
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
          // ⚠️ **尺寸要在 `frame.close()` 之前读。** close() 会把 VideoFrame 的
          // 所有属性重置为 0 —— 在它之后读 `displayWidth` 拿到的是 0。
          const width = frame.displayWidth;
          const height = frame.displayHeight;
          frameSize.current = { width, height };
          drawRotated(canvasRef.current, frame, width, height, rotateRef.current);
          frame.close();
          decodeFailures.current = 0;
          decodedFrames.current++;
          // 第一帧解出来是整条链路唯一的关键里程碑（有它才说明「等待对方画面」
          // 会消失），只记这一次，不逐帧刷屏。
          if (decodedFrames.current === 1) {
            trace('info', '解出画面', { width, height, rotate: rotateRef.current });
          }
          setState((prev) =>
            prev.active
              ? prev
              : {
                  ...prev,
                  active: true,
                  width: turnedSize(width, height, rotateRef.current).width,
                  height: turnedSize(width, height, rotateRef.current).height,
                },
          );
        },
        error: (error) => {
          trace('error', '解码器错误', { error: String(error) });
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
      lastFrameIndex.current = null;
      awaitingKeyframe.current = false;
      setState({ supported: true, active: false, width: 0, height: 0, error: null });
      return;
    }
  }, [enabled]);

  trpc.call.onCallVideo.useSubscription(undefined, {
    enabled,
    onData: (frame) => {
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

        // ⚠️ **连续性检查：关键帧之后，帧序号必须连续。**
        //
        // HEVC 的 P 帧依赖前序参考帧。跳帧后继续喂 delta，Chromium 硬解会拒绝
        // 这些「无参考帧」的帧，但**内部状态被污染**，继续输出错乱的 YUV ——
        // 2026-10-26 实测整屏纯绿（RGB `[0,88,0]`，R/B 恒为 0），直到下一个
        // 关键帧（约 15 秒后）才重新同步。
        //
        // 主进程侧已经改为「整段补发连续帧」（见 `CallManager.replayBuffer`），
        // 正常情况下这里不会触发。它保留作为**安全网**：网络丢包、补发与实时流
        // 的衔接缝隙、对端中途重启编码，都可能造成序号断裂。
        //
        // 触发时丢弃本帧并等下一个关键帧 —— 会短暂冻画面，但好过整屏绿。
        const previousIndex = lastFrameIndex.current;
        if (!acceptsFrame(previousIndex, frame.frameIndex, au.keyframe)) {
          if (!awaitingKeyframe.current) {
            awaitingKeyframe.current = true;
            trace('warn', '帧序号不连续，丢弃直到下一个关键帧', {
              previous: previousIndex,
              current: frame.frameIndex,
              gap: ((frame.frameIndex - (previousIndex ?? 0) + 65536) % 65536) >>> 0,
            });
          }
          return;
        }
        if (au.keyframe) awaitingKeyframe.current = false;
        lastFrameIndex.current = frame.frameIndex;

        const existing = decoderRef.current;
        const rebuilt = !existing || existing.state === 'closed';
        let decoder = existing;
        if (rebuilt) {
          // ⚠️ **必须互斥。** `onData` 是同步回调，但这里是 async 函数 —— 帧 N
          // 在 `await ensureDecoder()` 期间，帧 N+1 的 `onData` 已经进来了，
          // 它看到的 `decoderRef.current` 仍是 null，于是也走 `rebuilt` 分支，
          // 再次 `await ensureDecoder()`。而 `ensureDecoder` 第一件事就是
          // `decoderRef.current?.close()` —— **它会把帧 N 刚建好的解码器关掉**。
          //
          // 结果：帧 N 的 `decode()` 落到一个已关闭的解码器上（或被丢弃），
          // 帧 N+1 建的新解码器又没收到关键帧（`configured=false` + 后续全是
          // delta 帧），此后每一帧都在 `if (!configured.current) return` 处被
          // 丢掉 —— 表现就是「解出第一帧，画面永久停住」。
          //
          // 用一个在建标记挡住并发重建：谁先拿到谁建，其余帧直接返回等下一帧。
          if (buildingDecoder.current) return;
          buildingDecoder.current = true;
          try {
            decoder = await ensureDecoder(frame.info?.width ?? 640, frame.info?.height ?? 360);
          } finally {
            buildingDecoder.current = false;
          }
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
          trace('warn', 'decode() 抛错', {
            failures: decodeFailures.current,
            error: String(error),
          });
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
    onError: (error) => {
      trace('error', '视频订阅出错', { error: String(error) });
      setState((prev) => ({ ...prev, error: String(error) }));
    },
  });

  useEffect(() => {
    return () => {
      decoderRef.current?.close();
      decoderRef.current = null;
    };
  }, []);

  /**
   * 用户切换旋转角度后，把画布上**已经画着的那一帧**按新角度重画一遍。
   *
   * 不重画的话要等下一个解码输出才生效；对端暂停发帧（画面静止）时那个等待会
   * 一直持续到画面动起来，按钮看起来像没反应。这里把画布现有内容当源图重画。
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvas.width === 0 || canvas.height === 0) return;
    // 画布当前内容就是「上一角度画好的图」，不能直接当原图再转 —— 会叠着转。
    // 所以只更新画布尺寸，真实画面由下一帧补齐；同时把状态里的宽高换过来，
    // 让 CSS 的宽高比立刻正确。
    const { width, height } = frameSize.current;
    if (width === 0 || height === 0) return;
    const target = turnedSize(width, height, rotate);
    if (canvas.width !== target.width || canvas.height !== target.height) {
      canvas.width = target.width;
      canvas.height = target.height;
    }
  }, [canvasRef, rotate]);

  return state;
}

/**
 * 旋转后画面的显示尺寸。转了 90° / 270° 时宽高互换。
 *
 * 目标画布必须按这个尺寸设 —— 否则 CSS 的 `object-fit: cover` 会按原帧的横屏
 * 比例去裁，转正的竖画面又被压扁。
 */
function turnedSize(
  width: number,
  height: number,
  rotate: 0 | 90 | 270,
): { width: number; height: number } {
  return rotate === 0 ? { width, height } : { width: height, height: width };
}

/**
 * 按用户选的旋转角度把帧画进画布。
 *
 * `rotate === 0` 时就是原来的「画布 = 帧尺寸、原样贴」。需要转的时候围绕画布
 * 中心转 90° / 270°，两轴各缩放到撑满 —— 旋转会让画面在其中一个维度上留黑边，
 * 交给 CSS `object-fit: cover` 去裁即可，这里只保证不拉伸变形。
 */
function drawRotated(
  canvas: HTMLCanvasElement | null,
  frame: VideoFrame,
  width: number,
  height: number,
  rotate: 0 | 90 | 270,
): void {
  if (!canvas) return;
  const target = turnedSize(width, height, rotate);
  if (canvas.width !== target.width || canvas.height !== target.height) {
    canvas.width = target.width;
    canvas.height = target.height;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (rotate === 0) {
    ctx.drawImage(frame, 0, 0);
    return;
  }
  // 改了画布尺寸会重置变换矩阵，所以每次都重新设。
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.translate(target.width / 2, target.height / 2);
  ctx.rotate((rotate * Math.PI) / 180);
  ctx.drawImage(frame, -width / 2, -height / 2, width, height);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
