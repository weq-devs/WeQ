/**
 * 我的收藏 —— QQ favorites lightbox.
 *
 * Opened from the left rail (like the settings dialog). Loads ALL collected
 * items once via `account.listCollections` (paging the service until
 * `hasMore` is false — 收藏 sets are small), then does search + kind filter +
 * true pagination (翻页, not scroll) entirely client-side for instant response.
 *
 * Every content kind (text / link / gallery / audio / video / file / location
 * / richMedia / unknown) has its own card renderer. Collector-CDN images route
 * through the disk-cached avatar bridge (`collectionImageUrl`); clicking one
 * opens the shared lightbox. Location cards degrade gracefully — coordinates
 * always render even when name/address are empty.
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  Bookmark,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  Film,
  Image as ImageIcon,
  Layers,
  Link2,
  Loader2,
  MapPin,
  Music,
  Play,
  Search,
  X,
} from 'lucide-react';
import { client } from '../trpc/client';
import { QqAvatar } from './QqAvatar';
import { openLightbox } from './ImageLightbox';
import { collectionImageUrl } from '../lib/resourceUrl';
import { closeFromScrim, useEscapeToClose } from '../im-template/template/modalUtils';

interface PicWire {
  uri: string;
  width: number;
  height: number;
}

interface CollectionItemWire {
  cid: string;
  kind: string;
  type: number;
  createTime: number;
  collectTime: number;
  authorName: string;
  authorUin: string;
  groupName: string;
  text: string;
  link: { url: string; title: string; publisher: string; brief: string; pics: PicWire[] } | null;
  gallery: { pics: PicWire[] } | null;
  audio: { duration: number; stt: string } | null;
  video: {
    title: string;
    duration: number;
    cover: PicWire | null;
    fileName: string;
    fileSize: string;
  } | null;
  file: { name: string; size: string; ext: string } | null;
  location: { name: string; address: string; latitude: number; longitude: number } | null;
  richMedia: {
    title: string;
    subTitle: string;
    brief: string;
    originalUri: string;
    pics: PicWire[];
  } | null;
}

const PAGE_SIZE = 8;

/** Ordered kind filter chips. `all` first, then by rough frequency. */
const KIND_FILTERS: { id: string; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'richMedia', label: '图文' },
  { id: 'link', label: '链接' },
  { id: 'gallery', label: '图片' },
  { id: 'video', label: '视频' },
  { id: 'audio', label: '语音' },
  { id: 'file', label: '文件' },
  { id: 'location', label: '位置' },
  { id: 'text', label: '文本' },
  { id: 'unknown', label: '其他' },
];

const KIND_LABEL: Record<string, string> = Object.fromEntries(
  KIND_FILTERS.map((k) => [k.id, k.label]),
);

function humanSize(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
}

