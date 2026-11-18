// @ts-nocheck
/**
 * 消息输入框表情面板。
 *
 * 一栏一个来源，互不混排（「最近使用」因此不会被 Unicode 字符表情污染）：
 *   表情／超级表情 ← 共用 QQ 目录，各自在开头展示相应的最近使用。
 *   字符    ← 81214 非 0 的 Unicode 字符表情，单独一栏
 *   商城    ← market_emoticon_package_table；点包看全部，右上「+」弹灯箱搜索目录
 *   收藏    ← fav_emoji_info_storage_table（我喜欢的自定义表情）
 *   颜文字  ← 内置静态列表
 *
 * 图片字节全部走协议（weq-asset / weq-media），不过 tRPC。
 */

import { EmptyState } from '../../components/EmptyState';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTabActive } from '../../components/RetainedTabs.shared';
import { FavoriteBundleControls } from '../../components/qq-actions/FavoriteBundleControls';
import { FavoritePickerTab } from '../../components/qq-actions/FavoritePickerTab';
import {
  ArrowLeft,
  Heart,
  Hand,
  ImagePlus,
  MessageSquareQuote,
  Plus,
  Search,
  Smile,
  Sparkles,
  Store,
  Type,
  X,
  SearchX,
  Sticker,
} from 'lucide-react';
import type { RefObject } from 'react';
import { trpc } from '../../trpc/client';
import { useOverlayLayer } from '../../lib/overlayStack';
import { cn } from './classNames';
import { BounceEmojiPanel, type BounceEmojiDraft } from './bounceEmojiPanel';
import { PokeEmojiPanel, type PokeEmojiDraft, type RandomFaceDraft } from './pokeEmojiPanel';
import { CustomEmojiTab, ShowEmojiTab } from './showEmojiTabs';
import { marketFaceItem, systemFaceItem, unicodeFaceItem, type EmojiItem } from './emojiPacks';

type TabId =
  | 'face'
  | 'super'
  | 'unicode'
  | 'market'
  | 'fav'
  | 'kaomoji'
  | 'poke'
  | 'custom'
  | 'qqshow';

const TABS: Array<{ id: TabId; label: string; icon: typeof Smile }> = [
  { id: 'face', label: '表情', icon: Smile },
  { id: 'super', label: '超级表情', icon: Sticker },
  { id: 'fav', label: '收藏', icon: Heart },
  { id: 'market', label: '商城表情', icon: Store },
  { id: 'poke', label: '互动表情', icon: Hand },
  { id: 'qqshow', label: 'QQ 秀表情', icon: Sparkles },
  { id: 'custom', label: '自定义表情', icon: ImagePlus },
  { id: 'unicode', label: '字符表情', icon: Type },
  { id: 'kaomoji', label: '颜文字', icon: MessageSquareQuote },
];

const KAOMOJI_ITEMS: Array<[string, string]> = [
  ['开心', '(´▽`)'],
  ['大笑', 'ヽ(°〇°)ﾉ'],
  ['害羞', '(⁄ ⁄•⁄ω⁄•⁄ ⁄)'],
  ['思考', '(´･_･`)'],
  ['无语', '(¬_¬)'],
  ['尴尬', '(・_・;)'],
  ['哭泣', '(╥﹏╥)'],
  ['生气', '(╬ ಠ益ಠ)'],
  ['惊讶', 'Σ(ﾟДﾟ)'],
  ['困', '(-.-)zzZ'],
  ['爱心', '(｡♥‿♥｡)'],
  ['星星眼', '(✧ω✧)'],
  ['得意', 'ヽ(✿ﾟ▽ﾟ)ノ'],
  ['耸肩', '¯\\_(ツ)_/¯'],
  ['无奈', '┐(´∀｀)┌'],
  ['傻笑', '(´∀`)'],
  ['翻桌', '(╯°□°)╯︵ ┻━┻'],
  ['摊手', '╮(╯_╰)╭'],
  ['抱抱', 'ლ(´ ❥ `ლ)'],
  ['拜托', 'm(_ _)m'],
  ['叹气', '(´-ω-`)'],
  ['再见', 'ヾ(￣▽￣)Bye~'],
  ['躺平', '_(:з」∠)_'],
  ['欢呼', '\\(^o^)/'],
];

