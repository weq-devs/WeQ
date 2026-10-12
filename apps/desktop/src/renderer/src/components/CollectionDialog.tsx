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

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Download,
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
  RefreshCw,
  Search,
  Square,
  X,
} from 'lucide-react';
import { client } from '../trpc/client';
import { QqAvatar } from './QqAvatar';
import { openLightbox } from './ImageLightbox';
import { collectionImageUrl } from '../lib/resourceUrl';
import { closeFromScrim, useEscapeToClose } from '../im-template/template/modalUtils';
import { CollectionContent, collectionContentText } from './CollectionContent';
import { IS_WEB } from '../lib/target';

interface PicWire {
  uri: string;
  width: number;
  height: number;
}

interface CollectionItemWire {
  textTruncated?: boolean;
  contentStatus?: 'summary' | 'truncated' | 'cached';
  fullContent: string;
  fullContentFormat: 'text' | 'html' | 'binary' | null;
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
let requestSequence = 0;

function collectionRequestId(prefix: string): string {
  requestSequence += 1;
  return `${prefix}-${Date.now()}-${requestSequence}-${Math.random().toString(36).slice(2, 10)}`;
}

type CollectionSource = 'db' | 'network';

interface CollectionPageWire {
  items: CollectionItemWire[];
  hasMore: boolean;
}

interface CollectionDetailPatch {
  cid: string;
  contentStatus: 'cached';
  fullContent: string;
  fullContentFormat: 'text' | 'html' | 'binary' | null;
}

interface CollectionMediaResult {
  id: string;
  name: string;
  kind: string;
  state: 'downloaded' | 'failed' | 'unavailable';
  role: 'original' | 'preview' | 'unverified';
  bytes: number;
  md5Matches: boolean | null;
  sizeMatches: boolean | null;
  imageDecoded: boolean | null;
  error: string | null;
}

interface DetailSyncProgress {
  done: number;
  total: number;
  failed: number;
  cancelling: boolean;
  cancelled: boolean;
  message: string | null;
}

/** Page through `account.listCollections` until exhausted. 收藏集通常不大。 */
async function fetchAllCollections(source: CollectionSource): Promise<CollectionItemWire[] | null> {
  const all: CollectionItemWire[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (let page = 0; page < 1000; page++) {
    const res = (await client.account.listCollections.query({
      limit: 100,
      offset,
      source,
    })) as CollectionPageWire | null;
    // network 路径拿不到 p_skey / 请求失败时返回 null —— 保留已有的 db 结果。
    if (!res) return null;
    const inPage = new Set(seen);
    const fresh = res.items.filter((item) => {
      if (inPage.has(item.cid)) return false;
      inPage.add(item.cid);
      return true;
    });
    if (res.hasMore && !fresh.length) throw new Error('收藏分页没有进展，未标记加载完成。');
    for (const item of fresh) {
      seen.add(item.cid);
      all.push(item);
    }
    if (!res.hasMore) return all;
    offset += res.items.length;
  }
  throw new Error('收藏分页达到安全上限，未标记加载完成。');
}

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

function cachedContentText(it: CollectionItemWire): string {
  if (!it.fullContent) return '';
  if (it.fullContentFormat !== 'html') return it.fullContent;
  try {
    return collectionContentText(it.fullContent);
  } catch {
    return '';
  }
}

function applyDetailPatch(
  item: CollectionItemWire,
  patch: CollectionDetailPatch,
): CollectionItemWire {
  return item.cid === patch.cid ? { ...item, ...patch } : item;
}

function detailErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? '');
  if (/cancel|abort|取消/i.test(text)) return '同步已取消';
  if (/p_skey|online|pid|在线|登录|account/i.test(text)) return '需要登录中的 QQ 才能同步详情';
  return text || '同步详情失败';
}

