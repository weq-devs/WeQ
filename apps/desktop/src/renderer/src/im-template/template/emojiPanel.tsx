// @ts-nocheck
/**
 * 消息输入框表情面板。
 *
 * 一栏一个来源，互不混排（「最近使用」因此不会被 Unicode 字符表情污染）：
 *   最近    ← emoji_com_used_table（codec 解析，真实库）
 *   表情    ← base_sys_emoji_table 按 81266 分类，**全部**按小图展示（含大表情）：
 *             都能和文字合成一条消息
 *   超级表情 ← 同一份数据里除「小黄脸表情」外的全部，按大表情展示（同原先的超级
 *             表情块）；它们只能单独发，所以点选走 onSelectSuper，不落到输入框
 *   字符    ← 81214 非 0 的 Unicode 字符表情，单独一栏
 *   商城    ← market_emoticon_package_table；点包看全部，右上「+」弹灯箱搜索目录
 *   收藏    ← fav_emoji_info_storage_table（我喜欢的自定义表情）
 *   GIF     ← related_emoji_emoji_table（标签 → 表情集合，标签栏常驻）
 *   颜文字  ← 内置静态列表
 *
 * 图片字节全部走协议（weq-asset / weq-media），不过 tRPC。
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  Clock,
  Heart,
  Image as ImageIcon,
  MessageSquareQuote,
  Plus,
  Search,
  Smile,
  Sparkles,
  Store,
  Type,
  X,
} from 'lucide-react';
import type { RefObject } from 'react';
import { trpc } from '../../trpc/client';
import { useOverlayLayer } from '../../lib/overlayStack';
import { cn } from './classNames';
import {
  favEmojiItem,
  marketFaceItem,
  relatedEmojiItem,
  systemFaceItem,
  unicodeFaceItem,
  type EmojiItem,
} from './emojiPacks';

type TabId = 'recent' | 'face' | 'super' | 'unicode' | 'market' | 'fav' | 'gif' | 'kaomoji';

const TABS: Array<{ id: TabId; label: string; icon: typeof Smile }> = [
  { id: 'recent', label: '最近', icon: Clock },
  { id: 'face', label: '表情', icon: Smile },
  { id: 'super', label: '超级表情', icon: Sparkles },
  { id: 'unicode', label: '字符表情', icon: Type },
  { id: 'market', label: '商城表情', icon: Store },
  { id: 'fav', label: '收藏', icon: Heart },
  { id: 'gif', label: 'GIF 表情', icon: ImageIcon },
  { id: 'kaomoji', label: '颜文字', icon: MessageSquareQuote },
];

/** 系统表情里「小黄脸表情」不算超级表情，其余分类全部并进「超级表情」栏。 */
const SMALL_FACE_LABEL = '小黄脸表情';

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
}: {
  panelRef: RefObject<HTMLDivElement | null>;
  /** 普通表情：插进输入框，可以和文字合成一条消息。 */
  onSelect: (item: EmojiItem) => void;
  /** 超级表情：只能单独发，交给宿主挂成待发送卡片（缺省时退化成 onSelect）。 */
  onSelectSuper?: (item: EmojiItem) => void;
}) {
  const [tab, setTab] = useState<TabId>('face');
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
  const tags = overview.data?.tags ?? [];

  // 两栏吃的都是同一份系统表情（unicode 已经单独一栏了）：
  //   「表情」= 全部，一律小图 —— 大表情在这里也只是普通表情，能和文字一起发；
  //   「超级表情」= 除小黄脸外的全部，按大表情展示，点选只能单独发。
  const superGroups = systemGroups.filter((g) => g.label !== SMALL_FACE_LABEL);

  return (
    <div className={cn('emoji-panel')} ref={panelRef} aria-label="表情面板">
      <div className={cn('emoji-panel-body')}>
        {tab === 'recent' ? (
          <FaceGrid
            empty={recent.length === 0}
            emptyText="还没有使用记录"
            loading={overview.isLoading}
            items={recent.map((it) => ({
              key: `${it.unicode ? 'u' : 'f'}-${it.id}`,
              title: it.desc,
              item: faceItemToEmoji(it),
            }))}
            onSelect={onSelect}
          />
        ) : tab === 'face' ? (
          <div className={cn('emoji-section')}>
            {overview.isLoading && systemGroups.length === 0 ? (
              <div className={cn('emoji-state')}>加载中…</div>
            ) : null}
            {!overview.isLoading && systemGroups.length === 0 ? (
              <div className={cn('emoji-state')}>没有系统表情</div>
            ) : null}
            {systemGroups.map((group) => (
              <section className={cn('emoji-group')} key={group.key}>
                <h3>{group.label}</h3>
                <FaceGrid
                  items={group.items.map((it) => ({
                    key: it.id,
                    title: it.desc,
                    item: faceItemToEmoji(it),
                  }))}
                  onSelect={onSelect}
                />
              </section>
            ))}
          </div>
        ) : tab === 'super' ? (
          <div className={cn('emoji-section')}>
            {overview.isLoading && superGroups.length === 0 ? (
              <div className={cn('emoji-state')}>加载中…</div>
            ) : null}
            {!overview.isLoading && superGroups.length === 0 ? (
              <div className={cn('emoji-state')}>没有超级表情</div>
            ) : null}
            {superGroups.length > 0 ? (
              <div className={cn('emoji-super-hint')}>超级表情只能单独发送，不会带上输入框里的文字</div>
            ) : null}
            {superGroups.map((group) => (
              <div className={cn('emoji-subgroup')} key={group.key}>
                <h4>{group.label}</h4>
                <FaceGrid
                  layout="super"
                  items={group.items.map((it) => ({
                    key: it.id,
                    title: `${it.desc}（超级表情，只能单独发送）`,
                    item: faceItemToEmoji(it, true),
                  }))}
                  onSelect={onSelectSuper ?? onSelect}
                />
              </div>
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
          <FavTab
            loading={overview.isLoading}
            favorites={favorites}
            emptyText="还没有收藏的自定义表情"
            onSelect={onSelect}
          />
        ) : tab === 'gif' ? (
          <GifTab tags={tags} loading={overview.isLoading} onSelect={onSelect} />
        ) : (
          <KaomojiGrid onSelect={onSelect} />
        )}
      </div>

      <div className={cn('emoji-tabs')}>
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={cn(id === tab ? 'active' : '')}
            title={label}
            aria-label={label}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setTab(id)}
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

type GridCell = { key: string; title: string; item: EmojiItem };

function FaceGrid({
  items,
  onSelect,
  loading,
  empty,
  emptyText,
  layout = 'default',
}: {
  items: GridCell[];
  onSelect: (item: EmojiItem) => void;
  loading?: boolean;
  empty?: boolean;
  emptyText?: string;
  /** 网格尺寸：default 小图 / big 每行 4 个（贴纸）/ super 每行 5 个（超级表情）。 */
  layout?: 'default' | 'big' | 'super';
}) {
  if (loading && items.length === 0) {
    return <div className={cn('emoji-state')}>加载中…</div>;
  }
  if (empty || items.length === 0) {
    return <div className={cn('emoji-state')}>{emptyText ?? '这里还没有表情'}</div>;
  }
  return (
    <div
      className={cn(
        'emoji-grid',
        layout === 'big' && 'emoji-big-grid',
        layout === 'super' && 'emoji-super-grid',
      )}
    >
      {items.map((cell) => (
        <FaceCell key={cell.key} cell={cell} onSelect={onSelect} />
      ))}
    </div>
  );
}

function FaceCell({ cell, onSelect }: { cell: GridCell; onSelect: (item: EmojiItem) => void }) {
  const [broken, setBroken] = useState(false);
  const { item } = cell;
  return (
    <button
      type="button"
      title={cell.title}
      className={cn('emoji-cell', item.large && 'is-sticker')}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onSelect(item)}
    >
      {item.glyph ? (
        <span className={cn('emoji-glyph')}>{item.glyph}</span>
      ) : broken || !item.src ? (
        <span className={cn('emoji-cell-fallback')}>
          <Smile size={22} strokeWidth={1.4} />
        </span>
      ) : (
        <img src={item.src} alt={cell.title} draggable={false} onError={() => setBroken(true)} />
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
    return (
      <MarketPackDetail packId={packId} onBack={() => onOpenPack(null)} onSelect={onSelect} />
    );
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
        <div className={cn('emoji-state')}>
          还没有添加商城表情包，点右上「添加」去搜索
        </div>
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
            {detail.data.source === 'local' ? '本地' : '在线'} · {detail.data.count} 张
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

function FavTab({
  favorites,
  onSelect,
  loading,
  emptyText,
}: {
  favorites: Array<{
    id: string;
    hash: string;
    scope: string;
    bucket: string;
    oriFile: string | null;
    thumbFile: string | null;
    remoteUrl: string;
  }>;
  onSelect: (item: EmojiItem) => void;
  loading?: boolean;
  emptyText: string;
}) {
  if (loading && favorites.length === 0) return <div className={cn('emoji-state')}>加载中…</div>;
  if (favorites.length === 0) return <div className={cn('emoji-state')}>{emptyText}</div>;
  return (
    <div className={cn('emoji-grid emoji-big-grid')}>
      {favorites.map((fav) => {
        const variant = fav.thumbFile ? 'thumb' : 'ori';
        const file = fav.thumbFile ?? fav.oriFile;
        if (!file) return null;
        const item = favEmojiItem(fav.scope, fav.bucket, variant, file, fav.hash);
        return <FaceCell key={fav.id} cell={{ key: fav.id, title: fav.hash, item }} onSelect={onSelect} />;
      })}
    </div>
  );
}

// ── GIF ───────────────────────────────────────────────────────────────────────

function GifTab({
  tags,
  loading,
  onSelect,
}: {
  tags: Array<{ keyword: string; dirHash: string; count: number; cover: string | null }>;
  loading?: boolean;
  onSelect: (item: EmojiItem) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  // 没手动选就默认看第一个标签的内容（否则一进来空荡荡）；标签栏始终留在顶部，
  // 点标签只是切换下方内容，不会把它清掉。
  const active = tags.find((t) => t.keyword === picked) ?? tags[0] ?? null;
  const gifs = trpc.account.emojiPanel.relatedGifs.useQuery(
    { keyword: active?.keyword ?? '' },
    { enabled: !!active },
  );

  if (loading && tags.length === 0) return <div className={cn('emoji-state')}>加载中…</div>;
  if (tags.length === 0) return <div className={cn('emoji-state')}>还没有 GIF 表情</div>;

  const list = gifs.data ?? [];
  return (
    <div className={cn('emoji-section')}>
      <div className={cn('emoji-chip-row')}>
        {tags.map((tag) => (
          <button
            key={tag.keyword}
            type="button"
            className={cn('emoji-chip', tag.keyword === active?.keyword && 'active')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setPicked(tag.keyword)}
          >
            {tag.keyword}
            <em>{tag.count}</em>
          </button>
        ))}
      </div>
      {gifs.isLoading ? (
        <div className={cn('emoji-state')}>加载中…</div>
      ) : list.length === 0 ? (
        <div className={cn('emoji-state')}>这个标签下没有表情</div>
      ) : (
        <div className={cn('emoji-grid emoji-big-grid')}>
          {list.map((gif) => {
            const item = relatedEmojiItem(gif.hash, gif.file, active?.keyword ?? '');
            return (
              <FaceCell
                key={gif.file}
                cell={{ key: gif.file, title: active?.keyword ?? '', item }}
                onSelect={onSelect}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── 搜索灯箱（商城目录） ───────────────────────────────────────────────────────

function EmojiCatalogLightbox({
  onClose,
  onSelect,
}: {
  onClose: () => void;
  onSelect: (item: EmojiItem) => void;
}) {
  const layer = useOverlayLayer(true);
  const [keyword, setKeyword] = useState('');
  const [debounced, setDebounced] = useState('');
  const [openPackId, setOpenPackId] = useState<string | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(keyword.trim()), 260);
    return () => window.clearTimeout(t);
  }, [keyword]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

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
      style={{ zIndex: layer }}
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
          <button type="button" className={cn('emoji-lb-close')} onClick={onClose} aria-label="关闭">
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
            <div className={cn('emoji-state')}>没有找到匹配的表情包</div>
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

