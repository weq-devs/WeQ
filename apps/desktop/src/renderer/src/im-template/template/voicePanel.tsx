// @ts-nocheck
/** 输入区语音模式，包含录音、TTS 和群聊 AI 声聊。 */

import { observeCompactToolbar, ToolbarLabel } from '../../components/CompactToolbar';
import { AiVoiceControls, type AiVoiceDraft } from './aiVoicePanel';
import { FormSelect } from '../../components/FormSelect';
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { client } from '../../trpc/client';
import type { TranscribeResult } from '../../../../main/transcribe/engine';
import { useTabActive } from '../../components/RetainedTabs.shared';
import { PagesContext } from '../../components/WorkspacePages.shared';
import {
  Captions,
  FileAudio,
  Loader2,
  Mic,
  Pause,
  Play,
  SendHorizontal,
  Sparkles,
  Trash2,
  Type,
  Wand2,
  X,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from './classNames';
import { voiceModeContext } from './voicePanel.shared';
import { pcm16Samples, startRemoteMedia, needsNativeRemoteMedia } from '../../lib/remoteMedia';
import {
  decodeAudio,
  decodeRecordingToWav,
  decodeRecordingsToWav,
  encodePcmWav,
} from './composerSend';
import { topSurface } from '../../lib/surfaceEscape';
import {
  createMediaId,
  formatClipDuration,
  releaseVoiceClip,
  type VoiceClip,
} from './composerMedia';

const BAR_COUNT = 56;
const MAX_RECORD_MS = 60_000;
const MIN_RECORD_MS = 700;
const MAX_TTS_CHARS = 200;

type RecorderPhase = 'idle' | 'requesting' | 'recording' | 'paused' | 'finalizing' | 'review';
type SettledRecorderPhase = Exclude<RecorderPhase, 'requesting' | 'finalizing'>;
type StopTarget = 'paused' | 'review';

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
function downsamplePeaks(peaks: number[], target = BAR_COUNT): number[] {
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

function useVoiceRecorder() {
  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const [settledPhase, setSettledPhase] = useState<SettledRecorderPhase>('idle');
  const [clip, setClip] = useState<VoiceClip | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState('');
  const [transcriptReady, setTranscriptReady] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playbackMs, setPlaybackMs] = useState(0);
  const [playbackDurationMs, setPlaybackDurationMs] = useState(0);

  // 定长的音量历史，最新一条从右侧进入。
  const levelsRef = useRef<number[] | null>(null);
  if (!levelsRef.current) levelsRef.current = new Array(BAR_COUNT).fill(0);
  const levels = levelsRef.current;
  const waveListeners = useRef(new Set<() => void>());
  const subscribeWave = useCallback((listener: () => void) => {
    waveListeners.current.add(listener);
    return () => {
      waveListeners.current.delete(listener);
    };
  }, []);

  const phaseRef = useRef<RecorderPhase>('idle');
  const clipRef = useRef<VoiceClip | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const timeDomainRef = useRef<Uint8Array | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const nativeStopRef = useRef<(() => void) | null>(null);
  const nativeControllerRef = useRef<AbortController | null>(null);
  const nativeSamplesRef = useRef<Float32Array[]>([]);
  const nativeSampleCountRef = useRef(0);
  const levelTimerRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const maxTimerRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const captureRequestRef = useRef<symbol | null>(null);
  const stopTargetRef = useRef<StopTarget>('review');
  const segmentDurationRef = useRef<number | null>(null);
  const segmentsRef = useRef<Blob[]>([]);
  const preparedSegmentsRef = useRef<Blob[] | null>(null);
  const importedAudioRef = useRef(false);
  const completedDurationRef = useRef(0);
  const peaksRef = useRef<number[]>([]);
  const lastPeakAtRef = useRef(0);
  const transcriptionRef = useRef<AbortController | null>(null);
  const transcriptDraft = useRef<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const unmountedRef = useRef(false);

  const setPhaseSafe = useCallback((next: RecorderPhase) => {
    phaseRef.current = next;
    setPhase(next);
    // 开麦、整理录音期间保留当前画面，准备就绪后再切换波形和控件。
    if (next !== 'requesting' && next !== 'finalizing') setSettledPhase(next);
  }, []);

  const cleanupAudio = useCallback(() => {
    captureRequestRef.current = null;
    nativeStopRef.current?.();
    nativeStopRef.current = null;
    nativeControllerRef.current?.abort();
    nativeControllerRef.current = null;
    nativeSamplesRef.current = [];
    nativeSampleCountRef.current = 0;
    if (levelTimerRef.current !== null) {
      window.clearInterval(levelTimerRef.current);
      levelTimerRef.current = null;
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
    timeDomainRef.current = null;
    const ctx = ctxRef.current;
    ctxRef.current = null;
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {});
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) for (const track of stream.getTracks()) track.stop();
  }, []);

  const publishClip = useCallback((blob: Blob, durationMs: number) => {
    const next: VoiceClip = {
      id: createMediaId('voice'),
      source: 'record',
      url: URL.createObjectURL(blob),
      blob,
      durationMs,
      levels: downsamplePeaks(peaksRef.current),
      transcript: '',
    };
    audioRef.current?.pause();
    releaseVoiceClip(clipRef.current);
    clipRef.current = next;
    preparedSegmentsRef.current = segmentsRef.current;
    setClip(next);
    setPlaying(false);
    setPlaybackMs(0);
    setPlaybackDurationMs(durationMs);
  }, []);

  const importAudio = useCallback(
    async (file: File) => {
      if (phaseRef.current !== 'idle') return;
      if (!file.size) {
        setError('音频文件为空');
        return;
      }
      const segments = segmentsRef.current;
      setError(null);
      setPhaseSafe('finalizing');
      try {
        const bytes = await file.arrayBuffer();
        const blob = new Blob([bytes], { type: file.type });
        const audio = await decodeAudio(bytes);
        if (unmountedRef.current || segmentsRef.current !== segments) return;
        if (!Number.isFinite(audio.duration) || audio.duration <= 0) throw new Error();
        const duration = audio.duration * 1000;
        segmentsRef.current = [blob];
        importedAudioRef.current = true;
        completedDurationRef.current = duration;
        peaksRef.current = [];
        levels.fill(0);
        setElapsedMs(duration);
        publishClip(blob, duration);
        setPhaseSafe('paused');
      } catch {
        if (unmountedRef.current || segmentsRef.current !== segments) return;
        setError('无法读取此音频，请选择可播放的音频文件');
        setPhaseSafe('idle');
      }
    },
    [levels, publishClip, setPhaseSafe],
  );

  const prepareRecording = useCallback(
    async (target: StopTarget) => {
      const segments = segmentsRef.current;
      const duration = completedDurationRef.current;
      if (!segments.length) {
        setPhaseSafe('idle');
        if (target === 'review') setError('录音太短，请录久一点再结束');
        return;
      }
      const tooShort = target === 'review' && !importedAudioRef.current && duration < MIN_RECORD_MS;
      const nextPhase = tooShort ? 'paused' : target;
      setError(tooShort ? '录音太短，请录久一点再结束' : null);
      if (preparedSegmentsRef.current === segments && clipRef.current) {
        setPhaseSafe(nextPhase);
        return;
      }
      setPhaseSafe('finalizing');
      try {
        let blob = segments[0];
        if (segments.length > 1) {
          const recordings = await Promise.all(
            segments.map(async (part) => new Uint8Array(await part.arrayBuffer())),
          );
          const wav = await decodeRecordingsToWav(recordings);
          blob = new Blob([wav], { type: 'audio/wav' });
        }
        if (unmountedRef.current || segmentsRef.current !== segments) return;
        publishClip(blob, duration);
        setPhaseSafe(nextPhase);
      } catch (error) {
        if (unmountedRef.current || segmentsRef.current !== segments) return;
        setError(error instanceof Error ? error.message : '录音拼接失败');
        setPhaseSafe('paused');
      }
    },
    [publishClip, setPhaseSafe],
  );

  const completeSegment = useCallback(
    (blob: Blob) => {
      const duration = segmentDurationRef.current ?? performance.now() - startedAtRef.current;
      const target = stopTargetRef.current;
      chunksRef.current = [];
      cleanupAudio();
      if (blob.size) {
        segmentsRef.current = [...segmentsRef.current, blob];
        completedDurationRef.current = Math.min(
          MAX_RECORD_MS,
          completedDurationRef.current + duration,
        );
      }
      setElapsedMs(completedDurationRef.current);
      void prepareRecording(target);
    },
    [cleanupAudio, prepareRecording],
  );

  const stopCapture = useCallback(
    (target: StopTarget) => {
      const phase = phaseRef.current;
      if (phase === 'requesting') {
        cleanupAudio();
        setPhaseSafe(segmentsRef.current.length ? 'paused' : 'idle');
        return;
      }
      if (phase === 'paused' && target === 'review') {
        void prepareRecording('review');
        return;
      }
      if (phase !== 'recording') return;
      stopTargetRef.current = target;
      segmentDurationRef.current = performance.now() - startedAtRef.current;
      setPhaseSafe('finalizing');
      if (nativeStopRef.current) {
        const parts = nativeSamplesRef.current;
        const samples = new Float32Array(nativeSampleCountRef.current);
        let offset = 0;
        for (const part of parts) {
          samples.set(part, offset);
          offset += part.length;
        }
        completeSegment(
          samples.length
            ? new Blob([encodePcmWav(samples, 16000)], { type: 'audio/wav' })
            : new Blob(),
        );
        return;
      }
      const recorder = recorderRef.current;
      if (recorder?.state !== 'inactive') recorder?.stop();
    },
    [cleanupAudio, completeSegment, prepareRecording, setPhaseSafe],
  );

  const endRecord = useCallback(() => stopCapture('review'), [stopCapture]);
  const pauseRecord = useCallback(() => stopCapture('paused'), [stopCapture]);
  const releaseHeldRecord = useCallback(() => {
    if (phaseRef.current === 'recording' || phaseRef.current === 'requesting') endRecord();
  }, [endRecord]);

  const appendLevel = useCallback(
    (size: number) => {
      const level = Math.min(1, size * 3);
      levels.copyWithin(0, 1);
      levels[levels.length - 1] = level;
      peaksRef.current.push(level);
      for (const listener of waveListeners.current) listener();
    },
    [levels],
  );

  const tick = useCallback(() => {
    if (phaseRef.current !== 'recording') return;
    const analyser = analyserRef.current;
    const data = timeDomainRef.current;
    if (!analyser || !data) return;
    analyser.getByteTimeDomainData(data);
    let power = 0;
    for (const sample of data) power += ((sample - 128) / 128) ** 2;
    appendLevel(Math.sqrt(power / data.length));
  }, [appendLevel]);

  const beginRecord = useCallback(async () => {
    const phase = phaseRef.current;
    if (phase !== 'idle' && phase !== 'paused' && phase !== 'review') return;
    if (
      transcriptReady ||
      transcriptionRef.current ||
      completedDurationRef.current >= MAX_RECORD_MS
    )
      return;
    const request = Symbol('microphone');
    captureRequestRef.current = request;
    const current = () => !unmountedRef.current && captureRequestRef.current === request;
    const fail = (message: string) => {
      if (!current()) return;
      cleanupAudio();
      setElapsedMs(completedDurationRef.current);
      setError(message);
      setPhaseSafe(segmentsRef.current.length ? 'paused' : 'idle');
    };
    const startClock = () => {
      startedAtRef.current = performance.now();
      setPhaseSafe('recording');
      let displayedSecond = Math.floor(completedDurationRef.current / 1000);
      timerRef.current = window.setInterval(() => {
        const elapsed = Math.min(
          MAX_RECORD_MS,
          completedDurationRef.current + performance.now() - startedAtRef.current,
        );
        const second = Math.floor(elapsed / 1000);
        if (second === displayedSecond) return;
        displayedSecond = second;
        setElapsedMs(elapsed);
      }, 100);
      maxTimerRef.current = window.setTimeout(
        endRecord,
        MAX_RECORD_MS - completedDurationRef.current,
      );
    };
    if (phase === 'idle') {
      levels.fill(0);
      peaksRef.current = [];
    }
    stopTargetRef.current = 'review';
    segmentDurationRef.current = null;
    lastPeakAtRef.current = 0;
    audioRef.current?.pause();
    setError(null);
    setTranscribeError(null);
    setPhaseSafe('requesting');

    if (needsNativeRemoteMedia()) {
      recorderRef.current = null;
      nativeSamplesRef.current = [];
      nativeSampleCountRef.current = 0;
      const controller = new AbortController();
      nativeControllerRef.current = controller;
      const maxSamples = Math.floor((MAX_RECORD_MS - completedDurationRef.current) * 16);
      try {
        const stop = await startRemoteMedia(
          { audio: true },
          {
            audio: (bytes) => {
              if (!current() || phaseRef.current !== 'recording') return;
              const remaining = maxSamples - nativeSampleCountRef.current;
              if (remaining <= 0) return;
              const samples = pcm16Samples(bytes).subarray(0, remaining);
              nativeSamplesRef.current.push(samples);
              nativeSampleCountRef.current += samples.length;
              const now = performance.now();
              if (samples.length && now - lastPeakAtRef.current >= 68) {
                lastPeakAtRef.current = now;
                const power = samples.reduce((sum, value) => sum + value * value, 0);
                appendLevel(Math.sqrt(power / samples.length));
              }
            },
            error: fail,
          },
          controller.signal,
        );
        if (!current()) {
          stop();
          return;
        }
        nativeStopRef.current = stop;
        startClock();
      } catch (error) {
        fail(error instanceof Error ? error.message : '开始录音失败');
      }
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      fail('当前环境不支持录音');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (error) {
      fail(describeMicError(error));
      return;
    }
    if (!current()) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    streamRef.current = stream;
    const AudioCtor = window.AudioContext ?? window.webkitAudioContext;
    if (AudioCtor) {
      try {
        const ctx = new AudioCtor();
        ctxRef.current = ctx;
        await ctx.resume();
        if (!current()) return;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        ctx.createMediaStreamSource(stream).connect(analyser);
        analyserRef.current = analyser;
        timeDomainRef.current = new Uint8Array(analyser.fftSize);
      } catch {
        if (!current()) return;
      }
    }

    try {
      const mime = pickRecorderMime();
      const recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (current() && event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        if (!current()) return;
        const chunks = chunksRef.current;
        completeSegment(
          new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type || 'audio/webm' }),
        );
      };
      recorder.onerror = () => fail('录音出错');
      recorder.start(120);
      startClock();
      levelTimerRef.current = window.setInterval(tick, 68);
    } catch {
      fail('开始录音失败');
    }
  }, [
    appendLevel,
    cleanupAudio,
    completeSegment,
    endRecord,
    levels,
    setPhaseSafe,
    tick,
    transcriptReady,
  ]);

  const discard = useCallback(
    (expectedClipId?: string) => {
      if (expectedClipId && clipRef.current?.id !== expectedClipId) return;
      audioRef.current?.pause();
      segmentsRef.current = [];
      preparedSegmentsRef.current = null;
      importedAudioRef.current = false;
      completedDurationRef.current = 0;
      levels.fill(0);
      cleanupAudio();
      transcriptionRef.current?.abort();
      transcriptionRef.current = null;
      transcriptDraft.current = null;
      setTranscribing(false);
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {}
      }
      releaseVoiceClip(clipRef.current);
      clipRef.current = null;
      setClip(null);
      setTranscript('');
      setTranscriptReady(false);
      setTranscribeError(null);
      setError(null);
      setElapsedMs(0);
      setPlaying(false);
      setPlaybackMs(0);
      setPlaybackDurationMs(0);
      setPhaseSafe('idle');
    },
    [cleanupAudio, levels, setPhaseSafe],
  );

  const playbackAudio = useCallback(() => {
    const clip = clipRef.current;
    if (!clip?.url || preparedSegmentsRef.current !== segmentsRef.current) return;
    const audio = audioRef.current ?? new Audio();
    audioRef.current = audio;
    if (audio.src === clip.url) return audio;
    const updateTime = (exact = false) => {
      if (clipRef.current !== clip) return;
      const duration =
        Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration * 1000
          : clip.durationMs;
      if (exact) setPlaybackDurationMs(duration);
      const position = Math.min(duration, audio.currentTime * 1000);
      setPlaybackMs((previous) =>
        exact || Math.floor(previous / 1000) !== Math.floor(position / 1000) ? position : previous,
      );
    };
    audio.onplay = () => {
      if (clipRef.current === clip) setPlaying(true);
    };
    audio.onpause = () => {
      if (clipRef.current !== clip) return;
      updateTime(true);
      setPlaying(false);
    };
    audio.onended = () => {
      if (clipRef.current !== clip) return;
      updateTime(true);
      setPlaying(false);
    };
    audio.ontimeupdate = () => updateTime();
    audio.onseeked = () => updateTime(true);
    audio.ondurationchange = () => updateTime(true);
    audio.onerror = () => {
      if (clipRef.current !== clip) return;
      setPlaying(false);
      setError('无法播放这段录音');
    };
    audio.src = clip.url;
    return audio;
  }, []);

  const stopPlayback = useCallback(() => {
    audioRef.current?.pause();
    setPlaying(false);
  }, []);

  const togglePlay = useCallback(() => {
    const audio = playbackAudio();
    if (!audio) return;
    if (audio.paused) {
      const clip = clipRef.current;
      void audio.play().catch(() => {
        if (clipRef.current === clip) setPlaying(false);
      });
    } else audio.pause();
  }, [playbackAudio]);

  const seekPlayback = useCallback(
    (timeMs: number) => {
      const audio = playbackAudio();
      const clip = clipRef.current;
      if (!audio || !clip || !Number.isFinite(timeMs)) return;
      const duration =
        Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration * 1000
          : clip.durationMs;
      const next = Math.min(duration, Math.max(0, timeMs));
      audio.currentTime = next / 1000;
      setPlaybackMs(next);
    },
    [playbackAudio],
  );

  const readPlaybackMs = useCallback(() => {
    const audio = audioRef.current;
    return audio && audio.src === clipRef.current?.url ? audio.currentTime * 1000 : 0;
  }, []);

  const cancelTranscription = useCallback(() => {
    transcriptionRef.current?.abort();
    transcriptionRef.current = null;
    transcriptDraft.current = null;
    setTranscribing(false);
    setTranscript('');
    setTranscriptReady(false);
    setTranscribeError(null);
  }, []);

  const takeTranscriptDraft = useCallback(() => {
    const text = transcriptDraft.current;
    transcriptDraft.current = null;
    return text?.trim();
  }, []);

  const editTranscript = useCallback((text: string) => {
    if (transcriptDraft.current !== null) transcriptDraft.current = text;
    setTranscript(text);
  }, []);

  const transcribeClip = useCallback(async () => {
    const clip = clipRef.current;
    if (!clip?.blob || transcriptionRef.current) return;
    const controller = new AbortController();
    transcriptionRef.current = controller;
    setTranscribing(true);
    setTranscribeError(null);
    stopPlayback();
    let subscription: { unsubscribe: () => void } | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const wav = await decodeRecordingToWav(new Uint8Array(await clip.blob.arrayBuffer()), 16_000);
      if (controller.signal.aborted) return;
      const result = await new Promise<TranscribeResult | undefined>((resolve, reject) => {
        onAbort = () => resolve(undefined);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        subscription = client.bootstrap.transcribeRecording.subscribe(
          { wav },
          {
            onData: resolve,
            onError: reject,
            onComplete: () => resolve(undefined),
          },
        );
      });
      if (controller.signal.aborted || clipRef.current !== clip) return;
      if (!result?.success) throw new Error(result?.error ?? '本地转写失败');
      const text = result.text?.trim();
      if (!text) throw new Error('没有识别到文字');
      transcriptDraft.current = text;
      setTranscript(text);
      setTranscriptReady(true);
    } catch (error) {
      if (!controller.signal.aborted)
        setTranscribeError(error instanceof Error ? error.message : '本地转写失败');
    } finally {
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      subscription?.unsubscribe();
      if (transcriptionRef.current === controller) {
        transcriptionRef.current = null;
        setTranscribing(false);
      }
    }
  }, [stopPlayback]);

  useEffect(() => {
    // 挂载（含 StrictMode 的模拟重挂载）时都要把「已卸载」标记清掉 —— 它只写在
    // cleanup 里、effect 主体里不复位的话，StrictMode 下第一次模拟卸载就会把它永久
    // 置 true，之后每次 beginRecord 都会在 getUserMedia 返回后直接放弃：表现就是
    // 「一按就断、不到一秒自己回到待机」。
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      captureRequestRef.current = null;
      transcriptionRef.current?.abort();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {}
      }
      cleanupAudio();
      releaseVoiceClip(clipRef.current);
      const audio = audioRef.current;
      if (audio) {
        audio.onended = null;
        audio.pause();
      }
    };
  }, [cleanupAudio]);

  return {
    phase,
    panelPhase: settledPhase === 'idle' ? phase : settledPhase,
    levels,
    subscribeWave,
    clip,
    elapsedMs,
    error,
    transcript,
    transcriptReady,
    transcribing,
    transcribeError,
    playing,
    playbackMs,
    playbackDurationMs,
    playbackReady: clip !== null && preparedSegmentsRef.current === segmentsRef.current,
    readPlaybackMs,
    seekPlayback,
    beginRecord,
    importAudio,
    endRecord,
    pauseRecord,
    releaseHeldRecord,
    discard,
    togglePlay,
    transcribeClip,
    cancelTranscription,
    takeTranscriptDraft,
    stopPlayback,
    editTranscript,
  };
}

