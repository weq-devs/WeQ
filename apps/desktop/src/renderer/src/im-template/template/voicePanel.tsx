// @ts-nocheck
/**
 * 消息输入框内联的语音条：按住说话的录音键 + 横向声纹，外加文字转语音。
 *
 * 组件本身是**贴在输入框里**的（占掉正文编辑区那一行），不再是从输入框上沿弹出来的
 * 浮层 —— 位置样式见 composer-media.css 的 `@media (min-width: 761px)` 段。
 *
 * 录音走浏览器原生的 `getUserMedia` + `MediaRecorder`，声纹来自 `AnalyserNode`：
 * 每帧把频谱压成 {@link BAR_COUNT} 根柱子写进一个**固定数组**（原地写，不进 React
 * state），环形组件自己用 rAF 读这个数组直接改 DOM —— 60fps 下不触发任何 React
 * 重渲染，长按录音再久也不会掉帧。
 *
 * 面板本身不进浮层：收起不做按钮（没有外框也没有 ✕），再点一次工具栏那枚麦克风、
 * 或点到输入框外面就关掉它。
 *
 * 两处「配了才出现」的能力：
 *   - 语音转录（设置 → 语音配置里选了离线转录模型）：录音时顺带跑
 *     `SpeechRecognition`，松开就把识别文字带出来；回顾态里也能再转一次。
 *   - 文字转语音（配了 TTS 服务商）：另开一个页签，输入文字 → 合成语音 → 发送。
 *
 * 发送只把结果交给上层（`onSendVoice` / `onSendTranscript`），本模块不碰协议。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CircleStop,
  Loader2,
  Mic,
  Pause,
  Play,
  RotateCcw,
  SendHorizontal,
  Sparkles,
  Trash2,
  Type,
} from 'lucide-react';
import type { RefObject } from 'react';
import { cn } from './classNames';
import {
  createMediaId,
  formatClipDuration,
  releaseVoiceClip,
  type VoiceClip,
} from './composerMedia';

/** 环绕录音键的声纹柱子数量（360 / 56 ≈ 6.4°，密到看起来是连续的一圈）。 */
const BAR_COUNT = 56;

/** 每根柱子的角度。静态常量：柱子只按位置存在，顺便给它们一个稳定 key。 */
const RING_BARS = Array.from({ length: BAR_COUNT }, (_, index) => ({
  angle: (360 / BAR_COUNT) * index,
}));
/**
 * 环形半径（柱子根到圆心的距离，px）。
 *
 * 50 是跟舞台 126px、录音键 70px 一起算好的一组值：柱子最长时（scaleY 1.21，
 * 柱高 20px）外缘到半径 +12，整圈 124px，刚好盛在 126px 的舞台里，而且柱子收起时
 * 空出的内圈（直径 76px）还是比录音键大一圈，不会盖到按钮。
 */
const RING_RADIUS = 50;
const MAX_RECORD_MS = 60_000;
const MIN_RECORD_MS = 700;
const MAX_TTS_CHARS = 200;

type RecorderPhase = 'idle' | 'requesting' | 'recording' | 'review';

// ── SpeechRecognition（浏览器 API，TS 标准库里没有，这里给最小形状） ──────────

type SpeechAlternativeLike = { transcript: string };
type SpeechResultLike = {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechAlternativeLike;
};
type SpeechResultListLike = {
  length: number;
  [index: number]: SpeechResultLike;
};
type SpeechRecognitionEventLike = { resultIndex: number; results: SpeechResultListLike };
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
};
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

function recognitionErrorText(code: string | undefined): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return '麦克风或语音识别未授权';
    case 'no-speech':
      return '没有听到语音';
    case 'network':
      return '语音识别服务不可用（需要联网）';
    case 'aborted':
      return '';
    default:
      return '语音识别失败';
  }
}

function pickRecorderMime(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  if (typeof MediaRecorder === 'undefined') return '';
  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported?.(candidate)) return candidate;
  }
  return '';
}

