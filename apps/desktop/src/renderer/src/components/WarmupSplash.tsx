/**
 * 载入中的启动画面：logo + 进度条（或不确定态的转圈）。
 *
 * 自动进入（BootstrapView）和切换账号（AccountSwitchOverlay）共用。两处都要在
 * 数据齐了之后才放行到 MainView，否则首屏是空白头像 + 默认昵称 "WeQ"。
 *
 * `progress` 为空时显示转圈 + `hint`（用于「正在打开账号」这种拿不到百分比的
 * 阶段）；有值时显示真实的 已完成/总数 百分比。
 */

import { Loader2 } from 'lucide-react';
import type { ReactElement } from 'react';
import { WARMUP_TOTAL, type WarmupProgress } from '../lib/accountWarmup';
import logoUrl from '@resources/brand/logo.png';

export function WarmupSplash({
  progress,
  hint = '正在初始化…',
}: {
  progress?: WarmupProgress | null;
  hint?: string;
}): ReactElement {
  if (!progress) {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <img src={logoUrl} alt="WeQ" width={80} height={80} className="weq-splash-logo" />
        <div className="mt-5 flex items-center gap-2 text-[13px] text-[#3c5368]">
          <Loader2
            className="animate-spin text-[#0099ff]"
            size={15}
            strokeWidth={1.85}
            aria-hidden
          />
          {hint}
        </div>
      </div>
    );
  }

  const pct = Math.round((progress.done / (progress.total || WARMUP_TOTAL)) * 100);
  return (
    <div className="flex h-full flex-col items-center justify-center">
      <img src={logoUrl} alt="WeQ" width={80} height={80} className="weq-splash-logo" />
      <div className="mt-5 w-[260px]">
        <div
          className="weq-splash-track"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="weq-splash-bar" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-2.5 flex items-baseline justify-between text-[12px] text-[#3c5368]">
          <span>{progress.pending ? `正在载入${progress.pending}…` : '即将进入…'}</span>
          <span className="tabular-nums text-[#7a8b9e]">{pct}%</span>
        </div>
      </div>
    </div>
  );
}