// ── 声纹 ─────────────────────────────────────────────────────────────────────

function drawWaveBars(
  context: CanvasRenderingContext2D,
  levels: readonly number[],
  width: number,
  height: number,
  gap: number,
  color: string,
) {
  const stride = (width + gap) / BAR_COUNT;
  const barWidth = stride - gap;
  context.clearRect(0, 0, width, height);
  context.fillStyle = color;
  context.beginPath();
  for (let index = 0; index < BAR_COUNT; index++) {
    const value = levels[Math.floor((index / BAR_COUNT) * levels.length)] ?? 0;
    const amplitude = height * (0.14 + Math.min(1, value) * 0.86);
    const y = (height - amplitude) / 2;
    if (context.roundRect) {
      context.roundRect(
        index * stride,
        y,
        barWidth,
        amplitude,
        Math.min(2, barWidth / 2, amplitude / 2),
      );
    } else {
      context.rect(index * stride, y, barWidth, amplitude);
    }
  }
  context.fill();
}

/** 采样时重画波形，播放时只移动已绘好的波形和进度线。 */
function VoiceWave({
  levels,
  active,
  subscribeWave,
  playback,
}: {
  levels: readonly number[];
  active: boolean;
  subscribeWave: (listener: () => void) => () => void;
  playback?: {
    positionMs: number;
    durationMs: number;
    playing: boolean;
    disabled: boolean;
    readPositionMs: () => number;
    seek: (timeMs: number) => void;
  };
}) {
  const waveRef = useRef<HTMLDivElement | null>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const playedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const playedWindowRef = useRef<HTMLDivElement | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const showPlayback = Boolean(playback);

  useLayoutEffect(() => {
    const wave = waveRef.current;
    if (!wave) return;
    const layers = [baseCanvasRef.current, playedCanvasRef.current].flatMap((canvas) => {
      const context = canvas?.getContext('2d');
      return canvas && context ? [{ canvas, context, color: '' }] : [];
    });
    if (!layers.length) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let width = 0,
      height = 0,
      gap = 0;
    let frame: number | null = null;
    const draw = () => {
      frame = null;
      if (width <= 0 || height <= 0) return;
      for (const { context, color } of layers)
        drawWaveBars(context, levels, width, height, gap, color);
    };
    const scheduleDraw = () => {
      if (frame === null) frame = window.requestAnimationFrame(draw);
    };
    const resize = () => {
      width = wave.clientWidth;
      height = wave.clientHeight;
      if (width <= 0 || height <= 0) return;
      const density = Math.min(2, window.devicePixelRatio || 1);
      gap = Math.min(3, Math.max(1, window.innerWidth * 0.004), width / (BAR_COUNT * 2));
      for (const { canvas, context } of layers) {
        const pixelWidth = Math.round(width * density);
        const pixelHeight = Math.round(height * density);
        if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
        if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
        context.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0);
      }
      // 改变画布像素尺寸会清空内容，必须在同一次尺寸更新中重画。
      if (frame !== null) window.cancelAnimationFrame(frame);
      draw();
    };
    const refreshColors = () => {
      for (const layer of layers) layer.color = window.getComputedStyle(layer.canvas).color;
    };
    const sizeObserver = new ResizeObserver(resize);
    sizeObserver.observe(wave);
    const themeObserver = new MutationObserver(() => {
      refreshColors();
      scheduleDraw();
    });
    themeObserver.observe(document.documentElement, {
      attributeFilter: ['class', 'data-theme', 'style'],
    });
    refreshColors();
    resize();
    const unsubscribe = active
      ? subscribeWave(() => {
          if (!motion.matches) scheduleDraw();
        })
      : undefined;
    return () => {
      unsubscribe?.();
      sizeObserver.disconnect();
      themeObserver.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [levels, active, showPlayback, subscribeWave]);

  const { positionMs, durationMs, playing, readPositionMs } = playback ?? {};
  useLayoutEffect(() => {
    const playedWindow = playedWindowRef.current;
    const playedCanvas = playedCanvasRef.current;
    const playhead = playheadRef.current;
    if (
      !playedWindow ||
      !playedCanvas ||
      !playhead ||
      !durationMs ||
      typeof positionMs !== 'number'
    )
      return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let lastProgress = -1;
    const paint = (timeMs: number) => {
      const progress = Math.min(1, Math.max(0, timeMs / durationMs));
      if (progress === lastProgress) return;
      lastProgress = progress;
      // 反向平移裁切窗口和画布，着色区域前进，柱形保持原位。
      playedWindow.style.transform = `translateX(${(progress - 1) * 100}%)`;
      playedCanvas.style.transform = `translateX(${(1 - progress) * 100}%)`;
      playhead.style.transform = `translateX(${progress * 100}%)`;
    };
    const tick = () => {
      paint(readPositionMs?.() ?? positionMs);
      frame = window.requestAnimationFrame(tick);
    };
    const updateMotion = () => {
      window.cancelAnimationFrame(frame);
      if (playing && !motion.matches) tick();
      else paint(positionMs);
    };
    updateMotion();
    motion.addEventListener('change', updateMotion);
    return () => {
      window.cancelAnimationFrame(frame);
      motion.removeEventListener('change', updateMotion);
    };
  }, [durationMs, playing, positionMs, readPositionMs]);
  return (
    <div
      className={cn('voice-wave', playback && !playback.disabled && 'is-seekable')}
      aria-hidden={playback ? undefined : true}
      ref={waveRef}
    >
      <canvas className="voice-wave-canvas" ref={baseCanvasRef} aria-hidden="true" />
      {playback ? (
        <>
          <div className="voice-wave-progress" ref={playedWindowRef} aria-hidden="true">
            <canvas className="voice-wave-canvas" ref={playedCanvasRef} />
          </div>
          <div className="voice-wave-playhead" ref={playheadRef} aria-hidden="true" />
          {/* 用 inert 暂停定位交互，避免全局禁用样式覆盖滑块的透明度。 */}
          <input
            className="voice-wave-seek"
            type="range"
            min={0}
            max={playback.durationMs}
            step="any"
            value={Math.min(playback.positionMs, playback.durationMs)}
            inert={playback.disabled}
            aria-label="录音播放进度"
            aria-valuetext={`${formatClipDuration(playback.positionMs)} / ${formatClipDuration(playback.durationMs)}`}
            onChange={(event) => playback.seek(Number(event.target.value))}
          />
        </>
      ) : null}
    </div>
  );
}

function RecordingPlayButton({
  playing,
  disabled,
  onToggle,
  className,
}: {
  playing: boolean;
  disabled: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const label = playing ? '暂停播放' : '播放录音';
  return (
    <button
      type="button"
      className={cn('voice-review-play', playing && 'is-playing', className)}
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
    >
      {playing ? <Pause size={18} /> : <Play size={18} />}
    </button>
  );
}

// ── 面板 ─────────────────────────────────────────────────────────────────────

type RecordingOwner = { id: string; label: string };
type RecordingInput = 'button' | 'space';
const VoiceCaptureContext = createContext<{
  recorder: ReturnType<typeof useVoiceRecorder>;
  owner: RecordingOwner | null;
  input: RecordingInput;
  start: (owner: RecordingOwner, input: RecordingInput) => void;
  loadAudio: (owner: RecordingOwner, file: File) => void;
  registerInline: (id: string) => () => void;
} | null>(null);

/** Recorder lifetime follows the workspace and account. Chat pages can mount independently. */
export function VoiceWorkspace({
  children,
  onReturn,
  obscured,
}: {
  children: ReactNode;
  onReturn?: (id: string) => void;
  obscured?: boolean;
}) {
  const [returnId, setReturnId] = useState<string | null>(null);
  const [owner, setOwner] = useState<RecordingOwner | null>(null);
  const [input, setInput] = useState<RecordingInput>('button');
  const [inline, setInline] = useState<{ id: string } | null>(null);
  const recorder = useVoiceRecorder();
  const pages = useContext(PagesContext);
  const { takeTranscriptDraft } = recorder;
  const mode = useMemo(
    () => ({
      returnId,
      setReturnId,
      takeTranscriptDraft: (conversationId: string) =>
        owner?.id === conversationId ? takeTranscriptDraft() : undefined,
    }),
    [owner?.id, returnId, takeTranscriptDraft],
  );
  const registerInline = useCallback((id: string) => {
    const panel = { id };
    setInline(panel);
    return () => setInline((current) => (current === panel ? null : current));
  }, []);
  const { beginRecord, importAudio, releaseHeldRecord, phase, panelPhase } = recorder;
  function start(nextOwner: RecordingOwner, nextInput: RecordingInput) {
    if (phase !== 'idle' && owner?.id !== nextOwner.id) return;
    setOwner(nextOwner);
    setInput(nextInput);
    void beginRecord();
  }
  function loadAudio(nextOwner: RecordingOwner, file: File) {
    if (phase !== 'idle') return;
    setOwner(nextOwner);
    void importAudio(file);
  }
  useEffect(() => {
    if (input !== 'space' || (phase !== 'recording' && phase !== 'requesting')) return;
    function release(event: KeyboardEvent) {
      if (event.code !== 'Space') return;
      event.preventDefault();
      releaseHeldRecord();
    }
    window.addEventListener('keyup', release, true);
    return () => window.removeEventListener('keyup', release, true);
  }, [input, phase, releaseHeldRecord]);
  const openRecording = useCallback(() => {
    if (!owner) return;
    setReturnId(owner.id);
    pages?.select(null);
    onReturn?.(owner.id);
  }, [onReturn, owner, pages]);
  const showBubble =
    owner &&
    panelPhase !== 'idle' &&
    (panelPhase === 'paused' || obscured || inline?.id !== owner.id);
  return (
    <voiceModeContext.Provider value={mode}>
      <VoiceCaptureContext.Provider
        value={{ recorder, owner, input, start, loadAudio, registerInline }}
      >
        {children}
      </VoiceCaptureContext.Provider>
      <RecordingBubble
        owner={showBubble ? owner : null}
        status={
          panelPhase === 'paused'
            ? '已暂停'
            : panelPhase === 'finalizing'
              ? '整理中'
              : panelPhase === 'review'
                ? '待发送'
                : panelPhase === 'requesting'
                  ? '准备中'
                  : formatClipDuration(recorder.elapsedMs)
        }
        onOpen={openRecording}
      />
    </voiceModeContext.Provider>
  );
}

const RecordingBubble = memo(function RecordingBubble({
  owner,
  status,
  onOpen,
}: {
  owner: RecordingOwner | null;
  status: string;
  onOpen: () => void;
}) {
  const button = useRef<HTMLButtonElement | null>(null);
  const position = useRef<{ x: number; y: number } | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const frame = useRef<number | null>(null);
  const moved = useRef(false);
  const paint = useCallback(() => {
    frame.current = null;
    const current = position.current;
    if (!current || !button.current) return;
    const x = Math.max(8, Math.min(window.innerWidth - 68, current.x));
    const y = Math.max(8, Math.min(window.innerHeight - 68, current.y));
    position.current = { x, y };
    button.current.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }, []);
  useLayoutEffect(() => {
    if (!owner) return;
    paint();
    const resize = () => {
      if (frame.current === null) frame.current = window.requestAnimationFrame(paint);
    };
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
      frame.current = null;
      drag.current = null;
    };
  }, [owner, paint]);
  if (!owner) return null;
  return createPortal(
    <button
      ref={button}
      type="button"
      className="voice-recording-bubble"
      title={`返回「${owner.label}」的录音`}
      aria-label={`返回「${owner.label}」的录音`}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        const { left, top } = event.currentTarget.getBoundingClientRect();
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left, top };
        moved.current = false;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const gesture = drag.current;
        if (!gesture || gesture.id !== event.pointerId) return;
        const dx = event.clientX - gesture.x;
        const dy = event.clientY - gesture.y;
        if (!moved.current && Math.hypot(dx, dy) < 5) return;
        moved.current = true;
        position.current = { x: gesture.left + dx, y: gesture.top + dy };
        if (frame.current === null) frame.current = window.requestAnimationFrame(paint);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
      onClick={(event) => {
        if (moved.current && event.detail !== 0) {
          moved.current = false;
          return;
        }
        onOpen();
      }}
    >
      <Mic size={17} />
      <span className="weq-number weq-number-inherit">{status}</span>
    </button>,
    document.body,
  );
});