export function EmojiPanel({
  panelRef,
  onSelect,
  onSelectSuper,
  disabled,
  disabledHint,
  onSendBounce,
  onSendPoke,
  randomFaces,
  onSendRandom,
  sendTarget,
  onSentCustomEmoji,
  onInsertCustomEmoji,
  textOnly = false,
}: {
  panelRef: RefObject<HTMLDivElement | null>;
  /** 普通表情：插进输入框，可以和文字合成一条消息。 */
  onSelect: (item: EmojiItem) => void;
  /** 超级表情：只能单独发，交给宿主挂成待发送卡片（缺省时退化成 onSelect）。 */
  onSelectSuper?: (item: EmojiItem) => void;
  disabled?: boolean;
  disabledHint?: string;
  onSendBounce?: (draft: BounceEmojiDraft) => void;
  onSendPoke?: (draft: PokeEmojiDraft) => void;
  randomFaces?: React.ComponentProps<typeof PokeEmojiPanel>['randomFaces'];
  onSendRandom?: (draft: RandomFaceDraft) => void;
  /**
   * 「QQ 秀表情」点选后直接发送，需要当前目标。
   */
  sendTarget?: {
    peerType: 'c2c' | 'group';
    targetId: string;
    tempGroupCode?: string;
  };
  /** 发送成功后回调（宿主用来关面板 / 清理状态）。 */
  onSentCustomEmoji?: () => void;
  onInsertCustomEmoji?: (file: File) => void;
  /** 纯文本会话不展示必须携带 QQ 媒体元素的表情来源。 */
  textOnly?: boolean;
}) {
  const [tab, setTab] = useState<TabId>('face');
  const [bounceFace, setBounceFace] = useState<EmojiItem | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const bounceReturnScroll = useRef(0);
  const [marketPackId, setMarketPackId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  const overview = trpc.account.emojiPanel.overview.useQuery(undefined, {
    staleTime: 30_000,
  });
  const faces = overview.data?.faces ?? [];
  const systemGroups = faces.filter((g) => !g.unicode);
  const unicodeGroups = faces.filter((g) => g.unicode);
  const recent = overview.data?.recent ?? [];
  const favorites = overview.data?.favorites ?? [];
  const large = tab === 'super';
  const canBounce = onSendBounce && !textOnly;
  const displayGroups = large
    ? systemGroups
        .map((g) => ({ ...g, items: g.items.filter((item) => item.sticker) }))
        .filter((g) => g.items.length)
    : systemGroups;
  const displayRecent = recent.filter((item) => !item.unicode && (!large || item.sticker));
  const selectFace = large ? (onSelectSuper ?? onSelect) : onSelect;
  const openBounce =
    !large && canBounce
      ? (item: EmojiItem) => {
          bounceReturnScroll.current = bodyRef.current?.scrollTop ?? 0;
          setBounceFace(item);
        }
      : undefined;
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bounceFace ? 0 : bounceReturnScroll.current;
  }, [tab, bounceFace]);
  const faceCells = (items: typeof displayRecent) =>
    items.map((item) => ({
      key: item.id,
      title: item.desc,
      item: faceItemToEmoji(item, large),
    }));

  return (
    <div
      className={cn('emoji-panel')}
      ref={panelRef}
      aria-label="表情面板"
      data-favorite-toolbar={tab === 'fav' || undefined}
    >
      {tab === 'fav' && (
        <FavoriteBundleControls
          onChanged={async () => {
            await overview.refetch();
          }}
        />
      )}
      <div className="emoji-panel-body" ref={bodyRef}>
        {bounceFace && onSendBounce ? (
          <BounceEmojiPanel
            initialFace={bounceFace}
            disabled={disabled}
            disabledHint={disabledHint}
            onSend={onSendBounce}
            onClose={() => setBounceFace(null)}
          />
        ) : tab === 'poke' ? (
          <PokeEmojiPanel
            disabled={disabled}
            disabledHint={disabledHint}
            onSend={onSendPoke}
            randomFaces={randomFaces}
            onSendRandom={onSendRandom}
            onClose={() => setTab('face')}
          />
        ) : tab === 'face' || tab === 'super' ? (
          <div className={cn('emoji-section')}>
            <header className="emoji-section-head">
              <h3>{large ? '超级表情' : '表情'}</h3>
              {openBounce ? <span className="emoji-heading-note">弹射：右键 / 长按</span> : null}
            </header>
            {displayGroups.length === 0 ? (
              <div className="emoji-state">
                {overview.isLoading ? '加载中…' : large ? '没有超级表情' : '没有系统表情'}
              </div>
            ) : null}
            {displayRecent.length > 0 ? (
              <section className="emoji-group">
                <h3>最近使用</h3>
                <FaceGrid
                  layout={large ? 'super' : 'default'}
                  rows={large ? 1 : 2}
                  items={faceCells(displayRecent)}
                  onSelect={selectFace}
                  onBounce={openBounce}
                />
              </section>
            ) : null}
            {displayGroups.map((group) => (
              <section className="emoji-group" key={group.key}>
                <h3>{group.label}</h3>
                <FaceGrid
                  layout={large ? 'super' : 'default'}
                  items={faceCells(group.items)}
                  onSelect={selectFace}
                  onBounce={openBounce}
                />
              </section>
            ))}
          </div>
        ) : tab === 'unicode' ? (
          <CharacterGrid
            loading={overview.isLoading}
            items={unicodeGroups.flatMap((g) => g.items)}
            onSelect={onSelect}
          />
        ) : tab === 'market' ? (
          <MarketTab
            packId={marketPackId}
            onOpenPack={setMarketPackId}
            onSelect={onSelect}
            onOpenSearch={() => setSearchOpen(true)}
          />
        ) : tab === 'fav' ? (
          <FavoritePickerTab
            loading={overview.isLoading}
            favorites={favorites}
            onSelect={onSelect}
            onChanged={async () => {
              await overview.refetch();
            }}
          />
        ) : tab === 'custom' ? (
          <CustomEmojiTab
            disabled={Boolean(disabled) || !onInsertCustomEmoji}
            disabledHint={disabledHint}
            onInsert={onInsertCustomEmoji}
          />
        ) : tab === 'qqshow' ? (
          <ShowEmojiTab
            ctx={{
              peerType: sendTarget?.peerType ?? 'c2c',
              targetId: sendTarget?.targetId ?? '',
              ...(sendTarget?.tempGroupCode ? { tempGroupCode: sendTarget.tempGroupCode } : {}),
              disabled: Boolean(disabled) || !sendTarget,
              disabledHint: sendTarget ? (disabledHint ?? '') : '请先选择一个会话',
            }}
            onSent={() => onSentCustomEmoji?.()}
          />
        ) : (
          <KaomojiGrid onSelect={onSelect} />
        )}
      </div>

      <div className={cn('emoji-tabs')}>
        {TABS.filter(({ id }) =>
          id === 'poke'
            ? Boolean(onSendPoke)
            : id === 'custom'
              ? Boolean(onInsertCustomEmoji)
              : id === 'qqshow'
                ? Boolean(sendTarget)
                : true,
        ).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={cn(id === tab ? 'active' : '')}
            title={label}
            aria-label={label}
            disabled={textOnly && !['face', 'unicode', 'kaomoji'].includes(id)}
            aria-pressed={id === tab}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (id !== tab) bounceReturnScroll.current = 0;
              setTab(id);
              setBounceFace(null);
            }}
          >
            <Icon size={19} />
          </button>
        ))}
      </div>

      {searchOpen ? (
        <EmojiCatalogLightbox onClose={() => setSearchOpen(false)} onSelect={onSelect} />
      ) : null}
    </div>
  );
}

