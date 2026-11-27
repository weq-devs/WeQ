// @ts-nocheck
import { usePreferenceState } from '../../lib/clientPreferences';
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
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import { FavoriteBundleControls } from '../../components/qq-actions/FavoriteBundleControls';
import { observeCompactToolbar } from '../../components/CompactToolbar.shared';
import { FavoritePickerTab } from '../../components/qq-actions/FavoritePickerTab';
import { ActionIcon } from '../../components/qq-actions/shared';
import {
  ArrowLeft,
  Heart,
  Hand,
  ImagePlus,
  MessageSquareQuote,
  Plus,
  RefreshCw,
  Search,
  Smile,
  Store,
  Type,
  X,
  Sticker,
  Trash2,
} from 'lucide-react';
import type { RefObject } from 'react';
import { trpc } from '../../trpc/client';
import { EditorDialog } from '../../components/EditorDialog';
import { ConversationActionsMenu } from '../../components/ConversationActionsMenu';
import { DressSearchForm } from '../../components/DressSearchForm';
import { ShimmerImage } from '../../components/ShimmerImage';
import { useDevelopmentDressTools } from '../../hooks/useDevelopmentDressTools';
import { mediaUrl } from '../../lib/resourceUrl';
import { filterByName } from '../../lib/nameSearch';
import '../../styles/composer-emoji-catalog.css';
import { cn } from './classNames';
import { BounceEmojiPanel, type BounceEmojiDraft } from './bounceEmojiPanel';
import { PokeEmojiPanel, type PokeEmojiDraft, type RandomFaceDraft } from './pokeEmojiPanel';
import { CustomEmojiTab } from './customEmojiTab';
import { marketFaceItem, systemFaceItem, unicodeFaceItem, type EmojiItem } from './emojiPacks';

const MarketEmojiBrowserLightbox = lazy(() =>
  import('../../views/export/MarketEmojiBrowserLightbox').then((module) => ({
    default: module.MarketEmojiBrowserLightbox,
  })),
);

type TabId = 'face' | 'super' | 'unicode' | 'market' | 'fav' | 'kaomoji' | 'poke' | 'custom';