export function VoicePanel({
  conversationId,
  conversationLabel,
  canSend,
  sendHint,
  onSendVoice,
  onSendTranscript,
  onSendTts,
  ttsProviders = [],
  onSynthesizeSpeech,
  groupId,
  text,
  onTextChange,
  onUseTranscriptDraft,
  onExitVoiceMode,
  onSendAiVoice,
}: {
  conversationId: string;
  conversationLabel: string;
  /** 是否可以发送（QQ 在线且允许注入）。 */
  canSend: boolean;
  sendHint: string;
  onSendVoice: (clip: VoiceClip) => Promise<boolean | undefined>;
  onSendTranscript: (text: string) => Promise<boolean | undefined>;
  onSendTts: (bytes: Uint8Array, text: string) => Promise<void>;
  ttsProviders?: TtsVoiceProvider[];
  onSynthesizeSpeech?: (request: TtsSpeechRequest) => Promise<TtsSpeechResult>;
  groupId?: number;
  text: string;
  onTextChange: (text: string) => void;
  onUseTranscriptDraft: () => void;
  onExitVoiceMode: () => void;
  onSendAiVoice: (draft: AiVoiceDraft) => void;
}) {
  const [tab, setTab] = useState<'record' | 'tts' | 'ai'>('record');
  const tabActive = useTabActive();
  const { recorder, owner, input, start, loadAudio, registerInline } =
    useContext(VoiceCaptureContext)!;
  const ownsRecording = owner?.id === conversationId;
  const phase = ownsRecording ? recorder.phase : 'idle';
  const panelPhase = ownsRecording ? recorder.panelPhase : 'idle';
  const foreignRecording = !!owner && !ownsRecording && recorder.phase !== 'idle';
  const { endRecord, pauseRecord, stopPlayback } = recorder;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const aiSendRef = useRef<HTMLButtonElement | null>(null);
  const sendingReview = useRef(false);
  const [reviewSending, setReviewSending] = useState(false);
  const paused = panelPhase === 'paused';
  const reviewing = panelPhase === 'review';
  const showPlayback = paused || reviewing;
  const pending = phase === 'requesting' || phase === 'finalizing';
  const transcriptReady = reviewing && recorder.transcriptReady;
  const playback =
    showPlayback && recorder.playbackReady && recorder.playbackDurationMs > 0
      ? {
          positionMs: recorder.playbackMs,
          durationMs: recorder.playbackDurationMs,
          playing: recorder.playing,
          disabled: pending,
          readPositionMs: recorder.readPlaybackMs,
          seek: recorder.seekPlayback,
        }
      : undefined;
  const previewTime =
    playback && (recorder.playing || playback.positionMs > 0) ? playback.positionMs : undefined;
  const busy = phase === 'recording' || pending;
  const canResume =
    recorder.elapsedMs < MAX_RECORD_MS && !recorder.transcribing && !recorder.transcriptReady;
  const resumeByClick = () => start({ id: conversationId, label: conversationLabel }, 'button');

  function changeTab(next: typeof tab) {
    if (busy) return;
    if (next !== 'record' && ownsRecording) {
      stopPlayback();
      if (tab === 'record') onUseTranscriptDraft();
    }
    setTab(next);
  }

  async function sendReview(send: () => Promise<boolean | undefined>) {
    const id = recorder.clip?.id;
    if (!id || sendingReview.current) return;
    sendingReview.current = true;
    setReviewSending(true);
    try {
      if (await send()) recorder.discard(id);
    } finally {
      sendingReview.current = false;
      setReviewSending(false);
    }
  }

  useLayoutEffect(() => {
    if (!tabActive) return;
    return registerInline(conversationId);
  }, [conversationId, registerInline, tabActive]);

  useEffect(() => {
    if (ownsRecording && tabActive) return stopPlayback;
  }, [ownsRecording, stopPlayback, tabActive]);

  // 面板自己抢焦点，这样空格长按不会落进正文（正文聚焦时空格就是打字）。
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!tabActive || !root) return;
    const document = root.ownerDocument;
    function handleEscape(event: KeyboardEvent) {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229
      )
        return;
      const top = topSurface(document);
      if (top && !top.contains(root)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat || phase === 'finalizing') return;
      if (phase === 'recording' || phase === 'requesting') pauseRecord();
      else onExitVoiceMode();
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onExitVoiceMode, pauseRecord, phase, tabActive]);

  // 空格由录音所在页面启动，释放由工作区监听，切页时也能结束录音。
  function startWithSpace(event: React.KeyboardEvent) {
    if (
      tab !== 'record' ||
      event.code !== 'Space' ||
      event.repeat ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    )
      return;
    const target = event.target as HTMLElement;
    if (
      target.isContentEditable ||
      target.closest('input, textarea, button:not(.voice-record-btn)')
    )
      return;
    event.preventDefault();
    if (!busy && !foreignRecording && !reviewSending && (phase === 'idle' || canResume))
      start({ id: conversationId, label: conversationLabel }, 'space');
  }

  return (
    <div
      className={cn('voice-panel')}
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={startWithSpace}
      aria-label="语音"
    >
      <div className="voice-mode-switch" role="group" aria-label="语音方式">
        <button
          type="button"
          aria-pressed={tab === 'record'}
          disabled={busy}
          onClick={() => changeTab('record')}
        >
          <Mic size={16} /> 录音
        </button>
        <button
          type="button"
          aria-pressed={tab === 'tts'}
          disabled={busy}
          onClick={() => changeTab('tts')}
        >
          <Type size={16} /> TTS
        </button>
        {groupId ? (
          <button
            type="button"
            aria-pressed={tab === 'ai'}
            disabled={busy}
            onClick={() => changeTab('ai')}
          >
            <Sparkles size={16} /> AI 声聊
          </button>
        ) : null}
      </div>
      {tab !== 'record' ? (
        <div className="voice-synthesis">
          <div className="voice-synthesis-field">
            <span className="voice-synthesis-label">
              <span className="voice-tts-count" aria-hidden="true">
                {text.length}/{MAX_TTS_CHARS}
              </span>
            </span>
            <textarea
              className="voice-tts-input"
              aria-label="合成文字"
              value={text}
              maxLength={Math.max(MAX_TTS_CHARS, text.length)}
              placeholder="输入要合成语音的文字"
              onChange={(event) => onTextChange(event.target.value)}
              onKeyDown={(event) => {
                if (
                  tab === 'ai' &&
                  event.key === 'Enter' &&
                  (event.metaKey || event.ctrlKey) &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  aiSendRef.current?.click();
                }
              }}
            />
            {text.length > MAX_TTS_CHARS ? (
              <span className="voice-error" role="status">
                语音文字最多 {MAX_TTS_CHARS} 字，请缩短后发送。
              </span>
            ) : null}
          </div>
          {tab === 'ai' && groupId ? (
            <AiVoiceControls
              groupId={groupId}
              text={text}
              disabled={!canSend}
              disabledHint={sendHint}
              onSend={onSendAiVoice}
              sendRef={aiSendRef}
            />
          ) : (
            <TtsComposer
              text={text}
              providers={ttsProviders}
              canSend={canSend}
              sendHint={sendHint}
              onSendAudio={onSendTts}
              onSynthesize={onSynthesizeSpeech}
            />
          )}
        </div>
      ) : (
        <div
          className="voice-panel-body"
          data-wave-phase={panelPhase}
          data-transcript-ready={transcriptReady}
        >
          {foreignRecording ? null : (
            <VoiceWave
              levels={playback ? (recorder.clip?.levels ?? []) : recorder.levels}
              active={phase === 'recording'}
              subscribeWave={recorder.subscribeWave}
              playback={playback}
            />
          )}
          {playback ? (
            <RecordingPlayButton
              className="voice-stage-play"
              playing={recorder.playing}
              disabled={pending}
              onToggle={recorder.togglePlay}
            />
          ) : null}
          {!foreignRecording && !transcriptReady ? (
            <div className={cn('voice-record-track', (busy || showPlayback) && 'is-at-end')}>
              <button
                type="button"
                className="voice-record-btn"
                title={showPlayback ? '继续录音' : busy ? '结束录音' : '点击录音（也可长按空格）'}
                aria-label={showPlayback ? '继续录音' : busy ? '结束录音' : '点击录音'}
                disabled={
                  phase === 'finalizing' ||
                  (showPlayback && (pending || !canResume || reviewSending))
                }
                onClick={() => {
                  if (busy) endRecord();
                  else resumeByClick();
                }}
                onContextMenu={(event) => event.preventDefault()}
              >
                {panelPhase === 'requesting' ? (
                  <>
                    <Loader2 size={20} className="voice-spin" />
                    <strong>正在开麦…</strong>
                  </>
                ) : panelPhase === 'finalizing' ? (
                  <Loader2 size={20} className="voice-spin" />
                ) : busy || showPlayback ? (
                  <>
                    <strong className="voice-record-timer weq-number weq-number-inherit">
                      {formatClipDuration(previewTime ?? recorder.elapsedMs)}
                    </strong>
                    <em className="voice-record-note">
                      {showPlayback ? '继续录音' : input === 'space' ? '松开结束' : '点击结束'}
                    </em>
                  </>
                ) : (
                  <>
                    <Mic size={22} />
                    <strong>点击录音</strong>
                  </>
                )}
              </button>
            </div>
          ) : null}
          {transcriptReady ? (
            <span className="voice-review-time weq-number weq-number-inherit">
              {formatClipDuration(previewTime ?? recorder.elapsedMs)}
            </span>
          ) : null}
          {foreignRecording ? (
            <p className="voice-other-recording">另一个会话有录音，请通过悬浮球返回。</p>
          ) : reviewing && recorder.clip ? (
            <VoiceReview
              inert={pending}
              transcript={recorder.transcript}
              transcriptReady={transcriptReady}
              transcribing={recorder.transcribing}
              transcribeError={recorder.transcribeError}
              canSend={canSend && !reviewSending}
              sendHint={sendHint}
              onTranscribe={recorder.transcribeClip}
              onCancelTranscription={recorder.cancelTranscription}
              onTranscriptChange={recorder.editTranscript}
              onDiscard={() => recorder.discard()}
              onSendVoice={(voiceChanged) =>
                void sendReview(() =>
                  onSendVoice({ ...recorder.clip, transcript: recorder.transcript, voiceChanged }),
                )
              }
              onSendTranscript={() =>
                void sendReview(() => onSendTranscript(recorder.transcript.trim()))
              }
            />
          ) : null}

          {!foreignRecording && !reviewing ? (
            <div className={cn('voice-panel-foot')}>
              <span className={cn('voice-hint')}>
                {paused ? (
                  <>已暂停 · {formatClipDuration(recorder.elapsedMs)}</>
                ) : (
                  <>
                    <kbd>空格</kbd> 长按录音 · 最长 60 秒
                  </>
                )}
              </span>
              {paused ? (
                <button
                  type="button"
                  className="voice-btn ghost"
                  inert={pending}
                  onClick={endRecord}
                >
                  结束录音
                </button>
              ) : phase === 'idle' ? (
                <label className={cn('voice-pick-audio')} title="将本机音频导入录音">
                  <FileAudio size={13} />
                  选择音频
                  <input
                    type="file"
                    accept="audio/*"
                    hidden
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (file) loadAudio({ id: conversationId, label: conversationLabel }, file);
                    }}
                  />
                </label>
              ) : null}
              {ownsRecording && recorder.error ? (
                <span className="voice-error" role="status">
                  {recorder.error}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ── 回顾 ─────────────────────────────────────────────────────────────────────

function VoiceReview({
  inert,
  transcript,
  transcriptReady,
  transcribing,
  transcribeError,
  canSend,
  sendHint,
  onTranscribe,
  onCancelTranscription,
  onTranscriptChange,
  onDiscard,
  onSendVoice,
  onSendTranscript,
}: {
  inert: boolean;
  transcript: string;
  transcriptReady: boolean;
  transcribing: boolean;
  transcribeError: string | null;
  canSend: boolean;
  sendHint: string;
  onTranscribe: () => void;
  onCancelTranscription: () => void;
  onTranscriptChange: (text: string) => void;
  onDiscard: () => void;
  /** 发送语音；带上「变声标识」勾选态（协议已实现 `extBizInfo.ptt.changeVoice`）。 */
  onSendVoice: (voiceChanged: boolean) => void;
  onSendTranscript: () => void;
}) {
  const trimmed = transcript.trim();
  const cancelLabel = transcriptReady ? '取消转文字' : '取消转写';
  const [voiceChanged, setVoiceChanged] = useState(false);
  return (
    <div className={cn('voice-review')}>
      {transcribeError || transcribing || transcriptReady ? (
        <div className="voice-transcript-output">
          {transcribeError ? (
            <p className="voice-error" role="status">
              {transcribeError}
            </p>
          ) : null}
          {transcribing ? <p role="status">正在本地转写…</p> : null}
          {transcriptReady && !transcribing ? (
            <textarea
              aria-label="转写结果"
              value={transcript}
              onChange={(event) => onTranscriptChange(event.target.value)}
            />
          ) : null}
        </div>
      ) : null}

      <div ref={observeCompactToolbar} className="voice-review-actions" inert={inert}>
        {transcriptReady ? null : (
          <button
            data-danger="outline"
            type="button"
            className="voice-btn ghost"
            aria-label="删除录音"
            title="删除录音"
            onClick={onDiscard}
          >
            <Trash2 size={14} />
          </button>
        )}
        <button
          title={transcribing || transcriptReady ? cancelLabel : '转文字'}
          type="button"
          className="voice-btn ghost voice-transcribe-btn"
          onClick={transcribing || transcriptReady ? onCancelTranscription : onTranscribe}
        >
          {transcribing || transcriptReady ? <X size={14} /> : <Captions size={14} />}
          <ToolbarLabel>{transcribing || transcriptReady ? cancelLabel : '转文字'}</ToolbarLabel>
        </button>
        {transcriptReady ? (
          <button
            type="button"
            className="voice-btn primary"
            title={canSend ? '只发这段文字' : sendHint}
            disabled={!canSend || !trimmed}
            onClick={onSendTranscript}
          >
            <SendHorizontal size={14} /> <span>发送文字</span>
          </button>
        ) : (
          <>
            <button
              type="button"
              className={cn('voice-btn ghost', voiceChanged && 'is-active')}
              title={voiceChanged ? '取消发送变声标识' : '发送变声标识'}
              aria-label="发送变声标识"
              aria-pressed={voiceChanged}
              disabled={!canSend}
              onClick={() => setVoiceChanged((value) => !value)}
            >
              <Wand2 size={14} />
            </button>
            <button
              type="button"
              className="voice-btn primary"
              aria-label="发送语音"
              title={canSend ? '发送这条语音' : sendHint}
              disabled={!canSend}
              onClick={() => onSendVoice(voiceChanged)}
            >
              <SendHorizontal size={14} /> <span>发送语音</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ── 文字转语音 ───────────────────────────────────────────────────────────────

/** 一个可选的 TTS 服务商（设置 → 语音配置 里存的）。 */
export interface TtsVoiceProvider {
  id: string;
  name: string;
  /** 服务商配置里的默认音色（可空）。 */
  voice?: string;
}

export interface TtsSpeechRequest {
  text: string;
  providerId?: string;
  /** 覆盖服务商默认音色。 */
  voice?: string;
}

/** 合成结果：音频字节以 base64 过 IPC（小音频，不走临时文件）。 */
export interface TtsSpeechResult {
  providerName: string;
  /** mp3 | wav …（决定交给 WebAudio 解码时的 MIME）。 */
  format: string;
  audioBase64: string;
}

/** base64 → bytes。不用 `Uint8Array.from(atob(…))`：大一点就会爆栈。 */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const TTS_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
};

function TtsComposer({
  text,
  providers,
  canSend,
  sendHint,
  onSendAudio,
  onSynthesize,
}: {
  text: string;
  providers: TtsVoiceProvider[];
  canSend: boolean;
  sendHint: string;
  /** 合成好的音频当一条普通语音条发（上层解成 WAV 再转 SILK）。 */
  onSendAudio: (bytes: Uint8Array, text: string) => Promise<void>;
  onSynthesize?: (request: TtsSpeechRequest) => Promise<TtsSpeechResult>;
}) {
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '');
  const [voice, setVoice] = useState('');
  const [phase, setPhase] = useState<'idle' | 'preview' | 'send'>('idle');
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 试听过的合成结果：同一段文字 + 同一个服务商/音色再点「发送」不重复合成（省一次钱）。
  const cacheRef = useRef<{ key: string; bytes: Uint8Array; format: string } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const mounted = useRef(false);

  const body = text.trim();
  const provider = providers.find((item) => item.id === providerId) ?? providers[0] ?? null;
  const ready =
    Boolean(onSynthesize) && provider !== null && body.length > 0 && text.length <= MAX_TTS_CHARS;
  const busy = phase !== 'idle';
  /** 缓存键：文字 / 服务商 / 音色任一变了就得重新合成。 */
  const cacheKey = `${provider?.id ?? ''}|${voice.trim()}|${body}`;

  // 换服务商就把音色覆盖清掉 —— 一个服务商的音色名在另一个那里没有意义。
  useEffect(() => {
    setVoice('');
  }, [providerId]);

  // 面板卸载（收起）时把试听中的音频停干净，别留个声音在后面念。
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (audioRef.current) {
        audioRef.current.onpause = null;
        audioRef.current.onended = null;
      }
      audioRef.current?.pause();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  /** 合成（带缓存）。抛错交给调用方提示。 */
  async function synthesize(): Promise<{ bytes: Uint8Array; format: string } | null> {
    if (!onSynthesize || !provider || !body) return null;
    const cached = cacheRef.current;
    if (cached && cached.key === cacheKey) return cached;
    setError(null);
    const result = await onSynthesize({
      text: body,
      providerId: provider.id,
      ...(voice.trim() ? { voice: voice.trim() } : {}),
    });
    const bytes = base64ToBytes(result.audioBase64);
    if (bytes.byteLength === 0) throw new Error('TTS 服务商返回了空音频。');
    const value = { key: cacheKey, bytes, format: result.format || 'mp3' };
    cacheRef.current = value;
    return value;
  }

  function stopPlayback(): void {
    audioRef.current?.pause();
    setPlaying(false);
  }

  /** 试听：用合成出来的真音频放（不再用本机 speechSynthesis，试听的就是要发的那条）。 */
  async function handlePreview(): Promise<void> {
    if (!ready) return;
    if (playing) {
      stopPlayback();
      return;
    }
    setPhase('preview');
    try {
      const result = await synthesize();
      if (!result || !mounted.current) return;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const url = URL.createObjectURL(
        new Blob([result.bytes], { type: TTS_MIME[result.format] ?? 'audio/mpeg' }),
      );
      urlRef.current = url;
      const audio = audioRef.current ?? new Audio();
      audioRef.current = audio;
      audio.onended = () => setPlaying(false);
      audio.onpause = () => setPlaying(false);
      audio.src = url;
      audio.currentTime = 0;
      setPlaying(true);
      await audio.play().catch(() => setPlaying(false));
    } catch (err) {
      setPlaying(false);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPhase('idle');
    }
  }

  /** 合成并发送，沿用语音发送时的 WebAudio 解码与 SILK 转码。 */
  async function handleSend(): Promise<void> {
    if (!ready || !canSend) return;
    setPhase('send');
    try {
      const result = await synthesize();
      if (!result) return;
      await onSendAudio(result.bytes, body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPhase('idle');
    }
  }

  return (
    <div className={cn('voice-tts', 'voice-synthesis-controls')}>
      {provider ? null : <p className="voice-tts-note">在「设置 → 语音配置」中添加 TTS 服务商。</p>}
      <div className={cn('voice-tts-row')}>
        <label className={cn('voice-tts-voice')}>
          <span>服务商</span>
          <FormSelect
            value={provider?.id ?? ''}
            disabled={providers.length === 0}
            onChange={(event) => setProviderId(event.target.value)}
          >
            {providers.length === 0 ? <option value="">未配置</option> : null}
            {providers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </FormSelect>
        </label>
      </div>
      <div className={cn('voice-tts-row')}>
        <label className={cn('voice-tts-voice')}>
          <span>音色</span>
          <input
            type="text"
            value={voice}
            spellCheck={false}
            placeholder={provider?.voice || '默认音色，可留空'}
            onChange={(event) => setVoice(event.target.value)}
          />
        </label>
      </div>
      {error ? <span className={cn('voice-error')}>{error}</span> : null}
      <div className={cn('voice-review-actions')}>
        <button
          type="button"
          className={cn('voice-btn ghost')}
          // 试听中仍可点（再点一次 = 停止），只避开正在发送的那一瞬。
          disabled={!ready || busy}
          onClick={() => void handlePreview()}
        >
          {phase === 'preview' ? (
            <Loader2 size={14} className={cn('voice-spin')} />
          ) : playing ? (
            <Pause size={14} />
          ) : (
            <Play size={14} />
          )}
          {playing ? '停止' : '试听'}
        </button>
        <button
          type="button"
          className={cn('voice-btn primary')}
          title={canSend ? '合成并发送' : sendHint}
          disabled={!ready || !canSend || busy}
          onClick={() => void handleSend()}
        >
          {phase === 'send' ? (
            <Loader2 size={14} className={cn('voice-spin')} />
          ) : (
            <SendHorizontal size={14} />
          )}
          合成并发送
        </button>
      </div>
    </div>
  );
}
