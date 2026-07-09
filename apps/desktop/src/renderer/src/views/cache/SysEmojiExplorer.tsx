/**
 * Local system-emoji resource browser (the 系统表情 category of the cache view).
 *
 * QQ NT keeps its built-in animated faces under
 * `nt_data/Emoji/BaseEmojiSyastems/EmojiSystermResource/<name>/{png,apng,lottie}`.
 * The backend (`account.sysEmoji.*`) reports which formats each face carries;
 * here we render a grid (default preview = APNG via `<img>`, falling back to the
 * static PNG) that pages in as it scrolls. Clicking a face opens a lightbox that
 * renders EVERY format the face has — PNG / APNG through `<img>`, Lottie through
 * lottie-web — "有几个渲染几个", each in its own labelled panel.
 *
 * Bytes stream through the existing `weq-asset://emoji/<name>/<fmt>/<file>`
 * protocol (see main/resource_protocol.ts) — nothing crosses tRPC but metadata.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { RefreshCw, X, Smile } from 'lucide-react';
import type { SysEmojiEntry } from '@weq/service';
import { trpc, client } from '../../trpc/client';
import { emojiUrl } from '../../lib/resourceUrl';

const PAGE = 120;

/** weq-asset URL for one face's file in a given format dir. */
function faceUrl(name: string, fmt: 'png' | 'apng' | 'lottie', file: string): string {
  return emojiUrl(name, fmt, file);
}

