/**
 * 商城表情批量下载面板（导出中心 · marketpack 模式）。
 *
 * 全新自包含 UI，不复用会话导出的 ConversationPicker / ExportLightbox：
 *   顶部  搜索框 + 来源筛选 chips（离线搜 resources/emoji/market.csv 内存索引）
 *   主体  封面网格，滚动分页；每卡懒查 android.json 取首图当封面 + 名称/介绍/张数/来源
 *   预览  点卡片 → 灯箱展示该套全部表情的解密动图
 *   底部  已选 N 套 + 开始下载 → 起 exportManager 任务（下方任务列表跟踪 + 另存）
 *
 * 图片字节不过 tRPC —— <img> 指向 weq-media://mface?...&enc=tea（QQTEA 解密，见
 * media_protocol）。密钥后端按 packId 自动恢复（免费读种子 / 付费爆破）。
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Search, X, Store, RefreshCw, Download, Check, Loader2 } from 'lucide-react';
import type { MarketPackFeeType } from '@weq/service';
import { trpc, client } from '../../trpc/client';
import { mediaUrl } from '../../lib/resourceUrl';
import { useAppDialog } from '../../lib/dialogUtils';

const PAGE = 60;

/** 目录条目（对齐后端 searchCatalog 的 entries 投影）。 */
interface CatalogEntry {
  id: string;
  name: string;
  mark: string;
  feeType: MarketPackFeeType;
}

/** 来源徽章元信息（文案 + 色调 class 后缀）——与资源页 MarketPackExplorer 一致。 */
const FEE_META: Record<MarketPackFeeType, { label: string; tone: string }> = {
  free: { label: '免费', tone: 'free' },
  paid: { label: '付费', tone: 'paid' },
  svip: { label: 'SVIP', tone: 'svip' },
  vip: { label: 'VIP', tone: 'vip' },
  unknown: { label: '免费', tone: 'free' },
};

/** 筛选 chips：全部 + 四种付费门禁（unknown 已并入免费，不单列）。 */
const FEE_FILTERS: Array<{ id: MarketPackFeeType; label: string }> = [
  { id: 'free', label: '免费' },
  { id: 'paid', label: '付费' },
  { id: 'vip', label: 'VIP' },
  { id: 'svip', label: 'SVIP' },
];

/** weq-media URL：商城表情包的一张表情（TEA 解密路径，密钥后端自动恢复）。 */
function packImageUrl(packId: string, hash: string): string {
  return mediaUrl('mface', { pack: packId, hash, enc: 'tea' });
}

