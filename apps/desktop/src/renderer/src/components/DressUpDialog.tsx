/**
 * 个性装扮整页，保留分类与商城浏览现场。
 *
 * 「使用」集中管理当前装扮与渲染范围，其他类别保留商城浏览、搜索与已装筛选。
 *
 * 气泡、字体、头像挂件和通话背景走商城；使用页与聊天背景不显示商城搜索和筛选。
 *
 * 在线要求其实只剩搜索这一档,其余一律离线可用:
 *  - **浏览排行 / 安装(气泡 / 字体 / 挂件)**:离线可用 —— 资源先走本地离线 bundle(QQ 自带
 *    那批装扮资源),商城条目还自带 material,都不需要凭证;本地没有的款点击后由后端
 *    在需要时再尝试换链,失败才报错。所以**不再按 qqOnline 禁用任何安装按钮**。
 *  - **装扮搜索**:必须有在线 QQ 实例(商城搜索接口要用在线实例取凭证)。
 *  - **商城表情搜索**:搜索离线目录，不需要在线 QQ。
 *
 * 聊天背景与浮屏挂件一律离线可用(QQ 同款的直链 bootstrap 时已存进 config,浮屏挂件是 bundle 的)。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { z } from 'zod';
import {
  Loader2,
  Check,
  Download,
  Sparkles,
  WifiOff,
  Palette,
  Upload,
  Trophy,
  X,
  ChevronRight,
} from 'lucide-react';
import type { BubbleSkin, DressBackgroundSource, DressMallItem, DressScope } from '@weq/service';
import { trpc } from '../trpc/client';
import { useAppDialog } from '../lib/dialogUtils';
import { DressOpacityControl } from './DressOpacityControl';
import {
  dressBackgroundUrl,
  dressFontUrl,
  dressPendantFrameUrl,
  dressUrl,
  isVideoBackground,
} from '../lib/resourceUrl';
import { bubblePreviewCss } from '../lib/dressSkin';
import { resolveChatBackdrop, syncDressSkin, syncDressSkinPreloaded } from '../hooks/useDressSkin';
import { useNearViewport } from '../hooks/useNearViewport';
import { useDevelopmentDressTools } from '../hooks/useDevelopmentDressTools';
import { useMobileWebLayout } from '../hooks/useMobileWebViewport';
import { useVideoPlaybackSlot } from '../hooks/useVideoPlaybackSlot';
import { fontFaces } from '../lib/fontFaces';
import { acquireDecorationStyle } from '../lib/decorationResources';
import { useDressDownload } from '../hooks/useDressDownload';
import { useMultiSelection } from '../hooks/useMultiSelection';
import { DirectoryToolbar } from './DirectoryToolbar';
import { IS_WEB } from '../lib/target.shared';
import { pickAccountFile } from '../lib/accountFilePicker';
import type { DressOpacityKind } from './ChatBackdrop.shared';
import { ChatBackdrop, ScreenWidget } from './ChatBackdrop';
import { WorkspacePage } from './WorkspacePages';
import { usePageState } from './PageSnapshots.shared';
import { PageScrollSnapshot } from './PageScrollSnapshot';
import { pageValue } from '../lib/pageSnapshots';
import { MarketEmojiBrowserLightbox } from '../views/export/MarketEmojiBrowserLightbox';
import { RedPackSkinWall } from './gift/RedPackSkinWall';
import { DressSearchForm } from './DressSearchForm';
import '../styles/dressup.css';
import { ShimmerImage } from './ShimmerImage';
import { DRESS_KIND_ICONS } from '../lib/featureIcons.shared';

export type DressKind =
  | 'usage'
  | 'bubble'
  | 'font'
  | 'widget'
  | 'callbg'
  | 'background'
  | 'emoji'
  | 'redpack';

const KINDS: { id: DressKind; label: string; icon: ReactElement }[] = (
  [
    { id: 'bubble', label: '聊天气泡' },
    { id: 'font', label: '聊天字体' },
    { id: 'widget', label: '头像挂件' },
    { id: 'callbg', label: '通话背景' },
    { id: 'background', label: '聊天背景' },
    { id: 'emoji', label: '商城表情' },
    // 红包封面同样只读，且**完全离线**：只读仓库里的 resources/redpack/skins.json。
    { id: 'redpack', label: '红包封面' },
    { id: 'usage', label: '使用中' },
  ] satisfies Omit<{ id: DressKind; label: string; icon: ReactElement }, 'icon'>[]
).map((entry) => {
  const Icon = DRESS_KIND_ICONS[entry.id];
  return { ...entry, icon: <Icon size={14} aria-hidden /> };
});

/** 商城那几类共用一套列表 UI;聊天背景和表情包是各自独立的形状。 */
type MallKind = 'bubble' | 'font' | 'widget' | 'callbg';
type CurrentKind = MallKind | 'background' | 'screen';

interface MallBrowseState {
  view: 'rank' | 'installed';
  draft: string;
  keyword: string;
}

const DEFAULT_MALL_BROWSE: MallBrowseState = { view: 'rank', draft: '', keyword: '' };
const dressKindSchema = z.custom<DressKind>((value) => KINDS.some(({ id }) => id === value));
const mallBrowseSchema = z.record(
  z.enum(['bubble', 'font', 'widget', 'callbg']),
  z.object({ view: z.enum(['rank', 'installed']), draft: z.string(), keyword: z.string() }),
);

/** 通话背景没有「安装」概念,选中即用(远程 url 直接给通话窗口引)。 */
const isCallBg = (kind: MallKind): kind is 'callbg' => kind === 'callbg';

const SCOPES: Array<{ id: DressScope; label: string; hint: string }> = [
  { id: 'mine', label: '仅自己', hint: '仅覆盖自己发出的消息' },
  { id: 'fallback', label: '替代无装扮', hint: '仅替代原本没有对应装扮的消息，保留已有装扮' },
  { id: 'all', label: '覆盖全部', hint: '覆盖自己和他人消息的对应装扮' },
];

/** 排行 / 搜索首屏的骨架卡片数 —— 与一屏可见的卡片量相当,不用撑满整份列表。 */
const LOADING_SKELETON_CARDS = 12;
/** 骨架卡片的稳定 key(纯装饰节点,固定集合,不随数据重排)。 */
const SKELETON_CARD_KEYS = Array.from(
  { length: LOADING_SKELETON_CARDS },
  (_, i) => `dress-skel-${i}`,
);

/** 「已装」本地气泡预览的受管 <style> 节点 id(与消息装扮的注入分开)。 */

/**
 * 把一款气泡的九宫格 CSS 注入到预览格子里(按 data-bubble-preview 精确命中)。
 *
 * 底图按 chat 渲染同一套规则二选一:bubblePreviewCss 有 localFile(持久化的本地
 * 九宫格 PNG)就走 `weq-media://dressbubble`,没有(旧账号里 CDN 直链装的遗留款)则
 * 用它渲染真实消息时同一个 dress 代理地址 —— 预览与消息所见即所得,不另猜预览图。
 */
