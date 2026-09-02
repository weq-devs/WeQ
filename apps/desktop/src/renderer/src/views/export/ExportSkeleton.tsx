/**
 * Shared skeleton / shimmer placeholders for the 导出 (export hub) view.
 *
 * The pickers used to show a plain spinner + "加载中…" while their data loads.
 * These placeholders mirror the real list rows / chips / schedule cards so the
 * loading state reads as a natural continuation of the UI. Every placeholder is
 * debounced (useDebouncedLoading) so fast queries don't flash a skeleton.
 */

import type { ReactElement } from 'react';
import { useDebouncedLoading } from '../../hooks/useDebouncedLoading';

/** 延迟显示包装：loading 持续不足 delayMs 时不渲染，避免快速查询闪骨架。 */
function DebouncedSkeleton({
  delayMs = 80,
  children,
}: {
  delayMs?: number;
  children: ReactElement;
}): ReactElement | null {
  const visible = useDebouncedLoading(true, delayMs);
  if (!visible) return null;
  return children;
}

/** 列表行骨架：圆形头像 + 两行文字（会话/数据库/好友/收藏预览列表）。 */
export function PickerListSkeleton({
  rows = 7,
  delayMs = 80,
}: {
  rows?: number;
  delayMs?: number;
}): ReactElement | null {
  return (
    <DebouncedSkeleton delayMs={delayMs}>
      <div className="weq-exp-skel-rows" aria-hidden>
        {Array.from({ length: rows }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 静态占位列表
          <div className="weq-exp-skel-row" key={i}>
            <span className="weq-exp-skel weq-exp-skel-avatar" />
            <span className="weq-exp-skel-main">
              <span className="weq-exp-skel weq-exp-skel-line" />
              <span className="weq-exp-skel weq-exp-skel-line is-short" />
            </span>
          </div>
        ))}
      </div>
    </DebouncedSkeleton>
  );
}

/** chips 骨架（好友分组 / 收藏类型）。 */
export function ChipsSkeleton({
  chips = 5,
  delayMs = 80,
}: {
  chips?: number;
  delayMs?: number;
}): ReactElement | null {
  return (
    <DebouncedSkeleton delayMs={delayMs}>
      <div className="weq-exp-skel-chips" aria-hidden>
        {Array.from({ length: chips }, (_, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: 静态占位列表
            key={i}
            className={`weq-exp-skel weq-exp-skel-chip${i % 2 === 0 ? ' is-wide' : ''}`}
          />
        ))}
      </div>
    </DebouncedSkeleton>
  );
}

/** 表情/封面网格骨架（商城表情包等网格）。 */
export function GridSkeleton({
  cells = 12,
  delayMs = 80,
}: {
  cells?: number;
  delayMs?: number;
}): ReactElement | null {
  return (
    <DebouncedSkeleton delayMs={delayMs}>
      <div className="weq-exp-skel-grid" aria-hidden>
        {Array.from({ length: cells }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 静态占位列表
          <div className="weq-exp-skel-grid-card" key={i}>
            <span className="weq-exp-skel weq-exp-skel-grid-thumb" />
          </div>
        ))}
      </div>
    </DebouncedSkeleton>
  );
}

/** 无限滚动 footer 加载态：一行居中短条。 */
export function FooterSkeleton({ delayMs = 80 }: { delayMs?: number }): ReactElement | null {
  return (
    <DebouncedSkeleton delayMs={delayMs}>
      <div className="weq-exp-skel-footer" aria-hidden>
        <span className="weq-exp-skel weq-exp-skel-footer-bar" />
      </div>
    </DebouncedSkeleton>
  );
}

/** 定时任务列表骨架：卡片顶部名称/标签 + meta 行（weq-exp-sched-card 布局）。 */
export function ScheduleListSkeleton({
  cards = 2,
  delayMs = 80,
}: {
  cards?: number;
  delayMs?: number;
}): ReactElement | null {
  return (
    <DebouncedSkeleton delayMs={delayMs}>
      <div className="weq-exp-skel-sched" aria-hidden>
        {Array.from({ length: cards }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 静态占位列表
          <div className="weq-exp-skel-sched-card" key={i}>
            <span className="weq-exp-skel-sched-top">
              <span className="weq-exp-skel weq-exp-skel-sched-name" />
              <span className="weq-exp-skel weq-exp-skel-sched-tag" />
              <span className="weq-exp-skel weq-exp-skel-sched-tag is-short" />
            </span>
            <span className="weq-exp-skel-sched-meta">
              <span className="weq-exp-skel weq-exp-skel-sched-meta-item" />
              <span className="weq-exp-skel weq-exp-skel-sched-meta-item is-short" />
              <span className="weq-exp-skel weq-exp-skel-sched-meta-item" />
            </span>
          </div>
        ))}
      </div>
    </DebouncedSkeleton>
  );
}