// ── 表情 / 字符网格 ───────────────────────────────────────────────────────────

type GridCell = { key: string; title: string; item: EmojiItem; previewSrc?: string | null };

function FaceGrid({
  items,
  onSelect,
  loading,
  empty,
  emptyText,
  layout = 'default',
  rows,
  onBounce,
}: {
  items: GridCell[];
  onSelect: (item: EmojiItem) => void;
  loading?: boolean;
  empty?: boolean;
  emptyText?: string;
  /** 网格尺寸：default 小图 / big 每行 4 个（贴纸）/ super 每行 5 个（超级表情）。 */
  layout?: 'default' | 'big' | 'super';
  rows?: number;
  onBounce?: (item: EmojiItem) => void;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(0);
  const hasItems = items.length > 0 && !empty;
  useLayoutEffect(() => {
    const node = grid.current;
    if (!rows || !node) return;
    const measure = () => setColumns(getComputedStyle(node).gridTemplateColumns.split(' ').length);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [rows, hasItems, layout]);
  if (loading && items.length === 0) {
    return <div className={cn('emoji-state')}>加载中…</div>;
  }
  if (empty || items.length === 0) {
    return <EmptyState compact icon={<Smile />} title={emptyText ?? '这里还没有表情'} />;
  }
  return (
    <div
      ref={grid}
      className={cn(
        'emoji-grid',
        layout === 'default' && 'emoji-standard-grid',
        layout === 'big' && 'emoji-big-grid',
        layout === 'super' && 'emoji-super-grid',
      )}
    >
      {(rows ? items.slice(0, columns * rows) : items).map((cell) => (
        <FaceCell key={cell.key} cell={cell} onSelect={onSelect} onBounce={onBounce} />
      ))}
    </div>
  );
}

function FaceCell({
  cell,
  onSelect,
  onBounce,
}: {
  cell: GridCell;
  onSelect: (item: EmojiItem) => void;
  onBounce?: (item: EmojiItem) => void;
}) {
  const [broken, setBroken] = useState(false);
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const triggered = useRef(false);
  function cancelPress() {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  }
  useEffect(() => cancelPress, []);
  const { item } = cell;
  const src = cell.previewSrc ?? item.src;
  return (
    <button
      type="button"
      title={cell.title}
      className={cn('emoji-cell', item.large && 'is-sticker')}
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        triggered.current = false;
        if (!onBounce || event.pointerType === 'mouse' || !event.isPrimary) return;
        cancelPress();
        press.current = {
          x: event.clientX,
          y: event.clientY,
          timer: window.setTimeout(() => {
            triggered.current = true;
            cancelPress();
            onBounce(item);
          }, 500),
        };
      }}
      onPointerMove={(event) => {
        if (
          press.current &&
          Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 10
        )
          cancelPress();
      }}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onPointerLeave={cancelPress}
      onContextMenu={
        onBounce
          ? (event) => {
              event.preventDefault();
              event.stopPropagation();
              cancelPress();
              if (!triggered.current) onBounce(item);
              triggered.current = true;
            }
          : undefined
      }
      onClick={() => {
        if (!triggered.current) onSelect(item);
        triggered.current = false;
      }}
    >
      {item.glyph ? (
        <span className={cn('emoji-glyph')}>{item.glyph}</span>
      ) : broken || !src ? (
        <span className={cn('emoji-cell-fallback')}>
          <Smile size={22} strokeWidth={1.4} />
        </span>
      ) : (
        <img src={src} alt={cell.title} draggable={false} onError={() => setBroken(true)} />
      )}
    </button>
  );
}

