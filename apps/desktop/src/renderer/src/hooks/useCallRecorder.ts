/**
 * 通话录音的界面侧控制。
 *
 * 录音本体在主进程（两路 PCM 本来就在那儿），这里只做三件事：
 *
 *   1. 发 `startRecording` / `stopRecording`，维护本地状态；
 *   2. **Windows** 上额外采集「电脑正在播放的声音」并推给主进程 —— 系统音频只有
 *      `getDisplayMedia` 能拿到，而它必须在渲染层发起（主进程负责放行，见
 *      `call_display_media.ts`）。Linux 由主进程自己 `parec`，这里什么都不做；
 *   3. 把设置页的默认值带进第一次录音，抽屉里改了就临时覆盖。
 *
 * 系统音频**只进录音，不进通话上行**：电脑在放什么不该被发给对方。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { trpc } from '../trpc/client';

/** 一帧 640 字节（20 ms @ 16 kHz 单声道 16-bit）。 */
const FRAME_SAMPLES = 320;
const SYSTEM_RATE = 16_000;
const SYSTEM_BUFFER_SAMPLES = 256;

export type CallRecordingMode = 'self' | 'peer' | 'mixed';

export interface RecordingState {
  active: boolean;
  durationSec: number;
  mode: CallRecordingMode;
  systemAudio: boolean;
}

/** 录音结束后留在窗口里的那条结果。 */
export interface FinishedRecording {
  id: string;
  durationSec: number;
  mode: CallRecordingMode;
  systemAudio: boolean;
}

export interface UseCallRecorderOptions {
  /** 通话是否已接通（未接通不能录）。 */
  live: boolean;
  /** 默认值（来自设置页）。 */
  defaults: { mode: CallRecordingMode; systemAudio: boolean } | null;
  /** 系统音频能力，决定要不要走 getDisplayMedia。 */
  capability: 'native' | 'renderer' | 'unsupported' | null;
}

