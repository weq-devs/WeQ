/**
 * Local avatar cache browser (the 头像资源 category of the cache view).
 *
 * QQ NT caches avatars under `nt_data/avatar/{user,group,cover}`. The backend
 * (`account.avatarResource.*`) merges each hash's big (`b_`) + small (`s_`)
 * files into one {@link AvatarEntry}; here we render a masonry-ish grid, one
 * card per hash. Each card PREFERS the big original (`v=big`, falling back to the
 * thumbnail via `<img onError>`) and labels its source — 大图 / 缩略图 /
 * 大图+缩略图 — so a later "keep only thumbnails" cleanup has something to act on.
 *
 * The `user` scope can hold tens of thousands of files, so entries load a page
 * at a time and the grid fetches the next page as a sentinel scrolls into view.
 * Image bytes never cross tRPC — the `<img>` points at `weq-media://avatar`.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Users, UsersRound, Image as ImageIcon, RefreshCw, Calculator } from 'lucide-react';
import type { AvatarEntry, AvatarScope, AvatarScopeInfo } from '@weq/service';
import { trpc, client } from '../../trpc/client';
import { AvatarPathDialog } from './AvatarPathDialog';

const PAGE = 120;

const SCOPE_META: Record<AvatarScope, { label: string; icon: ReactElement }> = {
  user: { label: '好友头像', icon: <Users size={14} /> },
  group: { label: '群头像', icon: <UsersRound size={14} /> },
  cover: { label: '封面', icon: <ImageIcon size={14} /> },
};

function fmtBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** weq-media URL for one avatar file. */
function avatarSrc(scope: AvatarScope, hash: string, variant: 'big' | 'small'): string {
  return `weq-media://avatar?scope=${scope}&hash=${hash}&v=${variant}`;
}

export function AvatarExplorer(): ReactElement {
  const scopes = trpc.account.avatarResource.listScopes.useQuery();
  const scopeList = useMemo<AvatarScopeInfo[]>(
    () => ((scopes.data ?? []) as AvatarScopeInfo[]),
    [scopes.data],
  );
  // Scopes that actually exist on disk (hide empty ones, but always keep at
  // least `user` as a landing tab while the scan is in flight).
  const presentScopes = useMemo(
    () => scopeList.filter((s) => s.present && s.count > 0),
    [scopeList],
  );

  const [active, setActive] = useState<AvatarScope>('user');
  const [toolOpen, setToolOpen] = useState(false);

  // Auto-select the first present scope once the summary lands (if the current
  // one turned out empty).
  useEffect(() => {
    if (presentScopes.length === 0) return;
    if (!presentScopes.some((s) => s.scope === active)) {
      setActive(presentScopes[0]!.scope);
    }
  }, [presentScopes, active]);

  return (
    <div className="weq-cache-avatar">
      <div className="weq-cache-avatar-tabs">
        {(presentScopes.length > 0 ? presentScopes : scopeList).map((s) => (
          <button
            key={s.scope}
            type="button"
            className={`weq-cache-avatar-tab${s.scope === active ? ' is-on' : ''}`}
            onClick={() => setActive(s.scope)}
            disabled={s.present && s.count === 0}
          >
            {SCOPE_META[s.scope].icon}
            <span>{SCOPE_META[s.scope].label}</span>
            <em className="weq-cache-avatar-tabcount">{s.count}</em>
          </button>
        ))}
        {scopes.isLoading && scopeList.length === 0 ? (
          <span className="weq-cache-avatar-loading">扫描头像缓存中…</span>
        ) : null}
        <button
          type="button"
          className="weq-cache-avatar-tool"
          onClick={() => setToolOpen(true)}
          title="输入 QQ 号 / 群号，计算其头像缓存路径"
        >
          <Calculator size={14} />
          <span>算路径</span>
        </button>
      </div>

      <AvatarGrid key={active} scope={active} />
      {toolOpen ? <AvatarPathDialog onClose={() => setToolOpen(false)} /> : null}
    </div>
  );
}

/** Paged, lazy-loading grid for one scope. Remounted (via key) on scope change. */
function AvatarGrid({ scope }: { scope: AvatarScope }): ReactElement {
  const [entries, setEntries] = useState<AvatarEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const loadMore = useCallback(async (): Promise<void> => {
    if (loadingRef.current || done) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const page = await client.account.avatarResource.listEntries.query({
        scope,
        limit: PAGE,
        cursor,
      });
      setEntries((prev) => [...prev, ...page.entries]);
      setCursor(page.nextCursor);
      if (page.nextCursor === null) setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDone(true); // stop the sentinel from hammering a failing scope
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [scope, cursor, done]);

  // First page on mount.
  useEffect(() => {
    void loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-load the next page when the sentinel scrolls into view.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || done) return undefined;
    const io = new IntersectionObserver(
      (obs) => {
        if (obs.some((o) => o.isIntersecting)) void loadMore();
      },
      { rootMargin: '400px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, done]);

  if (error && entries.length === 0) {
    return <div className="weq-cache-grid-state is-error">{error}</div>;
  }
  if (!loading && entries.length === 0 && done) {
    return <div className="weq-cache-grid-state">该分类暂无头像缓存</div>;
  }

  return (
    <div className="weq-cache-avatar-scroll">
      <div className="weq-cache-avatar-grid">
        {entries.map((entry) => (
          <AvatarCard key={`${entry.bucket}:${entry.hash}`} scope={scope} entry={entry} />
        ))}
      </div>
      {!done ? (
        <div ref={sentinelRef} className="weq-cache-avatar-more">
          <RefreshCw size={14} className={loading ? 'is-spin' : ''} />
          {loading ? '加载中…' : '滚动加载更多'}
        </div>
      ) : (
        <div className="weq-cache-avatar-more is-end">已全部加载（{entries.length}）</div>
      )}
    </div>
  );
}

/** One merged avatar: prefers the big image, labels its source. */
function AvatarCard({
  scope,
  entry,
}: {
  scope: AvatarScope;
  entry: AvatarEntry;
}): ReactElement {
  // Prefer the big original; if it's missing or fails, fall back to the thumb.
  const [variant, setVariant] = useState<'big' | 'small'>(entry.hasBig ? 'big' : 'small');

  const source = sourceLabel(entry);
  const totalBytes = entry.bigBytes + entry.smallBytes;

  return (
    <figure className="weq-cache-avatar-card" title={entry.hash}>
      <div className="weq-cache-avatar-thumb">
        <img
          src={avatarSrc(scope, entry.hash, variant)}
          alt={entry.hash}
          loading="lazy"
          onError={() => {
            // Big failed → try the thumbnail once.
            if (variant === 'big' && entry.hasSmall) setVariant('small');
          }}
        />
        <span className={`weq-cache-avatar-src is-${source.tone}`}>{source.text}</span>
      </div>
      <figcaption className="weq-cache-avatar-meta">
        <span className="weq-cache-avatar-hash">{entry.hash.slice(0, 10)}…</span>
        <span className="weq-cache-avatar-size">{fmtBytes(totalBytes)}</span>
      </figcaption>
    </figure>
  );
}

/** Map which variants exist to a source badge (text + tone). */
function sourceLabel(entry: AvatarEntry): {
  text: string;
  tone: 'both' | 'big' | 'small';
} {
  if (entry.hasBig && entry.hasSmall) return { text: '大图+缩略图', tone: 'both' };
  if (entry.hasBig) return { text: '大图', tone: 'big' };
  return { text: '缩略图', tone: 'small' };
}
