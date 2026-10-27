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
import { requestOpenSettings } from '../lib/callSettingsBridge';
import { useToolWindow } from '../hooks/useCompositionWindow';
import { useCallAudio } from '../hooks/useCallAudio';
import { nextRotation } from '../lib/callVideo';
import { SCREEN_PROFILE, type VideoProfile } from '../../../shared/call_video_profile';
import { useCallVideo } from '../hooks/useCallVideo';
import { useCallCamera } from '../hooks/useCallCamera';
import { useCallScreen } from '../hooks/useCallScreen';
import { useCallRecorder } from '../hooks/useCallRecorder';
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
import '../styles/call-video.css';

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
  /** 本端摄像头是否开着。 */
  videoSending: boolean;
  /** 对端是否在发视频。 */
  videoReceiving: boolean;
  receivedVideoFrames: number;
  videoInfo: { width: number; height: number; profile: number; codec: 'hevc' } | null;
  /** 本端画面来源（摄像头 / 屏幕共享）。协议层不区分，只影响本端显示。 */
  videoSource: 'camera' | 'screen';
  /** 本端视频编码档位；还没开过视频为 null。 */
  videoProfile: {
    width: number;
    height: number;
    fps: number;
    bitrateKbps: number;
  } | null;
}

/**
 * 主进程实际生效的编码档位 → 采集档位。
 *
 * 采集必须与编码器**同尺寸**：编码器按自己的宽高校验 I420 平面长度，对不上就
 * 静默丢帧。主进程在切换采集源时会换档（摄像头 640×360 ↔ 共享 1280×720），
 * 这里把它读回来，`useVideoCapture` 再按这个上限约束采集端。
 *
 * `videoProfile` 为 null（还没开过视频）时退回共享档位的默认值。
 */
