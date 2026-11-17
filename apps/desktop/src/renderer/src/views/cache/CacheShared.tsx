import { NumericText } from '../../components/NumericText';
/**
 * Shared bits for the 本地资源 (cache) view: formatting helpers, the file-browser
 * toolbar + offset-paged infinite-scroll hook, the cursor-paged infinite-scroll
 * hook used by every emoji / avatar / media grid, the grid footer, and the
 * generic lightbox shell. Everything here is UI plumbing the explorers would
 * otherwise each re-implement (they used to carry five near-identical copies of
 * the cursor hook + footer + lightbox + `fmtBytes`).
 */

import type { ReactElement, ReactNode } from 'react';
import {
  Files,
  Package,
  Search,
  ArrowDownWideNarrow,
  ArrowUpWideNarrow,
  RefreshCw,
  X,
} from 'lucide-react';
import type { FileCategory, FileSortKey, FileSortOrder } from '@weq/service';
import { FooterSkeleton } from './CacheSkeleton';
import { EmptyState } from '../../components/EmptyState';
import { OverlayLayer } from '../../components/OverlayLayer';
import { type CategoryTab, CATEGORY_ORDER, CATEGORY_META, cn } from './CacheShared.shared';

const SORT_META: Record<FileSortKey, string> = {
  time: '时间',
  name: '名称',
  size: '大小',
};
const SORT_KEYS: FileSortKey[] = ['time', 'name', 'size'];

// ── toolbar ─────────────────────────────────────────────────────────────────

export interface ToolbarState {
  category: CategoryTab;
  search: string;
  sort: FileSortKey;
  order: FileSortOrder;
}

export function FileResourceToolbar({
  state,
  onChange,
  counts,
  total,
  onRefresh,
  refreshing,
}: {
  state: ToolbarState;
  onChange: (next: Partial<ToolbarState>) => void;
  /** Per-category counts (drives the tab badges); `null` while loading. */
  counts: Record<FileCategory, number> | null;
  total: number;
  onRefresh: () => void;
  refreshing: boolean;
}): ReactElement {
  // Present categories only (count > 0), plus the always-on 全部 tab.
  const present = CATEGORY_ORDER.filter((c) => (counts ? counts[c] > 0 : false));
  const tabs: CategoryTab[] = ['all', ...present];

  return (
    <div className="weq-filebrowser-toolbar">
      <div className="weq-filebrowser-tabs" role="tablist">
        {tabs.map((c) => (
          <button
            key={c}
            type="button"
            role="tab"
            className={`weq-filebrowser-tab${c === state.category ? ' is-on' : ''}`}
            aria-selected={c === state.category}
            onClick={() => onChange({ category: c })}
          >
            {CATEGORY_META[c].icon}
            <span>{CATEGORY_META[c].label}</span>
            <em className="weq-filebrowser-tabcount">
              <span className="weq-number weq-number-inherit">
                {c === 'all' ? total : (counts?.[c as FileCategory] ?? 0)}
              </span>
            </em>
          </button>
        ))}
      </div>

      <div className="weq-filebrowser-controls">
        <label className="weq-filebrowser-search">
          <Search size={13} aria-hidden />
          <input
            type="text"
            value={state.search}
            placeholder="搜索文件名…"
            onChange={(e) => onChange({ search: e.target.value })}
          />
        </label>

        <div className="weq-filebrowser-sort">
          {SORT_KEYS.map((k) => (
            <button
              key={k}
              type="button"
              className={`weq-filebrowser-sortkey${k === state.sort ? ' is-on' : ''}`}
              onClick={() => onChange({ sort: k })}
            >
              {SORT_META[k]}
            </button>
          ))}
          <button
            type="button"
            className="weq-filebrowser-order"
            title={state.order === 'desc' ? '降序（点击切升序）' : '升序（点击切降序）'}
            onClick={() => onChange({ order: state.order === 'desc' ? 'asc' : 'desc' })}
          >
            {state.order === 'desc' ? (
              <ArrowDownWideNarrow size={15} />
            ) : (
              <ArrowUpWideNarrow size={15} />
            )}
          </button>
        </div>

        <button
          type="button"
          className="weq-filebrowser-refresh"
          title="重新扫描"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <RefreshCw size={14} className={refreshing ? 'is-spin' : ''} />
        </button>
      </div>
    </div>
  );
}

/** Footer row for the infinite-scroll list (sentinel / loading / end state). */
export function ListFooter({
  loading,
  done,
  count,
  sentinelRef,
}: {
  loading: boolean;
  done: boolean;
  count: number;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
}): ReactElement {
  if (done) {
    if (count === 0) return <EmptyState compact icon={<Files />} title="没有匹配的文件" />;
    return (
      <div className="weq-filebrowser-more is-end">
        <NumericText>{`已全部加载（${count}）`}</NumericText>
      </div>
    );
  }
  if (loading) {
    return (
      <div ref={sentinelRef} className="weq-filebrowser-more">
        <FooterSkeleton />
      </div>
    );
  }
  return (
    <div ref={sentinelRef} className="weq-filebrowser-more">
      <RefreshCw size={14} />
      滚动加载更多
    </div>
  );
}

/** Footer row for a cursor-paged grid (sentinel / loading / end state). */
export function GridFooter({
  loading,
  done,
  count,
  sentinelRef,
}: {
  loading: boolean;
  done: boolean;
  count: number;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
}): ReactElement {
  if (done) {
    if (count === 0) return <EmptyState compact icon={<Package />} title="该分类暂无缓存" />;
    return (
      <div className="weq-cache-avatar-more is-end">
        <NumericText>{`已全部加载（${count}）`}</NumericText>
      </div>
    );
  }
  if (loading) {
    return (
      <div ref={sentinelRef} className="weq-cache-avatar-more">
        <FooterSkeleton />
      </div>
    );
  }
  return (
    <div ref={sentinelRef} className="weq-cache-avatar-more">
      <RefreshCw size={14} />
      滚动加载更多
    </div>
  );
}

// ── lightbox shell (blob overlay/dialog) ───────────────────────────────────────

/**
 * The generic `weq-blob-*` lightbox shell every resource lightbox shares:
 * dimmed overlay + centered dialog with a title/meta header and a close button.
 * Clicking the overlay closes it; clicks inside the dialog don't bubble out.
 * `dialogClass` / `bodyClass` carry each lightbox's specific sizing/grid styles.
 */
export function BlobDialog({
  dialogClass,
  bodyClass,
  title,
  meta,
  onClose,
  children,
}: {
  dialogClass?: string;
  bodyClass?: string;
  title: string;
  meta: string;
  onClose: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <OverlayLayer className="weq-blob-overlay" onClose={onClose}>
      <div
        className={cn('weq-blob-dialog', dialogClass)}
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="weq-blob-head">
          <div className="weq-blob-title">
            <h3>{title}</h3>
            <code>{meta}</code>
          </div>
          <button type="button" className="weq-blob-close" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>
        <div className={cn('weq-blob-body', bodyClass)}>{children}</div>
      </div>
    </OverlayLayer>
  );
}
export type { CategoryTab, PagedResult, CursorPage, CursorPagedResult } from './CacheShared.shared';
