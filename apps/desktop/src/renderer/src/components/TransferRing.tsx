import { Monitor } from 'lucide-react';
import { useState, type ReactNode, type VideoHTMLAttributes } from 'react';
import { transferPercent, type TransferProgress } from '../../../shared/transfer_progress';
import { useTransferProgress } from '../lib/transferActivity';
import '../styles/transfer-progress.css';

export function transferLabel(progress: TransferProgress): string {
  switch (progress.phase) {
    case 'to-host':
      return '正在传给电脑';
    case 'upload':
      return '正在上传';
    case 'download':
      return '正在下载';
    case 'confirming':
      return '正在确认结果';
    case 'failed':
      return '上传失败';
    default:
      return '正在准备';
  }
}

export function transferDetail(progress: TransferProgress): string | undefined {
  const percent = transferPercent(progress);
  if (percent !== undefined) return `${percent}%`;
  if (progress.items) return `已处理 ${progress.processed ?? 0}/${progress.items} 项`;
  if (progress.processed) return `已处理 ${progress.processed} 项`;
  return undefined;
}

export function TransferRing({
  progress,
  label = transferLabel(progress),
  size = 22,
  center,
}: {
  progress: TransferProgress;
  label?: string;
  size?: number;
  center?: ReactNode;
}) {
  const percent = transferPercent(progress);
  const detail = transferDetail(progress);
  return (
    <span className="weq-transfer-ring" title={detail ? `${label} · ${detail}` : label}>
      <svg
        role="progressbar"
        aria-label={label}
        aria-valuenow={percent}
        aria-valuetext={detail}
        viewBox="0 0 24 24"
        width={size}
        height={size}
        className={percent === undefined ? 'weq-transfer-spinning' : undefined}
      >
        <circle className="weq-transfer-track" cx="12" cy="12" r="10" />
        {percent !== 0 && (
          <circle
            cx="12"
            cy="12"
            r="10"
            pathLength="100"
            strokeDasharray={`${percent ?? 28} 100`}
            strokeLinecap="round"
            transform="rotate(-90 12 12)"
          />
        )}
      </svg>
      {center ??
        (progress.phase === 'to-host' ? (
          <Monitor className="weq-transfer-center" size={size / 2} aria-hidden />
        ) : null)}
    </span>
  );
}

export function TransferSummary({
  progress,
  label,
}: {
  progress: TransferProgress;
  label: string;
}) {
  return (
    <span className="weq-transfer-summary">
      <TransferRing progress={progress} label={label} size={19} />
      <span>{transferDetail(progress) ?? label}</span>
    </span>
  );
}

export function MediaLoadingRing({ label = '正在加载媒体' }: { label?: string }) {
  return (
    <span className="weq-media-loading-ring">
      <TransferRing progress={{ phase: 'preparing' }} label={label} />
    </span>
  );
}

export function MediaTransferBadge({ target }: { target?: string }) {
  const progress = useTransferProgress(target);
  return progress ? (
    <span className="weq-transfer-media-action">
      <TransferRing progress={progress} size={19} />
    </span>
  ) : null;
}

/** 使用播放器的等待状态；时间轴的缓冲比例不是文件字节进度。 */
export function useVideoBuffering(key: string, active: boolean) {
  const [state, setState] = useState({ key: '', waiting: false });
  const start = () => {
    if (active) setState({ key, waiting: true });
  };
  const stop = () =>
    setState((old) => (old.key === key && old.waiting ? { key, waiting: false } : old));
  const events = {
    onLoadStart: start,
    onWaiting: start,
    onPlaying: stop,
    onCanPlay: stop,
    onPause: stop,
    onEnded: stop,
    onError: stop,
  } satisfies VideoHTMLAttributes<HTMLVideoElement>;
  return { events, waiting: active && state.key === key && state.waiting };
}