function describeMicError(error: unknown): string {
  const name = (error as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return '麦克风权限被拒绝';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '没有找到麦克风';
  if (name === 'NotReadableError') return '麦克风被其它程序占用';
  return '无法开始录音';
}

/** 录音过程中的峰值采样是有上限的，超了按等距抽稀，画出来仍是整段形状。 */
function downsamplePeaks(peaks: number[], target = 48): number[] {
  if (peaks.length <= target) return peaks.slice();
  const out: number[] = [];
  for (let i = 0; i < target; i++) {
    const from = Math.floor((i / target) * peaks.length);
    const to = Math.max(from + 1, Math.floor(((i + 1) / target) * peaks.length));
    let peak = 0;
    for (let j = from; j < to; j++) peak = Math.max(peak, peaks[j] ?? 0);
    out.push(peak);
  }
  return out;
}

// ── 录音机 ───────────────────────────────────────────────────────────────────

function useVoiceRecorder({ canTranscribe }: { canTranscribe: boolean }) {
  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const [clip, setClip] = useState<VoiceClip | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState('');
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);

  // 声纹：一个**稳定引用**的定长数组，rAF 里原地写，环形组件直接读。
  const levelsRef = useRef<number[] | null>(null);
  if (!levelsRef.current) levelsRef.current = new Array(BAR_COUNT).fill(0);
  const levels = levelsRef.current;

  const phaseRef = useRef<RecorderPhase>('idle');
  const clipRef = useRef<VoiceClip | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const freqRef = useRef<Uint8Array | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const maxTimerRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const holdingRef = useRef(false);
  const wantStopRef = useRef(false);
  const discardRef = useRef(false);
  const peaksRef = useRef<number[]>([]);
  const lastPeakAtRef = useRef(0);
  const finalTranscriptRef = useRef('');
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const unmountedRef = useRef(false);

  const setPhaseSafe = useCallback((next: RecorderPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const cleanupAudio = useCallback(() => {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (maxTimerRef.current !== null) {
      window.clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
    analyserRef.current = null;
    freqRef.current = null;
    const ctx = ctxRef.current;
    ctxRef.current = null;
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {});
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) for (const track of stream.getTracks()) track.stop();
    if (levels) for (let i = 0; i < levels.length; i++) levels[i] = 0;
  }, [levels]);

  const stopRecognition = useCallback(() => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (!recognition) return;
    try {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.stop();
    } catch {}
  }, []);

  const startRecognition = useCallback(() => {
    if (!canTranscribe) return;
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    try {
      const recognition = new Ctor();
      recognitionRef.current = recognition;
      recognition.lang = 'zh-CN';
      recognition.continuous = true;
      recognition.interimResults = true;
      let finalText = '';
      recognition.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const text = result[0]?.transcript ?? '';
          if (result.isFinal) finalText += text;
          else interim += text;
        }
        finalTranscriptRef.current = finalText;
        setTranscript(`${finalText}${interim}`.trim());
      };
      // 边录边转是「顺带」的：环境不支持 / 没网时就安静地放弃，不要把红字糊到
      // 面板上（真正需要提示的是回顾态里手点的「转文字」）。
      recognition.onerror = () => {
        recognitionRef.current = null;
      };
      recognition.start();
    } catch {
      recognitionRef.current = null;
    }
  }, [canTranscribe]);

  const finalizeRecording = useCallback(() => {
    if (discardRef.current) {
      discardRef.current = false;
      chunksRef.current = [];
      return;
    }
    const duration = performance.now() - startedAtRef.current;
    const chunks = chunksRef.current;
    chunksRef.current = [];
    cleanupAudio();

    if (duration < MIN_RECORD_MS) {
      setElapsedMs(0);
      setPhaseSafe('idle');
      setError('说话时间太短，再按住久一点');
      return;
    }

    const blob = new Blob(chunks, { type: recorderRef.current?.mimeType || 'audio/webm' });
    const url = URL.createObjectURL(blob);
    const next: VoiceClip = {
      id: createMediaId('voice'),
      source: 'record',
      url,
      blob,
      durationMs: duration,
      levels: downsamplePeaks(peaksRef.current),
      transcript: finalTranscriptRef.current,
    };
    releaseVoiceClip(clipRef.current);
    clipRef.current = next;
    setClip(next);
    setTranscript(finalTranscriptRef.current);
    setElapsedMs(duration);
    setPhaseSafe('review');
  }, [cleanupAudio, setPhaseSafe]);

  const endRecord = useCallback(() => {
    holdingRef.current = false;
    stopRecognition();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {}
      return;
    }
    if (phaseRef.current === 'requesting') {
      wantStopRef.current = true;
    }
  }, [stopRecognition]);

  const tick = useCallback(() => {
    rafRef.current = window.requestAnimationFrame(tick);
    const analyser = analyserRef.current;
    const data = freqRef.current;
    if (!analyser || !data || !levels) return;
    analyser.getByteFrequencyData(data);
    const usable = Math.max(1, Math.floor(data.length * 0.72));
    let sum = 0;
    for (let i = 0; i < BAR_COUNT; i++) {
      // 低频信息多、高频信息少，用幂函数拉开带宽，否则整圈柱子会挤在左侧。
      const ratio = (i / Math.max(1, BAR_COUNT - 1)) ** 1.5;
      const index = Math.min(usable - 1, Math.floor(ratio * usable));
      const value = (data[index] ?? 0) / 255;
      levels[i] = levels[i] * 0.55 + value * 0.45;
      sum += value;
    }
    const now = performance.now();
    if (now - lastPeakAtRef.current > 90) {
      lastPeakAtRef.current = now;
      const peaks = peaksRef.current;
      if (peaks.length < 600) peaks.push(Math.min(1, (sum / BAR_COUNT) * 1.7));
    }
  }, [levels]);

  const beginRecord = useCallback(async () => {
    if (phaseRef.current === 'recording' || phaseRef.current === 'requesting') return;
    discardRef.current = false;
    wantStopRef.current = false;
    holdingRef.current = true;
    finalTranscriptRef.current = '';
    peaksRef.current = [];
    setError(null);
    setTranscribeError(null);
    setTranscript('');
    releaseVoiceClip(clipRef.current);
    clipRef.current = null;
    setClip(null);
    setElapsedMs(0);
    setPhaseSafe('requesting');

    if (!navigator.mediaDevices?.getUserMedia) {
      holdingRef.current = false;
      setPhaseSafe('idle');
      setError('当前环境不支持录音');
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      holdingRef.current = false;
      setPhaseSafe('idle');
      setError(describeMicError(err));
      return;
    }

    if (unmountedRef.current || !holdingRef.current) {
      for (const track of stream.getTracks()) track.stop();
      setPhaseSafe('idle');
      return;
    }

    streamRef.current = stream;

    const AudioCtor = window.AudioContext ?? window.webkitAudioContext;
    if (AudioCtor) {
      try {
        const ctx = new AudioCtor();
        await ctx.resume();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.78;
        ctx.createMediaStreamSource(stream).connect(analyser);
        ctxRef.current = ctx;
        analyserRef.current = analyser;
        freqRef.current = new Uint8Array(analyser.frequencyBinCount);
      } catch {
        // 画不出声纹也要能录 —— 声纹只是装饰。
      }
    }

    const mime = pickRecorderMime();
    let recorder: MediaRecorder;
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch {
      cleanupAudio();
      holdingRef.current = false;
      setPhaseSafe('idle');
      setError('开始录音失败');
      return;
    }

    recorderRef.current = recorder;
    chunksRef.current = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = finalizeRecording;
    recorder.onerror = () => {
      cleanupAudio();
      holdingRef.current = false;
      setPhaseSafe('idle');
      setError('录音出错');
    };

    startedAtRef.current = performance.now();
    try {
      recorder.start(120);
    } catch {
      cleanupAudio();
      holdingRef.current = false;
      setPhaseSafe('idle');
      setError('开始录音失败');
      return;
    }

    setPhaseSafe('recording');
    rafRef.current = window.requestAnimationFrame(tick);
    timerRef.current = window.setInterval(() => {
      setElapsedMs(performance.now() - startedAtRef.current);
    }, 100);
    maxTimerRef.current = window.setTimeout(() => endRecord(), MAX_RECORD_MS);
    startRecognition();
    if (wantStopRef.current) endRecord();
  }, [cleanupAudio, endRecord, finalizeRecording, setPhaseSafe, startRecognition, tick]);

  const discard = useCallback(() => {
    holdingRef.current = false;
    discardRef.current = true;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {}
    }
    stopRecognition();
    cleanupAudio();
    releaseVoiceClip(clipRef.current);
    clipRef.current = null;
    setClip(null);
    setTranscript('');
    setTranscribeError(null);
    setError(null);
    setElapsedMs(0);
    setPlaying(false);
    setPhaseSafe('idle');
  }, [cleanupAudio, setPhaseSafe, stopRecognition]);

  const ensureAudio = useCallback(() => {
    let audio = audioRef.current;
    if (!audio) {
      audio = new Audio();
      audioRef.current = audio;
    }
    return audio;
  }, []);

  const stopPlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.onended = null;
    audio.pause();
    setPlaying(false);
  }, []);

  const togglePlay = useCallback(() => {
    const current = clipRef.current;
    if (!current?.url) return;
    const audio = ensureAudio();
    if (audio.src !== current.url) {
      audio.src = current.url;
      audio.currentTime = 0;
    }
    audio.onended = () => setPlaying(false);
    audio.onpause = () => setPlaying(false);
    audio.onplay = () => setPlaying(true);
    if (audio.paused) void audio.play().catch(() => setPlaying(false));
    else audio.pause();
  }, [ensureAudio]);

  /** 回顾态「转文字」：一边播放录音一边跑识别（本机扬声器 → 麦克风回环）。 */
  const transcribeClip = useCallback(async () => {
    const current = clipRef.current;
    if (!current || transcribing) return;
    if (current.source === 'tts') {
      setTranscript(current.text ?? '');
      return;
    }
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setTranscribeError('当前环境不支持语音识别');
      return;
    }
    setTranscribing(true);
    setTranscribeError(null);
    stopPlayback();

    const audio = ensureAudio();
    if (audio.src !== current.url) audio.src = current.url ?? '';
    audio.currentTime = 0;

    let recognition: SpeechRecognitionLike;
    try {
      recognition = new Ctor();
    } catch {
      setTranscribing(false);
      setTranscribeError('当前环境不支持语音识别');
      return;
    }
    recognitionRef.current = recognition;
    recognition.lang = 'zh-CN';
    recognition.continuous = true;
    recognition.interimResults = true;
    let finalText = '';
    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? '';
        if (result.isFinal) finalText += text;
        else interim += text;
      }
      setTranscript(`${finalText}${interim}`.trim());
    };
    recognition.onerror = (event) => {
      const message = recognitionErrorText(event.error);
      if (message) setTranscribeError(message);
      setTranscribing(false);
      stopPlayback();
    };

    try {
      recognition.start();
    } catch {
      setTranscribing(false);
      setTranscribeError('语音识别启动失败');
      return;
    }

    audio.onended = () => {
      try {
        recognition.stop();
      } catch {}
      setTranscribing(false);
      setPlaying(false);
    };
    try {
      await audio.play();
    } catch {
      try {
        recognition.stop();
      } catch {}
      setTranscribing(false);
      setTranscribeError('无法播放录音，转写中断');
    }
  }, [ensureAudio, stopPlayback, transcribing]);

  /** 文字合成的结果塞进同一条回顾流程。 */
  const loadExternalClip = useCallback(
    (next: VoiceClip) => {
      releaseVoiceClip(clipRef.current);
      clipRef.current = next;
      setClip(next);
      setTranscript(next.transcript);
      setTranscribeError(null);
      setError(null);
      setElapsedMs(next.durationMs);
      setPhaseSafe('review');
    },
    [setPhaseSafe],
  );

  useEffect(() => {
    // 挂载（含 StrictMode 的模拟重挂载）时都要把「已卸载」标记清掉 —— 它只写在
    // cleanup 里、effect 主体里不复位的话，StrictMode 下第一次模拟卸载就会把它永久
    // 置 true，之后每次 beginRecord 都会在 getUserMedia 返回后直接放弃：表现就是
    // 「一按就断、不到一秒自己回到待机」。
    unmountedRef.current = false;
    discardRef.current = false;

    return () => {
      unmountedRef.current = true;
      discardRef.current = true;
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {}
      }
      stopRecognition();
      cleanupAudio();
      releaseVoiceClip(clipRef.current);
      const audio = audioRef.current;
      if (audio) {
        audio.onended = null;
        audio.pause();
      }
    };
  }, [cleanupAudio, stopRecognition]);

  return {
    phase,
    levels,
    clip,
    elapsedMs,
    error,
    transcript,
    transcribing,
    transcribeError,
    playing,
    beginRecord,
    endRecord,
    discard,
    togglePlay,
    transcribeClip,
    loadExternalClip,
    setTranscript,
  };
}

