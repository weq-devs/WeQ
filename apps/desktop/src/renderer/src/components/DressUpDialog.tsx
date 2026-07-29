/**
 * 个性装扮 —— 灯箱(与收藏 / 商城表情同一层级,不占左栏视图位)。
 *
 * 布局是「一栏到底」:头部一行放类别切换 + 搜索框 + 作用范围开关,下面直接是卡片
 * 网格。搜索**不单独分页** —— 输入即过滤当前列表来源:有关键词时打商城搜索接口,清空
 * 关键词就回到排行榜。这样用户不必在「排行/搜索/我的」之间跳来跳去。
 *
 * 三栏里前两栏(气泡 / 字体)走商城,第三栏(聊天背景 + 浮屏挂件)完全是本地的,
 * 所以搜索框、「已装」筛子、渲染范围那几个控件在它上面都会隐藏 —— 留着禁用的控件
 * 只会让人以为坏了。
 *
 * 在线要求分三档,UI 必须把差异讲清楚,否则用户会以为是坏了:
 *  - **浏览排行**:离线可用(仓库里存了一份静态排行,见 dressup 路由)。
 *  - **装气泡**:离线可用 —— 商城条目自带 material,不需要凭证。
 *  - **搜索 / 装字体**:必须有在线 QQ 实例(字体要发手Q 独有的包换下载链)。
 *
 * 背景与挂件一律离线可用(QQ 同款的直链 bootstrap 时已存进 config,挂件是 bundle 的)。
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  Search,
  Loader2,
  Check,
  Download,
  Sparkles,
  WifiOff,
  Palette,
  Type,
  Image as ImageIcon,
  Upload,
  Trophy,
  X,
} from 'lucide-react';
import type { BubbleSkin, DressBackgroundSource, DressMallItem, DressScope } from '@weq/service';
import { trpc } from '../trpc/client';
import { useAppDialog } from '../lib/dialogUtils';
import { dressBackgroundUrl, dressUrl } from '../lib/resourceUrl';
import { syncDressSkin, syncDressSkinPreloaded } from '../hooks/useDressSkin';
import { BACKDROP_VEIL_VAR, backdropVeil, ScreenWidget } from './ChatBackdrop';
import { closeFromScrim, useEscapeToClose } from '../im-template/template/modalUtils';
import '../styles/dressup.css';

type DressKind = 'bubble' | 'font' | 'background';

const KINDS: Array<{ id: DressKind; label: string; icon: ReactElement }> = [
  { id: 'bubble', label: '聊天气泡', icon: <Palette size={14} /> },
  { id: 'font', label: '聊天字体', icon: <Type size={14} /> },
  { id: 'background', label: '聊天背景', icon: <ImageIcon size={14} /> },
];

/** 商城那两类共用一套列表 UI;背景是另一套形状,单列出来判。 */
type MallKind = 'bubble' | 'font';

const SCOPES: Array<{ id: DressScope; label: string; hint: string }> = [
  { id: 'mine', label: '仅自己', hint: '只渲染我发出的消息(与手机 QQ 一致)' },
  { id: 'all', label: '所有人', hint: '连对方的消息也套上我的气泡和字体' },
];

