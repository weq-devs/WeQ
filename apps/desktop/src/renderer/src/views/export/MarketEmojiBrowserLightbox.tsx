/**
 * 商城表情整页浏览器。
 *
 * 卡片目录展示首张表情预览，点击后进入整包详情；返回保留目录滚动位置。
 *
 * 数据走 account.marketEmoji.searchCatalog（分页拉包目录）和
 * account.marketEmoji.getPackDetail（拉选中包的表情列表）。图片指向
 * weq-media://mface?...&enc=tea（密钥后端自动恢复），不过 tRPC。
 */

import { ToolbarLabel } from '../../components/CompactToolbar';
import { observeCompactToolbar } from '../../components/CompactToolbar.shared';
import { NumericText } from '../../components/NumericText';
import { EmptyState } from '../../components/EmptyState';
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { z } from 'zod/v3';
import { MarketFaceDetail } from '../../components/MarketFaceLightbox';
import {
  ArrowLeft,
  Store,
  X,
  RefreshCw,
  Loader2,
  Download,
  Plus,
  SearchX,
  Sticker,
} from 'lucide-react';
import type { MarketPackFeeType, ExportSavePolicy } from '@weq/service';
import { trpc, client } from '../../trpc/client';
import { useMultiSelection, type MultiSelectionItemProps } from '../../hooks/useMultiSelection';
import { useContentMultiSelect } from '../../state/contentSelection.shared';
import { useExportSavePolicy } from '../../hooks/useExportSavePolicy';
import { useDevelopmentDressTools } from '../../hooks/useDevelopmentDressTools';
import { DirectoryToolbar } from '../../components/DirectoryToolbar';
import { WorkspacePage } from '../../components/WorkspacePages';
import { PageScrollSnapshot } from '../../components/PageScrollSnapshot';
import { usePageDataCache, usePageState } from '../../components/PageSnapshots.shared';
import { pageValue } from '../../lib/pageSnapshots';
import { ServerSavePrompt } from '../../components/ServerSavePrompt';
import { MARKET_DOWNLOAD_MAX_PACKS } from '../../../../shared/market_emoji';
import '../../styles/export.css';
import '../../styles/workspace-tools.css';
import '../../styles/market-browser.css';
import { mediaUrl } from '../../lib/resourceUrl';
import { ShimmerImage } from '../../components/ShimmerImage';
import { useAppDialog } from '../../lib/dialogUtils';
import { useExportReportDialog } from './ExportReportControl.shared';
import { GridSkeleton } from './ExportSkeleton';

const PAGE = 60;

interface CatalogEntry {
  id: string;
  name: string;
  mark: string;
  feeType: MarketPackFeeType;
}

interface CatalogPage {
  entries: CatalogEntry[];
  total: number;
  nextCursor: string | null;
  catalogVersion: string | null;
}

const EMPTY_CATALOG: CatalogPage = {
  entries: [],
  total: 0,
  nextCursor: null,
  catalogVersion: null,
};
const feeSchema = z.set(z.enum(['free', 'paid', 'svip', 'vip', 'unknown']));

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

type ComposerPackActions = NonNullable<MarketEmojiBrowserProps['composerAdd']>;

function ComposerPackAddButton({
  actions,
  packId,
  name,
  unavailable,
}: {
  actions: ComposerPackActions;
  packId: string;
  name: string;
  unavailable?: boolean;
}) {
  const added = actions.addedIds.has(packId);
  const adding = actions.addingId === packId;
  return (
    <button
      type="button"
      className="weq-emb-download"
      disabled={added || unavailable || Boolean(actions.addingId)}
      aria-label={`${added ? '已添加' : adding ? '正在添加' : '添加'} ${name}`}
      onClick={() => actions.add(packId)}
    >
      {adding ? <Loader2 size={14} className="weq-emb-spin" /> : <Plus size={14} />}
      <ToolbarLabel>{added ? '已添加' : adding ? '添加中…' : '添加'}</ToolbarLabel>
    </button>
  );
}

function packImageUrl(packId: string, hash: string, preferPackImage: boolean): string {
  return mediaUrl('mface', { pack: packId, hash, ...(preferPackImage ? { enc: 'tea' } : {}) });
}

