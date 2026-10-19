/**
 * 商城表情整页浏览器。
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
import { MarketFaceDetail } from '../../components/MarketFaceLightbox';
import {
  ArrowLeft,
  Store,
  X,
  RefreshCw,
  Loader2,
  SmilePlus,
  Download,
  Settings2,
} from 'lucide-react';
import type { MarketPackFeeType } from '@weq/service';
import { trpc, client } from '../../trpc/client';
import { useMultiSelection, type MultiSelectionItemProps } from '../../hooks/useMultiSelection';
import { useContentMultiSelect } from '../../state/contentSelection';
import { useExportSavePolicy } from '../../hooks/useExportSavePolicy';
import { DirectoryToolbar } from '../../components/DirectoryToolbar';
import { WorkspacePage } from '../../components/WorkspacePages';
import { ExportSaveControl } from './ExportSaveControl';
import { MARKET_DOWNLOAD_MAX_PACKS } from '../../../../shared/market_emoji';
import '../../styles/market-browser.css';
import '../../styles/export.css';
import '../../styles/workspace-tools.css';
import { mediaUrl } from '../../lib/resourceUrl';
import { ShimmerImage } from '../../components/ShimmerImage';
import { useAppDialog } from '../../lib/dialogUtils';
import { GridSkeleton } from './ExportSkeleton';

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
function PackDetailPane({
  packId,
  name,
  description,
  busy,
  onDownload,
}: {
  packId: string;
  name: string;
  description: string;
  busy: boolean;
  onDownload: (packs: { id: string; name: string }[]) => Promise<void>;
}): ReactElement {
  const detail = trpc.account.marketEmoji.getPackDetail.useQuery({ packId });
  const [saving, setSaving] = useState(false);
  /** 正在看大图的 hash；空串 = 网格。 */
  const [detailHash, setDetailHash] = useState('');
  const fee = FEE_META[detail.data?.feeType ?? 'unknown'];
  const items = detail.data?.items ?? [];
  const index = items.findIndex((item) => item.hash === detailHash);
  const current = index >= 0 ? items[index] : undefined;

  // 换包时退出大图，避免停在上一个包的 hash 上。
  useEffect(() => {
    setDetailHash('');
  }, [packId]);

  async function download(): Promise<void> {
    setSaving(true);
    try {
      await onDownload([{ id: packId, name: name || detail.data?.name || packId }]);
    } finally {
      setSaving(false);
    }
  }

  if (current) {
    return (
      <MarketFaceDetail
        embedded
        packId={packId}
        packName={detail.data?.name || name || `表情包 ${packId}`}
        item={current}
        index={index}
        total={items.length}
        onBack={() => setDetailHash('')}
        onPrev={index > 0 ? () => setDetailHash(items[index - 1]!.hash) : undefined}
        onNext={index < items.length - 1 ? () => setDetailHash(items[index + 1]!.hash) : undefined}
      />
    );
  }

  return (
    <div className="weq-emb-detail">
      <div className="weq-emb-detail-head">
        <Store size={15} className="weq-emb-detail-head-icon" />
        <span className="weq-mface-lb-title">{detail.data?.name || `表情包 ${packId}`}</span>
        <em className={`weq-emb-fee is-${fee.tone}`}>{fee.label}</em>
        {detail.data ? <span className="weq-mface-lb-count">{detail.data.count} 张</span> : null}
        <button
          type="button"
          className="weq-emb-download"
          disabled={saving || busy || !detail.data}
          onClick={() => void download()}
          title="解密下载这一整套到本地文件夹"
        >
          {saving ? <Loader2 size={14} className="weq-emb-spin" /> : <Download size={14} />}
          一键下载
        </button>
      </div>
      {description ? <p className="weq-market-description">{description}</p> : null}
      {detail.isLoading ? (
        <GridSkeleton cells={10} />
      ) : !detail.data ? (
        <div className="weq-mface-lb-state is-error">无法获取这组表情（网络问题或包不存在）</div>
      ) : items.length === 0 ? (
        <div className="weq-mface-lb-state">这个表情包暂时没有可显示的表情</div>
      ) : (
        <div className="weq-mface-lb-scroll weq-emb-emoji-scroll">
          <div className="weq-mface-lb-grid">
            {items.map((it) => (
              <EmojiCell
                key={it.hash}
                packId={packId}
                hash={it.hash}
                name={it.name}
                onOpen={() => setDetailHash(it.hash)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** 一张表情图：TEA 解密后的 GIF；失败显示占位。点击看大图与解密参数。 */
function EmojiCell({
  packId,
  hash,
  name,
  onOpen,
}: {
  packId: string;
  hash: string;
  name: string;
  onOpen: () => void;
}): ReactElement {
  const [broken, setBroken] = useState(false);
  return (
    <button
      type="button"
      className="weq-mface-lb-cell is-button"
      title={name ? `${name} · 点击查看大图` : `${hash} · 点击查看大图`}
      onClick={onOpen}
    >
      <span className="weq-mface-lb-stage">
        {broken ? (
          <RefreshCw size={18} strokeWidth={1.4} className="weq-mface-lb-fallback" />
        ) : (
          <ShimmerImage
            src={packImageUrl(packId, hash)}
            alt={name || hash}
            loading="lazy"
            draggable={false}
            onError={() => setBroken(true)}
          />
        )}
      </span>
      {name ? <span className="weq-mface-lb-name">{name}</span> : null}
    </button>
  );
}

/** 左栏：一个包列表项（无需查 detail，mark 来自 catalog）。 */
function PackListItem({
  entry,
  selected,
  onSelect,
  selectionProps,
}: {
  entry: CatalogEntry;
  selected: boolean;
  onSelect: () => void;
  selectionProps: MultiSelectionItemProps;
}): ReactElement {
  const fee = FEE_META[entry.feeType];
  return (
    <button
      type="button"
      className={`weq-emb-pack-item${selected ? ' is-selected' : ''}`}
      aria-pressed={selected}
      {...selectionProps}
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

export function MarketEmojiBrowserLightbox({
  onClose,
  initialPackId,
  initialPackName,
  embedded = false,
}: {
  onClose?: () => void;
  initialPackId?: string;
  initialPackName?: string;
  /** 嵌在「个性装扮 → 表情」页签里：不套 WorkspacePage、不渲染标题与关闭按钮。 */
  embedded?: boolean;
}): ReactElement {
  const utils = trpc.useUtils();
  const dialog = useAppDialog();
  const save = useExportSavePolicy();
  const selection = useContentMultiSelect({ kind: 'market-emojis', container: 'catalog' });
  const [saveOpen, setSaveOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [queued, setQueued] = useState(false);
  const pending = useRef(false);
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [feeSel, setFeeSel] = useState<Set<MarketPackFeeType>>(new Set());
  const [latest, setLatest] = useState(false);

  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  // cursor / done 也存一份 ref，且随响应同步更新：IntersectionObserver 回调持有
  // 旧渲染闭包，而 done 状态要等 React commit 后才翻转——闭包读到旧值会把
  // 最后一页再拉一次（重复）。同步写 ref 堵死该窗口。
  const cursorRef = useRef<string | null>(null);
  const doneRef = useRef(false);
  const loadingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(initialPackId ?? null);
  useEffect(() => {
    if (initialPackId) setSelectedId(initialPackId);
  }, [initialPackId]);
  const packMulti = useMultiSelection({
    ids: entries.map((entry) => entry.id),
    selected: selection.selectedIds,
    onChange: selection.setSelectedIds,
    enabled: selection.selectionMode,
    disabled: downloading,
    onStart: () => selection.setSelectionMode(true),
    onExit: () => selection.setSelectionMode(false),
  });
  async function download(packs: { id: string; name: string }[]) {
    if (pending.current || !packs.length || packs.length > MARKET_DOWNLOAD_MAX_PACKS) return;
    const targets = packs.map((pack) => ({ ...pack }));
    pending.current = true;
    setDownloading(true);
    setQueued(false);
    try {
      const policy = await save.prepareSave();
      if (!policy || !save.isCurrent()) return;
      await client.account.marketEmoji.startDownload.mutate({
        packs: targets,
        savePolicy: policy,
        ...(save.accountUin ? { expectedAccountUin: save.accountUin } : {}),
      });
      if (!save.isCurrent()) return;
      setQueued(true);
      selection.removeSelectedIds(targets.map((pack) => pack.id));
      void utils.account.listExportTasks.invalidate().catch((error) => {
        if (save.isCurrent())
          dialog.error(
            '任务已创建，刷新列表失败',
            error instanceof Error ? error.message : String(error),
          );
      });
    } catch (error) {
      if (save.isCurrent())
        dialog.error('创建下载任务失败', error instanceof Error ? error.message : String(error));
    } finally {
      pending.current = false;
      if (save.isCurrent()) setDownloading(false);
    }
  }
  function downloadSelected() {
    const names = new Map(entries.map((entry) => [entry.id, entry.name]));
    void download([...selection.selectedIds].map((id) => ({ id, name: names.get(id) || id })));
  }

  // 防抖：输入停 300ms 落到 query。
  useEffect(() => {
    const t = setTimeout(() => setQuery(input.trim()), 300);
    return () => clearTimeout(t);
  }, [input]);

  // query / feeSel 变化 → 重置结果重新拉第一页。
  useEffect(() => {
    let cancelled = false;
    loadingRef.current = false;
    cursorRef.current = null;
    doneRef.current = false;
    setEntries([]);
    setDone(false);
    setLoading(true);
    (async () => {
      try {
        const page = await client.account.marketEmoji.searchCatalog.query({
          keyword: query || undefined,
          feeTypes: latest ? undefined : feeSel.size ? [...feeSel] : undefined,
          latest: latest || undefined,
          limit: PAGE,
          cursor: null,
        });
        if (cancelled) return;
        setEntries(page.entries);
        setTotal(page.total);
        cursorRef.current = page.nextCursor;
        if (page.nextCursor === null) {
          doneRef.current = true;
          setDone(true);
        }
      } catch {
        if (!cancelled) {
          doneRef.current = true;
          setDone(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query, feeSel, latest]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (loadingRef.current || doneRef.current || cursorRef.current === null) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const page = await client.account.marketEmoji.searchCatalog.query({
        keyword: query || undefined,
        feeTypes: latest ? undefined : feeSel.size ? [...feeSel] : undefined,
        latest: latest || undefined,
        limit: PAGE,
        cursor: cursorRef.current,
      });
      setEntries((prev) => [...prev, ...page.entries]);
      setTotal(page.total);
      cursorRef.current = page.nextCursor;
      if (page.nextCursor === null) {
        doneRef.current = true;
        setDone(true);
      }
    } catch {
      doneRef.current = true;
      setDone(true);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [query, feeSel, latest]);

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

  const feeMulti = useMultiSelection({
    ids: FEE_FILTERS.map((item) => item.id),
    selected: feeSel,
    onChange: (next) => {
      setLatest(false);
      setFeeSel(next);
    },
  });

  /** 「最新上架」：只看目录尾部（id 最大 = 上架最晚），与来源筛选互斥。 */
  const toggleLatest = (): void => {
    setLatest((v) => !v);
    setFeeSel(new Set());
  };

  const body = (
    <div
      className={`weq-market-browser${selectedId ? ' has-detail' : ''}${embedded ? ' is-embedded' : ''}`}
      role="region"
      aria-labelledby={embedded ? undefined : 'weq-market-title'}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {embedded ? (
        <div className="weq-market-head is-embedded">
          {/* 内嵌时左右两栏始终并排，左栏列表就在旁边，不需要「返回表情包列表」。
              以前那个返回按钮只在 ≤700px 的窄屏媒体查询里有意义，而主窗口最小宽度
              是 940px，桌面端永远不会触发 —— 选中表情包后只剩一个按钮独占一行。 */}
          <div className="weq-market-title">
            <Store size={18} strokeWidth={1.9} />
            <span className="weq-market-embedded-label">表情包</span>
            {total > 0 ? (
              <span className="weq-market-total">
                {loading && entries.length === 0
                  ? '搜索中…'
                  : `共 ${total.toLocaleString('en-US')} 套${query || feeSel.size || latest ? ' · 已过滤' : ''}`}
              </span>
            ) : null}
          </div>
        </div>
      ) : (
        <header className="weq-market-head">
          {selectedId ? (
            <button
              type="button"
              className="weq-market-back icon-button"
              title="返回表情包列表"
              aria-label="返回表情包列表"
              onClick={() => setSelectedId(null)}
            >
              <ArrowLeft size={18} />
            </button>
          ) : null}
          <div className="weq-market-title">
            <Store size={18} strokeWidth={1.9} />
            <h2 id="weq-market-title">商城表情</h2>
            {total > 0 ? (
              <span className="weq-market-total">
                {loading && entries.length === 0
                  ? '搜索中…'
                  : `共 ${total.toLocaleString('en-US')} 套${query || feeSel.size || latest ? ' · 已过滤' : ''}`}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className="weq-market-close"
            onClick={onClose}
            title="关闭商城表情"
            aria-label="关闭商城表情"
          >
            <X size={18} />
          </button>
        </header>
      )}
      {saveOpen || selection.selectionMode ? (
        <ExportSaveControl
          value={save.policy}
          onChange={save.setOverride}
          onPickDirectory={() => void save.pickDirectory()}
          onSetDefault={() => void save.setDefault()}
          onReset={() => save.setOverride(null)}
          overridden={save.hasOverride}
          disabled={downloading || save.settings.isLoading}
          picking={save.picking}
        />
      ) : null}
      {queued ? (
        <div className="weq-market-job-status" role="status">
          已创建下载任务
        </div>
      ) : null}

      <div className="weq-emb-body">
        {/* 左栏：搜索 + 筛选 + 包列表 */}
        <div className="weq-emb-left" {...packMulti.rootProps}>
          <DirectoryToolbar
            noun="表情包"
            query={input}
            onQuery={setInput}
            selecting={selection.selectionMode}
            onSelecting={selection.setSelectionMode}
            count={selection.selectedIds.size}
            onSelectAll={() =>
              selection.setSelectedIds(
                (current) => new Set([...current, ...entries.map((entry) => entry.id)]),
              )
            }
          >
            <button
              type="button"
              title="保存方式"
              aria-label="保存方式"
              aria-expanded={saveOpen}
              onClick={() => setSaveOpen(!saveOpen)}
            >
              <Settings2 size={16} />
            </button>
          </DirectoryToolbar>
          {selection.selectionMode ? (
            <div className="weq-market-selection-actions">
              <span>
                {selection.selectedIds.size} / {MARKET_DOWNLOAD_MAX_PACKS} 套
              </span>
              <button
                type="button"
                className="weq-action-primary"
                title={
                  selection.selectedIds.size > MARKET_DOWNLOAD_MAX_PACKS
                    ? `单次最多 ${MARKET_DOWNLOAD_MAX_PACKS} 套`
                    : '下载选中表情包'
                }
                disabled={
                  downloading ||
                  save.picking ||
                  save.settings.isLoading ||
                  !selection.selectedIds.size ||
                  selection.selectedIds.size > MARKET_DOWNLOAD_MAX_PACKS
                }
                onClick={downloadSelected}
              >
                {downloading ? (
                  <Loader2 size={15} className="weq-emb-spin" />
                ) : (
                  <Download size={15} />
                )}
                下载选中
              </button>
            </div>
          ) : null}

          <div className="weq-emb-fee-row" {...feeMulti.rootProps}>
            <button
              type="button"
              className={`weq-mpd-fee-chip${feeSel.size === 0 && !latest ? ' is-active' : ''}`}
              onClick={() => {
                setLatest(false);
                setFeeSel(new Set());
              }}
            >
              全部
            </button>
            <button
              type="button"
              className={`weq-mpd-fee-chip weq-emb-latest-chip${latest ? ' is-active' : ''}`}
              onClick={toggleLatest}
              title="只看最新上架的表情包（目录尾部）"
            >
              最新上架
            </button>
            {FEE_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={`weq-mpd-fee-chip${feeSel.has(f.id) ? ' is-active' : ''}`}
                {...feeMulti.itemProps(f.id)}
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
                    selected={
                      selection.selectionMode
                        ? selection.selectedIds.has(entry.id)
                        : selectedId === entry.id
                    }
                    selectionProps={packMulti.itemProps(entry.id)}
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
            <PackDetailPane
              packId={selectedId}
              name={
                entries.find((e) => e.id === selectedId)?.name ??
                (selectedId === initialPackId ? (initialPackName ?? '') : '')
              }
              description={entries.find((entry) => entry.id === selectedId)?.mark ?? ''}
              busy={downloading || save.picking}
              onDownload={download}
            />
          ) : (
            <div className="weq-emb-empty">
              <SmilePlus size={36} strokeWidth={1.3} />
              <span>点击左侧表情包查看全部表情</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  if (embedded) return body;
  return (
    <WorkspacePage title="商城表情" onClose={onClose} standalone>
      {body}
    </WorkspacePage>
  );
}
