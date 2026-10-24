/**
 * 通话窗口。
 *
 * 独立系统窗口，跟着通话状态走：呼叫中 → 振铃 → 接通 → 挂断。
 * 只在**主动发起**时出现 —— 来电由 QQ 本体处理，WeQ 收不到那条推送。
 *
 * 这个文件只负责**窗口生命周期与编排**（订阅、开关窗、挂断收尾）。界面拆到了
 * `components/call/`：
 *
 *   CallStage          背景 / 光环 / 头像 / 名字 / 状态 / 波形（形状按多人通话定）
 *   CallControls       底部操作栏（`extra` 插槽留给未来的摄像头 / 屏幕共享）
 *   CallRecorderBar    录音中的状态条 / 结束后的录音卡片
 *   CallSettingsDrawer 底部折叠抽屉，**后续设置都往这里加**
 *
 * 音频链路在 `hooks/useCallAudio.ts`，录音控制在 `hooks/useCallRecorder.ts`。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { trpc } from '../trpc/client';
import { resourceUrl } from '../lib/resourceUrl';
import { useToolWindow } from '../hooks/useCompositionWindow';
import { useCallAudio } from '../hooks/useCallAudio';
import { useCallRecorder, type CallRecordingMode } from '../hooks/useCallRecorder';
import { RenderDocumentContext } from '../lib/renderDocument';
import { HoverTooltip } from './HoverTooltip';
import { useToast } from './Toast';
import { useAppLock } from '../state/lock';
import { CallStage, type CallPeer, type CallState } from './call/CallStage';
import { CallControls } from './call/CallControls';
import { CallRecorderBar, CallRecordingCard, formatDuration } from './call/CallRecorderBar';
import { CallSettingsDrawer, useCallRecordingSettings } from './call/CallSettingsDrawer';
import '../styles/call.css';
import '../styles/call-recorder.css';

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

/**
 * 通话窗口。
 *
 * `call` 是发起时拿到的快照；后续状态全靠订阅推。窗口在 `ended` / `failed`
 * 之后再留 1.6 秒给用户看结果，然后自己关掉 —— **但录过音时不自动关**，
 * 录音卡片要留给用户播放 / 打开目录。
 */