export function SysEmojiExplorer(): ReactElement {
  const [entries, setEntries] = useState<SysEmojiEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [preview, setPreview] = useState<SysEmojiEntry | null>(null);
  const loadingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Seed the header total once (a cheap first query with limit 1 would race the
  // real first page, so just read it off the first real page instead).
  const totalQuery = trpc.account.sysEmoji.listEntries.useQuery({ limit: 1 });
  useEffect(() => {
    if (totalQuery.data && total === null) setTotal(totalQuery.data.total);
  }, [totalQuery.data, total]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (loadingRef.current || done) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const page = await client.account.sysEmoji.listEntries.query({ limit: PAGE, cursor });
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
    return <div className="weq-cache-grid-state">未找到系统表情资源</div>;
  }

  return (
    <div className="weq-cache-sysemoji">
      <div className="weq-cache-sysemoji-bar">
        <span className="weq-cache-data-name">系统表情</span>
        <span className="weq-cache-data-meta">
          {total ?? entries.length} 个 · 默认动图(APNG)预览，点击查看全部格式
        </span>
      </div>

      <div className="weq-cache-avatar-scroll">
        <div className="weq-cache-sysemoji-grid">
          {entries.map((entry) => (
            <SysEmojiCard key={entry.name} entry={entry} onOpen={() => setPreview(entry)} />
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

      {preview ? <SysEmojiLightbox entry={preview} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}

/** One grid card: prefers the APNG, falls back to the static PNG. */
function SysEmojiCard({
  entry,
  onOpen,
}: {
  entry: SysEmojiEntry;
  onOpen: () => void;
}): ReactElement {
  // Prefer the animated APNG; fall back to the static PNG when it fails / absent.
  const initial: 'apng' | 'png' =
    entry.hasApng && entry.apngFile ? 'apng' : 'png';
  const [fmt, setFmt] = useState<'apng' | 'png'>(initial);
  const [broken, setBroken] = useState(false);

  const file = fmt === 'apng' ? entry.apngFile : entry.pngFile;
  const badges = formatBadges(entry);

  return (
    <button type="button" className="weq-cache-sysemoji-card" onClick={onOpen} title={entry.name}>
      <span className="weq-cache-sysemoji-thumb">
        {broken || !file ? (
          <Smile size={26} strokeWidth={1.4} className="weq-cache-sysemoji-fallback" />
        ) : (
          <img
            src={faceUrl(entry.name, fmt, file)}
            alt={entry.name}
            loading="lazy"
            draggable={false}
            onError={() => {
              if (fmt === 'apng' && entry.hasPng && entry.pngFile) setFmt('png');
              else setBroken(true);
            }}
          />
        )}
      </span>
      <span className="weq-cache-sysemoji-name">{entry.name}</span>
      <span className="weq-cache-sysemoji-badges">
        {badges.map((b) => (
          <em key={b} className="weq-cache-sysemoji-badge">
            {b}
          </em>
        ))}
      </span>
    </button>
  );
}

/** Lightbox: render every format the face carries, each in its own panel. */
function SysEmojiLightbox({
  entry,
  onClose,
}: {
  entry: SysEmojiEntry;
  onClose: () => void;
}): ReactElement {
  const panels: Array<{ fmt: 'png' | 'apng' | 'lottie'; file: string; label: string }> = [];
  if (entry.hasApng && entry.apngFile) {
    panels.push({ fmt: 'apng', file: entry.apngFile, label: 'APNG 动图' });
  }
  if (entry.hasLottie && entry.lottieFile) {
    panels.push({ fmt: 'lottie', file: entry.lottieFile, label: 'Lottie 动画' });
  }
  if (entry.hasPng && entry.pngFile) {
    panels.push({ fmt: 'png', file: entry.pngFile, label: '静态 PNG' });
  }

  // When a Lottie is present it becomes the hero: rendered large and centered,
  // with the APNG / PNG shrunk to flank it. `has-lottie` drives that layout.
  const hasLottie = panels.some((p) => p.fmt === 'lottie');

  return (
    <div className="weq-blob-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className={`weq-blob-dialog weq-sysemoji-dialog${hasLottie ? ' has-lottie' : ''}`}
        role="dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="weq-blob-head">
          <div className="weq-blob-title">
            <h3>系统表情 · {entry.name}</h3>
            <code>{panels.length} 种格式</code>
          </div>
          <button type="button" className="weq-blob-close" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="weq-blob-body weq-sysemoji-panels">
          {panels.length === 0 ? (
            <div className="weq-cache-grid-state">该表情无可渲染的资源</div>
          ) : (
            panels.map((p) => (
              <figure key={p.fmt} className={`weq-sysemoji-panel is-${p.fmt}`}>
                <div className="weq-sysemoji-stage">
                  {p.fmt === 'lottie' ? (
                    <SysEmojiLottie src={faceUrl(entry.name, 'lottie', p.file)} label={entry.name} />
                  ) : (
                    <img
                      src={faceUrl(entry.name, p.fmt, p.file)}
                      alt={`${entry.name} ${p.label}`}
                      draggable={false}
                    />
                  )}
                </div>
                <figcaption className="weq-sysemoji-panel-cap">
                  <strong>{p.label}</strong>
                  <span>{p.file}</span>
                </figcaption>
              </figure>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Lottie player for the lightbox — mirrors the chat FaceEmoji approach:
 * `lottie_light` (no eval, CSP-safe) + svg renderer, looping. Falls back to a
 * muted note if the JSON can't be fetched / parsed.
 */
function SysEmojiLottie({ src, label }: { src: string; label: string }): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let destroyed = false;
    let anim: import('lottie-web').AnimationItem | undefined;
    setFailed(false);

    void (async () => {
      try {
        const [{ default: lottie }, res] = await Promise.all([
          import('lottie-web/build/player/lottie_light'),
          fetch(src),
        ]);
        if (!res.ok) throw new Error(`lottie fetch ${res.status}`);
        const data = (await res.json()) as unknown;
        if (destroyed || !containerRef.current) return;
        anim = lottie.loadAnimation({
          container: containerRef.current,
          renderer: 'svg',
          loop: true,
          autoplay: true,
          animationData: data,
        });
      } catch {
        if (!destroyed) setFailed(true);
      }
    })();

    return () => {
      destroyed = true;
      anim?.destroy();
    };
  }, [src]);

  if (failed) return <div className="weq-sysemoji-lottie-fail">Lottie 加载失败</div>;
  return (
    <div ref={containerRef} className="weq-sysemoji-lottie" role="img" aria-label={label} />
  );
}

/** Short format badges for a card (APNG / Lottie / PNG), in render-priority order. */
function formatBadges(entry: SysEmojiEntry): string[] {
  const out: string[] = [];
  if (entry.hasApng) out.push('APNG');
  if (entry.hasLottie) out.push('Lottie');
  if (entry.hasPng) out.push('PNG');
  return out;
}
