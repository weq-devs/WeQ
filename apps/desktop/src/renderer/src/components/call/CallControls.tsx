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
  /** 本端摄像头是否开着。 */
  cameraOn: boolean;
  /** 摄像头按钮是否可用（未接通 / 已结束都不能点）。 */
  cameraEnabled: boolean;
  /** 正在录音（按钮变成「停止」态）。 */
  recording: boolean;
  /** 录音按钮是否可用（未接通 / 已结束 / 请求中都不能点）。 */
  recordingEnabled: boolean;
  finished: boolean;
  hangupPending: boolean;
  onToggleMute: () => void;
  onToggleSpeaker: () => void;
  onToggleCamera: () => void;
  onToggleRecording: () => void;
  onHangup: () => void;
  /** 是否显示「旋转画面」按钮（对端在发视频时才需要）。 */
  canRotate: boolean;
  /** 当前旋转角度。 */
  rotation: 0 | 90 | 270;
  onRotate: () => void;
  /** 额外按钮（未来：屏幕共享）。 */
  extra?: ReactNode;
}

export function CallControls({
  muted,
  speakerOff,
  cameraOn,
  cameraEnabled,
  recording,
  recordingEnabled,
  finished,
  hangupPending,
  onToggleMute,
  onToggleSpeaker,
  onToggleCamera,
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
        title={cameraOn ? '关闭摄像头' : '开启摄像头'}
        aria-pressed={cameraOn}
      >
        {cameraOn ? <Video size={22} /> : <VideoOff size={22} />}
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
