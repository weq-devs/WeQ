/**
 * Local related-emoji (关联表情) resource browser (a category of the cache view).
 *
 * QQ NT keeps a keyword → emoji set under `nt_data/Emoji/emoji-related/emoji`:
 * `words.json` lists keywords, and each keyword that has emoji owns a dir named
 * `md5(keyword)` (UTF-8) full of plaintext gifs. The backend
 * (`account.relatedEmoji.*`) surfaces only keywords whose dir exists; here we
 * render one card per keyword — the first gif as the cover, the keyword as the
 * title — and open a lightbox with ALL of that keyword's gifs on click.
 *
 * Gif bytes never cross tRPC — the `<img>` points at `weq-media://relemoji`.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { RefreshCw, X, Image as ImageIcon } from 'lucide-react';
import type { RelatedEmojiKeyword } from '@weq/service';
import { trpc, client } from '../../trpc/client';
import { mediaUrl } from '../../lib/resourceUrl';

const PAGE = 120;

/** weq-media URL for one related-emoji gif. */
function relemojiUrl(hash: string, file: string): string {
  return mediaUrl('relemoji', { hash, file });
}

export function RelatedEmojiExplorer(): ReactElement {
  const [entries, setEntries] = useState<RelatedEmojiKeyword[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [preview, setPreview] = useState<RelatedEmojiKeyword | null>(null);
  const loadingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const loadMore = useCallback(async (): Promise<void> => {
    if (loadingRef.current || done) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const page = await client.account.relatedEmoji.listKeywords.query({ limit: PAGE, cursor });
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
    return <div className="weq-cache-grid-state">未找到关联表情资源</div>;
  }

  return (
    <div className="weq-cache-marketemoji">
      <div className="weq-cache-marketemoji-bar">
        <span className="weq-cache-data-name">关联表情</span>
        <span className="weq-cache-data-meta">
          {total ?? entries.length} 个关键词 · 点击查看该关键词的全部表情
        </span>
      </div>

      <div className="weq-cache-avatar-scroll">
        <div className="weq-cache-related-grid">
          {entries.map((entry) => (
            <RelatedEmojiCard
              key={entry.hash}
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

      {preview ? <RelatedEmojiLightbox entry={preview} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}

/** One keyword card: the first gif as cover + the keyword title. */
function RelatedEmojiCard({
  entry,
  onOpen,
}: {
  entry: RelatedEmojiKeyword;
  onOpen: () => void;
}): ReactElement {
  const [broken, setBroken] = useState(false);
  const cover = entry.cover ? relemojiUrl(entry.hash, entry.cover) : null;

  return (
    <button type="button" className="weq-cache-related-card" onClick={onOpen} title={entry.keyword}>
      <span className="weq-cache-related-cover">
        {broken || !cover ? (
          <ImageIcon size={24} strokeWidth={1.4} className="weq-cache-related-fallback" />
        ) : (
          <img
            src={cover}
            alt={entry.keyword}
            loading="lazy"
            draggable={false}
            onError={() => setBroken(true)}
          />
        )}
        {entry.gifCount > 1 ? (
          <em className="weq-cache-related-count">{entry.gifCount}</em>
        ) : null}
      </span>
      <span className="weq-cache-related-word">{entry.keyword}</span>
    </button>
  );
}

/** Lightbox: every gif for a keyword, fetched on open. */
function RelatedEmojiLightbox({
  entry,
  onClose,
}: {
  entry: RelatedEmojiKeyword;
  onClose: () => void;
}): ReactElement {
  const gifs = trpc.account.relatedEmoji.listGifs.useQuery({ hash: entry.hash });
  const files = gifs.data ?? [];

  return (
    <div className="weq-blob-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="weq-blob-dialog weq-related-dialog"
        role="dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="weq-blob-head">
          <div className="weq-blob-title">
            <h3>{entry.keyword}</h3>
            <code>{gifs.isLoading ? '加载中…' : `${files.length} 个表情`}</code>
          </div>
          <button type="button" className="weq-blob-close" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="weq-blob-body weq-related-panels">
          {gifs.isLoading ? (
            <div className="weq-cache-grid-state">加载中…</div>
          ) : files.length === 0 ? (
            <div className="weq-cache-grid-state">该关键词无可渲染的表情</div>
          ) : (
            files.map((file) => (
              <div key={file} className="weq-related-stage">
                <img src={relemojiUrl(entry.hash, file)} alt={file} draggable={false} />
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