export function DressUpDialog({ onClose }: { onClose: () => void }): ReactElement {
  const dialog = useAppDialog();
  const utils = trpc.useUtils();
  useEscapeToClose(onClose);

  const [kind, setKind] = useState<DressKind>('bubble');
  /** 输入框里的草稿。提交(回车 / 失焦)后才变成 keyword,避免每敲一个字打一次接口。 */
  const [draft, setDraft] = useState('');
  const [keyword, setKeyword] = useState('');
  /** 只看已装的那些 —— 与「搜索」并列的一个筛子,不是独立分页。 */
  const [mineOnly, setMineOnly] = useState(false);
  /** 正在装的 itemId —— 按钮显示转圈,避免重复点击。 */
  const [busyId, setBusyId] = useState(0);
  /** 「取消当前装扮」/「切换范围」进行中 —— 同样会重排聊天列表,也要盖加载态。 */
  const [clearing, setClearing] = useState(false);
  const [scoping, setScoping] = useState(false);
  /** 清晰度滑块的本地值。拖动时实时预览,松手才落盘(见 commitOpacity)。 */
  const [opacityDraft, setOpacityDraft] = useState(1);

  const state = trpc.account.dressup.getState.useQuery();
  const online = state.data?.qqOnline ?? false;
  const manifest = state.data?.manifest;
  const scope = manifest?.scope ?? 'mine';

  // 背景那栏不走商城,列表 query 一律停掉;下面两处的 kind 因此可以安全窄化。
  const mallKind: MallKind = kind === 'font' ? 'font' : 'bubble';
  const isMall = kind !== 'background';

  // 关键词为空 → 排行榜;有关键词 → 搜索。两条 query 互斥启用。
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

  // 清单里的清晰度是权威值,同步进滑块(切账号 / 外部改动都跟得上)。
  const savedOpacity = manifest?.backgroundOpacity;
  useEffect(() => {
    if (savedOpacity !== undefined) setOpacityDraft(savedOpacity);
  }, [savedOpacity]);

  // 拖动时直接改 CSS 变量做实时预览 —— 不走 tRPC,所以不会每帧写一次文件。
  useEffect(() => {
    for (const el of document.querySelectorAll<HTMLElement>('.weq-chat-backdrop')) {
      el.style.setProperty(BACKDROP_VEIL_VAR, backdropVeil(opacityDraft));
    }
  }, [opacityDraft]);

  const installBubble = trpc.account.dressup.installBubble.useMutation();
  const installFont = trpc.account.dressup.installFont.useMutation();
  const setActive = trpc.account.dressup.setActive.useMutation();
  const setScope = trpc.account.dressup.setScope.useMutation();
  const pickBackground = trpc.account.dressup.pickBackground.useMutation();
  const setBackground = trpc.account.dressup.setBackground.useMutation();
  const setWidget = trpc.account.dressup.setWidget.useMutation();
  const setBackgroundOpacity = trpc.account.dressup.setBackgroundOpacity.useMutation();

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
    async (item: DressMallItem): Promise<void> => {
      setBusyId(item.itemId);
      try {
        if (mallKind === 'bubble') {
          // material 原样回传 —— 外链推不出来,后端靠它零探测装上(见 dressup 路由)。
          // name/previewUrl 同理:装完只剩 itemId,商城没有按 id 查详情的接口。
          await installBubble.mutateAsync({
            itemId: item.itemId,
            material: item.material,
            name: item.name,
            previewUrl: item.previewLargeUrl || item.previewUrl,
          });
        } else {
          await installFont.mutateAsync({
            itemId: item.itemId,
            name: item.name,
            previewUrl: item.previewLargeUrl || item.previewUrl,
          });
        }
        const manifest = await setActive.mutateAsync({ kind: mallKind, itemId: item.itemId });
        // setActive 回的就是新清单,直接拿它注入,不必等 refetch 往返。
        await syncDressSkinPreloaded(manifest);
        await refresh();
      } catch (e) {
        dialog.error('装扮失败', e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(0);
      }
    },
    [mallKind, installBubble, installFont, setActive, refresh, dialog],
  );

  /** 取消当前生效的装扮,回到默认外观。 */
  const clear = useCallback(async (): Promise<void> => {
    setClearing(true);
    try {
      const manifest = await setActive.mutateAsync({ kind: mallKind, itemId: 0 });
      await syncDressSkinPreloaded(manifest);
      await refresh();
    } catch (e) {
      dialog.error('取消失败', e instanceof Error ? e.message : String(e));
    } finally {
      setClearing(false);
    }
  }, [mallKind, setActive, refresh, dialog]);

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
      await pickBackground.mutateAsync();
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

  /** 松手才落盘 —— 拖动过程中的实时预览由 previewBackdropOpacity 直接改 CSS 变量。 */
  const commitOpacity = useCallback(
    async (value: number): Promise<void> => {
      try {
        await setBackgroundOpacity.mutateAsync({ opacity: value });
        await refresh();
      } catch (e) {
        dialog.error('调整清晰度失败', e instanceof Error ? e.message : String(e));
      }
    },
    [setBackgroundOpacity, refresh, dialog],
  );

  /** 任何一种会改动聊天外观的操作正在进行 —— 驱动整个对话框的遮罩。 */
  const applying = busyId !== 0 || clearing || scoping;

  const activeId =
    mallKind === 'bubble' ? (manifest?.activeBubble ?? 0) : (manifest?.activeFont ?? 0);

  /**
   * 「已装」列表 —— 清单里的 + 自己在 QQ 里正在用的那款。
   *
   * 自己那款是 bootstrap 时从 getSelfDress 存下的(零额外请求),可能还没装过,
   * 这里也列出来让用户一键装上,这样 WeQ 的观感能和手机 QQ 对上。
   */
  const mine = useMemo((): Array<{
    itemId: number;
    name: string;
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
    const installed =
      mallKind === 'bubble'
        ? manifest.bubbles.map((b: BubbleSkin) => ({
            itemId: b.itemId,
            name: b.name || `气泡 ${b.itemId}`,
            installed: true,
            previewUrl: b.previewUrl ?? '',
          }))
        : manifest.fonts.map((f) => ({
            itemId: f.itemId,
            name: f.name || `字体 ${f.itemId}`,
            installed: true,
            previewUrl: f.previewUrl ?? '',
          }));

    const ownId =
      mallKind === 'bubble' ? (state.data?.own.bubbleId ?? 0) : (state.data?.own.fontId ?? 0);
    if (ownId && !installed.some((i) => i.itemId === ownId)) {
      // 只有 itemId,外链推不出来(新款目录段是服务端 nonce),所以没有预览图;
      // 点「使用」时后端走 protocol 换取,那条要在线实例。
      installed.unshift({
        itemId: ownId,
        name: `QQ 正在用的${mallKind === 'bubble' ? '气泡' : '字体'}`,
        installed: false,
        previewUrl: '',
      });
    }
    return installed;
  }, [manifest, mallKind, state.data]);

  /**
   * @param previewSrc 已经解析好的预览图 src(可直接进 `<img>`)。空串 = 无预览。
   *                   由调用方给,因为商城条目要经 `weq-media://dress` 代理,而走
   *                   protocol 装的气泡要经 `weq-media://dressbubble`。
   */
  function renderCard(item: DressMallItem, previewSrc: string): ReactElement {
    const isActive = item.itemId === activeId;
    const busy = busyId === item.itemId;
    // 离线时:字体一律装不了;气泡只有在自带 material 时能装(外链推不出来,没 material
    // 就得走 protocol 换取,那需要在线实例)。
    const blocked = !online && (kind === 'font' || !item.material);
    const blockedHint =
      kind === 'font'
        ? '下载字体需要登录该账号的 QQ 客户端'
        : '这款气泡需要登录该账号的 QQ 客户端才能获取资源地址';
    return (
      <div key={item.itemId} className={`weq-dress-card${isActive ? ' is-active' : ''}`}>
        <div className="weq-dress-card-preview">
          {previewSrc ? (
            <img src={previewSrc} alt={item.name} loading="lazy" />
          ) : (
            <div className="weq-dress-card-noimg">无预览</div>
          )}
          {item.animated ? <span className="weq-dress-badge">动效</span> : null}
        </div>
        <div className="weq-dress-card-body">
          <strong title={item.name}>{item.name}</strong>
          <small>{item.labels.slice(0, 2).join(' · ') || item.mallName || `#${item.itemId}`}</small>
        </div>
        <button
          type="button"
          className="weq-dress-use"
          disabled={busy || isActive || blocked || applying}
          title={blocked ? blockedHint : undefined}
          onClick={() => void use(item)}
        >
          {busy ? (
            <Loader2 size={14} className="weq-dress-spin" />
          ) : isActive ? (
            <Check size={14} />
          ) : (
            <Download size={14} />
          )}
          <span>{isActive ? '使用中' : busy ? '装扮中' : '使用'}</span>
        </button>
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

    const options: Array<{
      id: DressBackgroundSource;
      label: string;
      hint: string;
      preview: string;
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
        hint: hasCustom ? '你选的本地图片' : '还没有选择图片',
        preview: customPreview,
        disabled: !hasCustom,
      },
    ];

    return (
      <div className="weq-dress-bg">
        <section className="weq-dress-bg-section">
          <div className="weq-dress-bg-head">
            <h3>背景图</h3>
            <button
              type="button"
              className="weq-dress-pick"
              onClick={() => void chooseCustomFile()}
            >
              <Upload size={13} />
              {hasCustom ? '重新选图' : '选择图片…'}
            </button>
          </div>
          <div className="weq-dress-bg-row">
            {options.map((o) => (
              <button
                key={o.id}
                type="button"
                className={`weq-dress-bg-card${source === o.id ? ' is-active' : ''}`}
                disabled={o.disabled}
                title={o.hint}
                onClick={() => void chooseBackground(o.id)}
              >
                <div className="weq-dress-bg-preview">
                  {o.preview ? (
                    <img src={o.preview} alt={o.label} loading="lazy" />
                  ) : (
                    <span className="weq-dress-bg-none">{o.id === 'none' ? '无' : '未设置'}</span>
                  )}
                  {source === o.id ? (
                    <span className="weq-dress-bg-check">
                      <Check size={13} strokeWidth={2.5} />
                    </span>
                  ) : null}
                </div>
                <strong>{o.label}</strong>
                <small>{o.hint}</small>
              </button>
            ))}
          </div>

          {/* 背景默认压了一层磨砂,这条调它的厚度 —— 拖到最右接近原图。
              没有背景时这个控件没有意义,所以只在有背景时出现。 */}
          {source !== 'none' ? (
            <label className="weq-dress-opacity">
              <span>清晰度</span>
              <input
                type="range"
                min={0.05}
                max={1}
                step={0.05}
                value={opacityDraft}
                onChange={(e) => setOpacityDraft(Number(e.target.value))}
                // 拖动过程只改本地值(实时预览),松手才落盘 —— 否则每一帧都写一次文件。
                onPointerUp={(e) => void commitOpacity(Number(e.currentTarget.value))}
                onKeyUp={(e) => void commitOpacity(Number(e.currentTarget.value))}
              />
              <em>{Math.round(opacityDraft * 100)}%</em>
            </label>
          ) : null}
        </section>

        <section className="weq-dress-bg-section">
          <div className="weq-dress-bg-head">
            <h3>浮屏挂件</h3>
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
        </section>
      </div>
    );
  }

  function renderList(): ReactElement {
    if (kind === 'background') return renderBackground();

    if (mineOnly) {
      if (mine.length === 0) {
        return (
          <div className="weq-dress-empty">
            <Sparkles size={26} />
            <p>还没有装扮</p>
            <span>取消「已装」筛选去挑一款,或直接搜索名字</span>
          </div>
        );
      }
      return (
        <div className="weq-dress-grid">
          {mine.map((m) =>
            renderCard(
              {
                appId: mallKind === 'bubble' ? 2 : 5,
                itemId: m.itemId,
                name: m.name,
                previewUrl: '',
                previewLargeUrl: '',
                labels: m.installed ? [] : ['QQ 同款'],
                price: 0,
                mallName: '',
                animated: false,
                color: '',
                // 清单里没有 material(只有解析后的结果),未装的那款靠后端 protocol 兜底。
                material: null,
              },
              // 存的是 CDN 裸链,进 <img> 前得跟商城列表一样过 weq-media://dress 代理。
              m.previewUrl ? dressUrl(m.previewUrl) : '',
            ),
          )}
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
          <span>商城搜索要用在线实例取凭证。清空关键词可离线浏览排行榜。</span>
        </div>
      );
    }

    const query = searching ? search : rank;
    // 用 isInitialLoading 而不是 isLoading:react-query v4 里 disabled 的 query 也是
    // isLoading=true,拿它判断会永远停在「加载中」。
    if (query.isInitialLoading) {
      return (
        <div className="weq-dress-empty">
          <Loader2 size={26} className="weq-dress-spin" />
          <p>加载中…</p>
        </div>
      );
    }
    if (query.error) {
      return (
        <div className="weq-dress-empty is-error">
          <WifiOff size={26} />
          <p>{query.error.message}</p>
        </div>
      );
    }
    const items = searching ? (search.data?.items ?? []) : (rank.data?.items ?? []);
    if (items.length === 0) {
      return (
        <div className="weq-dress-empty">
          <Sparkles size={26} />
          <p>{searching ? '没有匹配的装扮' : '没有结果'}</p>
        </div>
      );
    }
    return (
      <div className="weq-dress-grid">
        {items.map((it) => renderCard(it, dressUrl(it.previewLargeUrl || it.previewUrl)))}
      </div>
    );
  }

  return (
    <div className="weq-dress-layer" role="presentation" onMouseDown={closeFromScrim(onClose)}>
      <div
        className="weq-dress-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="weq-dress-title"
      >
        <button className="weq-dress-close" onClick={onClose} title="关闭" type="button">
          <X size={18} strokeWidth={2} />
        </button>

        <header className="weq-dress-head">
          <div className="weq-dress-title-row">
            <Palette size={18} strokeWidth={1.9} />
            <h2 id="weq-dress-title">个性装扮</h2>
          </div>

          <div className="weq-dress-kinds" role="tablist" aria-label="装扮类别">
            {KINDS.map((k) => (
              <button
                key={k.id}
                type="button"
                role="tab"
                aria-selected={kind === k.id}
                className={`weq-dress-kind${kind === k.id ? ' is-active' : ''}`}
                onClick={() => setKind(k.id)}
              >
                {k.icon}
                {k.label}
              </button>
            ))}
          </div>

          {/* 背景不走商城,搜索框对它没有意义 —— 留一个禁用的输入框只会让人以为坏了。 */}
          {isMall ? (
            <form
              className="weq-dress-search"
              onSubmit={(e) => {
                e.preventDefault();
                const next = draft.trim();
                if (next && !online) {
                  dialog.error('需要在线 QQ', '装扮商城搜索需要登录该账号的 QQ 客户端以获取凭证。');
                  return;
                }
                setMineOnly(false);
                setKeyword(next);
              }}
            >
              <Search size={15} strokeWidth={1.8} />
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={online ? '搜索装扮名,回车确认' : '搜索需要登录 QQ 客户端'}
                disabled={!online}
                spellCheck={false}
              />
              {draft ? (
                <button
                  type="button"
                  className="weq-dress-search-clear"
                  title="清空"
                  onClick={() => {
                    setDraft('');
                    setKeyword('');
                  }}
                >
                  <X size={13} strokeWidth={2} />
                </button>
              ) : null}
            </form>
          ) : null}
        </header>

        {isMall ? (
          <div className="weq-dress-toolbar">
            <button
              type="button"
              className={`weq-dress-chip${mineOnly ? ' is-active' : ''}`}
              onClick={() => setMineOnly((v) => !v)}
              title="只看已安装的装扮"
            >
              已装
              <span className="weq-dress-chip-n">{mine.length}</span>
            </button>
            {!mineOnly && !searching && rank.data?.source === 'static' ? (
              <span className="weq-dress-hint">离线目录</span>
            ) : null}

            <div className="weq-dress-toolbar-right">
              <span className="weq-dress-scope-label">渲染范围</span>
              <div className="weq-dress-scope" role="radiogroup" aria-label="装扮渲染范围">
                {SCOPES.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    role="radio"
                    aria-checked={scope === s.id}
                    className={`weq-dress-scope-btn${scope === s.id ? ' is-active' : ''}`}
                    title={s.hint}
                    disabled={applying}
                    onClick={() => void changeScope(s.id)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              {activeId ? (
                <button
                  type="button"
                  className="weq-dress-clear"
                  disabled={applying}
                  onClick={() => void clear()}
                >
                  取消当前{mallKind === 'bubble' ? '气泡' : '字体'}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {state.error ? (
          <div className="weq-dress-notice is-bad">
            <WifiOff size={14} />
            <span>读取装扮状态失败：{state.error.message}</span>
          </div>
        ) : isMall && !state.isInitialLoading && !online ? (
          <div className="weq-dress-notice">
            <WifiOff size={14} />
            <span>
              QQ 未在线：可浏览排行榜，商城里的气泡也能直接使用。搜索、字体下载、以及 「QQ
              正在用的那款」需要登录 QQ 客户端。
            </span>
          </div>
        ) : isMall && !mineOnly && !searching ? (
          // 排行榜只取第一页(pageSize=20,见 dress_mall),不翻页。不说明的话
          // 用户会以为商城就这 20 款。
          <div className="weq-dress-notice is-info">
            <Trophy size={14} />
            <span>以下是装扮排行榜前 20 名。并不包含完整列表，其他装扮可以尝试搜索。</span>
          </div>
        ) : null}

        <div className="weq-dress-body">{renderList()}</div>

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
    </div>
  );
}
