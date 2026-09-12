/**
 * Shared bits for the 本地资源 (cache) view: formatting helpers, the file-browser
 * toolbar + offset-paged infinite-scroll hook, the cursor-paged infinite-scroll
 * hook used by every emoji / avatar / media grid, the grid footer, and the
 * generic lightbox shell. Everything here is UI plumbing the explorers would
 * otherwise each re-implement (they used to carry five near-identical copies of
 * the cursor hook + footer + lightbox + `fmtBytes`).
 */

import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import {
  Files,
  Image as ImageIcon,
  Film,
  Music,
  FileText,
  Archive,
  Code,
  Package,
  File as FileIcon,
  Search,
  ArrowDownWideNarrow,
  ArrowUpWideNarrow,
  RefreshCw,
  X,
} from 'lucide-react';
import type { FileCategory, FileSortKey, FileSortOrder } from '@weq/service';
import { FooterSkeleton } from './CacheSkeleton';

/** `all` (the landing tab) plus the real categories. */
export type CategoryTab = FileCategory | 'all';

export const CATEGORY_META: Record<CategoryTab, { label: string; icon: ReactElement }> = {
  all: { label: '全部', icon: <Files size={14} /> },
  image: { label: '图片', icon: <ImageIcon size={14} /> },
  video: { label: '视频', icon: <Film size={14} /> },
  audio: { label: '音频', icon: <Music size={14} /> },
  document: { label: '文档', icon: <FileText size={14} /> },
  archive: { label: '压缩包', icon: <Archive size={14} /> },
  code: { label: '代码', icon: <Code size={14} /> },
  program: { label: '程序', icon: <Package size={14} /> },
  other: { label: '其它', icon: <FileIcon size={14} /> },
};

/** Category order for the tab row. */
export const CATEGORY_ORDER: FileCategory[] = [
  'image',
  'video',
  'audio',
  'document',
  'archive',
  'code',
  'program',
  'other',
];

const SORT_META: Record<FileSortKey, string> = {
  time: '时间',
  name: '名称',
  size: '大小',
};
const SORT_KEYS: FileSortKey[] = ['time', 'name', 'size'];

