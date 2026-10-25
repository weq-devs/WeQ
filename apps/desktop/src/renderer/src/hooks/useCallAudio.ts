/**
 * 通话的实时音频链路（采集 + 播放）。
 *
 *   上行 —— `getUserMedia` → `AudioContext`（16 kHz）→ 攒 20 ms 一帧 → `pushAudio`
 *   下行 —— 订阅推来的 PCM → 环形队列 → 定时器每 20 ms 喂出
 *
 * 用 Web Audio 而不是 `<audio>` 播对端：通话是连续的 20 ms 流，`<audio>` 的解码 /
 * 缓冲模型适合整段文件，不适合实时流。
 *
 * 从 CallWindow 里抽出来，一是那文件本来就太长，二是**未来的视频通话**还要在这里
 * 加视频轨、多人通话要多路混音 —— 那些都不该和窗口的 DOM 搅在一起。
 */

import { useEffect, useRef, useState } from 'react';
import { trpc } from '../trpc/client';
import { callLevel, smoothLevel } from '../lib/callWave';

const CALL_RATE = 16_000;
const FRAME_SAMPLES = 320;
/**
 * 采集缓冲区的采样数。`createScriptProcessor` 只接受 2 的幂且 256~16384，
 * 取最小的 256（16 ms），再由回调自己攒成 320 采样一帧。
 */
const MIC_BUFFER_SAMPLES = 256;
/** 播放队列积压上限：200 ms。实时比完整重要。 */
const MAX_PLAY_FRAMES = 10;
/** 采集侧积压上限（1 秒）：主进程卡住时丢掉旧的。 */
const MAX_PENDING_SAMPLES = CALL_RATE;

export interface CallAudioOptions {
  /** 通话是否已接通（未接通不采集、不播放）。 */
  live: boolean;
  /** 本端静音：不累计响度、不发帧。 */
  muted: boolean;
  /** 关闭对方声音：不播、不累计对端响度。 */
  speakerOff: boolean;
  /** 是否在麦克风采集时就静音（录音仍需要麦克风，见 `micEnabled`）。 */
  micEnabled?: boolean;
  /** 录音期间即使静音也要保持采集（否则录到的是空轨）。 */
  keepMicForRecording?: boolean;
}