const TABS: Array<{ id: TabId; label: string; icon: typeof Smile }> = [
  { id: 'face', label: '表情', icon: Smile },
  { id: 'super', label: '超级表情', icon: Sticker },
  { id: 'fav', label: '收藏', icon: Heart },
  { id: 'market', label: '商城表情', icon: Store },
  { id: 'poke', label: '互动表情', icon: Hand },
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
  onInsertCustomEmoji?: (file: File) => void;
  /** 纯文本会话不展示必须携带 QQ 媒体元素的表情来源。 */
  textOnly?: boolean;
}) {
  const [selectedTab, setSelectedTab] = usePreferenceState('emojiPanelTab');
  const [bounceFace, setBounceFace] = useState<EmojiItem | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const bounceReturnScroll = useRef(0);
  const [marketPackId, setMarketPackId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [faceQuery, setFaceQuery] = useState('');

  const tabs = TABS.filter(({ id }) => {
    if (id === 'poke') return Boolean(onSendPoke);
    if (id === 'custom') return Boolean(onInsertCustomEmoji);
    return true;
  }).map((tab) => ({
    ...tab,
    disabled: textOnly && !['face', 'unicode', 'kaomoji'].includes(tab.id),
  }));
  const tab = tabs.some(({ id, disabled }) => id === selectedTab && !disabled)
    ? selectedTab
    : 'face';

  function selectTab(id: TabId) {
    if (id !== tab) {
      bounceReturnScroll.current = 0;
      setFaceQuery('');
    }
    setSelectedTab(id);
    setBounceFace(null);
  }

  const usesCatalog = tab === 'face' || tab === 'super' || tab === 'unicode';
  const catalog = trpc.account.emojiPanel.catalog.useQuery(undefined, {
    enabled: usesCatalog,
    staleTime: 30_000,
    retry: false,
  });
  const favoriteQuery = trpc.account.emojiPanel.favorites.useQuery(undefined, {
    enabled: tab === 'fav',
    staleTime: 30_000,
    retry: false,
  });
  const faces = catalog.data?.faces ?? [];
  const systemGroups = faces.filter((g) => !g.unicode);
  const unicodeGroups = faces.filter((g) => g.unicode);
  const recent = catalog.data?.recent ?? [];
  const favorites = favoriteQuery.data;
  const catalogUnavailable = !catalog.data && (catalog.isError || catalog.isPaused);
  const large = tab === 'super';
  const canBounce = onSendBounce && !textOnly;
  const displayGroups = large
    ? systemGroups
        .map((g) => ({ ...g, items: g.items.filter((item) => item.sticker) }))
        .filter((g) => g.items.length)
    : systemGroups;
  const displayRecent = recent.filter((item) => !item.unicode && (!large || item.sticker));
  const searchingFaces = Boolean(faceQuery.trim());
  const faceMatches = useMemo(() => {
    if (!searchingFaces || !usesCatalog) return [];
    const items = (catalog.data?.faces ?? []).flatMap((group) =>
      group.unicode === (tab === 'unicode') ? group.items : [],
    );
    return filterByName(large ? items.filter((item) => item.sticker) : items, faceQuery, (item) => [
      item.desc,
    ]);
  }, [catalog.data, faceQuery, large, searchingFaces, tab, usesCatalog]);
  const bouncing = Boolean(bounceFace && onSendBounce);
  const showFaceSearch = usesCatalog && !bouncing;
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
      className={cn('emoji-panel', showFaceSearch && 'emoji-panel-searchable')}
      ref={panelRef}
      aria-label="表情面板"
    >
      <header ref={observeCompactToolbar} className="emoji-panel-header">
        <h3>
          {bouncing
            ? '弹射表情'
            : tab === 'fav'
              ? '收藏表情'
              : TABS.find((item) => item.id === tab)?.label}
        </h3>
        {!bouncing && tab === 'face' && openBounce ? (
          <span className="emoji-heading-note">弹射：右键 / 长按</span>
        ) : null}
        {tab === 'fav' ? (
          <FavoriteBundleControls
            onChanged={async () => {
              await favoriteQuery.refetch();
            }}
          />
        ) : tab === 'market' && !marketPackId ? (
          <MarketAddButton onClick={() => setSearchOpen(true)} />
        ) : bouncing || tab === 'poke' ? (
          <div className="emoji-header-actions">
            <ActionIcon
              label="返回表情"
              onClick={() => (bouncing ? setBounceFace(null) : selectTab('face'))}
            >
              <X size={16} />
            </ActionIcon>
          </div>
        ) : null}
      </header>
      {showFaceSearch ? (
        <label className="weq-face-search">
          <Search size={14} aria-hidden />
          <input
            type="search"
            className="weq-face-search-input"
            aria-label="搜索表情"
            placeholder="搜索表情"
            value={faceQuery}
            onChange={(event) => {
              if (bodyRef.current) bodyRef.current.scrollTop = 0;
              setFaceQuery(event.target.value);
            }}
          />
        </label>
      ) : null}
      <div className="emoji-panel-body" ref={bodyRef}>
        {bounceFace && onSendBounce ? (
          <BounceEmojiPanel
            initialFace={bounceFace}
            disabled={disabled}
            disabledHint={disabledHint}
            onSend={onSendBounce}
          />
        ) : tab === 'poke' ? (
          <PokeEmojiPanel
            disabled={disabled}
            disabledHint={disabledHint}
            onSend={onSendPoke}
            randomFaces={randomFaces}
            onSendRandom={onSendRandom}
          />
        ) : usesCatalog && catalogUnavailable && !catalog.isFetching ? (
          <div className="emoji-state" role="status">
            <span>{catalog.isPaused ? '等待连接电脑' : '表情加载失败'}</span>
            <ActionIcon label="重试加载表情" onClick={() => void catalog.refetch()}>
              <RefreshCw size={15} aria-hidden />
            </ActionIcon>
          </div>
        ) : searchingFaces && usesCatalog ? (
          <div className="emoji-section">
            {tab === 'unicode' ? (
              <CharacterGrid
                loading={catalog.isFetching}
                items={faceMatches}
                onSelect={onSelect}
                emptyText="没有匹配的表情"
              />
            ) : (
              <FaceGrid
                layout={large ? 'super' : 'default'}
                loading={catalog.isFetching}
                items={faceCells(faceMatches)}
                emptyText="没有匹配的表情"
                onSelect={selectFace}
                onBounce={openBounce}
              />
            )}
          </div>
        ) : tab === 'face' || tab === 'super' ? (
          <div className={cn('emoji-section')}>
            {displayGroups.length === 0 ? (
              <div className="emoji-state">
                {catalog.isFetching ? '加载中…' : large ? '没有超级表情' : '没有系统表情'}
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
            loading={catalog.isFetching}
            items={unicodeGroups.flatMap((g) => g.items)}
            onSelect={onSelect}
          />
        ) : tab === 'market' ? (
          <MarketTab packId={marketPackId} onOpenPack={setMarketPackId} onSelect={onSelect} />
        ) : tab === 'fav' ? (
          <FavoritePickerTab
            loading={favoriteQuery.isFetching}
            localReadStatus={
              favoriteQuery.isPaused ? 'waiting' : favoriteQuery.isError ? 'failed' : undefined
            }
            favorites={favorites}
            onSelect={onSelect}
            onChanged={async () => {
              await favoriteQuery.refetch();
            }}
          />
        ) : tab === 'custom' ? (
          <CustomEmojiTab
            disabled={Boolean(disabled) || !onInsertCustomEmoji}
            disabledHint={disabledHint}
            onInsert={onInsertCustomEmoji}
          />
        ) : (
          <KaomojiGrid onSelect={onSelect} />
        )}
      </div>

      <div className={cn('emoji-tabs')}>
        {tabs.map(({ id, label, icon: Icon, disabled }) => (
          <button
            key={id}
            type="button"
            className={cn(id === tab ? 'active' : '')}
            title={label}
            aria-label={label}
            disabled={disabled}
            aria-pressed={id === tab}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => selectTab(id)}
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
  const cancelPress = useCallback(() => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  }, []);
  useEffect(() => cancelPress, [cancelPress]);
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
  emptyText = '没有字符表情',
}: {
  items: Array<{ id: string; desc: string; glyph: string }>;
  onSelect: (item: EmojiItem) => void;
  loading?: boolean;
  emptyText?: string;
}) {
  if (loading && items.length === 0) return <div className={cn('emoji-state')}>加载中…</div>;
  if (items.length === 0) return <div className={cn('emoji-state')}>{emptyText}</div>;
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

function MarketAddButton({ onClick }: { onClick: () => void }) {
  return (
    <div className="emoji-header-actions">
      <ActionIcon label="搜索更多表情" text="添加" onClick={onClick}>
        <Plus size={16} />
      </ActionIcon>
    </div>
  );
}

function MarketPackCover({ packId, hash }: { packId: string; hash?: string }) {
  const [unavailable, setUnavailable] = useState(false);
  return (
    <span className={cn('composer-preview-cover')} aria-hidden>
      {hash && !unavailable ? (
        <ShimmerImage
          src={mediaUrl('mface', { pack: packId, hash })}
          loading="lazy"
          draggable={false}
          onError={() => setUnavailable(true)}
        />
      ) : (
        <Sticker size={26} strokeWidth={1.5} />
      )}
    </span>
  );
}

function MarketTab({
  packId,
  onOpenPack,
  onSelect,
}: {
  packId: string | null;
  onOpenPack: (id: string | null) => void;
  onSelect: (item: EmojiItem) => void;
}) {
  const packages = trpc.account.emojiPanel.marketPackages.useQuery();
  const [menu, setMenu] = useState<{ x: number; y: number; packId: string } | null>(null);
  const utils = trpc.useUtils();
  const remove = trpc.account.marketEmoji.removeComposerPack.useMutation({
    onSuccess: async (_result, { packId }) => {
      utils.account.emojiPanel.marketPackages.setData(undefined, (data) =>
        data?.filter((pack) => pack.packId !== packId),
      );
      await Promise.all([
        utils.account.emojiPanel.marketPackages.invalidate(),
        utils.account.emojiPanel.marketPackDetail.invalidate({ packId }),
      ]);
    },
  });

  if (packId) {
    return <MarketPackDetail packId={packId} onBack={() => onOpenPack(null)} onSelect={onSelect} />;
  }

  const list = packages.data ?? [];
  return (
    <div className={cn('emoji-section', 'composer-preview-section')}>
      {remove.error ? (
        <div className="emoji-state" role="alert">
          {remove.error.message}
        </div>
      ) : null}
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
        <div className={cn('composer-preview-grid')}>
          {list.map((pkg) => {
            const name = pkg.name || `表情包 ${pkg.packId}`;
            return (
              <button
                key={pkg.packId}
                type="button"
                className={cn('composer-preview-card')}
                title={pkg.summary ? `${name}\n${pkg.summary}` : name}
                aria-haspopup="menu"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onOpenPack(pkg.packId)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setMenu({ x: event.clientX, y: event.clientY, packId: pkg.packId });
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))
                    return;
                  event.preventDefault();
                  const rect = event.currentTarget.getBoundingClientRect();
                  setMenu({ x: rect.left, y: rect.bottom, packId: pkg.packId });
                }}
              >
                <MarketPackCover key={pkg.coverHash} packId={pkg.packId} hash={pkg.coverHash} />
                <span className={cn('composer-preview-name')}>{name}</span>
              </button>
            );
          })}
        </div>
      )}
      {menu ? (
        <ConversationActionsMenu
          x={menu.x}
          y={menu.y}
          label="商城表情包操作"
          onClose={() => setMenu(null)}
          actions={[
            {
              label: '删除',
              icon: <Trash2 size={15} />,
              danger: 'outline',
              disabled: remove.isLoading,
              action: () => remove.mutate({ packId: menu.packId }),
            },
          ]}
        />
      ) : null}
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
  const development = useDevelopmentDressTools();
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
            item: marketFaceItem(
              packId,
              it.hash,
              it.name,
              development && detail.data?.source === 'online',
            ),
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
  const [draft, setDraft] = useState('');
  const [keyword, setKeyword] = useState('');
  const [partial, setPartial] = useState('');
  const development = useDevelopmentDressTools();
  const packages = trpc.account.emojiPanel.marketPackages.useQuery();
  const utils = trpc.useUtils();
  const addPack = trpc.account.marketEmoji.addComposerPack.useMutation({
    onMutate: () => setPartial(''),
    onSuccess: async (result, { packId }) => {
      if (result.cached < result.total)
        setPartial(`已添加 ${result.cached} 张可用表情，共 ${result.total} 张`);
      await Promise.all([
        utils.account.emojiPanel.marketPackages.invalidate(),
        utils.account.emojiPanel.marketPackDetail.invalidate({ packId }),
      ]);
    },
  });

  return (
    <EditorDialog title="添加商城表情" width={960} onClose={onClose}>
      <div className="composer-emoji-catalog">
        {addPack.error ? (
          <div className="weq-mface-lb-state is-error" role="alert">
            {addPack.error.message}
          </div>
        ) : null}
        {partial ? (
          <div className="weq-market-job-status" role="status">
            {partial}
          </div>
        ) : null}
        <Suspense
          fallback={
            <div className="emoji-state" role="status">
              加载中…
            </div>
          }
        >
          <MarketEmojiBrowserLightbox
            embedded
            embeddedSearch={{
              keyword,
              form: (
                <DressSearchForm
                  label="搜索表情包"
                  value={draft}
                  onChange={setDraft}
                  onSearch={setKeyword}
                />
              ),
            }}
            composerAdd={{
              addedIds: new Set(packages.data?.map((pack) => pack.packId)),
              addingId: addPack.isLoading ? addPack.variables?.packId : undefined,
              add: (packId) => addPack.mutate({ packId }),
              insert: (packId, item) => {
                flushSync(onClose);
                onSelect(marketFaceItem(packId, item.hash, item.name, development));
              },
            }}
          />
        </Suspense>
      </div>
    </EditorDialog>
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