function CharacterGrid({
  items,
  onSelect,
  loading,
}: {
  items: Array<{ id: string; desc: string; glyph: string }>;
  onSelect: (item: EmojiItem) => void;
  loading?: boolean;
}) {
  if (loading && items.length === 0) return <div className={cn('emoji-state')}>加载中…</div>;
  if (items.length === 0) return <div className={cn('emoji-state')}>没有字符表情</div>;
  return (
    <div className={cn('emoji-grid emoji-char-grid')}>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          title={it.desc}
          className={cn('emoji-cell')}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(unicodeFaceItem(it.glyph, it.desc))}
        >
          <span className={cn('emoji-glyph')}>{it.glyph}</span>
        </button>
      ))}
    </div>
  );
}

function KaomojiGrid({ onSelect }: { onSelect: (item: EmojiItem) => void }) {
  return (
    <div className={cn('kaomoji-grid')}>
      {KAOMOJI_ITEMS.map(([name, value]) => (
        <button
          key={name}
          type="button"
          title={name}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() =>
            onSelect({
              kind: 'unicode',
              id: `kaomoji:${name}`,
              name: value,
              token: value,
              src: null,
              glyph: value,
              large: false,
            })
          }
        >
          <span>{name}</span>
          <strong>{value}</strong>
        </button>
      ))}
    </div>
  );
}

