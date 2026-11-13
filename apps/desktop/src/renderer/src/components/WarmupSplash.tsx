import type { ReactElement } from 'react';
import type { WarmupProgress } from '../lib/accountWarmup';
import logoUrl from '@resources/brand/logo.png';
import '../styles/startup-home.css';
import '../styles/startup-progress.css';
import { useStartupProgress } from '../state/startupProgress';

/** 冷启动共用整条阶段进度；启动完成后的切号预热保留独立进度。 */
export function WarmupSplash({
  progress,
  hint = '正在检查启动环境',
}: {
  progress?: WarmupProgress | null;
  hint?: string;
}): ReactElement {
  const startup = useStartupProgress();
  const percent = startup.active
    ? startup.percent
    : progress
      ? Math.round((progress.done / Math.max(1, progress.total)) * 100)
      : null;
  const message = progress
    ? progress.pending
      ? `正在载入${progress.pending}…`
      : '正在准备会话界面'
    : hint;
  return (
    <div className="weq-warmup" role="status">
      <img src={logoUrl} alt="WeQ" width={80} height={80} className="weq-warmup-logo" />
      <div className="weq-warmup-progress">
        <div
          className="weq-warmup-track"
          role="progressbar"
          aria-label="启动进度"
          aria-valuetext={message}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
        >
          <div
            className="weq-warmup-bar"
            data-determinate={percent !== null || undefined}
            style={percent === null ? undefined : { width: `${percent}%` }}
          />
        </div>
        <div className="weq-warmup-status">
          <span>{message}</span>
          {percent !== null && <span className="weq-warmup-count">{percent}%</span>}
        </div>
      </div>
    </div>
  );
}