/** 整包详情：选中包的全部表情网格。 */
function PackDetailPane({
  packId,
  name,
  description,
  busy,
  onDownload,
  composerAdd,
  preferPackImage,
}: {
  packId: string;
  name: string;
  description: string;
  busy: boolean;
  composerAdd?: ComposerPackActions;
  preferPackImage: boolean;
  onDownload: (packs: { id: string; name: string }[], intent?: ExportSavePolicy) => Promise<void>;
}): ReactElement {
  const detail = trpc.account.marketEmoji.getPackDetail.useQuery({ packId });
  const [saving, setSaving] = useState(false);
  const [addError, setAddError] = useState('');
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

  async function runAction(): Promise<void> {
    setSaving(true);
    setAddError('');
    try {
      await onDownload([{ id: packId, name: name || detail.data?.name || packId }]);
    } catch (error) {
      setAddError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  if (current && !composerAdd) {
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
      <div ref={observeCompactToolbar} className="weq-emb-detail-head">
        <Store size={15} className="weq-emb-detail-head-icon" />
        <span className="weq-mface-lb-title">
          {detail.data?.name || name || `表情包 ${packId}`}
        </span>
        <em className={`weq-emb-fee is-${fee.tone}`}>{fee.label}</em>
        {detail.data ? (
          <span className="weq-mface-lb-count">
            <span className="weq-number weq-number-inherit">{detail.data.count}</span> 张
          </span>
        ) : null}
        {composerAdd ? (
          <ComposerPackAddButton
            actions={composerAdd}
            packId={packId}
            name={detail.data?.name || name || `表情包 ${packId}`}
            unavailable={!items.length}
          />
        ) : (
          <button
            type="button"
            className="weq-emb-download"
            disabled={saving || busy || !detail.data}
            onClick={() => void runAction()}
            title="解密下载这一整套到本地文件夹"
          >
            {saving ? <Loader2 size={14} className="weq-emb-spin" /> : <Download size={14} />}
            <ToolbarLabel>一键下载</ToolbarLabel>
          </button>
        )}
      </div>
      {description ? <p className="weq-market-description">{description}</p> : null}
      {addError ? (
        <p className="weq-mface-lb-state is-error" role="alert">
          {addError}
        </p>
      ) : null}
      {detail.isLoading ? (
        <GridSkeleton cells={10} />
      ) : !detail.data ? (
        <div className="weq-mface-lb-state is-error">无法获取这组表情（网络问题或包不存在）</div>
      ) : items.length === 0 ? (
        <EmptyState compact icon={<Sticker />} title="这个表情包暂时没有可显示的表情" />
      ) : (
        <div className="weq-mface-lb-scroll weq-emb-emoji-scroll">
          <div className="weq-mface-lb-grid">
            {items.map((it) => (
              <EmojiCell
                key={it.hash}
                packId={packId}
                hash={it.hash}
                name={it.name}
                preferPackImage={preferPackImage}
                insert={Boolean(composerAdd)}
                onOpen={
                  composerAdd ? () => composerAdd.insert(packId, it) : () => setDetailHash(it.hash)
                }
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** 一张表情图，读取失败时显示占位。 */
function EmojiCell({
  packId,
  hash,
  name,
  insert,
  preferPackImage,
  onOpen,
}: {
  packId: string;
  hash: string;
  name: string;
  insert: boolean;
  preferPackImage: boolean;
  onOpen: () => void;
}): ReactElement {
  const [broken, setBroken] = useState(false);
  return (
    <button
      type="button"
      className="weq-mface-lb-cell is-button"
      title={`${name || hash} · ${insert ? '点击插入输入框' : '点击查看大图'}`}
      onClick={onOpen}
    >
      <span className="weq-mface-lb-stage">
        {broken ? (
          <RefreshCw size={18} strokeWidth={1.4} className="weq-mface-lb-fallback" />
        ) : (
          <ShimmerImage
            src={packImageUrl(packId, hash, preferPackImage)}
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

/** 目录卡片：接近可视区域才补全首张表情，沿用详情缓存与解密图片通道。 */
function PackCard({
  entry,
  selected,
  onSelect,
  selectionProps,
  composerAdd,
  preferPackImage,
}: {
  entry: CatalogEntry;
  selected: boolean;
  onSelect: () => void;
  selectionProps?: MultiSelectionItemProps;
  composerAdd?: ComposerPackActions;
  preferPackImage: boolean;
}): ReactElement {
  const cardRef = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const observer = new IntersectionObserver(
      (records) => {
        if (!records.some((record) => record.isIntersecting)) return;
        setVisible(true);
        observer.disconnect();
      },
      { root: card.closest('.weq-market-catalog-scroll'), rootMargin: '200px' },
    );
    observer.observe(card);
    return () => observer.disconnect();
  }, []);
  const detail = trpc.account.marketEmoji.getPackDetail.useQuery(
    { packId: entry.id },
    { enabled: visible, staleTime: Infinity, refetchOnWindowFocus: false },
  );
  const cover = detail.data?.items[0];
  const fee = FEE_META[entry.feeType];
  const name = entry.name || `表情包 ${entry.id}`;
  const count = detail.data ? <NumericText>{`${detail.data.count} 张`}</NumericText> : '表情包';
  const preview = (
    <button
      ref={cardRef}
      type="button"
      className={
        composerAdd
          ? 'weq-market-pack-open'
          : `weq-market-pack-card${selected ? ' is-selected' : ''}`
      }
      aria-pressed={selected}
      title={name}
      {...selectionProps}
      onClick={onSelect}
    >
      <span className="weq-market-pack-preview">
        {visible && cover && !broken ? (
          <ShimmerImage
            src={packImageUrl(entry.id, cover.hash, preferPackImage)}
            alt=""
            loading="lazy"
            draggable={false}
            onError={() => setBroken(true)}
          />
        ) : visible && detail.isInitialLoading ? (
          <span className="weq-exp-skel weq-market-pack-loading" />
        ) : (
          <Store size={28} strokeWidth={1.3} className="weq-mface-lb-fallback" />
        )}
        <em className={`weq-emb-fee is-${fee.tone}`}>{fee.label}</em>
      </span>
      <span className="weq-emb-pack-meta">
        <span className="weq-emb-pack-name">{name}</span>
        <span className="weq-emb-pack-mark">{entry.mark || ' '}</span>
      </span>
      {!composerAdd ? (
        <span className="weq-market-pack-foot">
          <span>{count}</span>
          <span>{selected ? '已选中' : '查看表情'}</span>
        </span>
      ) : null}
    </button>
  );
  return composerAdd ? (
    <div className={`weq-market-pack-card${selected ? ' is-selected' : ''}`}>
      {preview}
      <div className="weq-market-pack-foot">
        <span>{count}</span>
        <ComposerPackAddButton actions={composerAdd} packId={entry.id} name={name} />
      </div>
    </div>
  ) : (
    preview
  );
}

interface MarketEmojiBrowserProps {
  onClose?: () => void;
  initialPackId?: string;
  initialPackName?: string;
  embedded?: boolean;
  embeddedSearch?: { keyword: string; form: ReactNode };
  composerAdd?: {
    add: (id: string) => void;
    addingId?: string;
    insert: (packId: string, item: { hash: string; name: string }) => void;
    addedIds: ReadonlySet<string>;
  };
}

export function MarketEmojiBrowserLightbox(props: MarketEmojiBrowserProps): ReactElement {
  const enabled = useDevelopmentDressTools();
  if (enabled || props.composerAdd)
    return <MarketEmojiBrowser {...props} preferPackImage={enabled} />;
  const empty = <EmptyState icon={<Store />} title="商城表情浏览不可用" />;
  return props.embedded ? (
    empty
  ) : (
    <WorkspacePage title="商城表情" onClose={props.onClose} standalone>
      {empty}
    </WorkspacePage>
  );
}

function MarketEmojiBrowser({
  onClose,
  initialPackId,
  initialPackName,
  embedded = false,
  embeddedSearch,
  composerAdd,
  preferPackImage,
}: MarketEmojiBrowserProps & { preferPackImage: boolean }): ReactElement {
  const utils = trpc.useUtils();
  const dialog = useAppDialog();
  const report = useExportReportDialog();
  const save = useExportSavePolicy();
  const selection = useContentMultiSelect({ kind: 'market-emojis', container: 'catalog' });
  const [downloading, setDownloading] = useState(false);
  const [queued, setQueued] = useState(false);
  const pending = useRef(false);
  const [input, setInput] = useState('');
  const [localQuery, setQuery] = useState('');
  const query = embeddedSearch?.keyword ?? localQuery;
  const composer = Boolean(composerAdd);
  const [feeSel, setFeeSel] = usePageState<Set<MarketPackFeeType>>(
    'market-emoji:fees',
    new Set(),
    feeSchema,
    false,
    embedded,
  );
  const [latest, setLatest] = usePageState(
    'market-emoji:latest',
    false,
    pageValue.boolean,
    false,
    embedded,
  );
  const catalogCache = usePageDataCache();
  const catalogKey = JSON.stringify(['market-emoji', query, [...feeSel].sort(), latest]);
  const [result, setResult] = useState(() => ({
    key: catalogKey,
    page: (embedded ? catalogCache.read<CatalogPage>(catalogKey) : undefined) ?? EMPTY_CATALOG,
  }));
  const catalog = result.key === catalogKey ? result.page : EMPTY_CATALOG;
  const { entries, total, nextCursor } = catalog;
  const done = nextCursor === null;
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  // 响应到达后同步更新游标，防止观察器在 React 提交前再次请求同一页。
  const catalogRef = useRef(catalog);
  const request = useRef(0);
  const loadingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(initialPackId ?? null);
  const previousQuery = useRef(query);
  useEffect(() => {
    if (previousQuery.current === query) return;
    previousQuery.current = query;
    setSelectedId(null);
  }, [query]);
  useEffect(() => {
    if (initialPackId) setSelectedId(initialPackId);
  }, [initialPackId]);
  const packMulti = useMultiSelection({
    ids: entries.map((entry) => entry.id),
    selected: selection.selectedIds,
    onChange: selection.setSelectedIds,
    anchorRef: selection.anchorRef,
    enabled: !composerAdd && selection.selectionMode,
    disabled: downloading,
    onStart: () => selection.setSelectionMode(true),
    onExit: () => selection.setSelectionMode(false),
  });
  async function download(packs: { id: string; name: string }[], intent?: ExportSavePolicy) {
    if (pending.current || !packs.length || packs.length > MARKET_DOWNLOAD_MAX_PACKS) return;
    const targets = packs.map((pack) => ({ ...pack }));
    const binding = save.binding;
    pending.current = true;
    setDownloading(true);
    setQueued(false);
    try {
      const includeIntegrityReport = await report.choose();
      if (includeIntegrityReport === null || !save.isCurrent()) return;
      const policy = await save.prepareSave(intent, {
        kind: 'bundle',
        name: targets.length === 1 ? targets[0]!.name || targets[0]!.id : '商城表情包',
        targetCount: targets.length,
      });
      if (!policy || !save.isCurrent()) return;
      await client.account.marketEmoji.startDownload.mutate({
        packs: targets,
        includeIntegrityReport,
        ...binding,
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
  function downloadSelected(intent?: ExportSavePolicy) {
    const names = new Map(entries.map((entry) => [entry.id, entry.name]));
    void download(
      [...selection.selectedIds].map((id) => ({ id, name: names.get(id) || id })),
      intent,
    );
  }

  // 防抖：输入停 300ms 落到 query。
  useEffect(() => {
    if (embeddedSearch) return;
    const t = setTimeout(() => setQuery(input.trim()), 300);
    return () => clearTimeout(t);
  }, [input, embeddedSearch]);

  // 复用已加载的页，让恢复的滚动位置可以落在首屏之后。
  useEffect(() => {
    const revision = ++request.current;
    const cancel = () => {
      request.current++;
    };
    const cached = embedded ? catalogCache.read<CatalogPage>(catalogKey) : undefined;
    catalogRef.current = cached ?? EMPTY_CATALOG;
    setResult({ key: catalogKey, page: catalogRef.current });
    setSearchError(null);
    loadingRef.current = true;
    setLoading(true);
    (async () => {
      try {
        const page = await client.account.marketEmoji.searchCatalog.query({
          composer,
          keyword: query || undefined,
          feeTypes: latest ? undefined : feeSel.size ? [...feeSel] : undefined,
          latest: latest || undefined,
          limit: PAGE,
          cursor: null,
        });
        if (request.current !== revision) return;
        if (cached && cached.catalogVersion === page.catalogVersion) return;
        catalogRef.current = page;
        setResult({ key: catalogKey, page });
        if (embedded) catalogCache.write(catalogKey, page);
      } catch (error) {
        if (request.current === revision)
          setSearchError(error instanceof Error ? error.message : '读取商城表情目录失败');
      } finally {
        if (request.current === revision) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    })();
    return cancel;
  }, [query, feeSel, latest, embedded, composer, catalogCache, catalogKey, refresh]);

  const loadMore = useCallback(async (): Promise<void> => {
    const current = catalogRef.current;
    if (loadingRef.current || current.nextCursor === null) return;
    const revision = request.current;
    loadingRef.current = true;
    setLoading(true);
    try {
      const page = await client.account.marketEmoji.searchCatalog.query({
        composer,
        keyword: query || undefined,
        feeTypes: latest ? undefined : feeSel.size ? [...feeSel] : undefined,
        latest: latest || undefined,
        limit: PAGE,
        cursor: current.nextCursor,
      });
      if (request.current !== revision) return;
      if (current.catalogVersion !== page.catalogVersion) {
        setRefresh((value) => value + 1);
        return;
      }
      const merged = { ...page, entries: [...current.entries, ...page.entries] };
      catalogRef.current = merged;
      setResult({ key: catalogKey, page: merged });
      if (embedded) catalogCache.write(catalogKey, merged);
    } catch {
      if (request.current !== revision) return;
      const stopped = { ...current, nextCursor: null };
      catalogRef.current = stopped;
      setResult({ key: catalogKey, page: stopped });
    } finally {
      if (request.current === revision) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, [query, feeSel, latest, embedded, composer, catalogCache, catalogKey]);

  // 返回目录时重新观察哨兵，详情页隐藏的目录不触发加载。
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || done || selectedId) return undefined;
    const io = new IntersectionObserver(
      (obs) => {
        if (obs.some((o) => o.isIntersecting)) void loadMore();
      },
      { root: el.closest('.weq-market-catalog-scroll'), rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, done, selectedId]);

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

  const catalogTotal =
    loading && entries.length === 0 ? (
      '搜索中…'
    ) : (
      <NumericText>{`共 ${total.toLocaleString('en-US')} 套${query || feeSel.size || latest ? ' · 已过滤' : ''}`}</NumericText>
    );
  const selectionTools = !composerAdd && (
    <DirectoryToolbar
      searchEnabled={!embeddedSearch}
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
    />
  );

  const body = (
    <div
      className={`weq-market-browser${selectedId ? ' has-detail' : ''}${embedded ? ' is-embedded' : ''}`}
      role="region"
      aria-labelledby={embedded ? undefined : 'weq-market-title'}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {report.dialog}
      {save.serverLocation && (
        <ServerSavePrompt name={save.serverLocation.name} onChoose={save.chooseServerLocation} />
      )}
      {embedded ? (
        selectedId && (
          <div className="weq-market-summary">
            <button
              type="button"
              className="weq-market-back icon-button"
              title="返回表情包列表"
              aria-label="返回表情包列表"
              onClick={() => setSelectedId(null)}
            >
              <ArrowLeft size={18} />
            </button>
            <span className="weq-market-total" role="status">
              {catalogTotal}
            </span>
            {embeddedSearch ? (
              <div className="weq-dress-toolbar-controls">{embeddedSearch.form}</div>
            ) : null}
          </div>
        )
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
            {total > 0 ? <span className="weq-market-total">{catalogTotal}</span> : null}
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
      {queued ? (
        <div className="weq-market-job-status" role="status">
          已创建下载任务
        </div>
      ) : null}

      <div className="weq-emb-body">
        <div className="weq-market-catalog" hidden={!!selectedId} {...packMulti.rootProps}>
          <div className={embedded ? 'weq-dress-toolbar' : 'weq-market-catalog-tools'}>
            {!embedded ? selectionTools : null}
            <div className="weq-emb-fee-row" {...feeMulti.rootProps}>
              <button
                type="button"
                className={`weq-mpd-fee-chip${feeSel.size === 0 && !latest ? ' is-active' : ''}`}
                aria-pressed={feeSel.size === 0 && !latest}
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
                aria-pressed={latest}
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
            {embedded ? (
              <div className="weq-dress-toolbar-controls">
                {selectionTools}
                {!selectedId ? embeddedSearch?.form : null}
              </div>
            ) : null}
          </div>
          {!composerAdd && selection.selectionMode ? (
            <div ref={observeCompactToolbar} className="weq-market-selection-actions">
              <span>
                <span className="weq-number weq-number-inherit">{selection.selectedIds.size}</span>{' '}
                / <span className="weq-number weq-number-inherit">{MARKET_DOWNLOAD_MAX_PACKS}</span>{' '}
                套
              </span>
              <div className="weq-save-action-group">
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
                  onClick={() => downloadSelected()}
                >
                  {downloading ? (
                    <Loader2 size={15} className="weq-emb-spin" />
                  ) : (
                    <Download size={15} />
                  )}
                  <ToolbarLabel>下载选中</ToolbarLabel>
                </button>
              </div>
            </div>
          ) : null}

          <PageScrollSnapshot
            key={catalogKey}
            snapshotKey={catalogKey}
            className="weq-market-catalog-scroll"
          >
            {embedded ? (
              <div className="weq-market-total weq-market-catalog-total" role="status">
                {catalogTotal}
              </div>
            ) : null}
            {loading && entries.length === 0 ? (
              <div className="weq-emb-pack-list-state">
                <Loader2 size={16} className="weq-emb-spin" />
                搜索中…
              </div>
            ) : entries.length === 0 && searchError ? (
              <EmptyState compact icon={<SearchX />} title={searchError} />
            ) : catalog.catalogVersion === null ? (
              <EmptyState
                compact
                icon={<Store />}
                title="请先下载商城表情目录"
                body="在「设置 → 增强功能 → 增强包」安装后即可搜索。"
              />
            ) : entries.length === 0 ? (
              <EmptyState compact icon={<SearchX />} title="没有匹配的表情包" />
            ) : (
              <>
                <div className="weq-market-pack-grid">
                  {entries.map((entry) => (
                    <PackCard
                      key={entry.id}
                      entry={entry}
                      selected={
                        !composerAdd && selection.selectionMode
                          ? selection.selectedIds.has(entry.id)
                          : selectedId === entry.id
                      }
                      selectionProps={composerAdd ? undefined : packMulti.itemProps(entry.id)}
                      composerAdd={composerAdd}
                      preferPackImage={preferPackImage}
                      onSelect={() => setSelectedId(entry.id)}
                    />
                  ))}
                </div>
                {!done ? (
                  <div ref={sentinelRef} className="weq-emb-sentinel">
                    {loading ? <Loader2 size={14} className="weq-emb-spin" /> : '加载更多…'}
                  </div>
                ) : (
                  <div className="weq-emb-sentinel">
                    已全部加载（
                    <span className="weq-number weq-number-inherit">{entries.length}</span>）
                  </div>
                )}
              </>
            )}
          </PageScrollSnapshot>
        </div>

        <div className="weq-emb-right" hidden={!selectedId}>
          {selectedId ? (
            <PackDetailPane
              key={selectedId}
              packId={selectedId}
              name={
                entries.find((e) => e.id === selectedId)?.name ??
                (selectedId === initialPackId ? (initialPackName ?? '') : '')
              }
              description={entries.find((entry) => entry.id === selectedId)?.mark ?? ''}
              busy={!composerAdd && (downloading || save.picking || save.settings.isLoading)}
              onDownload={download}
              composerAdd={composerAdd}
              preferPackImage={preferPackImage}
            />
          ) : null}
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
