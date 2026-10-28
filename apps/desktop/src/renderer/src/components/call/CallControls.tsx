/**
 * 通话底部操作栏。
 *
 * 按钮：麦克风、摄像头、录音、挂断、扬声器。挂断永远保持最显眼的位置。
 */

import type { ReactNode } from 'react';
import {
  Disc,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  RotateCcw,
  RotateCw,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
} from 'lucide-react';

export interface CallControlsProps {
  muted: boolean;
  speakerOff: boolean;
  /** 本端摄像头是否开着（屏幕共享时这个值也是 true —— 都算「在发画面」）。 */
  cameraOn: boolean;
  /** 摄像头按钮是否可用（未接通 / 已结束都不能点）。 */
  cameraEnabled: boolean;
  /**
   * 本端画面是否来自屏幕共享。
   *
   * 摄像头与共享**互斥**：共享时摄像头按钮变成「切回摄像头」。
   */
  screenSharing: boolean;
  /** 切换屏幕共享中（正在申请采集 / 重开编码器），按钮置灰防连点。 */
  screenSharingPending: boolean;
  /** 共享按钮是否可用（未接通 / 已结束都不能点）。 */
  screenShareEnabled: boolean;
  /** 正在录音（按钮变成「停止」态）。 */
  recording: boolean;
  /** 录音按钮是否可用（未接通 / 已结束 / 请求中都不能点）。 */
  recordingEnabled: boolean;
  finished: boolean;
  hangupPending: boolean;
  onToggleMute: () => void;
  onToggleSpeaker: () => void;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onToggleRecording: () => void;
  onHangup: () => void;
  /** 是否显示「旋转画面」按钮（对端在发视频时才需要）。 */
  canRotate: boolean;
  /** 当前旋转角度。 */
  rotation: 0 | 90 | 270;
  onRotate: () => void;
  /** 额外按钮。 */
  extra?: ReactNode;
}

export function CallControls({
  muted,
  speakerOff,
  cameraOn,
  cameraEnabled,
  screenSharing,
  screenSharingPending,
  screenShareEnabled,
  recording,
  recordingEnabled,
  finished,
  hangupPending,
  onToggleMute,
  onToggleSpeaker,
  onToggleCamera,
  onToggleScreenShare,
  onToggleRecording,
  onHangup,
  canRotate,
  rotation,
  onRotate,
  extra,
}: CallControlsProps) {
  return (
    <div className="weq-call-actions">
      <button
        type="button"
        className={`weq-call-btn${muted ? ' is-off' : ''}`}
        onClick={onToggleMute}
        disabled={finished}
        title={muted ? '取消静音' : '静音'}
        aria-pressed={muted}
      >
        {muted ? <MicOff size={22} /> : <Mic size={22} />}
      </button>

      <button
        type="button"
        className={`weq-call-btn${cameraOn ? '' : ' is-off'}`}
        onClick={onToggleCamera}
        disabled={finished || !cameraEnabled}
        title={screenSharing ? '关闭共享（回到摄像头）' : cameraOn ? '关闭摄像头' : '开启摄像头'}
        aria-pressed={cameraOn}
        data-source={screenSharing ? 'screen' : 'camera'}
      >
        {cameraOn ? <Video size={22} /> : <VideoOff size={22} />}
      </button>

      {/* 屏幕共享。与摄像头互斥：点它就切到共享，再点一次切回摄像头。
          协议侧与摄像头完全一致，只是采集源换掉，所以对端不会看到「共享中」
          的独立提示，但能看到屏幕画面。 */}
      <button
        type="button"
        className={`weq-call-btn${screenSharing ? ' is-active' : ''}`}
        onClick={onToggleScreenShare}
        disabled={finished || !screenShareEnabled || screenSharingPending}
        title={screenSharing ? '停止共享屏幕' : '共享屏幕'}
        aria-pressed={screenSharing}
      >
        <MonitorUp size={22} />
      </button>

      <button
        type="button"
        className={`weq-call-btn weq-call-btn-record${recording ? ' is-recording' : ''}`}
        onClick={onToggleRecording}
        disabled={finished || !recordingEnabled}
        title={recording ? '停止录音' : '开始录音'}
        aria-pressed={recording}
      >
        <Disc size={22} />
      </button>

      {/* 画面方向只能由用户判断：码流里没有任何朝向信息（见 lib/callVideo.ts 的
          PEER_ROTATE 注释），所以给一个按钮而不是自动转。 */}
      {canRotate ? (
        <button
          type="button"
          className={`weq-call-btn${rotation === 0 ? ' is-off' : ''}`}
          onClick={onRotate}
          disabled={finished}
          title={rotation === 0 ? '旋转画面' : `再转一次（当前 ${rotation}°）`}
          aria-label="旋转对方画面"
          data-rotation={rotation}
        >
          {rotation === 270 ? <RotateCcw size={22} /> : <RotateCw size={22} />}
        </button>
      ) : null}

      {extra}

      <button
        type="button"
        className="weq-call-btn is-hangup"
        onClick={onHangup}
        disabled={finished || hangupPending}
        title="挂断"
      >
        <PhoneOff size={26} />
      </button>

      <button
        type="button"
        className={`weq-call-btn${speakerOff ? ' is-off' : ''}`}
        onClick={onToggleSpeaker}
        disabled={finished}
        title={speakerOff ? '打开声音' : '关闭声音'}
        aria-pressed={speakerOff}
      >
        {speakerOff ? <VolumeX size={22} /> : <Volume2 size={22} />}
      </button>
    </div>
  );
}