function humanTime(ms: number): string {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function humanSeconds(sec: number): string {
  if (!sec || sec <= 0) return '';
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}:${String(r).padStart(2, '0')}` : `${s}"`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** All searchable text for one item, lower-cased. */
function searchCorpus(it: CollectionItemWire): string {
  const parts = [it.authorName, it.groupName, it.text];
  if (it.link) parts.push(it.link.title, it.link.publisher, it.link.brief, it.link.url);
  if (it.richMedia)
    parts.push(it.richMedia.title, it.richMedia.subTitle, it.richMedia.brief, it.richMedia.originalUri);
  if (it.video) parts.push(it.video.title, it.video.fileName);
  if (it.audio) parts.push(it.audio.stt);
  if (it.file) parts.push(it.file.name);
  if (it.location) parts.push(it.location.name, it.location.address);
  return parts.filter(Boolean).join(' ').toLowerCase();
}

function kindIcon(kind: string, size = 13): ReactElement {
  switch (kind) {
    case 'link':
      return <Link2 size={size} strokeWidth={1.8} />;
    case 'gallery':
      return <ImageIcon size={size} strokeWidth={1.8} />;
    case 'video':
      return <Film size={size} strokeWidth={1.8} />;
    case 'audio':
      return <Music size={size} strokeWidth={1.8} />;
    case 'file':
      return <FileText size={size} strokeWidth={1.8} />;
    case 'location':
      return <MapPin size={size} strokeWidth={1.8} />;
    case 'richMedia':
      return <Layers size={size} strokeWidth={1.8} />;
    default:
      return <Bookmark size={size} strokeWidth={1.8} />;
  }
}

/** A thumbnail that hides itself if the collector CDN 404s / times out. */
function Thumb({ pic, alt }: { pic: PicWire; alt: string }): ReactElement {
  const src = collectionImageUrl(pic.uri);
  return (
    <button
      type="button"
      className="weq-col-thumb"
      onClick={() => openLightbox(src, alt)}
      title="查看大图"
    >
      <img
        src={src}
        alt={alt}
        loading="lazy"
        onError={(e) => {
          (e.currentTarget.closest('.weq-col-thumb') as HTMLElement | null)?.classList.add(
            'is-broken',
          );
        }}
      />
    </button>
  );
}

function PicGrid({ pics, alt }: { pics: PicWire[]; alt: string }): ReactElement | null {
  if (!pics.length) return null;
  return (
    <div className={`weq-col-picgrid weq-col-picgrid-${Math.min(pics.length, 3)}`}>
      {pics.slice(0, 6).map((p, i) => (
        <Thumb key={`${p.uri}-${i}`} pic={p} alt={alt} />
      ))}
      {pics.length > 6 ? <span className="weq-col-picmore">+{pics.length - 6}</span> : null}
    </div>
  );
}

function CardBody({ it }: { it: CollectionItemWire }): ReactElement {
  switch (it.kind) {
    case 'text':
      return <p className="weq-col-text">{it.text || '(空文本)'}</p>;

    case 'link': {
      const l = it.link!;
      const cover = l.pics[0];
      return (
        <button
          type="button"
          className="weq-col-link"
          onClick={() => l.url && window.open(l.url, '_blank')}
          title={l.url}
        >
          {cover ? (
            <img className="weq-col-link-thumb" src={collectionImageUrl(cover.uri)} alt="" loading="lazy" />
          ) : (
            <span className="weq-col-link-thumb is-fallback">
              <Link2 size={20} strokeWidth={1.6} />
            </span>
          )}
          <span className="weq-col-link-meta">
            <span className="weq-col-link-title">{l.title || l.url || '链接'}</span>
            {l.brief ? <span className="weq-col-link-brief">{l.brief}</span> : null}
            <span className="weq-col-link-host">
              <ExternalLink size={11} strokeWidth={1.8} />
              {l.publisher || hostOf(l.url)}
            </span>
          </span>
        </button>
      );
    }

    case 'gallery':
      return <PicGrid pics={it.gallery!.pics} alt="收藏图片" />;

    case 'audio': {
      const a = it.audio!;
      return (
        <div className="weq-col-media-row">
          <span className="weq-col-media-icon">
            <Music size={18} strokeWidth={1.6} />
          </span>
          <span className="weq-col-media-meta">
            <span className="weq-col-media-title">语音{humanSeconds(a.duration / 1000) ? ` · ${humanSeconds(a.duration / 1000)}` : ''}</span>
            {a.stt ? <span className="weq-col-media-sub">{a.stt}</span> : null}
          </span>
        </div>
      );
    }

    case 'video': {
      const v = it.video!;
      const src = v.cover ? collectionImageUrl(v.cover.uri) : null;
      return (
        <div className="weq-col-video">
          <button
            type="button"
            className="weq-col-video-cover"
            onClick={() => src && openLightbox(src, v.title || '视频封面')}
            disabled={!src}
          >
            {src ? <img src={src} alt="" loading="lazy" /> : <Film size={26} strokeWidth={1.4} />}
            <span className="weq-col-video-play">
              <Play size={18} strokeWidth={1.8} fill="currentColor" />
            </span>
            {humanSeconds(v.duration) ? (
              <span className="weq-col-video-dur">{humanSeconds(v.duration)}</span>
            ) : null}
          </button>
          <span className="weq-col-media-sub">
            {v.title || v.fileName || '视频'}
            {humanSize(v.fileSize) ? ` · ${humanSize(v.fileSize)}` : ''}
          </span>
        </div>
      );
    }

    case 'file': {
      const f = it.file!;
      return (
        <div className="weq-col-media-row">
          <span className="weq-col-media-icon">
            {f.ext ? <span className="weq-col-file-ext">{f.ext}</span> : <FileText size={18} strokeWidth={1.6} />}
          </span>
          <span className="weq-col-media-meta">
            <span className="weq-col-media-title">{f.name || '文件'}</span>
            {humanSize(f.size) ? <span className="weq-col-media-sub">{humanSize(f.size)}</span> : null}
          </span>
        </div>
      );
    }

    case 'location': {
      const loc = it.location!;
      const hasCoord = Boolean(loc.latitude || loc.longitude);
      const mapUrl = hasCoord
        ? `https://uri.amap.com/marker?position=${loc.longitude},${loc.latitude}&name=${encodeURIComponent(loc.name || '收藏位置')}`
        : '';
      return (
        <div className="weq-col-location">
          <span className="weq-col-loc-pin">
            <MapPin size={18} strokeWidth={1.7} />
          </span>
          <span className="weq-col-loc-meta">
            <span className="weq-col-loc-name">{loc.name || '未命名地点'}</span>
            {loc.address ? <span className="weq-col-loc-addr">{loc.address}</span> : null}
            {hasCoord ? (
              <span className="weq-col-loc-coord">
                {loc.latitude.toFixed(5)}, {loc.longitude.toFixed(5)}
              </span>
            ) : null}
          </span>
          {mapUrl ? (
            <button
              type="button"
              className="weq-col-loc-open"
              onClick={() => window.open(mapUrl, '_blank')}
              title="在地图中查看"
            >
              <ExternalLink size={13} strokeWidth={1.8} />
            </button>
          ) : null}
        </div>
      );
    }

    case 'richMedia': {
      const r = it.richMedia!;
      const heading = r.title || r.subTitle;
      const body = r.brief;
      const hasAny = heading || body || r.pics.length;
      return (
        <div className="weq-col-rich">
          {heading ? <p className="weq-col-rich-title">{heading}</p> : null}
          {body ? <p className="weq-col-text">{body}</p> : null}
          <PicGrid pics={r.pics} alt={heading || '收藏内容'} />
          {!hasAny ? <p className="weq-col-text is-muted">(无文本内容)</p> : null}
        </div>
      );
    }

    default:
      return <p className="weq-col-text is-muted">未知类型（type {it.type}）</p>;
  }
}

function CollectionCard({ it }: { it: CollectionItemWire }): ReactElement {
  return (
    <article className="weq-col-card">
      <header className="weq-col-card-head">
        <QqAvatar uin={it.authorUin || undefined} size={26} className="weq-col-avatar" />
        <span className="weq-col-card-who">
          <span className="weq-col-card-name">{it.authorName || '未知'}</span>
          {it.groupName ? <span className="weq-col-card-group">{it.groupName}</span> : null}
        </span>
        <span className={`weq-col-kind-badge weq-col-kind-${it.kind}`}>
          {kindIcon(it.kind)}
          {KIND_LABEL[it.kind] ?? '其他'}
        </span>
      </header>
      <div className="weq-col-card-body">
        <CardBody it={it} />
      </div>
      <footer className="weq-col-card-foot">{humanTime(it.collectTime)}</footer>
    </article>
  );
}

export function CollectionDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactElement | null {
  useEscapeToClose(onClose);
  const [items, setItems] = useState<CollectionItemWire[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [page, setPage] = useState(0);

  // Load everything once, the first time the dialog opens.
  //
  // NOTE: `loading` must NOT be an effect dependency. `setLoading(true)` on the
  // first line would otherwise re-trigger this effect, whose cleanup flips the
  // in-flight `cancelled` flag — so the original request resolves but every
  // setState (incl. `setLoading(false)`) is skipped, leaving it spinning
  // forever. The `loaded` guard alone prevents duplicate loads.
  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const all: CollectionItemWire[] = [];
        let offset = 0;
        for (;;) {
          const res = (await client.account.listCollections.query({
            limit: 100,
            offset,
          })) as { items: CollectionItemWire[]; hasMore: boolean };
          all.push(...res.items);
          if (!res.hasMore || res.items.length === 0) break;
          offset += res.items.length;
        }
        if (!cancelled) {
          setItems(all);
          setLoaded(true);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载收藏失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, loaded]);

  // Search-filtered set (kind ignored) — drives the per-kind chip counts.
  const bySearch = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => searchCorpus(it).includes(q));
  }, [items, query]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: bySearch.length };
    for (const it of bySearch) c[it.kind] = (c[it.kind] ?? 0) + 1;
    return c;
  }, [bySearch]);

  const filtered = useMemo(
    () => (kind === 'all' ? bySearch : bySearch.filter((it) => it.kind === kind)),
    [bySearch, kind],
  );

  // Reset to first page whenever the visible set changes.
  useEffect(() => {
    setPage(0);
  }, [query, kind]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageItems = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  if (!open) return null;

  return (
    <div className="weq-collection-layer" role="presentation" onMouseDown={closeFromScrim(onClose)}>
      <div
        className="weq-collection-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="weq-collection-title"
      >
        <button className="weq-collection-close" onClick={onClose} title="关闭" type="button">
          <X size={18} strokeWidth={2} />
        </button>

        <header className="weq-collection-head">
          <div className="weq-collection-title-row">
            <Bookmark size={18} strokeWidth={1.9} />
            <h2 id="weq-collection-title">我的收藏</h2>
            {loaded ? <span className="weq-collection-total">{items.length}</span> : null}
          </div>
          <div className="weq-collection-search">
            <Search size={15} strokeWidth={1.8} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索标题 / 内容 / 来源…"
              spellCheck={false}
            />
            {query ? (
              <button type="button" className="weq-collection-search-clear" onClick={() => setQuery('')}>
                <X size={13} strokeWidth={2} />
              </button>
            ) : null}
          </div>
        </header>

        <div className="weq-collection-filters" role="tablist" aria-label="收藏类型">
          {KIND_FILTERS.filter((k) => k.id === 'all' || (counts[k.id] ?? 0) > 0).map((k) => (
            <button
              key={k.id}
              type="button"
              role="tab"
              aria-selected={kind === k.id}
              className={`weq-collection-chip${kind === k.id ? ' is-active' : ''}`}
              onClick={() => setKind(k.id)}
            >
              {k.label}
              <span className="weq-collection-chip-n">{counts[k.id] ?? 0}</span>
            </button>
          ))}
        </div>

        <div className="weq-collection-body">
          {loading ? (
            <div className="weq-collection-state">
              <Loader2 size={22} className="weq-spin" />
              <span>正在加载收藏…</span>
            </div>
          ) : error ? (
            <div className="weq-collection-state is-error">{error}</div>
          ) : filtered.length === 0 ? (
            <div className="weq-collection-state">
              {items.length === 0 ? '还没有任何收藏' : '没有匹配的收藏'}
            </div>
          ) : (
            <div className="weq-collection-grid">
              {pageItems.map((it) => (
                <CollectionCard key={it.cid} it={it} />
              ))}
            </div>
          )}
        </div>

        {!loading && !error && filtered.length > 0 ? (
          <footer className="weq-collection-pager">
            <button
              type="button"
              className="weq-collection-page-btn"
              disabled={safePage <= 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              <ChevronLeft size={16} strokeWidth={2} />
              上一页
            </button>
            <span className="weq-collection-page-info">
              第 {safePage + 1} / {pageCount} 页
            </span>
            <button
              type="button"
              className="weq-collection-page-btn"
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            >
              下一页
              <ChevronRight size={16} strokeWidth={2} />
            </button>
          </footer>
        ) : null}
      </div>
    </div>
  );
}