// ── 声纹 ─────────────────────────────────────────────────────────────────────

/**
 * 环绕录音键的一圈声纹。自己跑 rAF 直接改每根柱子的 transform/opacity，
 * 不经过 React 渲染 —— 每帧只做 {@link BAR_COUNT} 次样式写入。
 */
function VoiceWaveRing({ levels, active }: { levels: number[]; active: boolean }) {
  const barRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    let frame = 0;
    let phase = 0;
    const step = () => {
      frame = window.requestAnimationFrame(step);
      phase += 0.06;
      const bars = barRefs.current;
      const flow = Math.floor(phase);
      for (let i = 0; i < bars.length; i++) {
        const bar = bars[i];
        if (!bar) continue;
        const angle = (360 / BAR_COUNT) * i;
        let value: number;
        if (activeRef.current) {
          value = levels[(i + flow) % levels.length] ?? 0;
        } else {
          // 待机：极轻的呼吸，让面板不显得僵。
          value = 0.09 + 0.05 * Math.sin(phase * 1.6 + i * 0.55);
        }
        const scale = 0.16 + Math.min(1, value) * 1.05;
        bar.style.transform = `rotate(${angle}deg) translateY(-${RING_RADIUS}px) scaleY(${scale})`;
        bar.style.opacity = `${0.3 + Math.min(1, value) * 0.7}`;
      }
    };
    frame = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(frame);
  }, [levels]);

  return (
    <div className={cn('voice-ring')} aria-hidden="true">
      {RING_BARS.map((bar, index) => (
        <span
          key={bar.angle}
          ref={(node) => {
            barRefs.current[index] = node;
          }}
        />
      ))}
    </div>
  );
}

