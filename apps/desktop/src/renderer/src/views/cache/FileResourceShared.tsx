/**
 * Shared bits for the two 文件 browsers (File 目录 + 下载文件):
 * formatting helpers, the category-tab + search + sort toolbar, and a generic
 * offset-paged infinite-scroll hook. Both views render file cards the same way
 * the chat does (icon by extension), enriched with an inline image preview.
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
} from 'lucide-react';
import type { FileCategory, FileSortKey, FileSortOrder } from '@weq/service';

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
 * one page for the current filter; changing any value in `deps` resets the list
 * and reloads from offset 0. All fetches are async off the render thread.
 */
export function usePagedList<T>(
  fetchPage: (offset: number, limit: number) => Promise<{ entries: T[]; total: number }>,
  deps: unknown[],
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

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
  return (
    <div ref={sentinelRef} className="weq-filebrowser-more">
      <RefreshCw size={14} className={loading ? 'is-spin' : ''} />
      {loading ? '加载中…' : '滚动加载更多'}
    </div>
  );
}

interface Cn {
  (...parts: (string | false | null | undefined)[]): string;
}
export const cn: Cn = (...parts) => parts.filter(Boolean).join(' ');