function injectBubblePreviewCss(skin: BubbleSkin): () => void {
  const sel =
    `.weq-dress-bubble-preview-stage[data-bubble-preview="${skin.itemId}"]` +
    ' .weq-dress-preview-bubble';
  const css = bubblePreviewCss(skin, sel);
  return acquireDecorationStyle(`preview-bubble:${skin.itemId}`, (resource) =>
    resource.append(css),
  );
}

/** 「已装」里没有商城预览图的气泡 —— 用本地九宫格素材把气泡本身画出来。 */
function BubbleLocalPreview({ itemId }: { itemId: number }): ReactElement {
  return (
    <span className="weq-dress-bubble-preview-stage" data-bubble-preview={itemId}>
      {/* 气泡本体样式由 injectBubblePreviewCss 注入,几何与聊天渲染同源。 */}
      <span className="weq-dress-preview-bubble">气泡文字</span>
    </span>
  );
}

/**
 * 「已装」里没有预览图的聊天字体 —— 本地 ttf 经 FontFace 注册后直接排样例文字。
 *
 * 与 MessageDecorationCard 的字体预览同款做法;family 独立命名,不碰聊天那套
 * `weq-dress-<id>`,避免污染正在生效的装扮字体注册。
 */
function FontLocalPreview({ itemId }: { itemId: number }): ReactElement {
  const family = `weq-dress-list-preview-${itemId}`;
  const [state, setState] = useState<'loading' | 'ready' | 'fail'>('loading');

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    const font = fontFaces.acquire(family, dressFontUrl(itemId));
    void font.ready
      .then((ok) => {
        if (cancelled) return;
        setState(ok ? 'ready' : 'fail');
      })
      .catch(() => {
        // 某些 QQ 字体过不了 Chromium 的 OTS 校验 —— 与消息装扮同款处理,静默降级。
        if (!cancelled) setState('fail');
      });
    return () => {
      cancelled = true;
      font.release();
    };
  }, [family, itemId]);

  if (state === 'loading') {
    return <span className="weq-dress-skel-block weq-dress-font-loading" aria-hidden />;
  }
  if (state === 'ready') {
    return (
      <span className="weq-dress-font-preview" style={{ fontFamily: `"${family}"` }}>
        <span className="weq-dress-font-preview-main">装扮气泡Aa</span>
        <span className="weq-dress-font-preview-sub">WeQ 123 聊天字体</span>
      </span>
    );
  }
  return <span className="weq-dress-font-fallback">无预览</span>;
}

/** 装扮页列表的滚动容器 —— 预览按它的视口懒加载(见 useNearViewport)。 */
const LIST_SCROLL_SELECTOR = '.weq-dress-body';

/**
 * 一张卡片的预览格。
 *
 * 之前是整页一次性把每张预览图 / 每路视频都挂上去:通话背景那一栏 82 款、每款一支
 * autoPlay 的 mp4,进页瞬间几十路解码同时起,整页就卡住了。现在分两种策略:
 *
 *  - **图片**:进过视口才设 `src`,之后一直留着(滚回来不用重新走主进程代理)。
 *  - **视频**:只在视口内才挂 `<video>`;离屏退回静态封面图 —— 通话背景条目自带
 *    `image.jpg`,所以离屏看到的是同一款的首帧,不会变成空白格。
 */