/** 回顾态的静态声纹（按峰值归一化，小声录的也能看清形状）。 */
function VoiceReviewWave({ levels }: { levels: number[] }) {
  const bars = useMemo(() => {
    const source = levels.length > 0 ? levels : [0.18, 0.42, 0.7, 0.3, 0.55];
    const peak = Math.max(0.12, ...source);
    return source.map((value, index) => ({
      // 柱子只按位置存在：key 由位置派生，而不是直接把 map 的下标丢进 key。
      id: `peak-${index}`,
      height: `${Math.max(10, (value / peak) * 100)}%`,
    }));
  }, [levels]);
  return (
    <div className={cn('voice-review-wave')} aria-hidden="true">
      {bars.map((bar) => (
        <i key={bar.id} style={{ height: bar.height }} />
      ))}
    </div>
  );
}

// ── 面板 ─────────────────────────────────────────────────────────────────────

export function VoicePanel({
  panelRef,
  canSend,
  sendHint,
  transcribeEnabled,
  ttsEnabled,
  ttsProviderCount,
  onSendVoice,
  onSendTranscript,
  onBusyChange,
}: {
  panelRef: RefObject<HTMLDivElement | null>;
  /** 是否可以发送（QQ 在线且允许注入）。 */
  canSend: boolean;
  sendHint: string;
  /** 设置里选了离线转录模型。 */
  transcribeEnabled: boolean;
  /** 设置里配了 TTS 服务商。 */
  ttsEnabled: boolean;
  ttsProviderCount: number;
  onSendVoice: (clip: VoiceClip) => void;
  onSendTranscript: (text: string) => void;
  /** 收起不做按钮：这个面板是内嵌在输入框里的，再点一次工具栏那枚麦克风就行。 */
  onBusyChange: (busy: boolean) => void;
}) {
  const [tab, setTab] = useState<'record' | 'tts'>('record');
  const recorder = useVoiceRecorder({ canTranscribe: transcribeEnabled });
  const { phase, beginRecord, endRecord, discard } = recorder;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const busy = phase === 'recording' || phase === 'requesting';

  // 面板自己抢焦点，这样空格长按不会落进正文（正文聚焦时空格就是打字）。
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);

  // 空格长按 = 按住说话；松开即停。正文 / 输入框聚焦时不抢。
  useEffect(() => {
    if (tab !== 'record') return;

    function isTypingTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      if (target.isContentEditable) return true;
      const tag = target.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA';
    }

    function onKeyDown(event: KeyboardEvent) {
      if (
        event.code !== 'Space' ||
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }
      if (isTypingTarget(event.target)) return;
      if (phase === 'recording' || phase === 'requesting') return;
      event.preventDefault();
      void beginRecord();
    }

    function onKeyUp(event: KeyboardEvent) {
      if (event.code !== 'Space' || isTypingTarget(event.target)) return;
      event.preventDefault();
      endRecord();
    }

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
    };
  }, [beginRecord, endRecord, phase, tab]);

  // 录音期间的「松手」在 window 上听：录音键在录音中会重渲染（换图标 / 计时器），
  // 挂在按钮上的 onPointerUp 一旦丢了捕获就收不到 —— 表现就是「按住了却自己断掉」。
  // window 级监听不依赖捕获，鼠标移出按钮也照样能停。
  // 只听 pointer，不听 window 的 blur：第一次录音会弹麦克风授权，窗口失焦不该把
  // 这条正在录的语音掐掉。
  useEffect(() => {
    if (phase !== 'recording' && phase !== 'requesting') return;

    const stop = () => endRecord();
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [endRecord, phase]);

  // 切到合成页签时把正在录的那条收干净。
  useEffect(() => {
    if (tab === 'tts' && (phase === 'recording' || phase === 'requesting')) discard();
  }, [discard, phase, tab]);

  return (
    <div
      className={cn('voice-panel')}
      ref={(node) => {
        rootRef.current = node;
        if (panelRef) panelRef.current = node;
      }}
      tabIndex={-1}
      aria-label="语音"
    >
      {/* 头部只在真的有两个页签（配了 TTS）时才出现：平时这一栏（标题 / 按住说话
          的提示）整条都不渲染，录音界面就是光秃秃一个声纹环，彻底看成输入框的一部分。 */}
      {ttsEnabled ? (
        <header className={cn('voice-panel-head')}>
          <div className={cn('voice-panel-tabs')}>
            <button
              type="button"
              className={cn(tab === 'record' && 'active')}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setTab('record')}
            >
              <Mic size={13} /> 录音
            </button>
            <button
              type="button"
              className={cn(tab === 'tts' && 'active')}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setTab('tts')}
            >
              <Type size={13} /> 文字转语音
            </button>
          </div>
        </header>
      ) : null}

      <div className={cn('voice-panel-body')}>
        {tab === 'tts' ? (
          <TtsComposer
            providerCount={ttsProviderCount}
            canSend={canSend}
            sendHint={sendHint}
            onSendVoice={onSendVoice}
          />
        ) : phase === 'review' && recorder.clip ? (
          <VoiceReview
            clip={recorder.clip}
            transcript={recorder.transcript}
            transcribing={recorder.transcribing}
            transcribeError={recorder.transcribeError}
            playing={recorder.playing}
            transcribeEnabled={transcribeEnabled}
            canSend={canSend}
            sendHint={sendHint}
            onTogglePlay={recorder.togglePlay}
            onTranscribe={recorder.transcribeClip}
            onTranscriptChange={recorder.setTranscript}
            onDiscard={recorder.discard}
            onSendVoice={() => onSendVoice({ ...recorder.clip, transcript: recorder.transcript })}
            onSendTranscript={() => onSendTranscript(recorder.transcript.trim())}
          />
        ) : (
          <div className={cn('voice-stage')}>
            <div className={cn('voice-pulse', busy && 'active')} aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <VoiceWaveRing levels={recorder.levels} active={phase === 'recording'} />
            <button
              type="button"
              className={cn(
                'voice-record-btn',
                busy && 'is-recording',
                phase === 'requesting' && 'is-waiting',
                recorder.error && 'is-error',
              )}
              title="按住说话（也可以长按空格）"
              aria-label="按住说话"
              onKeyDown={(event) => {
                if (event.code === 'Space' || event.key === 'Enter') event.preventDefault();
              }}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                void beginRecord();
              }}
              onPointerUp={(event) => {
                event.preventDefault();
                endRecord();
              }}
              onContextMenu={(event) => event.preventDefault()}
            >
              {phase === 'requesting' ? (
                <Loader2 size={22} className={cn('voice-spin')} />
              ) : busy ? (
                <CircleStop size={22} />
              ) : (
                <Mic size={22} />
              )}
              <strong>
                {phase === 'requesting' ? '正在打开麦克风…' : busy ? '松开结束' : '按住说话'}
              </strong>
              {busy ? (
                <em className={cn('voice-record-timer')}>
                  {formatClipDuration(recorder.elapsedMs)}
                </em>
              ) : null}
            </button>
          </div>
        )}

        {tab === 'record' ? (
          <div className={cn('voice-panel-foot')}>
            <span className={cn('voice-hint')}>
              <kbd>空格</kbd> 长按录音 · 最长 60 秒
            </span>
            {recorder.error ? <span className={cn('voice-error')}>{recorder.error}</span> : null}
            {!recorder.error && recorder.transcribeError && !busy ? (
              <span className={cn('voice-error')}>{recorder.transcribeError}</span>
            ) : null}
            {!recorder.error && !recorder.transcribeError && transcribeEnabled && busy ? (
              <span className={cn('voice-hint ok')}>
                <Sparkles size={12} /> 正在转文字…
              </span>
            ) : null}
            {!recorder.error && !recorder.transcribeError && !transcribeEnabled && !busy ? (
              <span className={cn('voice-hint dim')}>未配置转录模型，仅发送语音</span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── 回顾 ─────────────────────────────────────────────────────────────────────

function VoiceReview({
  clip,
  transcript,
  transcribing,
  transcribeError,
  playing,
  transcribeEnabled,
  canSend,
  sendHint,
  onTogglePlay,
  onTranscribe,
  onTranscriptChange,
  onDiscard,
  onSendVoice,
  onSendTranscript,
}: {
  clip: VoiceClip;
  transcript: string;
  transcribing: boolean;
  transcribeError: string | null;
  playing: boolean;
  transcribeEnabled: boolean;
  canSend: boolean;
  sendHint: string;
  onTogglePlay: () => void;
  onTranscribe: () => void;
  onTranscriptChange: (text: string) => void;
  onDiscard: () => void;
  onSendVoice: () => void;
  onSendTranscript: () => void;
}) {
  const trimmed = transcript.trim();
  return (
    <div className={cn('voice-review')}>
      <div className={cn('voice-review-head')}>
        <button
          type="button"
          className={cn('voice-review-play', playing && 'is-playing')}
          title={playing ? '暂停' : '试听'}
          aria-label={playing ? '暂停' : '试听'}
          onClick={onTogglePlay}
        >
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <VoiceReviewWave levels={clip.levels} />
        <span className={cn('voice-review-time')}>{formatClipDuration(clip.durationMs)}</span>
        <span className={cn('voice-review-tag')}>
          {clip.source === 'tts' ? '合成语音' : '录音'}
        </span>
      </div>

      {clip.source === 'tts' && clip.text ? (
        <p className={cn('voice-review-text')}>{clip.text}</p>
      ) : null}

      {transcribeEnabled ? (
        trimmed || transcribing || transcribeError ? (
          <div className={cn('voice-transcript-card', transcribeError && 'is-error')}>
            <div className={cn('voice-transcript-head')}>
              <span>
                {transcribeError ? (
                  transcribeError
                ) : (
                  <>
                    <Sparkles size={12} /> 转文字
                  </>
                )}
              </span>
              {transcribing ? (
                <em>
                  <Loader2 size={12} className={cn('voice-spin')} /> 识别中
                </em>
              ) : null}
            </div>
            {!transcribeError && clip.source !== 'tts' ? (
              <textarea
                value={transcript}
                rows={2}
                placeholder="识别结果可编辑后再发送"
                onChange={(event) => onTranscriptChange(event.target.value)}
              />
            ) : null}
          </div>
        ) : (
          <button
            type="button"
            className={cn('voice-transcribe-btn')}
            title="播放录音并同步识别（需扬声器外放）"
            disabled={transcribing}
            onClick={onTranscribe}
          >
            {transcribing ? (
              <Loader2 size={14} className={cn('voice-spin')} />
            ) : (
              <Sparkles size={14} />
            )}
            <span>{transcribing ? '转写中…' : '转文字'}</span>
          </button>
        )
      ) : null}

      <div className={cn('voice-review-actions')}>
        <button type="button" className={cn('voice-btn ghost')} onClick={onDiscard}>
          <Trash2 size={14} /> 删除
        </button>
        {trimmed ? (
          <button
            type="button"
            className={cn('voice-btn ghost')}
            title={canSend ? '只发这段文字' : sendHint}
            disabled={!canSend}
            onClick={onSendTranscript}
          >
            <Type size={14} /> 发送文字
          </button>
        ) : null}
        <button
          type="button"
          className={cn('voice-btn primary')}
          title={canSend ? '发送这条语音' : sendHint}
          disabled={!canSend}
          onClick={onSendVoice}
        >
          <SendHorizontal size={14} /> 发送语音
        </button>
      </div>
    </div>
  );
}

// ── 文字转语音 ───────────────────────────────────────────────────────────────

function TtsComposer({
  providerCount,
  canSend,
  sendHint,
  onSendVoice,
}: {
  providerCount: number;
  canSend: boolean;
  sendHint: string;
  onSendVoice: (clip: VoiceClip) => void;
}) {
  const [text, setText] = useState('');
  const [voiceName, setVoiceName] = useState('');
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const read = () => {
      const list = synth.getVoices();
      const zh = list.filter((voice) => voice.lang?.toLowerCase().startsWith('zh'));
      const rest = list.filter((voice) => !voice.lang?.toLowerCase().startsWith('zh'));
      setVoices([...zh, ...rest]);
    };
    read();
    synth.addEventListener?.('voiceschanged', read);
    return () => {
      synth.removeEventListener?.('voiceschanged', read);
      synth.cancel();
    };
  }, []);

  useEffect(() => {
    if (voiceName && voices.some((voice) => voice.name === voiceName)) return;
    setVoiceName(voices[0]?.name ?? '');
  }, [voiceName, voices]);

  const body = text.trim();
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;

  function speak(onDone?: () => void) {
    if (!synth || !body) return;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(body);
    const voice = voices.find((item) => item.name === voiceName);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    } else {
      utterance.lang = 'zh-CN';
    }
    utterance.rate = 1;
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => {
      setSpeaking(false);
      onDone?.();
    };
    utterance.onerror = () => {
      setSpeaking(false);
      setError('语音合成失败，换一个发音人试试');
    };
    setError(null);
    synth.speak(utterance);
  }

  function handlePreview() {
    // 正在读的时候再点一次就是停，别把同一句叠着念。
    if (speaking && synth) {
      synth.cancel();
      setSpeaking(false);
      return;
    }
    speak();
  }

  function handleSend() {
    if (!body) return;
    // 合成完成即发送：先把这条语音播出来，同时构造一条 TTS 语音交给上层。
    speak();
    onSendVoice({
      id: createMediaId('tts'),
      source: 'tts',
      url: null,
      blob: null,
      // 中文按 ~4.2 字/秒估时长，只用来画语音条长度。
      durationMs: Math.max(1200, (body.length / 4.2) * 1000),
      levels: [],
      transcript: body,
      text: body,
    });
  }

  return (
    <div className={cn('voice-tts')}>
      <div className={cn('voice-tts-note')}>
        <Sparkles size={13} />
        <span>
          已配置 {providerCount} 个 TTS 服务商；此处用本机发音人合成，试听后发送该条语音。
        </span>
      </div>
      <textarea
        className={cn('voice-tts-input')}
        rows={3}
        value={text}
        maxLength={MAX_TTS_CHARS}
        placeholder="输入要合成语音的文字，例如：在吗？我马上到。"
        onChange={(event) => setText(event.target.value)}
      />
      <div className={cn('voice-tts-row')}>
        <label className={cn('voice-tts-voice')}>
          <span>发音人</span>
          <select
            value={voiceName}
            onChange={(event) => setVoiceName(event.target.value)}
            disabled={voices.length === 0}
          >
            {voices.length === 0 ? <option value="">本机默认发音人</option> : null}
            {voices.map((voice) => (
              <option key={voice.name} value={voice.name}>
                {voice.name}
                {voice.lang ? `（${voice.lang}）` : ''}
              </option>
            ))}
          </select>
        </label>
        <span className={cn('voice-tts-count')}>
          {text.length}/{MAX_TTS_CHARS}
        </span>
      </div>
      {error ? <span className={cn('voice-error')}>{error}</span> : null}
      <div className={cn('voice-review-actions')}>
        <button
          type="button"
          className={cn('voice-btn ghost')}
          disabled={!body || !synth}
          onClick={handlePreview}
        >
          {speaking ? <Pause size={14} /> : <RotateCcw size={14} />}
          {speaking ? '停止' : '试听'}
        </button>
        <button
          type="button"
          className={cn('voice-btn primary')}
          title={canSend ? '合成并发送' : sendHint}
          disabled={!body || !synth || !canSend}
          onClick={handleSend}
        >
          <SendHorizontal size={14} /> 合成并发送
        </button>
      </div>
    </div>
  );
}