// ── 商城表情 ──────────────────────────────────────────────────────────────────

function MarketTab({
  packId,
  onOpenPack,
  onSelect,
  onOpenSearch,
}: {
  packId: string | null;
  onOpenPack: (id: string | null) => void;
  onSelect: (item: EmojiItem) => void;
  onOpenSearch: () => void;
}) {
  const packages = trpc.account.emojiPanel.marketPackages.useQuery();

  if (packId) {
    return <MarketPackDetail packId={packId} onBack={() => onOpenPack(null)} onSelect={onSelect} />;
  }

  const list = packages.data ?? [];
  return (
    <div className={cn('emoji-section')}>
      <div className={cn('emoji-section-head')}>
        <h3>我添加的商城表情包</h3>
        <button
          type="button"
          className={cn('emoji-add-btn')}
          title="搜索更多表情"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onOpenSearch}
        >
          <Plus size={15} /> 添加
        </button>
      </div>
      {packages.isLoading ? (
        <div className={cn('emoji-state')}>加载中…</div>
      ) : list.length === 0 ? (
        <EmptyState
          compact
          icon={<Sticker />}
          title="还没有添加商城表情包"
          body="点右上「添加」去搜索"
        />
      ) : (
        <div className={cn('emoji-pack-list')}>
          {list.map((pkg) => (
            <button
              key={pkg.packId}
              type="button"
              className={cn('emoji-pack-card')}
              title={pkg.name}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onOpenPack(pkg.packId)}
            >
              <span className={cn('emoji-pack-name')}>{pkg.name || `表情包 ${pkg.packId}`}</span>
              <span className={cn('emoji-pack-summary')}>{pkg.summary || '点击查看全部表情'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function MarketPackDetail({
  packId,
  onBack,
  onSelect,
}: {
  packId: string;
  onBack: () => void;
  onSelect: (item: EmojiItem) => void;
}) {
  const detail = trpc.account.emojiPanel.marketPackDetail.useQuery({ packId });
  const items = detail.data?.items ?? [];
  return (
    <div className={cn('emoji-section')}>
      <div className={cn('emoji-section-head')}>
        <button
          type="button"
          className={cn('emoji-back-btn')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onBack}
        >
          <ArrowLeft size={14} /> 返回
        </button>
        <h3>{detail.data?.name || `表情包 ${packId}`}</h3>
        {detail.data ? (
          <span className={cn('emoji-count')}>
            {detail.data.source === 'local' ? '本地' : '在线'} ·{' '}
            <span className="weq-number weq-number-inherit">{detail.data.count}</span> 张
          </span>
        ) : null}
      </div>
      {detail.isLoading ? (
        <div className={cn('emoji-state')}>加载中…</div>
      ) : items.length === 0 ? (
        <div className={cn('emoji-state')}>这个表情包暂时没有可显示的表情</div>
      ) : (
        <FaceGrid
          layout="big"
          items={items.map((it) => ({
            key: it.hash,
            title: it.name || it.hash,
            item: marketFaceItem(packId, it.hash, it.name),
          }))}
          onSelect={onSelect}
        />
      )}
    </div>
  );
}

// ── 收藏 ──────────────────────────────────────────────────────────────────────

// ── 搜索灯箱（商城目录） ───────────────────────────────────────────────────────

function EmojiCatalogLightbox({
  onClose,
  onSelect,
}: {
  onClose: () => void;
  onSelect: (item: EmojiItem) => void;
}) {
  const tabActive = useTabActive();
  const layer = useOverlayLayer(tabActive);
  const [keyword, setKeyword] = useState('');
  const [debounced, setDebounced] = useState('');
  const [openPackId, setOpenPackId] = useState<string | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(keyword.trim()), 260);
    return () => window.clearTimeout(t);
  }, [keyword]);

  useLayoutEffect(() => {
    if (!tabActive) return undefined;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [tabActive, onClose]);

  const catalog = trpc.account.marketEmoji.searchCatalog.useQuery(
    { keyword: debounced || undefined, limit: 40 },
    { enabled: !openPackId },
  );
  const detail = trpc.account.emojiPanel.marketPackDetail.useQuery(
    { packId: openPackId ?? '' },
    { enabled: !!openPackId },
  );

  return createPortal(
    <div
      className={cn('emoji-lb-layer')}
      hidden={!tabActive}
      style={{ zIndex: layer, display: tabActive ? undefined : 'none' }}
      onMouseDown={onClose}
    >
      <div className={cn('emoji-lb')} onMouseDown={(e) => e.stopPropagation()}>
        <div className={cn('emoji-lb-head')}>
          {openPackId ? (
            <button
              type="button"
              className={cn('emoji-back-btn')}
              onClick={() => setOpenPackId(null)}
            >
              <ArrowLeft size={14} /> 返回
            </button>
          ) : (
            <span className={cn('emoji-lb-title')}>
              <Store size={15} /> 表情搜索
            </span>
          )}
          {!openPackId ? (
            <label className={cn('emoji-lb-search')}>
              <Search size={14} />
              <input
                value={keyword}
                autoFocus
                placeholder="搜索表情包名称 / 介绍"
                onChange={(e) => setKeyword(e.target.value)}
              />
            </label>
          ) : (
            <span className={cn('emoji-lb-title')}>{detail.data?.name ?? openPackId}</span>
          )}
          <button
            type="button"
            className={cn('emoji-lb-close')}
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </div>

        <div className={cn('emoji-lb-body')}>
          {openPackId ? (
            detail.isLoading ? (
              <div className={cn('emoji-state')}>获取这组表情中…</div>
            ) : (detail.data?.items ?? []).length === 0 ? (
              <div className={cn('emoji-state')}>这个表情包暂时没有可显示的表情</div>
            ) : (
              <FaceGrid
                layout="big"
                items={(detail.data?.items ?? []).map((it) => ({
                  key: it.hash,
                  title: it.name || it.hash,
                  item: marketFaceItem(openPackId, it.hash, it.name),
                }))}
                onSelect={onSelect}
              />
            )
          ) : catalog.isLoading ? (
            <div className={cn('emoji-state')}>搜索中…</div>
          ) : (catalog.data?.entries ?? []).length === 0 ? (
            <EmptyState compact icon={<SearchX />} title="没有找到匹配的表情包" />
          ) : (
            <div className={cn('emoji-pack-list')}>
              {(catalog.data?.entries ?? []).map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={cn('emoji-pack-card')}
                  title={entry.name}
                  onClick={() => setOpenPackId(entry.id)}
                >
                  <span className={cn('emoji-pack-name')}>{entry.name}</span>
                  <span className={cn('emoji-pack-summary')}>{entry.mark || '查看全部表情'}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── helpers ───────────────────────────────────────────────────────────────────

function faceItemToEmoji(
  it: {
    id: string;
    desc: string;
    unicode: boolean;
    glyph: string;
  },
  large = false,
): EmojiItem {
  return it.unicode
    ? unicodeFaceItem(it.glyph || it.id, it.desc)
    : systemFaceItem(it.id, it.desc, large);
}
