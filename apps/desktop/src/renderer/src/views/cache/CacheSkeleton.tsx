/**
 * Shared skeleton / shimmer placeholders for the 本地资源 (cache) view.
 *
 * The explorers used to show a plain "加载中…" text / spinner while their first
 * page loads. These placeholders mirror the real card / row / grid / table
 * layouts so the loading state reads as a natural continuation of the UI.
 * Every placeholder is debounced (useDebouncedLoading) so fast local queries
 * don't flash a skeleton.
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

/** 网格卡片骨架：方形缩略图 + 底部 caption 条（头像/表情/媒体网格）。 */
export function GridSkeleton({
  cells = 18,
  delayMs = 80,
}: {
  cells?: number;
  delayMs?: number;
}): ReactElement | null {
  return (
    <DebouncedSkeleton delayMs={delayMs}>
      <div className="weq-cache-skel-grid" aria-hidden>
        {Array.from({ length: cells }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 静态占位列表
          <div className="weq-cache-skel-card" key={i}>
            <span className="weq-cache-skel weq-cache-skel-thumb" />
            <span className="weq-cache-skel weq-cache-skel-caption" />
          </div>
        ))}
      </div>
    </DebouncedSkeleton>
  );
}

/** File 目录卡片骨架：4/3 图块 + 两行文字（weq-filecard 布局）。 */
export function FileGridSkeleton({
  cards = 9,
  delayMs = 80,
}: {
  cards?: number;
  delayMs?: number;
}): ReactElement | null {
  return (
    <DebouncedSkeleton delayMs={delayMs}>
      <div className="weq-cache-skel-filegrid" aria-hidden>
        {Array.from({ length: cards }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 静态占位列表
          <div className="weq-cache-skel-card" key={i}>
            <span className="weq-cache-skel weq-cache-skel-filethumb" />
            <span className="weq-cache-skel weq-cache-skel-line" />
            <span className="weq-cache-skel weq-cache-skel-line is-short" />
          </div>
        ))}
      </div>
    </DebouncedSkeleton>
  );
}

/** 列表行骨架：圆角图标块 + 两行文字（下载文件列表行）。 */
export function ListRowsSkeleton({
  rows = 6,
  delayMs = 80,
}: {
  rows?: number;
  delayMs?: number;
}): ReactElement | null {
  return (
    <DebouncedSkeleton delayMs={delayMs}>
      <div className="weq-cache-skel-rows" aria-hidden>
        {Array.from({ length: rows }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 静态占位列表
          <div className="weq-cache-skel-row" key={i}>
            <span className="weq-cache-skel weq-cache-skel-avatar" />
            <span className="weq-cache-skel-main">
              <span className="weq-cache-skel weq-cache-skel-line" />
              <span className="weq-cache-skel weq-cache-skel-line is-short" />
            </span>
          </div>
        ))}
      </div>
    </DebouncedSkeleton>
  );
}

/** 数据库对象树骨架：组标题条 + 若干行条。 */
export function TreeSkeleton({ delayMs = 80 }: { delayMs?: number }): ReactElement | null {
  return (
    <DebouncedSkeleton delayMs={delayMs}>
      <div className="weq-cache-skel-tree" aria-hidden>
        <span className="weq-cache-skel weq-cache-skel-tree-head" />
        {Array.from({ length: 5 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 静态占位列表
          <span className="weq-cache-skel weq-cache-skel-tree-line" key={i} />
        ))}
        <span className="weq-cache-skel weq-cache-skel-tree-head is-muted" />
        {Array.from({ length: 2 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 静态占位列表
          <span className="weq-cache-skel weq-cache-skel-tree-line is-short" key={i} />
        ))}
      </div>
    </DebouncedSkeleton>
  );
}

/** 数据库数据表格骨架：表头行 + 若干行单元格。 */
export function TableSkeleton({
  rows = 7,
  cols = 5,
  delayMs = 80,
}: {
  rows?: number;
  cols?: number;
  delayMs?: number;
}): ReactElement | null {
  return (
    <DebouncedSkeleton delayMs={delayMs}>
      <div className="weq-cache-skel-table" aria-hidden>
        <div className="weq-cache-skel-table-row is-head">
          {Array.from({ length: cols }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 静态占位列表
            <span className="weq-cache-skel weq-cache-skel-table-cell" key={i} />
          ))}
        </div>
        {Array.from({ length: rows }, (_, r) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 静态占位列表
          <div className="weq-cache-skel-table-row" key={r}>
            {Array.from({ length: cols }, (_, c) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: 静态占位列表
                key={c}
                className={`weq-cache-skel weq-cache-skel-table-cell${
                  (r + c) % 3 === 0 ? ' is-short' : ''
                }`}
              />
            ))}
          </div>
        ))}
      </div>
    </DebouncedSkeleton>
  );
}

/** chips 骨架（分组 / 收藏类型）。 */
export function ChipsSkeleton({
  chips = 5,
  delayMs = 80,
}: {
  chips?: number;
  delayMs?: number;
}): ReactElement | null {
  return (
    <DebouncedSkeleton delayMs={delayMs}>
      <div className="weq-cache-skel-chips" aria-hidden>
        {Array.from({ length: chips }, (_, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: 静态占位列表
            key={i}
            className={`weq-cache-skel weq-cache-skel-chip${i % 2 === 0 ? ' is-wide' : ''}`}
          />
        ))}
      </div>
    </DebouncedSkeleton>
  );
}

/** 信息面板骨架：label / value 行（商城表情包详情等信息条）。 */
export function InfoPanelSkeleton({
  rows = 3,
  delayMs = 80,
}: {
  rows?: number;
  delayMs?: number;
}): ReactElement | null {
  return (
    <DebouncedSkeleton delayMs={delayMs}>
      <div className="weq-cache-skel-infopanel" aria-hidden>
        {Array.from({ length: rows }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 静态占位列表
          <div className="weq-cache-skel-infopanel-row" key={i}>
            <span className="weq-cache-skel weq-cache-skel-infopanel-label" />
            <span className="weq-cache-skel weq-cache-skel-infopanel-val" />
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
      <div className="weq-cache-skel-footer" aria-hidden>
        <span className="weq-cache-skel weq-cache-skel-footer-bar" />
      </div>
    </DebouncedSkeleton>
  );
}

/** 顶栏内联加载提示骨架（tab 行「扫描中…」/ 下拉「加载中…」）。 */
export function InlineSkeleton({
  width = 96,
  delayMs = 80,
}: {
  width?: number;
  delayMs?: number;
}): ReactElement | null {
  return (
    <DebouncedSkeleton delayMs={delayMs}>
      <span className="weq-cache-skel weq-cache-skel-inline" style={{ width }} aria-hidden />
    </DebouncedSkeleton>
  );
}
