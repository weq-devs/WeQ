/**
 * 通话窗口。
 *
 * 一个独立浮层，跟着通话状态走：呼叫中 → 振铃 → 接通 → 挂断。
 * 只在**主动发起**时出现 —— 来电由 QQ 本体处理，WeQ 收不到那条推送。
 *
 * 音频链路在这里闭环：
 *   上行 —— `getUserMedia` → `AudioContext`（16 kHz）→ 切 20 ms 帧 → `pushAudio`
 *   下行 —— `onCallAudio` 订阅 → 环形队列 → `AudioContext` 定时喂出
 *
 * 用 Web Audio 而不是 `<audio>` 播对端：通话是连续的 20 ms 流，`<audio>` 的
 * 解码 / 缓冲模型适合整段文件，不适合实时流。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Mic,
  MicOff,
  PhoneOff,
  Volume2,
  VolumeX,
  Loader2,
  PhoneCall,
  PhoneIncoming,
} from 'lucide-react';
import { trpc } from '../trpc/client';
import '../styles/call.css';

/** 通话状态（与主进程 `CallState` 一致）。 */
type CallState =
  | 'idle'
  | 'calling'
  | 'ringing'
  | 'connecting'
  | 'connected'
  | 'ending'
  | 'ended'
  | 'failed';

interface CallInfo {
  state: CallState;
  roomId: string | null;
  peerUin: string;
  peerUid: string;
  peerName: string;
  peerAvatar: string;
  /** 通话背景静态图（个性装扮「来电」）。空表示没设。 */
  backgroundUrl: string;
  /** 通话背景动态版。非空时优先播它。 */
  backgroundVideoUrl: string;
  startedAt: number | null;
  connectedAt: number | null;
  endReason: string | null;
  lastError: string | null;
  sentFrames: number;
  receivedFrames: number;
  durationSec: number;
}

const CALL_RATE = 16_000;
const FRAME_SAMPLES = 320;

/**
 * 采集缓冲区的采样数。`createScriptProcessor` 只接受 2 的幂且 256~16384，
 * 取最小的 256（16 ms），再由回调自己攒成 320 采样一帧。
 */
const MIC_BUFFER_SAMPLES = 256;

/**
 * 波形柱的静态形状：中间高两边低。
 *
 * 预先算好而不是在渲染里 `Math.sin`，一是避免每帧重算，二是给每根柱子一个
 * 稳定的 key（用下标当 key 会让 lint 报错，且柱子的顺序本身不会变）。
 */
const WAVE_BARS = Array.from({ length: 24 }, (_, i) => Math.abs(Math.sin((i / 23) * Math.PI)));

/** 状态 → 文案。接通后显示时长，其余显示阶段。 */
function statusText(info: CallInfo): string {
  switch (info.state) {
    case 'calling':
      return '正在呼叫…';
    case 'ringing':
      return '等待对方接听…';
    case 'connecting':
      return '正在接通…';
    case 'connected':
      return formatDuration(info.durationSec);
    case 'ending':
      return '正在挂断…';
    case 'ended':
      return endText(info.endReason);
    case 'failed':
      return info.lastError ?? '呼叫失败';
    default:
      return '';
  }
}