function DressCardPreview({
  slotKey,
  imageSrc,
  videoSrc,
  alt,
  children,
}: {
  /** 播放名额的唯一标识(见 useVideoPlaybackSlot)。 */
  slotKey: string;
  imageSrc: string;
  videoSrc?: string;
  alt: string;
  /** 本地画出来的预览(气泡 / 字体),给了就不走图片 / 视频这一套。 */
  children?: ReactElement;
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const { near, entered } = useNearViewport(ref, { rootSelector: LIST_SCROLL_SELECTOR });
  // 在视口内还要抢到播放名额才播 —— 一屏可能摆下二十多张卡片。
  const showVideo = useVideoPlaybackSlot(slotKey, Boolean(videoSrc) && near);
  return (
    <div
      className={`weq-dress-card-preview weq-media-frame${videoSrc ? ' is-video' : ''}`}
      ref={ref}
    >
      {children ? (
        children
      ) : showVideo ? (
        // poster 就是离屏时要显示的那张封面,浏览器会顺手把它载入缓存 —— 滚出去
        // 换成 <img> 时不会白一下。
        <video src={videoSrc} poster={imageSrc || undefined} autoPlay loop muted playsInline />
      ) : imageSrc && entered ? (
        // 有视频但离屏时同样走这张封面 —— 它本来就是这支视频的首帧。
        <ShimmerImage src={imageSrc} alt={alt} loading="lazy" decoding="async" />
      ) : imageSrc ? (
        // 还没滚到:连 src 都不给,免得一进页就把几十张封面一起拉下来。
        <span className="weq-dress-card-pending" aria-hidden />
      ) : (
        <div className="weq-dress-card-noimg">无预览</div>
      )}
    </div>
  );
}

/**
 * 排行 / 搜索加载中的骨架占位 —— 与真实卡片同构(预览格 + 两行文字 + 按钮),
 * shimmer 扫光,避免整页在「转圈 / 卡片」之间跳版。
 */
function DressListSkeleton(): ReactElement {
  return (
    <div className="weq-dress-grid" aria-hidden>
      {SKELETON_CARD_KEYS.map((k) => (
        <div className="weq-dress-card" key={k}>
          <div className="weq-dress-card-preview">
            <span className="weq-dress-skel-block weq-dress-skel-preview" />
          </div>
          <div className="weq-dress-card-body">
            <span className="weq-dress-skel-block weq-dress-skel-line" />
            <span className="weq-dress-skel-block weq-dress-skel-line is-short" />
          </div>
          <div className="weq-dress-card-actions">
            <span className="weq-dress-skel-block weq-dress-skel-btn" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function DressUpDialog({
  onClose,
  initialKind,
  initialEmojiPackId,
  initialEmojiPackName,
}: {
  onClose: () => void;
  /** 从全局搜索等入口直达某个页签（表情页签会带上要定位的表情包）。 */
  initialKind?: DressKind;
  initialEmojiPackId?: string;
  initialEmojiPackName?: string;
}): ReactElement {
  const mobile = useMobileWebLayout();
  const developmentDressTools = useDevelopmentDressTools();
  const dialog = useAppDialog();
  const download = useDressDownload();
  const utils = trpc.useUtils();

  const [selectedKind, setSelectedKind] = usePageState<DressKind>(
    'dress-up:kind',
    'usage',
    dressKindSchema,
  );
  const explicitKind = useRef(initialKind);
  useLayoutEffect(() => {
    if (explicitKind.current) {
      setSelectedKind(explicitKind.current);
      explicitKind.current = undefined;
    }
  }, [setSelectedKind]);
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  function setSelectionMode(enabled: boolean) {
    setSelecting(enabled);
    if (!enabled) setSelectedIds(new Set());
  }
  function setKind(next: DressKind) {
    if (next === kind) return;
    setSelectionMode(false);
    setSelectedKind(next);
  }
  const kind = developmentDressTools ? (explicitKind.current ?? selectedKind) : 'background';
  const [mallBrowsing, setMallBrowsing] = usePageState('dress-up:mall', {}, mallBrowseSchema);
  const [emojiDraft, setEmojiDraft] = usePageState('dress-up:emoji-draft', '', pageValue.string);
  const [emojiKeyword, setEmojiKeyword] = usePageState(
    'dress-up:emoji-keyword',
    '',
    pageValue.string,
  );
  /** 正在装的 itemId —— 按钮显示转圈,避免重复点击。 */
  const [busyId, setBusyId] = useState(0);
  /** 「取消当前装扮」/「切换范围」进行中 —— 同样会重排聊天列表,也要盖加载态。 */
  const [clearing, setClearing] = useState(false);
  const [scoping, setScoping] = useState(false);
  const state = trpc.account.dressup.getState.useQuery();
  const online = state.data?.qqOnline ?? false;
  const manifest = state.data?.manifest;
  const scope = manifest?.scope ?? 'mine';
  const backdrop = resolveChatBackdrop(manifest, state.data?.own.chatBgUrl ?? '');
  const hasBackground = Boolean(backdrop.imageUrl || backdrop.videoUrl);
  const backgroundSection = useRef<HTMLElement>(null);
  const widgetSection = useRef<HTMLElement>(null);
  const backgroundTarget = useRef<'background' | 'screen' | null>(null);
  useLayoutEffect(() => {
    if (kind !== 'background' || !backgroundTarget.current) return;
    const target =
      backgroundTarget.current === 'screen' ? widgetSection.current : backgroundSection.current;
    backgroundTarget.current = null;
    target?.closest('[data-page-snapshot]')?.dispatchEvent(new Event('weq-page-navigation'));
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'start' });
  }, [kind]);

  // 背景和表情包都不走装扮商城,装扮列表 query 一律停掉;下面两处的 kind 因此可以安全窄化。
  const isMall = kind === 'bubble' || kind === 'font' || kind === 'widget' || kind === 'callbg';
  const mallKind: MallKind =
    kind === 'font'
      ? 'font'
      : kind === 'widget'
        ? 'widget'
        : kind === 'callbg'
          ? 'callbg'
          : 'bubble';

  const { view, draft, keyword } = mallBrowsing[mallKind] ?? DEFAULT_MALL_BROWSE;
  const mineOnly = view === 'installed';
  const listScope = isMall ? JSON.stringify(['dress-up', kind, view, keyword]) : `dress-up:${kind}`;
  function updateMallBrowse(patch: Partial<MallBrowseState>) {
    if (
      (patch.view && patch.view !== view) ||
      (patch.keyword !== undefined && patch.keyword !== keyword)
    ) {
      setSelectedIds(new Set());
    }
    setMallBrowsing((current) => ({
      ...current,
      [mallKind]: { ...(current[mallKind] ?? DEFAULT_MALL_BROWSE), ...patch },
    }));
  }

  // 商城目录中，回车提交关键词后从排行榜切到搜索结果。
  const searching = keyword.length > 0;
  const rank = trpc.account.dressup.rank.useQuery(
    { kind: mallKind },
    { enabled: isMall && !mineOnly && !searching },
  );
  const search = trpc.account.dressup.search.useQuery(
    { kind: mallKind, keyword },
    { enabled: isMall && !mineOnly && searching && online, retry: false },
  );
  const widgets = trpc.account.dressup.widgets.useQuery(undefined, {
    enabled: kind === 'background',
    staleTime: Infinity,
  });

  // 清单变化(装了新的 / 切换生效 / 改范围)后重新注入样式。
  useEffect(() => {
    syncDressSkin(manifest);
  }, [manifest]);

  // 「已装」里没有商城预览图的气泡(旧版 40801 自动装遗留的条目、以及旧配置里缺预览图的
  // 条目 —— 现在 40801 解析只进共享缓存、不再写「已装」,但旧配置里的条目还在),
  // 预先注入本地预览 CSS —— 渲染层只负责摆 DOM,样式写一次就够。用 layout effect
  // 让样式赶在首帧绘制前落地,避免「已装」网格先闪一帧裸文字气泡。
  useLayoutEffect(() => {
    if (!manifest) return;
    const release: (() => void)[] = [];
    for (const b of manifest.bubbles) {
      // local-only:能进清单的款本地九宫格必在,直接画本体当预览。
      if (!b.previewUrl || (kind === 'usage' && b.itemId === manifest.activeBubble))
        release.push(injectBubblePreviewCss(b));
    }
    return () => {
      for (const dispose of release) dispose();
    };
  }, [manifest, kind]);

  const installBubble = trpc.account.dressup.installBubble.useMutation();
  const installFont = trpc.account.dressup.installFont.useMutation();
  const installWidget = trpc.account.dressup.installWidget.useMutation();
  const setActive = trpc.account.dressup.setActive.useMutation();
  const setScope = trpc.account.dressup.setScope.useMutation();
  const pickBackground = trpc.account.dressup.pickBackground.useMutation();
  const setBackground = trpc.account.dressup.setBackground.useMutation();
  const setWidget = trpc.account.dressup.setWidget.useMutation();
  const setCallBackground = trpc.account.dressup.setCallBackground.useMutation();
  const setBackgroundOpacity = trpc.account.dressup.setBackgroundOpacity.useMutation();
  const setWidgetOpacity = trpc.account.dressup.setWidgetOpacity.useMutation();

  const refresh = useCallback(async (): Promise<void> => {
    await utils.account.dressup.getState.invalidate();
  }, [utils]);

  /**
   * 装一款并立即生效 —— 用户点「使用」时期望的就是这个。
   *
   * 全程盖在加载态里,包括**样式注入**:注入要等图片解码 / 字体下载,那段是整个流程里
   * 最容易看出卡顿的一段(消息列表会重排)。若只等到 mutation 返回就收工,加载态会在
   * 真正的卡顿开始前消失,反而显得更卡。所以这里手动注入并 await,而不是等清单
   * invalidate 后由 effect 去做。
   */
  const use = useCallback(
    async (item: DressMallItem, nameForManifest = item.name): Promise<void> => {
      setBusyId(item.itemId);
      try {
        // nameForManifest 与卡片上显示的名字可以不同 ——「QQ 正在用的X」那种占位串
        // 显示可以,落盘不行(存进清单就洗不掉,列表会永远显示占位名)。
        const name = nameForManifest;
        if (isCallBg(mallKind)) {
          const imageUrl = item.previewLargeUrl || item.previewUrl;
          if (!imageUrl && !item.videoUrl) throw new Error('这款通话背景没有可用素材');
          await setCallBackground.mutateAsync({
            itemId: item.itemId,
            name,
            imageUrl,
            videoUrl: item.videoUrl,
          });
          await refresh();
          return;
        }
        if (mallKind === 'bubble') {
          // 只带 itemId —— 后端走本地离线 bundle → protocol 唯一下载链(见 dressup 路由)。
          // name/previewUrl 同理:装完只剩 itemId,商城没有按 id 查详情的接口。
          await installBubble.mutateAsync({
            itemId: item.itemId,
            name,
            previewUrl: item.previewLargeUrl || item.previewUrl,
          });
        } else if (mallKind === 'font') {
          await installFont.mutateAsync({
            itemId: item.itemId,
            name,
            previewUrl: item.previewLargeUrl || item.previewUrl,
          });
        } else {
          await installWidget.mutateAsync({
            itemId: item.itemId,
            name,
            previewUrl: item.previewLargeUrl || item.previewUrl,
          });
        }
        const manifest = await setActive.mutateAsync({
          kind: mallKind,
          itemId: item.itemId,
        });
        // setActive 回的就是新清单,直接拿它注入,不必等 refetch 往返。
        await syncDressSkinPreloaded(manifest);
        await refresh();
      } catch (e) {
        dialog.error('装扮失败', e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(0);
      }
    },
    [
      mallKind,
      installBubble,
      installFont,
      installWidget,
      setActive,
      setCallBackground,
      refresh,
      dialog,
    ],
  );

  /** 取消当前生效的装扮,回到默认外观。 */
  const clear = useCallback(
    async (target: MallKind): Promise<void> => {
      setClearing(true);
      try {
        if (isCallBg(target)) {
          await setCallBackground.mutateAsync({ itemId: 0 });
          await refresh();
          return;
        }
        const manifest = await setActive.mutateAsync({
          kind: target,
          itemId: 0,
        });
        await syncDressSkinPreloaded(manifest);
        await refresh();
      } catch (e) {
        dialog.error('取消失败', e instanceof Error ? e.message : String(e));
      } finally {
        setClearing(false);
      }
    },
    [setActive, refresh, dialog, setCallBackground.mutateAsync],
  );

  const changeScope = useCallback(
    async (next: DressScope): Promise<void> => {
      if (next === scope) return;
      setScoping(true);
      try {
        const manifest = await setScope.mutateAsync({ scope: next });
        await syncDressSkinPreloaded(manifest);
        await refresh();
      } catch (e) {
        dialog.error('切换范围失败', e instanceof Error ? e.message : String(e));
      } finally {
        setScoping(false);
      }
    },
    [scope, setScope, refresh, dialog],
  );

  /**
   * 背景与挂件的改动**不需要 preload + 遮罩**:它们只影响 .chat-pane 上那一层
   * 独立的 backdrop,不参与消息列表的排版,所以不会引起重排。
   */
  const chooseBackground = useCallback(
    async (source: DressBackgroundSource): Promise<void> => {
      try {
        await setBackground.mutateAsync({ source });
        await refresh();
      } catch (e) {
        dialog.error('切换背景失败', e instanceof Error ? e.message : String(e));
      }
    },
    [setBackground, refresh, dialog],
  );

  /** 选图 —— 主进程开系统文件框,拷进本账号目录后自动切到自定义。 */
  const chooseCustomFile = useCallback(async (): Promise<void> => {
    try {
      const picked = IS_WEB ? await pickAccountFile('file') : undefined;
      if (IS_WEB && !picked) return;
      await pickBackground.mutateAsync(picked ? { path: picked.path } : undefined);
      await refresh();
    } catch (e) {
      dialog.error('选择背景图失败', e instanceof Error ? e.message : String(e));
    }
  }, [pickBackground, refresh, dialog]);

  const chooseWidget = useCallback(
    async (widgetId: string): Promise<void> => {
      try {
        await setWidget.mutateAsync({ widgetId });
        await refresh();
      } catch (e) {
        dialog.error('切换挂件失败', e instanceof Error ? e.message : String(e));
      }
    },
    [setWidget, refresh, dialog],
  );

  async function commitOpacity(kind: DressOpacityKind, opacity: number) {
    try {
      const mutation = kind === 'background' ? setBackgroundOpacity : setWidgetOpacity;
      await mutation.mutateAsync({ opacity });
      await refresh();
    } catch (e) {
      dialog.error('调整不透明度失败', e instanceof Error ? e.message : String(e));
    }
  }

  function renderOpacity(kind: DressOpacityKind, summary = false) {
    if (kind === 'background' ? !hasBackground : !backdrop.widgetId) return null;
    return (
      <DressOpacityControl
        kind={kind}
        summary={summary}
        value={kind === 'background' ? backdrop.backgroundOpacity : backdrop.widgetOpacity}
        onCommit={(value) => commitOpacity(kind, value)}
      />
    );
  }

  /** 任何一种会改动聊天外观的操作正在进行 —— 驱动整个对话框的遮罩。 */
  const applying = busyId !== 0 || clearing || scoping;

  const activeId = isCallBg(mallKind)
    ? (state.data?.own.callBgId ?? 0)
    : mallKind === 'bubble'
      ? (manifest?.activeBubble ?? 0)
      : mallKind === 'font'
        ? (manifest?.activeFont ?? 0)
        : (manifest?.activeWidget ?? 0);

  /**
   * 「已装」列表 —— 清单里的 + 自己在 QQ 里正在用的那款。
   *
   * 自己那款是 bootstrap 时从 getSelfDress 存下的(零额外请求),可能还没装过,
   * 这里也列出来让用户一键装上,这样 WeQ 的观感能和手机 QQ 对上。
   */
  const mine = useMemo((): Array<{
    itemId: number;
    name: string;
    /** true = name 只是「QQ 正在用的X」这种占位串,不能当真名存进清单。 */
    placeholderName?: boolean;
    installed: boolean;
    /**
     * 商城预览图(装的时候落盘的那张)。空串 = 没有,卡片会显示占位。
     *
     * **不拿九宫格底图凑数** —— 那是 128×112 的拉伸源图,塞进 110px 的卡片里既糊
     * 又跟商城列表长得不一样;宁可显示「无预览」也别给个错的。
     */
    previewUrl: string;
  }> => {
    if (!manifest) return [];
    // 显式标注:map 推出来的类型不含 placeholderName,下面 unshift 那条会过不了。
    const installed: Array<{
      itemId: number;
      name: string;
      placeholderName?: boolean;
      installed: boolean;
      previewUrl: string;
    }> = isCallBg(mallKind)
      ? []
      : mallKind === 'bubble'
        ? manifest.bubbles.map((b: BubbleSkin) => ({
            itemId: b.itemId,
            name: b.name || `气泡 ${b.itemId}`,
            installed: true,
            previewUrl: b.previewUrl ?? '',
          }))
        : mallKind === 'font'
          ? manifest.fonts.map((f) => ({
              itemId: f.itemId,
              name: f.name || `字体 ${f.itemId}`,
              installed: true,
              previewUrl: f.previewUrl ?? '',
            }))
          : manifest.widgets.map((w) => ({
              itemId: w.itemId,
              name: w.name || `挂件 ${w.itemId}`,
              installed: true,
              previewUrl: w.previewUrl ?? '',
            }));

    const own = state.data?.own;
    // 三类各自读自己的 own 字段(bootstrap 时从 getSelfDress 存下)。
    const ownMap = {
      bubble: {
        id: own?.bubbleId,
        name: own?.bubbleName,
        preview: own?.bubblePreviewUrl,
        label: '气泡',
      },
      font: {
        id: own?.fontId,
        name: own?.fontName,
        preview: own?.fontPreviewUrl,
        label: '字体',
      },
      widget: {
        id: own?.widgetId,
        name: own?.widgetName,
        preview: own?.widgetPreviewUrl,
        label: '挂件',
      },
      callbg: {
        id: own?.callBgId,
        name: own?.callBgName,
        // 静态图优先；动态素材的首帧也是这张。
        preview: own?.callBgUrl,
        label: '通话背景',
      },
    }[mallKind];
    const ownId = ownMap.id ?? 0;
    if (ownId && !installed.some((i) => i.itemId === ownId)) {
      // 名字和预览图是 getSelfDress 一起回的(见 home_dress),所以这一条也能显示人话 ——
      // 拿不到时才退回「QQ 正在用的X」。真正缺的只有资源本身:点「使用」时后端优先
      // 查本地离线 bundle,本地没有才走 protocol(那一步才需要在线实例)。
      const ownName = ownMap.name ?? '';
      const ownPreview = ownMap.preview ?? '';
      installed.unshift({
        itemId: ownId,
        // 只在真的没名字时才用占位串,而且要标出来 —— 否则它会被 use() 当成真名
        // 写进清单,以后列表里就永远显示「QQ 正在用的气泡」了(实测踩过)。
        name: ownName || `QQ 正在用的${ownMap.label}`,
        placeholderName: !ownName,
        installed: false,
        previewUrl: ownPreview,
      });
    }
    return installed;
  }, [manifest, mallKind, state.data]);

  const catalog = searching ? search : rank;
  const catalogItems = (searching && !online) || catalog.error ? [] : (catalog.data?.items ?? []);
  const installedItems = mine
    .filter((item) => item.name.toLowerCase().includes(keyword.toLowerCase()))
    .map((item) => ({
      ...item,
      videoUrl: mallKind === 'callbg' ? state.data?.own.callBgVideoUrl || undefined : undefined,
      previewLargeUrl: '',
    }));
  const downloadable = isMall
    ? (mineOnly ? installedItems : catalogItems)
        .map((item) => ({
          itemId: item.itemId,
          name: item.name,
          mediaUrl:
            mallKind === 'callbg'
              ? item.videoUrl || item.previewLargeUrl || item.previewUrl
              : undefined,
        }))
        .filter((item) => mallKind !== 'callbg' || Boolean(item.mediaUrl))
    : [];
  const downloadIds = downloadable.map((item) => item.itemId);
  const downloadsById = new Map(downloadable.map((item) => [item.itemId, item]));
  const selectedDownloads = downloadable.filter((item) => selectedIds.has(item.itemId));
  const allSelected = downloadIds.length > 0 && selectedDownloads.length === downloadIds.length;
  const multi = useMultiSelection({
    ids: downloadIds,
    selected: selectedIds,
    onChange: setSelectedIds,
    enabled: isMall && selecting,
    onStart: () => setSelectionMode(true),
    onExit: () => setSelectionMode(false),
  });

  /**
   * @param previewSrc 已经解析好的预览图 src(可直接进 `<img>`)。空串 = 无预览。
   *                   由调用方给,因为商城条目要经 `weq-media://dress` 代理,而走
   *                   protocol 装的气泡要经 `weq-media://dressbubble`。
   * @param nameForManifest 落盘用的名字,省略则同 `item.name`。「我的」里那条
   *                   「QQ 正在用的X」传空串 —— 占位名显示可以,存进清单洗不掉。
   */
  function renderCard(
    item: DressMallItem,
    previewSrc: string,
    nameForManifest?: string,
    localPreview?: ReactElement,
  ): ReactElement {
    const isActive = item.itemId === activeId;
    const busy = busyId === item.itemId;
    const target = downloadsById.get(item.itemId);
    const key = `${mallKind}:${item.itemId}`;
    const downloading = download.savingKey === key;
    const selected = selecting && selectedIds.has(item.itemId);
    // 安装不再按 qqOnline 禁用:资源先走本地离线 bundle(QQ 自带那批装扮资源,
    // 见 nt_helper 的 queryDressResourceUrl),只有本地没有时才需要在线实例去换外链,
    // 那一步的失败由后端在点击时如实报错。离线也能装的款不再被按钮拦住。
    return (
      <div
        key={item.itemId}
        className={`weq-dress-card${isActive ? ' is-active' : ''}${selected ? ' is-selected' : ''}`}
      >
        <DressCardPreview
          slotKey={`${mallKind}:${item.itemId}`}
          imageSrc={previewSrc}
          // 通话背景本来就是动态的 —— 在视口里就直接播，静帧看不出效果。
          videoSrc={isCallBg(mallKind) && item.videoUrl ? dressUrl(item.videoUrl) : undefined}
          alt={item.name}
        >
          {localPreview}
        </DressCardPreview>
        <div className="weq-dress-card-body">
          <strong title={item.name}>{item.name}</strong>
          <small>
            {item.labels.slice(0, 2).join(' · ') || item.mallName || (
              <span className="weq-number weq-number-inherit">#{item.itemId}</span>
            )}
          </small>
        </div>
        {selecting ? (
          <button
            type="button"
            className="weq-dress-card-select"
            aria-label={`选择 ${item.name || item.itemId}`}
            aria-pressed={selected}
            {...multi.itemProps(item.itemId, !target)}
            disabled={!target}
          />
        ) : (
          <div className="weq-dress-card-actions">
            <button
              type="button"
              className="weq-dress-use"
              title="仅影响 WeQ 本地显示，不影响实际发送"
              disabled={busy || isActive || applying}
              onClick={() => void use(item, nameForManifest ?? item.name)}
            >
              {busy ? (
                <Loader2 size={14} className="weq-dress-spin" />
              ) : isActive ? (
                <Check size={14} />
              ) : (
                <Sparkles size={14} />
              )}
              <span>{isActive ? '使用中' : busy ? '装扮中' : '使用'}</span>
            </button>
            <button
              type="button"
              className="weq-dress-save"
              title="创建下载任务"
              aria-label={`下载 ${item.name || item.itemId}`}
              disabled={applying || download.disabled || !target}
              onClick={() => target && void download.run(mallKind, [target], key)}
            >
              {downloading ? (
                <Loader2 size={14} className="weq-dress-spin" />
              ) : (
                <Download size={14} />
              )}
              <span>下载</span>
            </button>
          </div>
        )}
      </div>
    );
  }

  function renderUsage(): ReactElement {
    if (state.isInitialLoading) return <DressListSkeleton />;
    const bubble = manifest?.bubbles.find((item) => item.itemId === manifest.activeBubble);
    const font = manifest?.fonts.find((item) => item.itemId === manifest.activeFont);
    const widget = manifest?.widgets.find((item) => item.itemId === manifest.activeWidget);
    const current: Array<{
      kind: CurrentKind;
      label: string;
      value: string | number;
      name?: string;
      preview?: ReactElement;
      imageSrc?: string;
    }> = [
      {
        kind: 'bubble',
        label: '聊天气泡',
        value: manifest?.activeBubble ?? 0,
        name: bubble?.name,
        preview: bubble ? <BubbleLocalPreview itemId={bubble.itemId} /> : undefined,
      },
      {
        kind: 'font',
        label: '聊天字体',
        value: manifest?.activeFont ?? 0,
        name: font?.name,
        preview: font ? <FontLocalPreview itemId={font.itemId} /> : undefined,
      },
      {
        kind: 'widget',
        label: '头像挂件',
        value: manifest?.activeWidget ?? 0,
        name: widget?.name,
        imageSrc: widget ? dressPendantFrameUrl(widget.itemId, 1) : '',
      },
      {
        kind: 'callbg',
        label: '通话背景',
        value: state.data?.own.callBgId ?? 0,
        name: state.data?.own.callBgName,
        imageSrc: dressUrl(state.data?.own.callBgUrl ?? ''),
      },
      {
        kind: 'background',
        label: '聊天背景',
        value: hasBackground ? (manifest?.background ?? '') : '',
        name:
          manifest?.background === 'qq'
            ? 'QQ 同款'
            : backdrop.videoUrl
              ? '自定义视频'
              : '自定义图片',
        preview: <ChatBackdrop {...backdrop} widgetId="" />,
      },
      {
        kind: 'screen',
        label: '浮屏挂件',
        value: backdrop.widgetId,
        preview: <ChatBackdrop {...backdrop} imageUrl="" videoUrl="" />,
      },
    ];
    function chooseCurrent(target: CurrentKind) {
      if (target === 'background' || target === 'screen') {
        backgroundTarget.current = target;
        setKind('background');
      } else setKind(target);
    }

    function clearCurrent(target: CurrentKind) {
      if (target === 'background') void chooseBackground('none');
      else if (target === 'screen') void chooseWidget('');
      else void clear(target);
    }

    return (
      <div className="weq-dress-usage">
        <section aria-labelledby="weq-dress-current-title">
          <h3 id="weq-dress-current-title">使用中的装扮</h3>
          <div className="weq-dress-current-list">
            {current.map((item) => (
              <div className="weq-dress-current" key={item.kind}>
                <DressCardPreview
                  slotKey={`current:${item.kind}`}
                  imageSrc={item.value ? (item.imageSrc ?? '') : ''}
                  alt={item.name || item.label}
                >
                  {item.value ? (
                    item.preview
                  ) : (
                    <span className="weq-dress-current-empty" aria-hidden>
                      {item.kind === 'screen' ? (
                        <Sparkles size={14} />
                      ) : (
                        KINDS.find((entry) => entry.id === item.kind)?.icon
                      )}
                    </span>
                  )}
                </DressCardPreview>
                <div className="weq-dress-current-info">
                  <span>{item.label}</span>
                  <strong>
                    {item.value
                      ? item.name || (
                          <>
                            {item.label}{' '}
                            <span className="weq-number weq-number-inherit">{item.value}</span>
                          </>
                        )
                      : '未使用'}
                  </strong>
                  {!item.value &&
                  (item.kind === 'bubble' || item.kind === 'font' || item.kind === 'widget') ? (
                    <small>按消息记录还原</small>
                  ) : null}
                </div>
                <div className="weq-dress-current-actions">
                  {item.value ? (
                    <button
                      type="button"
                      className="weq-dress-current-action"
                      disabled={applying}
                      title={`取消使用${item.label}`}
                      aria-label={`取消使用${item.label}`}
                      onClick={() => clearCurrent(item.kind)}
                    >
                      <X size={16} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="weq-dress-current-action"
                    disabled={applying}
                    title={`选择${item.label}`}
                    aria-label={`选择${item.label}`}
                    onClick={() => chooseCurrent(item.kind)}
                  >
                    <ChevronRight size={18} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
        {hasBackground || backdrop.widgetId ? (
          <section className="weq-dress-usage-opacity" aria-labelledby="weq-dress-opacity-title">
            <h3 id="weq-dress-opacity-title">不透明度</h3>
            {renderOpacity('background', true)}
            {renderOpacity('widget', true)}
          </section>
        ) : null}
        <section className="weq-dress-usage-scope" aria-labelledby="weq-dress-scope-title">
          <h3 id="weq-dress-scope-title">渲染范围</h3>
          <div className="weq-dress-scope" role="radiogroup" aria-label="装扮渲染范围">
            {SCOPES.map((option) => (
              <label
                key={option.id}
                className={`weq-dress-scope-btn${scope === option.id ? ' is-active' : ''}`}
                title={option.hint}
              >
                <input
                  type="radio"
                  name="dress-scope"
                  value={option.id}
                  checked={scope === option.id}
                  disabled={applying || !manifest}
                  onChange={() => void changeScope(option.id)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
          <p className="weq-dress-local-note">“使用”仅影响 WeQ 本地显示，不影响实际发送。</p>
        </section>
      </div>
    );
  }

  /** 聊天背景 + 浮屏挂件。与商城那两栏形状完全不同,所以单独一套 UI。 */
  function renderBackground(): ReactElement {
    const source = manifest?.background ?? 'none';
    const qqUrl = state.data?.own.chatBgUrl ?? '';
    const hasCustom = Boolean(manifest?.backgroundFile);
    const customPreview = manifest?.backgroundFile
      ? dressBackgroundUrl(manifest.backgroundFile)
      : '';
    // 自定义背景可能是本地视频 —— 预览格得用 <video> 而不是 <img>(见 isVideoBackground)。
    const customIsVideo = isVideoBackground(manifest?.backgroundFile ?? '');

    const options: Array<{
      id: DressBackgroundSource;
      label: string;
      hint: string;
      preview: string;
      /** preview 是视频,预览格用 `<video>` 播。 */
      video?: boolean;
      disabled: boolean;
    }> = [
      { id: 'none', label: '不使用', hint: '沿用主题配色', preview: '', disabled: false },
      {
        id: 'qq',
        label: 'QQ 同款',
        hint: qqUrl ? '你在手机 QQ 里设置的那张' : '这个账号在 QQ 里没有设置聊天背景',
        preview: dressUrl(qqUrl),
        disabled: !qqUrl,
      },
      {
        id: 'custom',
        label: '自定义',
        hint: hasCustom
          ? customIsVideo
            ? '你选的本地视频'
            : '你选的本地图片'
          : '还没有选择图片或视频',
        preview: customPreview,
        video: customIsVideo,
        disabled: !hasCustom,
      },
    ];

    return (
      <div className="weq-dress-bg">
        <section
          ref={backgroundSection}
          className="weq-dress-bg-section"
          tabIndex={-1}
          aria-labelledby="weq-dress-bg-title"
        >
          <div className="weq-dress-bg-head">
            <h3 id="weq-dress-bg-title">背景图 / 视频</h3>
          </div>
          <div className="weq-dress-bg-row">
            {options.map((o) => (
              <div
                key={o.id}
                className={`weq-dress-bg-card${source === o.id ? ' is-active' : ''}`}
                data-unavailable={o.id === 'qq' && o.disabled}
              >
                <button
                  type="button"
                  className="weq-dress-bg-select"
                  aria-label={o.label}
                  aria-pressed={source === o.id}
                  disabled={o.disabled}
                  title={o.hint}
                  onClick={() => void chooseBackground(o.id)}
                />
                <div className="weq-dress-bg-preview weq-media-frame">
                  {o.preview ? (
                    o.video ? (
                      // muted + autoPlay + loop:预览与聊天里看到的都是循环播放的效果,
                      // 否则视频背景在选之前只是个静止的第一帧。
                      <video src={o.preview} autoPlay loop muted playsInline preload="metadata" />
                    ) : (
                      <ShimmerImage src={o.preview} alt={o.label} loading="lazy" />
                    )
                  ) : o.id !== 'custom' ? (
                    <span className="weq-dress-bg-none">{o.id === 'none' ? '无' : '未设置'}</span>
                  ) : null}
                  {o.id === 'custom' ? (
                    <button
                      type="button"
                      className="weq-set-btn weq-set-btn-sm weq-dress-pick"
                      aria-label={hasCustom ? '更换背景图片或视频' : '选择背景图片或视频'}
                      onClick={() => void chooseCustomFile()}
                    >
                      <Upload size={13} aria-hidden />
                      {hasCustom ? '更换' : '选择'}
                    </button>
                  ) : null}
                  {source === o.id ? (
                    <span className="weq-dress-bg-check">
                      <Check size={13} strokeWidth={2.5} />
                    </span>
                  ) : null}
                </div>
                <strong>{o.label}</strong>
                <small>{o.hint}</small>
              </div>
            ))}
          </div>

          {renderOpacity('background')}
        </section>

        <section
          ref={widgetSection}
          className="weq-dress-bg-section"
          tabIndex={-1}
          aria-labelledby="weq-dress-widget-title"
        >
          <div className="weq-dress-bg-head">
            <h3 id="weq-dress-widget-title">浮屏挂件</h3>
            <span className="weq-dress-bg-note">叠在背景上循环播放的动画，再点一次取消</span>
          </div>
          <div className="weq-dress-widget-grid">
            {(widgets.data ?? []).map((w) => (
              <button
                key={w.id}
                type="button"
                className={`weq-dress-widget${manifest?.widgetId === w.id ? ' is-active' : ''}`}
                // 再点一次当前这款 = 取消。没有单独的「无」格,这是取消挂件的唯一入口,
                // 所以选中态的 title 必须把它说出来(标题栏那句也提了一遍)。
                onClick={() => void chooseWidget(manifest?.widgetId === w.id ? '' : w.id)}
                title={manifest?.widgetId === w.id ? '正在使用 —— 再点一次取消' : `挂件 ${w.id}`}
              >
                {/* 预览跑真 lottie,与聊天背景是同一个组件 —— 拿包里第一张图当封面
                    往往只是某一帧的碎片,选之前和选之后看到的会对不上。 */}
                <ScreenWidget widgetId={w.id} className="weq-dress-widget-anim" />
                <span className="weq-dress-widget-id">{w.id}</span>
              </button>
            ))}
          </div>
          {renderOpacity('widget')}
        </section>
      </div>
    );
  }

  function renderList(): ReactElement {
    if (kind === 'usage') return renderUsage();
    if (kind === 'background') return renderBackground();

    if (mineOnly) {
      if (installedItems.length === 0) {
        return (
          <div className="weq-dress-empty">
            <Sparkles size={26} />
            <p>{keyword ? '没有匹配的已装装扮' : '还没有装扮'}</p>
            {!keyword ? <span>可在「热门」挑选装扮</span> : null}
          </div>
        );
      }
      return (
        <div className="weq-dress-grid">
          {installedItems.map((m) => {
            // 「已装」里没有商城预览图的款(旧版 40801 自动装遗留的)—— 预览直接画
            // 气泡 / 字体本体:气泡优先本地持久化 PNG,字体走本地 ttf 排样例文字。
            const localPreview =
              mallKind === 'bubble' ? (
                (() => {
                  // local-only:能进清单的款本地九宫格必在,直接把气泡本体画出来当预览
                  // —— 底图与 chat 渲染同源,不另猜预览图。
                  const skin = manifest?.bubbles.find((b) => b.itemId === m.itemId);
                  return m.installed && skin && !skin.previewUrl ? (
                    <BubbleLocalPreview itemId={m.itemId} />
                  ) : undefined;
                })()
              ) : m.installed &&
                !m.previewUrl &&
                manifest?.fonts.some((f) => f.itemId === m.itemId) ? (
                <FontLocalPreview itemId={m.itemId} />
              ) : undefined;
            return renderCard(
              {
                appId: mallKind === 'bubble' ? 2 : mallKind === 'font' ? 5 : 4,
                itemId: m.itemId,
                name: m.name,
                // 原样带上 —— use() 会把这两个字段写进清单,置空的话装完又会退回
                // 「气泡 <id>」+ 空预览(「QQ 正在用的那款」点使用时正好走这条)。
                previewUrl: m.previewUrl,
                previewLargeUrl: m.previewLargeUrl,
                videoUrl: m.videoUrl,
                labels: m.installed ? [] : ['QQ 同款'],
                price: 0,
                mallName: '',
              },
              // 存的是 CDN 裸链,进 <img> 前得跟商城列表一样过 weq-media://dress 代理。
              m.previewUrl ? dressUrl(m.previewUrl) : '',
              // 占位名只用于显示,不落盘(空串 → 清单里没有 name → 列表退回「气泡 <id>」,
              // 那是可恢复的;存了假名字反而永远洗不掉)。
              m.placeholderName ? '' : m.name,
              localPreview,
            );
          })}
        </div>
      );
    }

    // 搜索没在线就根本不会发请求 —— 必须先讲清原因,否则会停在「加载中」不动
    // (react-query 的 disabled query 一直是 pending,不是 loading 结束)。
    if (searching && !online) {
      return (
        <div className="weq-dress-empty is-warn">
          <WifiOff size={26} />
          <p>搜索需要登录 QQ 客户端</p>
          <span>登录 QQ 后可搜索商城装扮，也可以清空关键词浏览热门目录。</span>
        </div>
      );
    }

    // 用 isInitialLoading 而不是 isLoading:react-query v4 里 disabled 的 query 也是
    // isLoading=true,拿它判断会永远停在「加载中」。首屏等待期用与卡片同构的骨架屏
    // 占位,免得排行榜 / 搜索结果出来时整页从「转圈」跳到「卡片」跳版。
    if (catalog.isInitialLoading) {
      return <DressListSkeleton />;
    }
    if (catalog.error) {
      return (
        <div className="weq-dress-empty is-error">
          <WifiOff size={26} />
          <p>{catalog.error.message}</p>
        </div>
      );
    }
    if (catalogItems.length === 0) {
      return (
        <div className="weq-dress-empty">
          <Sparkles size={26} />
          <p>{searching ? '没有匹配的装扮' : '没有结果'}</p>
        </div>
      );
    }
    return (
      <div className="weq-dress-grid">
        {catalogItems.map((it) => renderCard(it, dressUrl(it.previewLargeUrl || it.previewUrl)))}
      </div>
    );
  }

  return (
    <WorkspacePage title="个性装扮" onClose={onClose} standalone mobileChrome={mobile}>
      {download.prompt}
      <div className="weq-dress-dialog" role="region" aria-labelledby="weq-dress-title">
        <header className="weq-dress-head">
          <div className="weq-dress-title-row">
            <Palette size={18} strokeWidth={1.9} />
            <h2 id="weq-dress-title">个性装扮</h2>
          </div>

          <div className="weq-dress-kinds" role="tablist" aria-label="装扮类别">
            {KINDS.filter((k) => developmentDressTools || k.id === 'background').map((k) => (
              <button
                key={k.id}
                type="button"
                role="tab"
                id={`weq-dress-tab-${k.id}`}
                aria-controls="weq-dress-panel"
                aria-selected={kind === k.id}
                className={`weq-dress-kind${kind === k.id ? ' is-active' : ''}`}
                onClick={() => setKind(k.id)}
              >
                {k.icon}
                {k.label}
              </button>
            ))}
          </div>
        </header>

        <div
          id="weq-dress-panel"
          role="tabpanel"
          aria-labelledby={`weq-dress-tab-${kind}`}
          className="weq-dress-panel"
          {...(isMall ? multi.rootProps : {})}
        >
          {state.error && (isMall || kind === 'usage' || kind === 'background') ? (
            <div className="weq-dress-notice is-bad">
              <WifiOff size={14} />
              <span>读取装扮状态失败：{state.error.message}</span>
            </div>
          ) : null}
          {isMall ? (
            <div className="weq-dress-toolbar">
              <div className="weq-dress-toolbar-leading" role="group" aria-label="装扮列表">
                <button
                  type="button"
                  className={`weq-dress-chip${!mineOnly && !searching ? ' is-active' : ''}`}
                  aria-pressed={!mineOnly && !searching}
                  onClick={() => updateMallBrowse(DEFAULT_MALL_BROWSE)}
                >
                  热门
                </button>
                <button
                  type="button"
                  className={`weq-dress-chip${mineOnly ? ' is-active' : ''}`}
                  aria-pressed={mineOnly}
                  onClick={() => {
                    if (!mineOnly) updateMallBrowse({ ...DEFAULT_MALL_BROWSE, view: 'installed' });
                  }}
                >
                  已装
                  <span className="weq-dress-chip-n weq-number weq-number-inherit">
                    {mine.length}
                  </span>
                </button>
              </div>
              <div className="weq-dress-toolbar-controls">
                <DirectoryToolbar
                  searchEnabled={false}
                  noun="装扮"
                  query=""
                  onQuery={() => {}}
                  selecting={selecting}
                  onSelecting={setSelectionMode}
                  count={selectedDownloads.length}
                  allSelected={allSelected}
                  onSelectAll={() => setSelectedIds(new Set(allSelected ? [] : downloadIds))}
                />
                <DressSearchForm
                  label={mineOnly ? '搜索已装装扮' : '搜索装扮'}
                  value={draft}
                  onChange={(value) => updateMallBrowse({ draft: value })}
                  onSearch={(value) => updateMallBrowse({ keyword: value })}
                  disabled={!mineOnly && !online}
                  maxLength={50}
                />
              </div>
              {selecting ? (
                <button
                  type="button"
                  className="weq-set-btn weq-set-btn-primary weq-dress-download-selection"
                  disabled={download.disabled || applying || !selectedDownloads.length}
                  onClick={async () => {
                    if (await download.run(mallKind, selectedDownloads, 'selection'))
                      setSelectedIds((current) => (current === selectedIds ? new Set() : current));
                  }}
                >
                  {download.savingKey === 'selection' ? (
                    <Loader2 size={14} className="weq-dress-spin" aria-hidden />
                  ) : (
                    <Download size={14} aria-hidden />
                  )}
                  下载选中
                </button>
              ) : null}
            </div>
          ) : null}
          {isMall && !mineOnly && !searching && !state.error ? (
            <div className="weq-dress-notice is-info">
              <Trophy size={14} aria-hidden />
              <span>
                {mallKind === 'callbg'
                  ? '这里展示热门通话背景。'
                  : rank.data?.source === 'static'
                    ? '这里展示本地收录的热门装扮。'
                    : '这里展示当前热门装扮。'}
                {online
                  ? '想找其他款式，可以按名称搜索。'
                  : !state.isInitialLoading
                    ? '登录 QQ 后可按名称搜索商城。'
                    : ''}
              </span>
            </div>
          ) : null}

          {kind === 'redpack' ? (
            <RedPackSkinWall />
          ) : kind === 'emoji' ? (
            <MarketEmojiBrowserLightbox
              embedded
              embeddedSearch={{
                keyword: emojiKeyword,
                form: (
                  <DressSearchForm
                    label="搜索表情包"
                    value={emojiDraft}
                    onChange={setEmojiDraft}
                    onSearch={setEmojiKeyword}
                  />
                ),
              }}
              initialPackId={initialEmojiPackId}
              initialPackName={initialEmojiPackName}
            />
          ) : (
            <PageScrollSnapshot key={listScope} snapshotKey={listScope} className="weq-dress-body">
              {renderList()}
            </PageScrollSnapshot>
          )}
        </div>

        {/* 换装期间盖住整个对话框:样式注入会重排下面的消息列表,期间点别的只会
            叠加更多重排。用 aria-live 让读屏也能知道正在应用。 */}
        {applying ? (
          <div className="weq-dress-applying" role="status" aria-live="polite">
            <div className="weq-dress-applying-box">
              <Loader2 size={22} className="weq-dress-spin" />
              <span>正在应用装扮…</span>
            </div>
          </div>
        ) : null}
      </div>
    </WorkspacePage>
  );
}