function screenProfile(profile: CallInfo['videoProfile']): VideoProfile {
  if (!profile) return SCREEN_PROFILE;
  return {
    width: profile.width,
    height: profile.height,
    fps: profile.fps || SCREEN_PROFILE.fps,
    bitrateKbps: profile.bitrateKbps || SCREEN_PROFILE.bitrateKbps,
    // 采集端直接要目标尺寸，省掉一次缩放（见 shared/call_video_profile.ts）。
    captureWidth: profile.width,
    captureHeight: profile.height,
  };
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
  /**
   * 对端画面的旋转角度（用户手动切）。
   *
   * 不通话时归零：下一通可能换个设备，沿用上一通的角度只会让人先看到歪的。
   */
  const [peerRotation, setPeerRotation] = useState<0 | 90 | 270>(0);

  const finished = info.state === 'ended' || info.state === 'failed';
  const live = info.state === 'connected';
  /**
   * 对端是否在发视频。
   *
   * ⚠️ **必须叠加 `live`。** 挂断后服务端的最后一次快照里 `videoReceiving` 仍可能
   * 是 true（看门狗还没来得及把它收敛），于是界面在「已挂断」之后还挂着
   * 「等待对方画面…」的加载态 —— 通话都结束了，等的那块画面永远不会来。
   */
  const peerVideoOn = live && info.videoReceiving;
  /** 对端在发视频（或本端开着摄像头）时才有必要跑解码 / 画中画。 */
  const videoLayout = peerVideoOn || info.videoSending;
  const peerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const selfCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoEnabled = peerVideoOn;
  const video = useCallVideo({
    enabled: videoEnabled,
    canvasRef: peerCanvasRef,
    rotate: peerRotation,
  });
  /**
   * 本端画面：摄像头与屏幕共享**互斥**。
   *
   * 两者共用同一条采集管线（`useVideoCapture`），差别只在于拿流的方式与编码档位。
   * 协议侧完全一致 —— 都是一路普通主视频流，所以对端看到的画面是一样的。
   */
  const screenSharing = info.videoSource === 'screen';
  const capturing = live && info.videoSending;
  // 摄像头：共享时不采集（否则摄像头指示灯会亮着、白占一路解码）。
  const camera = useCallCamera({ enabled: capturing && !screenSharing });
  // 屏幕共享：档位以主进程实际生效的为准（它可能因源宽高比而微调）。
  const screen = useCallScreen({
    enabled: capturing && screenSharing,
    profile: screenProfile(info.videoProfile),
    onEnded: () => {
      // 用户在系统共享栏点了「停止共享」：轨道自己结束了，把状态切回摄像头。
      // 不这么做界面会一直停在「共享中」，而且再也收不到新帧。
      void switchSourceRef.current?.('camera');
    },
  });
  /** 当前生效的采集状态（摄像头或屏幕）。 */
  const capture = screenSharing ? screen : camera;
  // 采集错误要告诉用户（权限被拒 / 没有设备 / 用户取消），否则会以为「点了没反应」。
  useEffect(() => {
    if (!capture.error) return;
    useToast.getState().push({
      tone: 'warning',
      message: screenSharing ? '无法共享屏幕' : '无法打开摄像头',
      detail: capture.error,
    });
  }, [capture.error, screenSharing]);

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
  /**
   * 语音是竖屏（400×620，留给大头像与波形），视频是横屏（16:9 的画面）。
   *
   * 窗口尺寸只在 `open()` 时定，所以这里在布局切换时自己 `resizeTo` ——
   * 保持左上角不动、按比例换宽高，用户手动改过的尺寸会被这一次切换覆盖，
   * 但之后不再干预（只在 `videoLayout` 真变化时跑）。
   */
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

  /**
   * 布局切换时换窗口尺寸。
   *
   * 语音 400×620（竖屏），视频 720×480（横屏 3:2，容得下 16:9 画面 + 底部控件）。
   * 只在「有没有视频」这件事真的变化时跑，避免每次状态推送都 resize。
   */
  const sizedForVideo = useRef(false);
  useEffect(() => {
    const popup = tool.popup;
    if (!popup || popup.closed) return;
    if (sizedForVideo.current === videoLayout) return;
    sizedForVideo.current = videoLayout;
    try {
      popup.resizeTo(videoLayout ? 720 : 400, videoLayout ? 480 : 620);
    } catch {
      // 某些窗口管理器会拒绝 resizeTo，退化成让 CSS 自己适配即可。
    }
  }, [tool.popup, videoLayout]);

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

  /** 旋转按钮：0° → 顺时针 90° → 逆时针 90° → 0°。 */
  const handleRotate = useCallback(() => {
    setPeerRotation((current) => nextRotation(current));
  }, []);

  /**
   * 摄像头开关。
   *
   * 主进程只发控制信令并切发送状态；画面由渲染层的采集管线推过去。
   *
   * ⚠️ 共享屏幕时这个键**只切回摄像头、不关视频** —— 按钮提示写的是「关闭共享
   * （回到摄像头）」，用户点它期待的是切回摄像头继续通话，而不是画面整个没了。
   * 要彻底停止发画面，用「停止共享」按钮。
   */
  /** 切采集源（在 `switchSource` 定义之后赋值；这里先声明，供回调引用）。 */
  const switchSourceRef = useRef<((source: 'camera' | 'screen') => Promise<void>) | null>(null);

  const setCamera = trpc.call.setCamera.useMutation();
  const cameraPending = useRef(false);
  const handleToggleCamera = useCallback(() => {
    if (cameraPending.current) return;
    if (screenSharing) {
      // 已开着视频，只需要换采集源；`setCamera` 保持 true。
      void switchSourceRef.current?.('camera');
      return;
    }
    cameraPending.current = true;
    const next = !info.videoSending;
    setCamera.mutate({ enabled: next }, { onSettled: () => (cameraPending.current = false) });
  }, [info.videoSending, screenSharing, setCamera]);

  /**
   * 屏幕共享开关（与摄像头互斥的切换式）。
   *
   * 流程：切主进程采集源（重开编码器、换档位）→ 渲染层按新档位重新采集。
   * 目标分辨率跟着源宽高比走，采集拿到真实尺寸后再回头让主进程对齐编码器
   * （见 `useVideoCapture` 的尺寸推导与 `resizeVideo`）。
   */
  const setVideoSource = trpc.call.setVideoSource.useMutation();
  const resizeVideo = trpc.call.resizeVideo.useMutation();
  const sourcePending = useRef(false);
  const [sourceBusy, setSourceBusy] = useState(false);

  /**
   * 切换采集源。返回 Promise 以便调用方串接（比如「先切回摄像头再关视频」）。
   *
   * 用 ref 暴露给 `onEnded` 这类长生命周期回调：它们拿不到最新的闭包。
   */
  const switchSource = useCallback(
    async (source: 'camera' | 'screen') => {
      if (sourcePending.current) return;
      if (info.videoSource === source) return;
      sourcePending.current = true;
      setSourceBusy(true);
      try {
        const result = await setVideoSource.mutateAsync({ source });
        if (!result.ok) {
          useToast.getState().push({
            tone: 'warning',
            message: source === 'screen' ? '无法开始共享屏幕' : '无法切回摄像头',
            detail: '通话可能已经结束。',
          });
        }
      } catch (error) {
        useToast.getState().push({
          tone: 'warning',
          message: source === 'screen' ? '无法开始共享屏幕' : '无法切回摄像头',
          detail: error instanceof Error ? error.message : String(error),
        });
      } finally {
        sourcePending.current = false;
        setSourceBusy(false);
      }
    },
    [info.videoSource, setVideoSource],
  );
  switchSourceRef.current = switchSource;

  const handleToggleScreenShare = useCallback(() => {
    void switchSource(screenSharing ? 'camera' : 'screen');
  }, [screenSharing, switchSource]);

  /**
   * 采集尺寸与编码器对齐。
   *
   * 共享超宽屏 / 4:3 屏时，渲染层会按源比例推出一个非 16:9 的尺寸；编码器必须
   * 跟着改，否则 `pushFrame` 的平面长度校验不通过、帧会被静默丢掉（表现就是
   * 「点了共享，对方什么都看不到」）。
   */
  useEffect(() => {
    if (!capture.active || capture.width <= 0 || capture.height <= 0) return;
    if (
      capture.width === info.videoProfile?.width &&
      capture.height === info.videoProfile?.height
    ) {
      return;
    }
    resizeVideo.mutate({ width: capture.width, height: capture.height });
  }, [capture.active, capture.width, capture.height, info.videoProfile, resizeVideo]);

  /** 打开设置页的「通话与录音」。通话窗口不关，用户回来还能继续。 */
  const openSettings = useCallback(() => {
    requestOpenSettings('callRecording');
  }, []);
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
            peerCanvasRef={peerVideoOn ? peerCanvasRef : undefined}
            peerVideoActive={video.active}
            peerVideoOn={peerVideoOn}
            selfCanvasRef={videoLayout ? selfCanvasRef : undefined}
            selfVideoOn={info.videoSending}
            selfVideoElement={capture.video}
            selfVideoSource={info.videoSource}
            videoError={video.supported ? video.error : (video.error ?? '当前环境不支持视频解码')}
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
            cameraOn={info.videoSending}
            cameraEnabled={live}
            screenSharing={screenSharing}
            screenSharingPending={sourceBusy}
            screenShareEnabled={live}
            recording={Boolean(recorder.recording?.active)}
            recordingEnabled={live && !recorder.busy}
            finished={finished}
            hangupPending={hangup.isPending}
            onToggleMute={() => setMuted((value) => !value)}
            onToggleSpeaker={() => setSpeakerOff((value) => !value)}
            onToggleCamera={handleToggleCamera}
            onToggleScreenShare={handleToggleScreenShare}
            onToggleRecording={handleToggleRecording}
            onHangup={handleHangup}
            canRotate={peerVideoOn}
            rotation={peerRotation}
            onRotate={handleRotate}
          />

          <CallSettingsDrawer
            roomId={info.roomId}
            sentFrames={info.sentFrames}
            receivedFrames={info.receivedFrames}
            videoSending={info.videoSending}
            videoReceiving={info.videoReceiving}
            receivedVideoFrames={info.receivedVideoFrames}
            videoSize={info.videoInfo}
            onOpenSettings={openSettings}
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
