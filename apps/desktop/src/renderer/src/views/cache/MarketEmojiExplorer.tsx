/**
 * Local market-face (store sticker) resource browser (商城表情 category).
 *
 * QQ NT keeps downloaded store stickers under
 * `nt_data/Emoji/marketface/<itemId>/<hash>`, where GIF files are encrypted
 * with a 50-step XOR and PNG files are plaintext. The backend enumerates all
 * files and groups them by hash (one sticker may have both gif and png); here
 * we render a grid (thumbnails via `<img>`, prefer GIF) that pages in as it
 * scrolls. Clicking a sticker opens a lightbox that displays all available
 * formats side-by-side, just like the system emoji viewer.
 *
 * Bytes stream through the existing `weq-media://mface?pack=<itemId>&hash=<hash>`
 * protocol (see main/media_protocol.ts) — nothing crosses tRPC but metadata.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { RefreshCw, X, Sticker } from 'lucide-react';
import type { MarketFaceEntry } from '@weq/service';
import { trpc, client } from '../../trpc/client';
import { mediaUrl } from '../../lib/resourceUrl';

const PAGE = 120;

/** weq-media URL for one market face by pack+hash. */
function mfaceUrl(itemId: string, hash: string): string {
  return mediaUrl('mface', { pack: itemId, hash });
}

export function MarketEmojiExplorer(): ReactElement {
  const [entries, setEntries] = useState<MarketFaceEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [preview, setPreview] = useState<MarketFaceEntry | null>(null);
  const loadingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Seed the header total once.
  const totalQuery = trpc.account.marketEmoji.listEntries.useQuery({ limit: 1 });
  useEffect(() => {
    if (totalQuery.data && total === null) setTotal(totalQuery.data.total);
  }, [totalQuery.data, total]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (loadingRef.current || done) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const page = await client.account.marketEmoji.listEntries.query({ limit: PAGE, cursor });
      setEntries((prev) => [...prev, ...page.entries]);
      setTotal(page.total);
      setCursor(page.nextCursor);
      if (page.nextCursor === null) setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDone(true);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [cursor, done]);

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
    return <div className="weq-cache-grid-state">未找到商城表情资源</div>;
  }

  return (
    <div className="weq-cache-marketemoji">
      <div className="weq-cache-marketemoji-bar">
        <span className="weq-cache-data-name">商城表情</span>
        <span className="weq-cache-data-meta">
          {total ?? entries.length} 个 · 优先展示动图(GIF)，点击查看全部格式
        </span>
      </div>

      <div className="weq-cache-avatar-scroll">
        <div className="weq-cache-marketemoji-grid">
          {entries.map((entry) => (
            <MarketEmojiCard
              key={`${entry.itemId}-${entry.hash}`}
              entry={entry}
              onOpen={() => setPreview(entry)}
            />
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

      {preview ? <MarketEmojiLightbox entry={preview} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}

/** One grid card: prefer GIF (animated), fall back to PNG (static). */
function MarketEmojiCard({
  entry,
  onOpen,
}: {
  entry: MarketFaceEntry;
  onOpen: () => void;
}): ReactElement {
  const [broken, setBroken] = useState(false);

  // Prefer GIF, fall back to PNG.
  const url = mfaceUrl(entry.itemId, entry.hash);
  const badges = formatBadges(entry);

  return (
    <button type="button" className="weq-cache-marketemoji-card" onClick={onOpen} title={entry.hash}>
      <span className="weq-cache-marketemoji-thumb">
        {broken ? (
          <Sticker size={26} strokeWidth={1.4} className="weq-cache-marketemoji-fallback" />
        ) : (
          <img
            src={url}
            alt={entry.hash}
            loading="lazy"
            draggable={false}
            onError={() => setBroken(true)}
          />
        )}
      </span>
      <span className="weq-cache-marketemoji-hash">{entry.hash.slice(0, 8)}</span>
      <span className="weq-cache-marketemoji-badges">
        {badges.map((b) => (
          <em key={b} className="weq-cache-marketemoji-badge">
            {b}
          </em>
        ))}
      </span>
    </button>
  );
}

/** Lightbox: render every format the sticker has — GIF / PNG, each in its own panel. */
function MarketEmojiLightbox({
  entry,
  onClose,
}: {
  entry: MarketFaceEntry;
  onClose: () => void;
}): ReactElement {
  const panels: Array<{ fmt: 'gif' | 'png'; label: string; size: number }> = [];
  if (entry.hasGif) {
    panels.push({ fmt: 'gif', label: 'GIF 动图', size: entry.gifSize });
  }
  if (entry.hasPng) {
    panels.push({ fmt: 'png', label: 'PNG 静图', size: entry.pngSize });
  }

  const url = mfaceUrl(entry.itemId, entry.hash);

  return (
    <div className="weq-blob-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="weq-blob-dialog weq-marketemoji-dialog"
        role="dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="weq-blob-head">
          <div className="weq-blob-title">
            <h3>商城表情 · {entry.hash.slice(0, 12)}</h3>
            <code>{panels.length} 种格式</code>
          </div>
          <button type="button" className="weq-blob-close" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="weq-blob-body weq-marketemoji-panels">
          {panels.length === 0 ? (
            <div className="weq-cache-grid-state">该表情无可渲染的资源</div>
          ) : (
            panels.map((p) => (
              <figure key={p.fmt} className="weq-marketemoji-panel">
                <div className="weq-marketemoji-stage">
                  <img src={url} alt={`${entry.hash} ${p.label}`} draggable={false} />
                </div>
                <figcaption className="weq-marketemoji-panel-cap">
                  <strong>{p.label}</strong>
                  <span>{formatSize(p.size)}</span>
                </figcaption>
              </figure>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/** Short format badges for a card (GIF / PNG), in render-priority order. */
function formatBadges(entry: MarketFaceEntry): string[] {
  const out: string[] = [];
  if (entry.hasGif) out.push('GIF');
  if (entry.hasPng) out.push('PNG');
  return out;
}

/** Format bytes as KB/MB. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