/** 麦克风采集 + 对端播放。返回两端实时响度（0..1，画波形用）。 */
export function useCallAudio({
  live,
  muted,
  speakerOff,
  micEnabled = true,
  keepMicForRecording = false,
}: CallAudioOptions): { level: number; peerLevel: number } {
  const [level, setLevel] = useState(0);
  const [peerLevel, setPeerLevel] = useState(0);

  const micStream = useRef<MediaStream | null>(null);
  const micContext = useRef<AudioContext | null>(null);
  const playBuffer = useRef<Int16Array[]>([]);
  const playTimer = useRef<number | null>(null);
  /** 采集侧攒帧用的缓冲（16 ms 一段，凑满 20 ms 才发）。 */
  const micPending = useRef<Float32Array>(new Float32Array(0));
  const mutedRef = useRef(muted);
  const speakerRef = useRef(speakerOff);
  // 走 ref 而不是 effect 依赖：录音开始/结束时若让采集重挂，会白白停掉一次麦克风
  // （每次重开都有几百毫秒的空白）。
  const keepMicRef = useRef(keepMicForRecording);

  mutedRef.current = muted;
  speakerRef.current = speakerOff;
  keepMicRef.current = keepMicForRecording;

  const pushAudio = trpc.call.pushAudio.useMutation();
  const pushRef = useRef(pushAudio.mutate);
  pushRef.current = pushAudio.mutate;

  // ── 对端音频：进队列，由独立定时器按 20 ms 喂出 ──
  trpc.call.onCallAudio.useSubscription(undefined, {
    onData: (pcm) => {
      const raw = pcm as unknown as Uint8Array;
      if (speakerRef.current) return;
      playBuffer.current.push(toInt16(raw));
      if (playBuffer.current.length > MAX_PLAY_FRAMES)
        playBuffer.current.splice(0, playBuffer.current.length - MAX_PLAY_FRAMES);
    },
    onError: (error) => console.error('[call] audio subscription error', error),
  });

  // ── 播放循环 ──
  useEffect(() => {
    const Context = window.AudioContext;
    if (!Context) return;
    const context = new Context();
    const schedule = () => {
      playTimer.current = window.setTimeout(() => {
        const frame = playBuffer.current.shift();
        if (frame && !speakerRef.current) {
          const buffer = context.createBuffer(1, frame.length, CALL_RATE);
          const channel = buffer.getChannelData(0);
          for (let i = 0; i < frame.length; i++) channel[i] = (frame[i] ?? 0) / 0x8000;
          // 与上行同一套响度：两边柱子对同样大小的声音应该一样高。
          const next = callLevel(channel);
          setPeerLevel((prev) => smoothLevel(prev, next));
          const source = context.createBufferSource();
          source.buffer = buffer;
          source.connect(context.destination);
          source.start();
        } else {
          setPeerLevel((prev) => smoothLevel(prev, 0));
        }
        schedule();
      }, 20);
    };
    schedule();
    return () => {
      if (playTimer.current !== null) window.clearTimeout(playTimer.current);
      void context.close();
    };
  }, []);

  // ── 麦克风采集 ──
  // 录音时即使静音也要保持采集（只是不发帧），否则录下来的本端是空轨。
  const wantMic = live && micEnabled;
  useEffect(() => {
    if (!wantMic) return;
    let cancelled = false;
    let interval: number | null = null;

    const start = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
        });
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        micStream.current = stream;
        const context = new AudioContext({ sampleRate: CALL_RATE });
        micContext.current = context;
        // 采集是在「接通」之后才开始的，那时早就没有瞬时用户激活了。Electron
        // 默认允许自动播放，但上下文万一以 suspended 状态建出来，音频线程不跑、
        // `onaudioprocess` 一次都不回调 —— 表现就是没有波形、也没有上行声音。
        if (context.state === 'suspended') await context.resume().catch(() => {});
        if (context.state !== 'running') {
          console.warn('[call] 麦克风音频上下文未运行', context.state);
        }
        const source = context.createMediaStreamSource(stream);
        // 直接按 16 kHz 跑上下文：浏览器会在采集侧重采样，省掉自己插值。
        //
        // 缓冲区大小必须是 2 的幂且落在 256~16384 之间 —— 通话要的 320（20 ms）
        // 不合法，`createScriptProcessor(320)` 会直接抛 IndexSizeError（而且抛在
        // 一个 async 函数里，被下面的 catch 吞掉，表现成「麦克风静悄悄不工作」）。
        // 所以取最小合法值 256（16 ms），攒够 320 个采样再切一帧发出去。
        const processor = context.createScriptProcessor(MIC_BUFFER_SAMPLES, 1, 1);
        processor.onaudioprocess = (event) => {
          const input = event.inputBuffer.getChannelData(0);
          const silent = mutedRef.current;
          if (!silent) {
            // 响度走 RMS + dBFS：回声消除 / 降噪下峰值只有 0.1 上下，按峰值线性
            // 放大时柱子几乎不动，观感就是「本端没有波形」。
            const next = callLevel(input);
            setLevel((prev) => smoothLevel(prev, next));
          }
          // 静音时也要继续攒帧：录音要的是麦克风原声，而「静音」只表示不发给
          // 对方。由主进程按 `muted` 决定这一帧是喂录音还是也发给对方。
          if (!silent || keepMicRef.current) {
            micPending.current = concatFloat(micPending.current, input);
          }
          while (micPending.current.length >= FRAME_SAMPLES) {
            const slice = micPending.current.subarray(0, FRAME_SAMPLES);
            const frame = new Int16Array(FRAME_SAMPLES);
            for (let i = 0; i < FRAME_SAMPLES; i++) {
              const v = Math.max(-1, Math.min(1, slice[i] ?? 0));
              frame[i] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
            }
            micPending.current = micPending.current.subarray(FRAME_SAMPLES);
            void pushRef.current({ pcm: new Uint8Array(frame.buffer), muted: silent });
          }
          if (micPending.current.length > MAX_PENDING_SAMPLES)
            micPending.current = new Float32Array(0);
        };
        source.connect(processor);
        processor.connect(context.destination);

        // 静音时响度归零（采集本身不停，只是不再累计响度与帧）
        interval = window.setInterval(() => {
          if (mutedRef.current) setLevel((prev) => smoothLevel(prev, 0));
        }, 100);
      } catch (error) {
        console.error('[call] 麦克风不可用', error);
      }
    };
    void start();

    return () => {
      cancelled = true;
      if (interval !== null) window.clearInterval(interval);
      for (const track of micStream.current?.getTracks() ?? []) track.stop();
      micStream.current = null;
      micPending.current = new Float32Array(0);
      void micContext.current?.close();
      micContext.current = null;
      setLevel(0);
    };
  }, [wantMic]);

  return { level, peerLevel };
}

/**
 * 把两段 Float32 采样接起来。
 *
 * 不用 `Array.prototype.push` 攒数组再摊平：`onaudioprocess` 是音频线程回调，
 * 每次调用都要保持 O(帧长)，攒成二维数组再展开会让 GC 在音频路径上抖动。
 */
function concatFloat(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function toInt16(bytes: Uint8Array): Int16Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Int16Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}