export function useCallRecorder({ live, defaults, capability }: UseCallRecorderOptions) {
  const [recording, setRecording] = useState<RecordingState | null>(null);
  const [finished, setFinished] = useState<FinishedRecording | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = trpc.call.startRecording.useMutation();
  const stop = trpc.call.stopRecording.useMutation();
  const pushSystem = trpc.call.pushSystemAudio.useMutation();

  const systemStream = useRef<MediaStream | null>(null);
  const systemContext = useRef<AudioContext | null>(null);
  const pushRef = useRef(pushSystem.mutate);
  pushRef.current = pushSystem.mutate;

  /**
   * 录音条的时长自己走秒表，不等主进程每秒推的状态。
   *
   * 主进程那一拍是跟着通话 ticker 走的（1 秒一次），刚点下录音到第一次推送之间
   * 最长有 1 秒空档；而且窗口刚打开时状态订阅可能还没接上。本地计时器没有这些
   * 延迟，界面不会「点了没反应」。
   */
  const startedAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (!recording?.active) return;
    const timer = window.setInterval(() => {
      const startedAt = startedAtRef.current;
      if (startedAt === null) return;
      const durationSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      setRecording((prev) => (prev ? { ...prev, durationSec } : prev));
    }, 500);
    return () => window.clearInterval(timer);
  }, [recording?.active]);

  /** Windows：采系统音频，切 20 ms 帧推给主进程。失败只记日志，不打断录音。 */
  const startSystemAudio = useCallback(async () => {
    if (capability !== 'renderer') return;
    try {
      // 主进程的 handler 会把 audio 固定回 loopback；video 是 Chromium 的硬性
      // 要求（两者至少一个），拿到流之后立刻停掉，别白占一路桌面捕获。
      const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      for (const track of stream.getVideoTracks()) {
        track.stop();
        stream.removeTrack(track);
      }
      if (stream.getAudioTracks().length === 0) {
        for (const track of stream.getTracks()) track.stop();
        console.warn('[call] 没有拿到系统音频轨');
        return;
      }
      systemStream.current = stream;
      const context = new AudioContext({ sampleRate: SYSTEM_RATE });
      systemContext.current = context;
      if (context.state === 'suspended') await context.resume().catch(() => {});
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(SYSTEM_BUFFER_SAMPLES, 1, 1);
      let pending = new Float32Array(0);
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        const merged = new Float32Array(pending.length + input.length);
        merged.set(pending, 0);
        merged.set(input, pending.length);
        let offset = 0;
        while (merged.length - offset >= FRAME_SAMPLES) {
          const frame = new Int16Array(FRAME_SAMPLES);
          for (let i = 0; i < FRAME_SAMPLES; i++) {
            const v = Math.max(-1, Math.min(1, merged[offset + i] ?? 0));
            frame[i] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
          }
          offset += FRAME_SAMPLES;
          void pushRef.current({ pcm: new Uint8Array(frame.buffer) });
        }
        pending = merged.slice(offset);
        if (pending.length > SYSTEM_RATE) pending = new Float32Array(0);
      };
      source.connect(processor);
      processor.connect(context.destination);
    } catch (cause) {
      console.warn('[call] 系统声音采集失败', cause);
    }
  }, [capability]);

  const stopSystemAudio = useCallback(() => {
    for (const track of systemStream.current?.getTracks() ?? []) track.stop();
    systemStream.current = null;
    void systemContext.current?.close();
    systemContext.current = null;
  }, []);

  const begin = useCallback(
    async (override?: Partial<{ mode: CallRecordingMode; systemAudio: boolean }>) => {
      if (!live || busy || recording?.active) return;
      setBusy(true);
      setError(null);
      setFinished(null);
      try {
        const mode = override?.mode ?? defaults?.mode ?? 'mixed';
        const systemAudio = override?.systemAudio ?? defaults?.systemAudio ?? false;
        const snapshot = await start.mutateAsync({ mode, systemAudio });
        startedAtRef.current = Date.now();
        setRecording({
          active: true,
          durationSec: snapshot.durationSec,
          mode: snapshot.mode,
          systemAudio: snapshot.systemAudio,
        });
        if (systemAudio) void startSystemAudio();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '无法开始录音');
      } finally {
        setBusy(false);
      }
    },
    [busy, defaults, live, recording?.active, start, startSystemAudio],
  );

  const end = useCallback(async () => {
    if (busy || !recording?.active) return;
    setBusy(true);
    stopSystemAudio();
    try {
      const entry = await stop.mutateAsync();
      startedAtRef.current = null;
      setRecording(null);
      if (entry) {
        setFinished({
          id: entry.id,
          durationSec: entry.durationSec,
          mode: entry.mode,
          systemAudio: entry.systemAudio,
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法停止录音');
      setRecording(null);
    } finally {
      setBusy(false);
    }
  }, [busy, recording?.active, stop, stopSystemAudio]);

  // 主进程的内部收尾（对端挂断 / 被踢 / 异常）不会有人 await mutation，结果只从
  // 这条订阅过来。用户点「停止」时两条路都会到，`finished` 覆盖成同一份即可。
  trpc.call.onCallRecording.useSubscription(undefined, {
    onData: (entry) => {
      startedAtRef.current = null;
      setRecording(null);
      setFinished({
        id: entry.id,
        durationSec: entry.durationSec,
        mode: entry.mode,
        systemAudio: entry.systemAudio,
      });
    },
    onError: (cause) => console.error('[call] recording subscription error', cause),
  });

  // 通话挂断 / 结束：主进程会自己收尾，这里只清掉本地采集，避免麦克风/屏幕
  // 采集一直挂着（`getDisplayMedia` 的轨道不关会一直显示共享指示）。
  useEffect(() => {
    if (live) return;
    stopSystemAudio();
    setRecording(null);
  }, [live, stopSystemAudio]);

  // 卸载时也要关：窗口关掉不该留着系统音频采集。
  useEffect(() => () => stopSystemAudio(), [stopSystemAudio]);

  return { recording, finished, error, busy, begin, end, clearFinished: () => setFinished(null) };
}