export function CallWindow({ initial, onClose }: { initial: CallInfo; onClose: () => void }) {
  const locked = useAppLock((state) => state.locked);
  const [info, setInfo] = useState<CallInfo>(initial);
  const [muted, setMuted] = useState(false);
  const [speakerOff, setSpeakerOff] = useState(false);
  const [backdropFailed, setBackdropFailed] = useState(false);

  const finished = info.state === 'ended' || info.state === 'failed';
  const live = info.state === 'connected';

  const settings = useCallRecordingSettings();
  const recorder = useCallRecorder({
    live,
    defaults: settings.config
      ? { mode: settings.config.mode, systemAudio: settings.config.systemAudio }
      : null,
    capability: settings.capability,
  });

  // 录音期间即使点了静音也要保持麦克风采集（否则录下来的是空轨）。
  const { level, peerLevel } = useCallAudio({
    live,
    muted,
    speakerOff,
    keepMicForRecording: Boolean(recorder.recording?.active),
  });

  const hangup = trpc.call.hangup.useMutation({
    onError: () => {
      hangupRequested.current = false;
    },
  });
  const tool = useToolWindow({
    name: 'weq-call',
    title: 'WeQ · 语音通话',
    width: 400,
    height: 620,
    bodyClass: 'weq-call-window-body',
  });
  const finishedRef = useRef(finished);
  finishedRef.current = finished;
  const hangupRef = useRef(hangup.mutate);
  hangupRef.current = hangup.mutate;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const hangupRequested = useRef(false);
  const closeRequested = useRef(false);
  const requestHangup = useCallback(() => {
    if (finishedRef.current || hangupRequested.current) return;
    hangupRequested.current = true;
    hangupRef.current();
  }, []);
  const closeWindow = useCallback(() => {
    if (closeRequested.current) return;
    closeRequested.current = true;
    tool.close();
    onCloseRef.current();
  }, [tool.close]);
  const lifecycle = useRef(0);
  useEffect(() => {
    const generation = ++lifecycle.current;
    const popup = tool.open();
    if (!popup) {
      requestHangup();
      useToast.getState().push({
        tone: 'error',
        message: '无法打开通话窗口',
        detail: '已结束本次呼叫，请允许弹出窗口后重试。',
      });
      onCloseRef.current();
    }
    const timer = window.setInterval(() => {
      if (!popup?.closed) return;
      requestHangup();
      closeWindow();
    }, 200);
    return () => {
      window.clearInterval(timer);
      // StrictMode 会立即重挂载；只为真正卸载（切号／退出主界面）挂断。
      queueMicrotask(() => {
        if (lifecycle.current === generation) requestHangup();
      });
    };
  }, [tool.open, requestHangup, closeWindow]);

  // ── 状态订阅 ──
  trpc.call.onCallState.useSubscription(undefined, {
    onData: (next) => {
      const call = next as CallInfo;
      if (call?.state) setInfo((prev) => ({ ...prev, ...call }));
    },
    onError: (error) => console.error('[call] state subscription error', error),
  });

  // 主进程侧的非致命错误（目前只有「电脑声音采集失败」）。用 toast 而不是塞进
  // 状态行：通话本身没问题，不该让状态文字变成报错。
  trpc.call.onCallError.useSubscription(undefined, {
    onData: (message) => {
      useToast.getState().push({ tone: 'warning', message });
    },
    onError: (error) => console.error('[call] error subscription error', error),
  });

  // ── 铃声 ──
  useEffect(() => {
    if (info.state !== 'ringing' && info.state !== 'calling') return;
    const audio = new Audio(resourceUrl('call', 'ringtone-caller.mp3'));
    audio.loop = true;
    // 自动播放策略：发起通话一定来自用户点击，这条播放是被允许的。
    void audio.play().catch(() => {});
    return () => {
      audio.pause();
      audio.currentTime = 0;
    };
  }, [info.state]);

  // 结束后停留一会儿让用户看到结果。录过音就不自动关 —— 录音卡片要留给用户操作。
  const hasRecording = Boolean(recorder.finished);
  useEffect(() => {
    if (!finished || hasRecording) return;
    const timer = window.setTimeout(closeWindow, 1600);
    return () => window.clearTimeout(timer);
  }, [finished, hasRecording, closeWindow]);

  const handleHangup = useCallback(() => {
    requestHangup();
  }, [requestHangup]);

  /** 录音按钮：录音中再点就是停。 */
  const handleToggleRecording = useCallback(() => {
    if (recorder.recording?.active) void recorder.end();
    else void recorder.begin();
  }, [recorder]);

  const handleModeChange = useCallback(
    (mode: CallRecordingMode) => settings.update({ mode }),
    [settings],
  );
  const handleSystemAudioChange = useCallback(
    (enabled: boolean) => settings.update({ systemAudio: enabled }),
    [settings],
  );
  const openFolder = trpc.help.openFolder.useMutation();
  const handleOpenFolder = useCallback(() => {
    const dir = settings.dir;
    if (!dir) {
      useToast.getState().push({
        tone: 'info',
        message: '暂时定位不到录音目录',
        detail: '账号还没打开，或录音目录不可用。',
      });
      return;
    }
    openFolder.mutate({ path: dir });
  }, [openFolder, settings.dir]);

  const peers: CallPeer[] = [
    {
      uin: info.peerUin,
      name: info.peerName || info.peerUin,
      avatarUrl: info.peerAvatar,
      level: peerLevel,
    },
  ];

  const popup = tool.popup;
  if (!popup || popup.closed) return null;

  return createPortal(
    <RenderDocumentContext.Provider value={popup.document}>
      <div
        className="weq-call-backdrop"
        role="region"
        aria-label="语音通话"
        hidden={locked}
        inert={locked}
      >
        <div
          className={`weq-call-card${live ? ' is-live' : ''}${
            !backdropFailed && (info.backgroundUrl || info.backgroundVideoUrl)
              ? ' has-backdrop'
              : ''
          }`}
          data-state={info.state}
        >
          <CallStage
            peers={peers}
            state={info.state}
            status={statusText(info)}
            selfLevel={level}
            backgroundUrl={info.backgroundUrl}
            backgroundVideoUrl={info.backgroundVideoUrl}
            backdropFailed={backdropFailed}
            onBackdropError={() => setBackdropFailed(true)}
          />

          {recorder.recording?.active ? <CallRecorderBar recording={recorder.recording} /> : null}
          {recorder.finished ? (
            <CallRecordingCard
              recording={recorder.finished}
              onOpenFolder={handleOpenFolder}
              onClose={closeWindow}
            />
          ) : null}
          {recorder.error ? (
            <div className="weq-call-recording-error" role="alert">
              {recorder.error}
            </div>
          ) : null}

          <CallControls
            muted={muted}
            speakerOff={speakerOff}
            recording={Boolean(recorder.recording?.active)}
            recordingEnabled={live && !recorder.busy}
            finished={finished}
            hangupPending={hangup.isPending}
            onToggleMute={() => setMuted((value) => !value)}
            onToggleSpeaker={() => setSpeakerOff((value) => !value)}
            onToggleRecording={handleToggleRecording}
            onHangup={handleHangup}
          />

          <CallSettingsDrawer
            mode={settings.config?.mode ?? 'mixed'}
            systemAudio={settings.config?.systemAudio ?? false}
            capability={settings.capability}
            recordingDir={settings.config?.dir ?? null}
            locked={Boolean(recorder.recording?.active)}
            roomId={info.roomId}
            sentFrames={info.sentFrames}
            receivedFrames={info.receivedFrames}
            onModeChange={handleModeChange}
            onSystemAudioChange={handleSystemAudioChange}
            onPickDir={() => settings.pickDir()}
          />
        </div>
      </div>
      {locked ? (
        <div className="weq-call-locked" role="status">
          应用已锁定
        </div>
      ) : null}
      <HoverTooltip />
    </RenderDocumentContext.Provider>,
    popup.document.body,
  );
}