function endText(reason: string | null): string {
  switch (reason) {
    case 'peer_hangup':
      return '对方已挂断';
    case 'timeout':
      return '无人接听';
    case 'connect_fail':
      return '连接失败';
    case 'kicked':
      return '通话被中断';
    case 'hangup':
      return '已挂断';
    default:
      return '通话结束';
  }
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * 通话窗口。
 *
 * `call` 是发起时拿到的快照；后续状态全靠订阅推。窗口在 `ended` / `failed`
 * 之后再留 1.6 秒给用户看结果，然后自己关掉。
 */
export function CallWindow({ initial, onClose }: { initial: CallInfo; onClose: () => void }) {
  const [info, setInfo] = useState<CallInfo>(initial);
  const [muted, setMuted] = useState(false);
  const [speakerOff, setSpeakerOff] = useState(false);
  /** 本端麦克风的实时响度（0..1），画波形用。 */
  const [level, setLevel] = useState(0);
  /** 对端的实时响度。 */
  const [peerLevel, setPeerLevel] = useState(0);

  const micStream = useRef<MediaStream | null>(null);
  const micContext = useRef<AudioContext | null>(null);
  const playContext = useRef<AudioContext | null>(null);
  const playBuffer = useRef<Int16Array[]>([]);
  const playTimer = useRef<number | null>(null);
  /** 采集侧攒帧用的缓冲（16 ms 一段，凑满 20 ms 才发）。 */
  const micPending = useRef<Float32Array>(new Float32Array(0));
  const mutedRef = useRef(muted);
  const speakerRef = useRef(speakerOff);

  mutedRef.current = muted;
  speakerRef.current = speakerOff;

  const pushAudio = trpc.call.pushAudio.useMutation();
  const hangup = trpc.call.hangup.useMutation();
  const pushRef = useRef(pushAudio.mutate);
  pushRef.current = pushAudio.mutate;

  // ── 状态订阅 ──
  trpc.call.onCallState.useSubscription(undefined, {
    onData: (next) => {
      const call = next as CallInfo;
      if (call?.state) setInfo((prev) => ({ ...prev, ...call }));
    },
    onError: (error) => console.error('[call] state subscription error', error),
  });

  // ── 对端音频：解码后进队列，由独立定时器按 20 ms 喂出 ──
  trpc.call.onCallAudio.useSubscription(undefined, {
    onData: (pcm) => {
      const raw = pcm as unknown as Uint8Array;
      if (speakerRef.current) return;
      playBuffer.current.push(toInt16(raw));
      // 积压超过 10 帧（200 ms）说明播放卡了，丢掉旧的保持实时。
      if (playBuffer.current.length > 10)
        playBuffer.current.splice(0, playBuffer.current.length - 10);
    },
    onError: (error) => console.error('[call] audio subscription error', error),
  });

  // ── 播放循环 ──
  useEffect(() => {
    const Context = window.AudioContext;
    if (!Context) return;
    const context = new Context();
    playContext.current = context;
    const schedule = () => {
      playTimer.current = window.setTimeout(() => {
        const frame = playBuffer.current.shift();
        if (frame && !speakerRef.current) {
          const buffer = context.createBuffer(1, frame.length, CALL_RATE);
          const channel = buffer.getChannelData(0);
          let peak = 0;
          for (let i = 0; i < frame.length; i++) {
            const v = (frame[i] ?? 0) / 0x8000;
            channel[i] = v;
            peak = Math.max(peak, Math.abs(v));
          }
          setPeerLevel((prev) => prev * 0.6 + Math.min(1, peak * 2.5) * 0.4);
          const source = context.createBufferSource();
          source.buffer = buffer;
          source.connect(context.destination);
          source.start();
        } else {
          setPeerLevel((prev) => prev * 0.75);
        }
        schedule();
      }, 20);
    };
    schedule();
    return () => {
      if (playTimer.current !== null) window.clearTimeout(playTimer.current);
      void context.close();
      playContext.current = null;
    };
  }, []);

  // ── 麦克风采集 ──
  useEffect(() => {
    let cancelled = false;
    let interval: number | null = null;

    const start = async () => {
      if (info.state !== 'connected') return;
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
          if (!mutedRef.current) {
            let peak = 0;
            for (let i = 0; i < input.length; i++) peak = Math.max(peak, Math.abs(input[i] ?? 0));
            setLevel((prev) => prev * 0.5 + Math.min(1, peak * 3) * 0.5);
            // 追加到待切缓冲末尾。
            micPending.current = concatFloat(micPending.current, input);
          }
          // 攒够一帧（320 采样）就发出去；一次回调可能攒出不止一帧。
          while (micPending.current.length >= FRAME_SAMPLES) {
            const slice = micPending.current.subarray(0, FRAME_SAMPLES);
            const frame = new Int16Array(FRAME_SAMPLES);
            for (let i = 0; i < FRAME_SAMPLES; i++) {
              const v = Math.max(-1, Math.min(1, slice[i] ?? 0));
              frame[i] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
            }
            micPending.current = micPending.current.subarray(FRAME_SAMPLES);
            void pushRef.current({ pcm: new Uint8Array(frame.buffer) });
          }
          // 积压超过 1 秒说明主进程那边卡住了，丢掉旧的保证实时。
          if (micPending.current.length > CALL_RATE) micPending.current = new Float32Array(0);
        };
        source.connect(processor);
        processor.connect(context.destination);

        // 静音时响度归零
        interval = window.setInterval(() => {
          if (mutedRef.current) setLevel((prev) => prev * 0.5);
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
  }, [info.state]);

  // ── 铃声 ──
  useEffect(() => {
    if (info.state !== 'ringing' && info.state !== 'calling') return;
    const audio = new Audio('weq-asset://call/ringtone-caller.mp3');
    audio.loop = true;
    // 自动播放策略：发起通话一定来自用户点击，这条播放是被允许的。
    void audio.play().catch(() => {});
    return () => {
      audio.pause();
      audio.currentTime = 0;
    };
  }, [info.state]);

  const ringing = info.state === 'calling' || info.state === 'ringing';
  const live = info.state === 'connected';
  const finished = info.state === 'ended' || info.state === 'failed';

  // 结束后停留一会儿让用户看到结果
  useEffect(() => {
    if (!finished) return;
    const timer = window.setTimeout(onClose, 1600);
    return () => window.clearTimeout(timer);
  }, [finished, onClose]);

  const handleHangup = useCallback(() => {
    hangup.mutate();
  }, [hangup]);

  /**
   * 背景素材加载失败（URL 过期 / 网络不通）。
   *
   * 素材挂了就退回无背景的样子 —— 否则会露出一块没有压暗层的破图，
   * 白字直接压在杂色上，比没有背景更难看。
   */
  const [backdropFailed, setBackdropFailed] = useState(false);
  const hasBackdrop = !backdropFailed && Boolean(info.backgroundUrl || info.backgroundVideoUrl);

  const initialLetter = useMemo(
    () => (info.peerName || info.peerUin).slice(0, 1).toUpperCase(),
    [info.peerName, info.peerUin],
  );

  return (
    <div className="weq-call-backdrop" role="dialog" aria-modal="true" aria-label="语音通话">
      <div
        className={`weq-call-card${live ? ' is-live' : ''}${hasBackdrop ? ' has-backdrop' : ''}`}
        data-state={info.state}
      >
        {/* 个性化通话背景：视频优先（这类装扮本来就是动图），静帧兜底。 */}
        {hasBackdrop ? (
          <div className="weq-call-backdrop-media" aria-hidden="true">
            {info.backgroundVideoUrl && !backdropFailed ? (
              <video
                src={info.backgroundVideoUrl}
                autoPlay
                loop
                muted
                playsInline
                onError={() => setBackdropFailed(true)}
              />
            ) : info.backgroundUrl && !backdropFailed ? (
              <img src={info.backgroundUrl} alt="" onError={() => setBackdropFailed(true)} />
            ) : null}
          </div>
        ) : null}
        {/* 呼吸光环：接通后跟随对端响度 */}
        <div className="weq-call-halo" style={{ ['--peer-level' as string]: peerLevel }} />

        <div className="weq-call-avatar">
          {info.peerAvatar ? (
            <img src={info.peerAvatar} alt="" draggable={false} />
          ) : (
            <span className="weq-call-avatar-fallback">{initialLetter}</span>
          )}
        </div>

        <div className="weq-call-name">{info.peerName || info.peerUin}</div>
        <div className={`weq-call-status${live ? ' is-live' : ''}`}>
          {ringing ? <Loader2 size={14} className="weq-call-spin" /> : null}
          {live ? <PhoneIncoming size={14} /> : null}
          <span>{statusText(info)}</span>
        </div>

        {/* 波形：两排细柱，左本端右对端 */}
        <div className={`weq-call-wave${live ? ' is-visible' : ''}`} aria-hidden="true">
          {WAVE_BARS.map((shape, _index) => (
            <span
              key={`self-${shape}`}
              className="weq-call-wave-bar"
              style={{
                ['--bar' as string]: String(0.18 + shape * (0.25 + level * 0.9)),
              }}
            />
          ))}
          {WAVE_BARS.map((shape) => (
            <span
              key={`peer-${shape}`}
              className="weq-call-wave-bar is-peer"
              style={{
                ['--bar' as string]: String(0.18 + shape * (0.25 + peerLevel * 0.9)),
              }}
            />
          ))}
        </div>

        <div className="weq-call-actions">
          <button
            type="button"
            className={`weq-call-btn${muted ? ' is-off' : ''}`}
            onClick={() => setMuted((v) => !v)}
            disabled={finished}
            title={muted ? '取消静音' : '静音'}
            aria-pressed={muted}
          >
            {muted ? <MicOff size={22} /> : <Mic size={22} />}
          </button>

          <button
            type="button"
            className="weq-call-btn is-hangup"
            onClick={handleHangup}
            disabled={finished || hangup.isPending}
            title="挂断"
          >
            <PhoneOff size={26} />
          </button>

          <button
            type="button"
            className={`weq-call-btn${speakerOff ? ' is-off' : ''}`}
            onClick={() => setSpeakerOff((v) => !v)}
            disabled={finished}
            title={speakerOff ? '打开声音' : '关闭声音'}
            aria-pressed={speakerOff}
          >
            {speakerOff ? <VolumeX size={22} /> : <Volume2 size={22} />}
          </button>
        </div>

        {/* 链路细节：只在展开时显示，避免主界面堆字 */}
        <details className="weq-call-details">
          <summary>通话信息</summary>
          <dl>
            <div>
              <dt>房间</dt>
              <dd>{info.roomId ?? '—'}</dd>
            </div>
            <div>
              <dt>已发送</dt>
              <dd>{info.sentFrames} 帧</dd>
            </div>
            <div>
              <dt>已接收</dt>
              <dd>{info.receivedFrames} 帧</dd>
            </div>
          </dl>
        </details>

        {ringing ? <PhoneCall size={0} aria-hidden="true" /> : null}
      </div>
    </div>
  );
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
