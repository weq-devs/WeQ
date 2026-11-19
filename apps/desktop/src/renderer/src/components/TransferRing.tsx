import { Monitor } from 'lucide-react';
import type { ReactNode } from 'react';
import { transferPercent, type TransferProgress } from '../../../shared/transfer_progress';
import { useTransferProgress } from '../lib/transferActivity';
import { transferDetail, transferLabel } from '../lib/transferPresentation';
import '../styles/transfer-progress.css';

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