export function MarketEmojiDownloadPane({ onStarted }: { onStarted: () => void }): ReactElement {
  const dialog = useAppDialog();

  // 搜索状态：输入即时更新 input，防抖后落到 query 触发拉取。
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [feeSel, setFeeSel] = useState<Set<MarketPackFeeType>>(new Set());

  // 结果 / 分页。
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // 勾选 + 预览 + 提交。
  const [selected, setSelected] = useState<Map<string, string>>(new Map()); // id → name
  const [preview, setPreview] = useState<CatalogEntry | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 防抖：输入停 300ms 落到 query。
  useEffect(() => {
    const t = setTimeout(() => setQuery(input.trim()), 300);
    return () => clearTimeout(t);
  }, [input]);

  // query / feeSel 变化 → 重置结果并重新拉第一页。feeSel 由 useState 持有，未 toggle
  // 时引用稳定，可直接作依赖。
  useEffect(() => {
    let cancelled = false;
    loadingRef.current = false;
    setEntries([]);
    setCursor(null);
    setDone(false);
    setError(null);
    setLoading(true);
    (async () => {
      try {
        const page = await client.account.marketEmoji.searchCatalog.query({
          keyword: query || undefined,
          feeTypes: feeSel.size ? [...feeSel] : undefined,
          limit: PAGE,
          cursor: null,
        });
        if (cancelled) return;
        setEntries(page.entries);
        setTotal(page.total);
        setCursor(page.nextCursor);
        if (page.nextCursor === null) setDone(true);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setDone(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query, feeSel]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (loadingRef.current || done || cursor === null) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const page = await client.account.marketEmoji.searchCatalog.query({
        keyword: query || undefined,
        feeTypes: feeSel.size ? [...feeSel] : undefined,
        limit: PAGE,
        cursor,
      });
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
  }, [cursor, done, query, feeSel]);

  // 滚动到底自动加载下一页。
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

  const toggleFee = (id: MarketPackFeeType): void => {
    setFeeSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelect = (entry: CatalogEntry): void => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(entry.id)) next.delete(entry.id);
      else next.set(entry.id, entry.name);
      return next;
    });
  };

  async function startDownload(): Promise<void> {
    if (selected.size === 0) return;
    setSubmitting(true);
    try {
      await client.account.marketEmoji.startDownload.mutate({
        packs: [...selected.entries()].map(([id, name]) => ({ id, name })),
      });
      setSelected(new Map());
      onStarted();
      dialog.info('已开始下载', '下载任务已加入下方「导出任务列表」，完成后点任务上的「保存文件夹…」导出到本地。');
    } catch (e) {
      dialog.error('启动下载失败', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="weq-mpd">
      {/* 顶部：搜索 + 来源筛选 */}
      <div className="weq-mpd-toolbar">
        <div className="weq-mpd-search">
          <Search size={16} aria-hidden />
          <input
            placeholder="搜索表情包名称或描述（如 兔、新年、猫）"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          {input ? (
            <button type="button" title="清空" onClick={() => setInput('')}>
              <X size={14} />
            </button>
          ) : null}
        </div>
        <div className="weq-mpd-fees">
          <button
            type="button"
            className={`weq-mpd-fee-chip${feeSel.size === 0 ? ' is-active' : ''}`}
            onClick={() => setFeeSel(new Set())}
          >
            全部
          </button>
          {FEE_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`weq-mpd-fee-chip${feeSel.has(f.id) ? ' is-active' : ''}`}
              onClick={() => toggleFee(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="weq-mpd-meta">
        {error ? (
          <span className="is-error">{error}</span>
        ) : (
          <span>
            {loading && entries.length === 0 ? '搜索中…' : `共 ${total.toLocaleString('en-US')} 套`}
            {query || feeSel.size ? ' · 已过滤' : ''} · 点击表情包预览，勾选后批量下载
          </span>
        )}
      </div>

      {/* 主体：封面网格 */}
      <div className="weq-mpd-scroll">
        {entries.length === 0 && !loading ? (
          <div className="weq-mpd-empty">{error ? '搜索失败' : '没有匹配的表情包'}</div>
        ) : (
          <div className="weq-mpd-grid">
            {entries.map((entry) => (
              <PackCard
                key={entry.id}
                entry={entry}
                checked={selected.has(entry.id)}
                onToggle={() => toggleSelect(entry)}
                onOpen={() => setPreview(entry)}
              />
            ))}
          </div>
        )}
        {!done ? (
          <div ref={sentinelRef} className="weq-mpd-more">
            <RefreshCw size={14} className={loading ? 'is-spin' : ''} />
            {loading ? '加载中…' : '滚动加载更多'}
          </div>
        ) : entries.length > 0 ? (
          <div className="weq-mpd-more is-end">已全部加载（{entries.length}）</div>
        ) : null}
      </div>

      {/* 底部操作条（面板自带，不用导出中心的通用 footer） */}
      <div className="weq-mpd-actions">
        <span className="weq-mpd-actions-count">
          {selected.size > 0 ? `已选 ${selected.size} 套` : '勾选表情包后开始下载'}
        </span>
        {selected.size > 0 ? (
          <button type="button" className="weq-mpd-clear" onClick={() => setSelected(new Map())}>
            清空
          </button>
        ) : null}
        <button
          type="button"
          className="weq-mpd-download"
          disabled={selected.size === 0 || submitting}
          onClick={() => void startDownload()}
        >
          {submitting ? <Loader2 size={15} className="is-spin" /> : <Download size={15} />}
          批量下载
        </button>
      </div>

      {preview ? <PackPreview entry={preview} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}

/** 一张封面卡片：懒查 android.json 取首图当封面 + 名称/介绍/张数/来源徽章 + 勾选层。 */
function PackCard({
  entry,
  checked,
  onToggle,
  onOpen,
}: {
  entry: CatalogEntry;
  checked: boolean;
  onToggle: () => void;
  onOpen: () => void;
}): ReactElement {
  const detail = trpc.account.marketEmoji.getPackDetail.useQuery({ packId: entry.id });
  const [broken, setBroken] = useState(false);
  const fee = FEE_META[entry.feeType];
  const cover = detail.data?.items[0]?.hash;
  const summary = detail.data?.summary || entry.mark;

  return (
    <div className={`weq-mpd-card${checked ? ' is-checked' : ''}`}>
      <button
        type="button"
        className="weq-mpd-card-check"
        onClick={onToggle}
        title={checked ? '取消选择' : '选择'}
        aria-pressed={checked}
      >
        {checked ? <Check size={14} /> : null}
      </button>
      <button type="button" className="weq-mpd-card-body" onClick={onOpen} title={entry.name}>
        <span className="weq-mpd-cover">
          {cover && !broken ? (
            <img
              src={packImageUrl(entry.id, cover)}
              alt={entry.name}
              loading="lazy"
              draggable={false}
              onError={() => setBroken(true)}
            />
          ) : (
            <Store size={28} strokeWidth={1.3} className="weq-mpd-cover-fallback" />
          )}
          <em className={`weq-mpd-fee is-${fee.tone}`}>{fee.label}</em>
        </span>
        <span className="weq-mpd-card-info">
          <strong className="weq-mpd-card-name">{entry.name || `表情包 ${entry.id}`}</strong>
          <small className="weq-mpd-card-summary">{summary || '暂无介绍'}</small>
          <span className="weq-mpd-card-foot">
            <code>#{entry.id}</code>
            {detail.data ? <span>{detail.data.count} 张</span> : <span className="weq-mpd-dots">…</span>}
          </span>
        </span>
      </button>
    </div>
  );
}

/** 预览灯箱：该套全部表情的解密动图网格。 */
function PackPreview({ entry, onClose }: { entry: CatalogEntry; onClose: () => void }): ReactElement {
  const detail = trpc.account.marketEmoji.getPackDetail.useQuery({ packId: entry.id });
  const items = detail.data?.items ?? [];
  const fee = FEE_META[entry.feeType];

  return (
    <div className="weq-blob-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="weq-blob-dialog weq-mpd-preview"
        role="dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="weq-blob-head">
          <div className="weq-blob-title">
            <h3>
              {entry.name || `表情包 ${entry.id}`}
              <em className={`weq-mpd-fee is-${fee.tone}`}>{fee.label}</em>
            </h3>
            <code>#{entry.id}{detail.data ? ` · ${detail.data.count} 张` : ''}</code>
          </div>
          <button type="button" className="weq-blob-close" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>
        {entry.mark ? <p className="weq-mpd-preview-mark">{entry.mark}</p> : null}
        <div className="weq-blob-body weq-mpd-preview-body">
          {detail.isLoading ? (
            <div className="weq-mpd-empty">获取表情列表中…</div>
          ) : items.length === 0 ? (
            <div className="weq-mpd-empty">无法获取该表情包（网络问题或包不存在）</div>
          ) : (
            <div className="weq-mpd-preview-grid">
              {items.map((it) => (
                <PreviewCell key={it.hash} packId={entry.id} hash={it.hash} name={it.name} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 一张预览表情：TEA 解密后的 GIF；失败显示占位。 */
function PreviewCell({ packId, hash, name }: { packId: string; hash: string; name: string }): ReactElement {
  const [broken, setBroken] = useState(false);
  return (
    <figure className="weq-mpd-preview-cell" title={name || hash}>
      <span className="weq-mpd-preview-stage">
        {broken ? (
          <RefreshCw size={16} strokeWidth={1.4} className="weq-mpd-cover-fallback" />
        ) : (
          <img
            src={packImageUrl(packId, hash)}
            alt={name || hash}
            loading="lazy"
            draggable={false}
            onError={() => setBroken(true)}
          />
        )}
      </span>
      {name ? <figcaption>{name}</figcaption> : null}
    </figure>
  );
}
