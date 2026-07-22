/**
 * 商城表情浏览器灯箱。
 *
 * 两栏布局：
 *   左栏  搜索框 + 来源筛选 chips + 无限滚动包列表（名称 / 描述 / 付费徽章）
 *   右栏  点击包后展示该包全部表情的解密动图网格（复用 weq-mface-lb-* 样式）
 *
 * 数据走 account.marketEmoji.searchCatalog（分页拉包目录）和
 * account.marketEmoji.getPackDetail（拉选中包的表情列表）。图片指向
 * weq-media://mface?...&enc=tea（密钥后端自动恢复），不过 tRPC。
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Search, Store, X, RefreshCw, Loader2, SmilePlus } from 'lucide-react';
import type { MarketPackFeeType } from '@weq/service';
import { trpc, client } from '../../trpc/client';
import { mediaUrl } from '../../lib/resourceUrl';

const PAGE = 60;

interface CatalogEntry {
  id: string;
  name: string;
  mark: string;
  feeType: MarketPackFeeType;
}

const FEE_META: Record<MarketPackFeeType, { label: string; tone: string }> = {
  free: { label: '免费', tone: 'free' },
  paid: { label: '付费', tone: 'paid' },
  svip: { label: 'SVIP', tone: 'svip' },
  vip: { label: 'VIP', tone: 'vip' },
  unknown: { label: '免费', tone: 'free' },
};

const FEE_FILTERS: Array<{ id: MarketPackFeeType; label: string }> = [
  { id: 'free', label: '免费' },
  { id: 'paid', label: '付费' },
  { id: 'vip', label: 'VIP' },
  { id: 'svip', label: 'SVIP' },
];

function packImageUrl(packId: string, hash: string): string {
  return mediaUrl('mface', { pack: packId, hash, enc: 'tea' });
}

/** 右栏：选中包的全部表情网格。 */
function PackDetailPane({ packId }: { packId: string }): ReactElement {
  const detail = trpc.account.marketEmoji.getPackDetail.useQuery({ packId });
  const fee = FEE_META[detail.data?.feeType ?? 'unknown'];
  const items = detail.data?.items ?? [];

  return (
    <div className="weq-emb-detail">
      <div className="weq-emb-detail-head">
        <Store size={15} className="weq-emb-detail-head-icon" />
        <span className="weq-mface-lb-title">
          {detail.data?.name || `表情包 ${packId}`}
        </span>
        <em className={`weq-emb-fee is-${fee.tone}`}>{fee.label}</em>
        {detail.data ? (
          <span className="weq-mface-lb-count">{detail.data.count} 张</span>
        ) : null}
      </div>
      {detail.isLoading ? (
        <div className="weq-mface-lb-state">
          <Loader2 size={18} className="weq-emb-spin" />
          获取表情列表中…
        </div>
      ) : !detail.data ? (
        <div className="weq-mface-lb-state is-error">
          无法获取这组表情（网络问题或包不存在）
        </div>
      ) : items.length === 0 ? (
        <div className="weq-mface-lb-state">这个表情包暂时没有可显示的表情</div>
      ) : (
        <div className="weq-mface-lb-scroll weq-emb-emoji-scroll">
          <div className="weq-mface-lb-grid">
            {items.map((it) => (
              <EmojiCell key={it.hash} packId={packId} hash={it.hash} name={it.name} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** 一张表情图：TEA 解密后的 GIF；失败显示占位。 */
function EmojiCell({ packId, hash, name }: { packId: string; hash: string; name: string }): ReactElement {
  const [broken, setBroken] = useState(false);
  return (
    <figure className="weq-mface-lb-cell" title={name || hash}>
      <span className="weq-mface-lb-stage">
        {broken ? (
          <RefreshCw size={18} strokeWidth={1.4} className="weq-mface-lb-fallback" />
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
      {name ? <figcaption className="weq-mface-lb-name">{name}</figcaption> : null}
    </figure>
  );
}

/** 左栏：一个包列表项（无需查 detail，mark 来自 catalog）。 */
function PackListItem({
  entry,
  selected,
  onSelect,
}: {
  entry: CatalogEntry;
  selected: boolean;
  onSelect: () => void;
}): ReactElement {
  const fee = FEE_META[entry.feeType];
  return (
    <button
      type="button"
      className={`weq-emb-pack-item${selected ? ' is-selected' : ''}`}
      onClick={onSelect}
    >
      <em className={`weq-emb-fee is-${fee.tone}`}>{fee.label}</em>
      <span className="weq-emb-pack-meta">
        <span className="weq-emb-pack-name">{entry.name || `表情包 ${entry.id}`}</span>
        <span className="weq-emb-pack-mark">{entry.mark || ' '}</span>
      </span>
    </button>
  );
}

export function MarketEmojiBrowserLightbox({ onClose }: { onClose: () => void }): ReactElement {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [feeSel, setFeeSel] = useState<Set<MarketPackFeeType>>(new Set());

  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // ESC 关闭。
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 防抖：输入停 300ms 落到 query。
  useEffect(() => {
    const t = setTimeout(() => setQuery(input.trim()), 300);
    return () => clearTimeout(t);
  }, [input]);

  // query / feeSel 变化 → 重置结果重新拉第一页。
  useEffect(() => {
    let cancelled = false;
    loadingRef.current = false;
    setEntries([]);
    setCursor(null);
    setDone(false);
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
      } catch {
        if (!cancelled) setDone(true);
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
    } catch {
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
      { rootMargin: '200px' },
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

  const selectedEntry = selectedId ? entries.find((e) => e.id === selectedId) : null;

  return (
    <div className="weq-blob-overlay weq-anim-fade" role="presentation" onMouseDown={onClose}>
      <div
        className="weq-blob-dialog weq-emb-dialog"
        role="dialog"
        aria-label="商城表情浏览"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="weq-blob-head">
          <div className="weq-blob-title">
            <h3>商城表情浏览</h3>
            {total > 0 ? (
              <code>
                {loading && entries.length === 0
                  ? '搜索中…'
                  : `共 ${total.toLocaleString('en-US')} 套${query || feeSel.size ? ' · 已过滤' : ''}`}
              </code>
            ) : null}
          </div>
          <button type="button" className="weq-blob-close" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="weq-emb-body">
          {/* 左栏：搜索 + 筛选 + 包列表 */}
          <div className="weq-emb-left">
            <div className="weq-emb-toolbar">
              <div className="weq-mpd-search">
                <Search size={15} aria-hidden />
                <input
                  placeholder="搜索表情包名称或描述"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                />
                {input ? (
                  <button type="button" title="清空" onClick={() => setInput('')}>
                    <X size={14} />
                  </button>
                ) : null}
              </div>
            </div>

            <div className="weq-emb-fee-row">
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

            <div className="weq-emb-pack-list">
              {loading && entries.length === 0 ? (
                <div className="weq-emb-pack-list-state">
                  <Loader2 size={16} className="weq-emb-spin" />
                  搜索中…
                </div>
              ) : entries.length === 0 ? (
                <div className="weq-emb-pack-list-state">没有匹配的表情包</div>
              ) : (
                <>
                  {entries.map((entry) => (
                    <PackListItem
                      key={entry.id}
                      entry={entry}
                      selected={selectedId === entry.id}
                      onSelect={() => setSelectedId(entry.id)}
                    />
                  ))}
                  {!done ? (
                    <div ref={sentinelRef} className="weq-emb-sentinel">
                      {loading ? <Loader2 size={14} className="weq-emb-spin" /> : '加载更多…'}
                    </div>
                  ) : (
                    <div className="weq-emb-sentinel">已全部加载（{entries.length}）</div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* 右栏：选中包的表情网格 */}
          <div className="weq-emb-right">
            {selectedId ? (
              <PackDetailPane packId={selectedId} />
            ) : (
              <div className="weq-emb-empty">
                <SmilePlus size={36} strokeWidth={1.3} />
                <span>点击左侧表情包查看全部表情</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
