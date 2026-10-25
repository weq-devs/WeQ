/**
 * 录音状态条 / 录音结果卡片。
 *
 * 录音中：红点 + 时长 + 当前模式，贴在波形与操作栏之间（不抢舞台）。
 * 录音结束：变成一张卡片，可以播放、打开所在目录、关掉窗口。
 *
 * 为什么结束后**不自动关窗**：录音是用户主动要留下的东西，窗口一闪而过等于让人
 * 去文件管理器里翻。没录音时仍按原来的行为 1.6 秒后自动关。
 */

import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Pause, Play, X } from 'lucide-react';
import { recordingUrl } from '../../lib/resourceUrl';
import type {
  CallRecordingMode,
  FinishedRecording,
  RecordingState,
} from '../../hooks/useCallRecorder';

const MODE_LABEL: Record<CallRecordingMode, string> = {
  self: '仅本端',
  peer: '仅对方',
  mixed: '双方',
};

export function CallRecorderBar({ recording }: { recording: RecordingState }) {
  return (
    <div className="weq-call-recording" role="status">
      <span className="weq-call-recording-dot" aria-hidden />
      <span className="weq-call-recording-label">录音中</span>
      <span className="weq-call-recording-time">{formatDuration(recording.durationSec)}</span>
      <span className="weq-call-recording-mode">
        {MODE_LABEL[recording.mode]}
        {recording.systemAudio ? ' · 含电脑声音' : ''}
      </span>
    </div>
  );
}

export function CallRecordingCard({
  recording,
  onOpenFolder,
  onClose,
}: {
  recording: FinishedRecording;
  onOpenFolder: () => void;
  onClose: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setPlaying(false);
    setFailed(false);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
  }, [recording.id]);

  const toggle = () => {
    let audio = audioRef.current;
    if (!audio) {
      audio = new Audio(recordingUrl(recording.id));
      audio.onended = () => setPlaying(false);
      audio.onerror = () => {
        setPlaying(false);
        setFailed(true);
      };
      audioRef.current = audio;
    }
    if (playing) {
      audio.pause();
      setPlaying(false);
      return;
    }
    void audio
      .play()
      .then(() => setPlaying(true))
      .catch(() => setFailed(true));
  };

  return (
    <div className="weq-call-recording-card">
      <div className="weq-call-recording-head">
        <span className="weq-call-recording-label">通话录音</span>
        <span className="weq-call-recording-time">{formatDuration(recording.durationSec)}</span>
        <button
          type="button"
          className="weq-call-recording-dismiss"
          onClick={onClose}
          title="关闭窗口"
          aria-label="关闭窗口"
        >
          <X size={14} />
        </button>
      </div>
      <div className="weq-call-recording-body">
        <button
          type="button"
          className="weq-call-recording-play"
          onClick={toggle}
          disabled={failed}
          title={failed ? '录音文件已丢失' : playing ? '暂停' : '播放'}
        >
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <span className="weq-call-recording-meta">
          {failed
            ? '录音文件已丢失'
            : `${MODE_LABEL[recording.mode]}${recording.systemAudio ? ' · 含电脑声音' : ''}`}
        </span>
        <button
          type="button"
          className="weq-call-recording-folder"
          onClick={onOpenFolder}
          title="打开录音目录"
          aria-label="打开录音目录"
        >
          <FolderOpen size={16} />
        </button>
      </div>
    </div>
  );
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