export function fmtBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function fmtDate(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The category is an image kind — used to decide whether to try an inline preview. */
export function isImageCategory(cat: FileCategory): boolean {
  return cat === 'image';
}

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
              {c === 'all' ? total : (counts?.[c as FileCategory] ?? 0)}
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

// ── paged infinite-scroll hook ────────────────────────────────────────────────

const PAGE = 80;

export interface PagedResult<T> {
  entries: T[];
  total: number;
  loading: boolean;
  error: string | null;
  done: boolean;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Offset-paged loader with an IntersectionObserver sentinel. `fetchPage` pulls
 * one page for the current filter; changing `filterKey` resets the list and
 * reloads from offset 0. All fetches are async off the render thread.
 */
export function usePagedList<T>(
  fetchPage: (offset: number, limit: number) => Promise<{ entries: T[]; total: number }>,
  filterKey: string,
): PagedResult<T> {
  const [entries, setEntries] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const offsetRef = useRef(0);
  const loadingRef = useRef(false);
  const doneRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Bump on every filter change so a late in-flight page from the previous
  // filter can't append into the reset list.
  const genRef = useRef(0);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  const loadMore = useCallback(async (): Promise<void> => {
    if (loadingRef.current || doneRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    const gen = genRef.current;
    try {
      const page = await fetchRef.current(offsetRef.current, PAGE);
      if (gen !== genRef.current) return; // filter changed mid-flight — drop
      setTotal(page.total);
      setEntries((prev) => [...prev, ...page.entries]);
      offsetRef.current += page.entries.length;
      if (page.entries.length < PAGE || offsetRef.current >= page.total) {
        doneRef.current = true;
        setDone(true);
      }
    } catch (e) {
      if (gen !== genRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
      doneRef.current = true;
      setDone(true);
    } finally {
      if (gen === genRef.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, []);

  // Reset + reload whenever the filter changes.
  useEffect(() => {
    genRef.current += 1;
    offsetRef.current = 0;
    loadingRef.current = false;
    doneRef.current = false;
    setEntries([]);
    setTotal(0);
    setDone(false);
    setError(null);
    void loadMore();
  }, [filterKey, loadMore]);

  // Auto-load the next page as the sentinel scrolls into view.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || done) return undefined;
    const io = new IntersectionObserver(
      (obs) => {
        if (obs.some((o) => o.isIntersecting)) void loadMore();
      },
      { rootMargin: '500px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, done, entries.length]);

  return { entries, total, loading, error, done, sentinelRef };
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
    return (
      <div className="weq-filebrowser-more is-end">
        {count === 0 ? '没有匹配的文件' : `已全部加载（${count}）`}
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

// ── cursor-paged infinite scroll (emoji / avatar / media grids) ─────────────────

/** Page size for the cursor-paged grids (backend cap is 500). */
export const CURSOR_PAGE = 120;

/** One page as the backend reports it: entries + an opaque resume cursor. */
export interface CursorPage<T> {
  entries: T[];
  nextCursor: string | null;
  /** Optional total reported by the backend (header counts); absent for some kinds. */
  total?: number;
}

export interface CursorPagedResult<T> {
  entries: T[];
  /** Latest `total` the backend reported, else null (no total on some kinds). */
  total: number | null;
  loading: boolean;
  error: string | null;
  done: boolean;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  /** Reset to page 1 and refetch (e.g. after a bulk download added entries). */
  reload: () => Promise<void>;
}

/**
 * Cursor-based infinite-scroll loader. `fetchPage(cursor)` pulls one page; the
 * sentinel auto-loads the next as it scrolls into view. Not filter-aware — each
 * grid mounts its own instance (via `key`), and `reload` imperatively restarts
 * the walk from page 1 (dropping any in-flight page that raced it).
 */
export function useCursorPaged<T>(
  fetchPage: (cursor: string | null) => Promise<CursorPage<T>>,
): CursorPagedResult<T> {
  const [entries, setEntries] = useState<T[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const cursorRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  const doneRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  // Bump on every reload so a late in-flight page from the old walk can't
  // append into the reset list.
  const genRef = useRef(0);

  const loadMore = useCallback(async (): Promise<void> => {
    if (loadingRef.current || doneRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    const gen = genRef.current;
    try {
      const page = await fetchRef.current(cursorRef.current);
      if (gen !== genRef.current) return; // reload happened mid-flight — drop
      setEntries((prev) => [...prev, ...page.entries]);
      if (typeof page.total === 'number') setTotal(page.total);
      cursorRef.current = page.nextCursor;
      if (page.nextCursor === null) {
        doneRef.current = true;
        setDone(true);
      }
    } catch (e) {
      if (gen !== genRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
      // Stop the sentinel from hammering a failing kind.
      doneRef.current = true;
      setDone(true);
    } finally {
      if (gen === genRef.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, []);

  // First page on mount (the sentinel can't fire before there's content, so
  // prime the list here). loadMore 稳定，可作 effect 依赖。
  useEffect(() => {
    void loadMore();
  }, [loadMore]);

  // Auto-load the next page as the sentinel scrolls into view.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || done) return undefined;
    const io = new IntersectionObserver(
      (obs) => {
        if (obs.some((o) => o.isIntersecting)) void loadMore();
      },
      { rootMargin: '500px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, done, entries.length]);

  // Imperative reset: drop everything and refetch page 1.
  const reload = useCallback(async (): Promise<void> => {
    genRef.current += 1;
    cursorRef.current = null;
    loadingRef.current = false;
    doneRef.current = false;
    setEntries([]);
    setTotal(null);
    setDone(false);
    setError(null);
    await loadMore();
  }, [loadMore]);

  return { entries, total, loading, error, done, sentinelRef, reload };
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
    return (
      <div className="weq-cache-avatar-more is-end">
        {count === 0 ? '该分类暂无缓存' : `已全部加载（${count}）`}
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
    <div className="weq-blob-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className={cn('weq-blob-dialog', dialogClass)}
        role="dialog"
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
    </div>
  );
}

type Cn = (...parts: (string | false | null | undefined)[]) => string;
export const cn: Cn = (...parts) => parts.filter(Boolean).join(' ');