/** All searchable text for one item, lower-cased. */
function searchCorpus(it: CollectionItemWire): string {
  const parts = [it.authorName, it.groupName, it.text, cachedContentText(it)];
  if (it.link) parts.push(it.link.title, it.link.publisher, it.link.brief, it.link.url);
  if (it.richMedia)
    parts.push(
      it.richMedia.title,
      it.richMedia.subTitle,
      it.richMedia.brief,
      it.richMedia.originalUri,
    );
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
        // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
        <Thumb key={`${p.uri}-${i}`} pic={p} alt={alt} />
      ))}
      {pics.length > 6 ? <span className="weq-col-picmore">+{pics.length - 6}</span> : null}
    </div>
  );
}

function CardBody({ it }: { it: CollectionItemWire }): ReactElement {
  const cachedText = cachedContentText(it);
  switch (it.kind) {
    case 'text':
      return <p className="weq-col-text">{cachedText || it.text || '(空文本)'}</p>;

    case 'link': {
      const l = it.link;
      if (!l) return <p className="weq-col-text is-muted">暂无链接内容</p>;
      const cover = l.pics[0];
      return (
        <button
          type="button"
          className="weq-col-link"
          onClick={() => l.url && window.open(l.url, '_blank')}
          title={l.url}
        >
          {cover ? (
            <img
              className="weq-col-link-thumb"
              src={collectionImageUrl(cover.uri)}
              alt=""
              loading="lazy"
            />
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
      return <PicGrid pics={it.gallery?.pics ?? []} alt="收藏图片" />;

    case 'audio': {
      const a = it.audio;
      if (!a) return <p className="weq-col-text is-muted">暂无语音内容</p>;
      return (
        <div className="weq-col-media-row">
          <span className="weq-col-media-icon">
            <Music size={18} strokeWidth={1.6} />
          </span>
          <span className="weq-col-media-meta">
            <span className="weq-col-media-title">
              语音{humanSeconds(a.duration / 1000) ? ` · ${humanSeconds(a.duration / 1000)}` : ''}
            </span>
            {a.stt ? <span className="weq-col-media-sub">{a.stt}</span> : null}
          </span>
        </div>
      );
    }

    case 'video': {
      const v = it.video;
      if (!v) return <p className="weq-col-text is-muted">暂无视频内容</p>;
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
      const f = it.file;
      if (!f) return <p className="weq-col-text is-muted">暂无文件内容</p>;
      return (
        <div className="weq-col-media-row">
          <span className="weq-col-media-icon">
            {f.ext ? (
              <span className="weq-col-file-ext">{f.ext}</span>
            ) : (
              <FileText size={18} strokeWidth={1.6} />
            )}
          </span>
          <span className="weq-col-media-meta">
            <span className="weq-col-media-title">{f.name || '文件'}</span>
            {humanSize(f.size) ? (
              <span className="weq-col-media-sub">{humanSize(f.size)}</span>
            ) : null}
          </span>
        </div>
      );
    }

    case 'location': {
      const loc = it.location;
      if (!loc) return <p className="weq-col-text is-muted">暂无位置信息</p>;
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
      const r = it.richMedia ?? { title: '', subTitle: '', brief: '', originalUri: '', pics: [] };
      const heading = r.title || r.subTitle;
      const body = cachedText || r.brief;
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

function CollectionCard({
  it,
  onOpen,
}: {
  it: CollectionItemWire;
  onOpen: (item: CollectionItemWire) => void;
}): ReactElement {
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
      <footer className="weq-col-card-foot">
        <span>{humanTime(it.collectTime)}</span>
        <button type="button" className="weq-col-detail-open" onClick={() => onOpen(it)}>
          查看详情
          <ChevronRight size={12} />
        </button>
      </footer>
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
  const [items, setItems] = useState<CollectionItemWire[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [page, setPage] = useState(0);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<CollectionItemWire | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailReload, setDetailReload] = useState(0);
  const [detailSync, setDetailSync] = useState<DetailSyncProgress | null>(null);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaResults, setMediaResults] = useState<CollectionMediaResult[] | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const mediaRun = useRef<{ requestId: string; cid: string } | null>(null);
  const detailGeneration = useRef(0);
  const forceDetailRefresh = useRef(false);
  const detailSyncRun = useRef<{ requestId: string; cancelled: boolean } | null>(null);
  const selectedContentStatus = useRef<CollectionItemWire['contentStatus']>(undefined);
  selectedContentStatus.current = selected?.contentStatus;
  useEscapeToClose(() => {
    if (selected) setSelected(null);
    else onClose();
  });

  // Two-stage load, the first time the dialog opens: paint the local
  // collection.db immediately (fast, works offline), then quietly swap in the
  // weiyun collector result once it lands (slow, but authoritative). A network
  // failure / missing p_skey keeps the db rows — 收藏 is never an error state.
  //
  // Reopening or explicitly refreshing reads the latest QQ detail cache. Every
  // state write belongs to this load so a closed/reopened dialog cannot receive
  // the previous network result or clear the new load's progress indicators.
  useEffect(() => {
    if (!open) {
      const run = detailSyncRun.current;
      if (run) {
        run.cancelled = true;
        void client.account.cancelCollectionDetailSync.mutate({ requestId: run.requestId });
      }
      setSelected(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setRefreshing(false);
    setError(null);
    (async () => {
      try {
        const local = await fetchAllCollections('db');
        if (cancelled) return;
        setItems(local ?? []);
        setLoaded(true);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载收藏失败');
        return;
      } finally {
        if (!cancelled) setLoading(false);
      }

      setRefreshing(true);
      try {
        const fresh = await fetchAllCollections('network');
        if (!cancelled && fresh) setItems(fresh);
      } catch {
        /* 网络补充失败:保留本地结果,不打扰用户 */
      } finally {
        if (!cancelled) setRefreshing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, reload]);

  const selectedCid = selected?.cid;
  useEffect(() => {
    setMediaResults(null);
    setMediaError(null);
    setMediaLoading(false);
    return () => {
      const run = mediaRun.current;
      if (run) {
        mediaRun.current = null;
        void client.account.cancelCollectionDetailSync
          .mutate({ requestId: run.requestId })
          .catch(() => {});
      }
    };
  }, [selectedCid, open]);

  const downloadAttachments = async (): Promise<void> => {
    if (!selectedCid || mediaRun.current) return;
    const run = { requestId: collectionRequestId('collection-media'), cid: selectedCid };
    mediaRun.current = run;
    setMediaLoading(true);
    setMediaError(null);
    try {
      const results = await client.account.downloadCollectionMedia.mutate(run);
      if (mediaRun.current === run) setMediaResults(results);
    } catch (error) {
      if (mediaRun.current === run) setMediaError(detailErrorText(error));
    } finally {
      if (mediaRun.current === run) {
        mediaRun.current = null;
        setMediaLoading(false);
      }
    }
  };

  const saveAttachment = async (id: string): Promise<void> => {
    try {
      const result = await client.account.saveCollectionMedia.mutate({ id });
      if (result?.downloadId) {
        const link = document.createElement('a');
        link.href = `/_download/${encodeURIComponent(result.downloadId)}`;
        link.download = result.name;
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
    } catch (error) {
      setMediaError(detailErrorText(error));
    }
  };
  useEffect(() => {
    if (!open || !selectedCid) return;
    let cancelled = false;
    const generation = ++detailGeneration.current;
    const cid = selectedCid;
    const force = forceDetailRefresh.current;
    forceDetailRefresh.current = false;
    setDetailLoading(true);
    setDetailError(null);
    void (async () => {
      try {
        const local = (await client.account.collectionDetail.query({
          cid,
        })) as CollectionItemWire | CollectionDetailPatch | null;
        if (cancelled || generation !== detailGeneration.current) return;
        if (local) {
          // Keep the current cloud summary; QQ's local list row may be stale
          // or absent even though a durable detail response is available.
          const detailFields = {
            contentStatus: local.contentStatus,
            fullContent: local.fullContent,
            fullContentFormat: local.fullContentFormat,
          };
          setSelected((current) =>
            current?.cid === cid ? { ...current, ...detailFields } : current,
          );
          setItems((current) =>
            current.map((item) => (item.cid === cid ? { ...item, ...detailFields } : item)),
          );
        }
        const alreadyCached =
          local?.contentStatus === 'cached' || selectedContentStatus.current === 'cached';
        if (alreadyCached && !force) return;
        const patches = (await client.account.syncCollectionDetails.mutate({
          requestId: collectionRequestId('collection-detail'),
          cids: [cid],
          force,
        })) as CollectionDetailPatch[];
        if (cancelled || generation !== detailGeneration.current) return;
        const patch = patches[0];
        if (!patch) throw new Error('收藏详情响应为空');
        setSelected((current) => (current ? applyDetailPatch(current, patch) : current));
        setItems((current) => current.map((item) => applyDetailPatch(item, patch)));
      } catch (error) {
        if (!cancelled && generation === detailGeneration.current) {
          setDetailError(detailErrorText(error));
        }
      } finally {
        if (!cancelled && generation === detailGeneration.current) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, selectedCid, detailReload]);

  const syncAllDetails = async (): Promise<void> => {
    if (detailSyncRun.current) return;
    const targets = items.filter((item) => item.contentStatus !== 'cached').map((item) => item.cid);
    if (!targets.length) {
      setDetailSync({
        done: items.length,
        total: items.length,
        failed: 0,
        cancelling: false,
        cancelled: false,
        message: null,
      });
      return;
    }
    const run = { requestId: collectionRequestId('collection-sync'), cancelled: false };
    detailSyncRun.current = run;
    setDetailSync({
      done: 0,
      total: targets.length,
      failed: 0,
      cancelling: false,
      cancelled: false,
      message: null,
    });
    let done = 0;
    let failed = 0;
    let failureMessage: string | null = null;
    try {
      for (let offset = 0; offset < targets.length; offset += 20) {
        if (run.cancelled) break;
        const cids = targets.slice(offset, offset + 20);
        try {
          const patches = (await client.account.syncCollectionDetails.mutate({
            requestId: run.requestId,
            cids,
          })) as CollectionDetailPatch[];
          if (run.cancelled) break;
          const byCid = new Map(patches.map((patch) => [patch.cid, patch]));
          setItems((current) =>
            current.map((item) => {
              const patch = byCid.get(item.cid);
              return patch ? applyDetailPatch(item, patch) : item;
            }),
          );
          setSelected((current) => {
            if (!current) return current;
            const patch = byCid.get(current.cid);
            return patch ? applyDetailPatch(current, patch) : current;
          });
        } catch (error) {
          const message = detailErrorText(error);
          failureMessage = message;
          if (run.cancelled || /取消/.test(message)) break;
          if (message === '需要登录中的 QQ 才能同步详情') {
            failed += targets.length - done;
            done = targets.length;
            setDetailSync({
              done,
              total: targets.length,
              failed,
              cancelling: false,
              cancelled: false,
              message: failureMessage,
            });
            break;
          }
          failed += cids.length;
        }
        done += cids.length;
        setDetailSync({
          done,
          total: targets.length,
          failed,
          cancelling: false,
          cancelled: false,
          message: failureMessage,
        });
        // Let the progress paint and give the stop button a chance to cancel
        // before the next bounded request starts.
        if (!run.cancelled && done < targets.length) {
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
      }
    } finally {
      if (detailSyncRun.current === run) detailSyncRun.current = null;
      setDetailSync((current) =>
        current
          ? {
              ...current,
              done: Math.max(current.done, done),
              failed,
              cancelling: false,
              cancelled: run.cancelled,
              message: failureMessage,
            }
          : null,
      );
    }
  };

  const cancelDetailSync = (): void => {
    const run = detailSyncRun.current;
    if (!run) return;
    run.cancelled = true;
    setDetailSync((current) =>
      current ? { ...current, cancelling: true, cancelled: true, message: null } : current,
    );
    void client.account.cancelCollectionDetailSync.mutate({ requestId: run.requestId });
  };

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
            {selected ? (
              <button
                type="button"
                className="weq-col-detail-back"
                onClick={() => setSelected(null)}
                title="返回收藏"
              >
                <ChevronLeft size={18} />
              </button>
            ) : null}
            <Bookmark size={18} strokeWidth={1.9} />
            <h2 id="weq-collection-title">{selected ? '收藏详情' : '我的收藏'}</h2>
            {loaded && !selected ? (
              <span className="weq-collection-total">{items.length}</span>
            ) : null}
            {selected ? (
              <>
                <button
                  type="button"
                  className="weq-col-detail-back"
                  title="刷新详情"
                  disabled={detailLoading || mediaLoading}
                  onClick={() => {
                    setMediaResults(null);
                    setMediaError(null);
                    forceDetailRefresh.current = true;
                    setDetailReload((n) => n + 1);
                  }}
                >
                  <RefreshCw size={14} />
                </button>
                <button
                  type="button"
                  className="weq-collection-sync-button"
                  disabled={detailLoading || mediaLoading}
                  onClick={() => void downloadAttachments()}
                >
                  <Download size={13} />
                  {mediaLoading ? '下载中' : '下载附件'}
                </button>
                {mediaLoading ? (
                  <button
                    type="button"
                    className="weq-collection-sync-button"
                    onClick={() => {
                      const run = mediaRun.current;
                      if (run)
                        void client.account.cancelCollectionDetailSync
                          .mutate({ requestId: run.requestId })
                          .catch(() => {});
                    }}
                  >
                    <Square size={10} />
                    停止
                  </button>
                ) : null}
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="weq-col-detail-back"
                  title="刷新收藏"
                  disabled={loading || refreshing || Boolean(detailSyncRun.current)}
                  onClick={() => {
                    setDetailSync(null);
                    setReload((n) => n + 1);
                  }}
                >
                  <RefreshCw size={14} />
                </button>
                {detailSyncRun.current ? (
                  <button
                    type="button"
                    className="weq-collection-sync-button"
                    onClick={cancelDetailSync}
                    disabled={detailSync?.cancelling}
                  >
                    <Square size={10} fill="currentColor" />
                    {detailSync?.cancelling ? '正在取消' : '停止'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="weq-collection-sync-button"
                    onClick={() => void syncAllDetails()}
                    disabled={loading || refreshing || items.length === 0}
                  >
                    <Download size={13} />
                    同步详情
                  </button>
                )}
              </>
            )}
            {refreshing && !selected ? (
              <span className="weq-collection-syncing" title="正在同步最新收藏">
                <Loader2 size={13} className="weq-spin" />
                同步中
              </span>
            ) : null}
            {detailSync && !selected ? (
              <span className="weq-collection-syncing" role="status">
                {detailSyncRun.current ? (
                  <Loader2 size={13} className="weq-spin" />
                ) : (
                  <Download size={13} />
                )}
                {detailSyncRun.current
                  ? `${detailSync.done}/${detailSync.total}`
                  : detailSync.cancelled
                    ? '已停止'
                    : detailSync.message === '需要登录中的 QQ 才能同步详情'
                      ? '需要登录 QQ'
                      : detailSync.failed
                        ? `完成 ${detailSync.done - detailSync.failed}/${detailSync.total}`
                        : '详情已同步'}
              </span>
            ) : null}
          </div>
          {!selected ? (
            <div className="weq-collection-search">
              <Search size={15} strokeWidth={1.8} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索标题 / 内容 / 来源…"
                spellCheck={false}
              />
              {query ? (
                <button
                  type="button"
                  className="weq-collection-search-clear"
                  onClick={() => setQuery('')}
                >
                  <X size={13} strokeWidth={2} />
                </button>
              ) : null}
            </div>
          ) : null}
        </header>
        {!selected ? (
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
        ) : null}
        <div className="weq-collection-body">
          {selected ? (
            <section className="weq-col-detail">
              <div className="weq-col-detail-meta">
                <QqAvatar uin={selected.authorUin || undefined} size={30} />
                <span>
                  {selected.authorName || '未知'}
                  {selected.groupName ? ` · ${selected.groupName}` : ''}
                </span>
                <time>{humanTime(selected.collectTime)}</time>
              </div>
              {detailLoading ? (
                <div className="weq-collection-state">
                  <Loader2 size={20} className="weq-spin" />
                  正在加载…
                </div>
              ) : null}
              {detailError ? (
                <p className="weq-col-detail-unavailable" role="status">
                  {detailError}
                </p>
              ) : null}
              {mediaError ? (
                <p className="weq-col-detail-unavailable" role="status">
                  {mediaError}
                </p>
              ) : null}
              {mediaResults ? (
                <div className="weq-col-media-results">
                  <div className="weq-col-media-results-head">
                    <span>
                      {mediaResults.length ? `附件 ${mediaResults.length}` : '暂无可下载附件'}
                    </span>
                    {!IS_WEB && mediaResults.some((result) => result.state === 'downloaded') ? (
                      <button
                        type="button"
                        className="weq-col-detail-open"
                        onClick={() => void client.account.revealCollectionMedia.mutate()}
                      >
                        打开文件夹
                      </button>
                    ) : null}
                  </div>
                  {mediaResults.map((result, index) => (
                    <div className="weq-col-media-result" key={result.id}>
                      <span>{result.name || `附件 ${index + 1}`}</span>
                      {result.state === 'downloaded' ? (
                        <button
                          type="button"
                          className="weq-col-detail-open"
                          onClick={() => void saveAttachment(result.id)}
                        >
                          另存为
                        </button>
                      ) : null}
                      <span title={result.error ?? undefined}>
                        {result.state !== 'downloaded'
                          ? result.error || '暂时无法下载'
                          : result.role === 'original'
                            ? '原件已校验'
                            : result.role === 'preview'
                              ? '预览图已下载'
                              : result.md5Matches === false
                                ? '已下载，原件校验不符'
                                : result.sizeMatches === false
                                  ? '已下载，大小与记录不符'
                                  : '已下载，原件未核验'}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
              {selected.fullContentFormat === 'text' || selected.fullContentFormat === 'html' ? (
                <CollectionContent
                  content={selected.fullContent}
                  format={selected.fullContentFormat}
                />
              ) : (
                <>
                  <CardBody it={selected} />
                  {!detailLoading ? (
                    <p className="weq-col-detail-unavailable">
                      {selected.fullContentFormat === 'binary'
                        ? '详情已同步，当前类型暂不支持直接预览。'
                        : selected.contentStatus === 'cached'
                          ? '详情已同步，当前没有额外正文。'
                          : '未能获取完整内容。'}
                    </p>
                  ) : null}
                </>
              )}
            </section>
          ) : loading ? (
            <div className="weq-collection-state">
              <Loader2 size={22} className="weq-spin" />
              <span>正在加载收藏…</span>
            </div>
          ) : error ? (
            <div className="weq-collection-state is-error">{error}</div>
          ) : filtered.length === 0 ? (
            <div className="weq-collection-state">
              {items.length === 0
                ? refreshing
                  ? '正在同步收藏…'
                  : '还没有任何收藏'
                : '没有匹配的收藏'}
            </div>
          ) : (
            <div className="weq-collection-grid">
              {pageItems.map((it) => (
                <CollectionCard key={it.cid} it={it} onOpen={setSelected} />
              ))}
            </div>
          )}
        </div>
        {!selected && !loading && !error && filtered.length > 0 ? (
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
