/**
 * 个性装扮 —— 灯箱(与收藏 / 商城表情同一层级,不占左栏视图位)。
 *
 * 布局是「一栏到底」:头部一行放 气泡/字体 切换 + 搜索框 + 作用范围开关,下面直接是卡片
 * 网格。搜索**不单独分页** —— 输入即过滤当前列表来源:有关键词时打商城搜索接口,清空
 * 关键词就回到排行榜。这样用户不必在「排行/搜索/我的」之间跳来跳去。
 *
 * 在线要求分三档,UI 必须把差异讲清楚,否则用户会以为是坏了:
 *  - **浏览排行**:离线可用(仓库里存了一份静态排行,见 dressup 路由)。
 *  - **装气泡**:离线可用 —— 商城条目自带 material,不需要凭证。
 *  - **搜索 / 装字体**:必须有在线 QQ 实例(字体要发手Q 独有的包换下载链)。
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
  X,
} from 'lucide-react';
import type { BubbleSkin, DressMallItem, DressScope } from '@weq/service';
import { trpc } from '../trpc/client';
import { useAppDialog } from '../lib/dialogUtils';
import { dressUrl, dressBubbleUrl } from '../lib/resourceUrl';
import { syncDressSkin } from '../hooks/useDressSkin';
import { closeFromScrim, useEscapeToClose } from '../im-template/template/modalUtils';
import '../styles/dressup.css';

type DressKind = 'bubble' | 'font';

const KINDS: Array<{ id: DressKind; label: string; icon: ReactElement }> = [
  { id: 'bubble', label: '聊天气泡', icon: <Palette size={14} /> },
  { id: 'font', label: '聊天字体', icon: <Type size={14} /> },
];

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

  const state = trpc.account.dressup.getState.useQuery();
  const online = state.data?.qqOnline ?? false;
  const manifest = state.data?.manifest;
  const scope = manifest?.scope ?? 'mine';

  // 关键词为空 → 排行榜;有关键词 → 搜索。两条 query 互斥启用。
  const searching = keyword.length > 0;
  const rank = trpc.account.dressup.rank.useQuery({ kind }, { enabled: !mineOnly && !searching });
  const search = trpc.account.dressup.search.useQuery(
    { kind, keyword },
    { enabled: !mineOnly && searching && online, retry: false },
  );

  // 清单变化(装了新的 / 切换生效 / 改范围)后重新注入样式。
  useEffect(() => {
    syncDressSkin(manifest);
  }, [manifest]);

  const installBubble = trpc.account.dressup.installBubble.useMutation();
  const installFont = trpc.account.dressup.installFont.useMutation();
  const setActive = trpc.account.dressup.setActive.useMutation();
  const setScope = trpc.account.dressup.setScope.useMutation();

  const refresh = useCallback(async (): Promise<void> => {
    await utils.account.dressup.getState.invalidate();
  }, [utils]);

  /** 装一款并立即生效 —— 用户点「使用」时期望的就是这个。 */
  const use = useCallback(
    async (item: DressMallItem): Promise<void> => {
      setBusyId(item.itemId);
      try {
        if (kind === 'bubble') {
          // material 原样回传 —— 外链推不出来,后端靠它零探测装上(见 dressup 路由)。
          await installBubble.mutateAsync({ itemId: item.itemId, material: item.material });
        } else {
          await installFont.mutateAsync({ itemId: item.itemId, name: item.name });
        }
        await setActive.mutateAsync({ kind, itemId: item.itemId });
        await refresh();
      } catch (e) {
        dialog.error('装扮失败', e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(0);
      }
    },
    [kind, installBubble, installFont, setActive, refresh, dialog],
  );

  /** 取消当前生效的装扮,回到默认外观。 */
  const clear = useCallback(async (): Promise<void> => {
    try {
      await setActive.mutateAsync({ kind, itemId: 0 });
      await refresh();
    } catch (e) {
      dialog.error('取消失败', e instanceof Error ? e.message : String(e));
    }
  }, [kind, setActive, refresh, dialog]);

  const changeScope = useCallback(
    async (next: DressScope): Promise<void> => {
      if (next === scope) return;
      try {
        await setScope.mutateAsync({ scope: next });
        await refresh();
      } catch (e) {
        dialog.error('切换范围失败', e instanceof Error ? e.message : String(e));
      }
    },
    [scope, setScope, refresh, dialog],
  );

  const activeId = kind === 'bubble' ? (manifest?.activeBubble ?? 0) : (manifest?.activeFont ?? 0);

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
    /** 已装气泡的预览图就是清单里存的九宫格底图;其余没有可用预览。 */
    previewUrl: string;
  }> => {
    if (!manifest) return [];
    const installed =
      kind === 'bubble'
        ? manifest.bubbles.map((b: BubbleSkin) => ({
            itemId: b.itemId,
            name: `气泡 ${b.itemId}`,
            installed: true,
            // 走 protocol 兜底装的没有 CDN 直链,预览要走本地那支。
            previewUrl: b.localFile ? dressBubbleUrl(b.itemId) : dressUrl(b.staticUrl),
          }))
        : manifest.fonts.map((f) => ({
            itemId: f.itemId,
            name: f.name || `字体 ${f.itemId}`,
            installed: true,
            previewUrl: '',
          }));

    const ownId =
      kind === 'bubble' ? (state.data?.own.bubbleId ?? 0) : (state.data?.own.fontId ?? 0);
    if (ownId && !installed.some((i) => i.itemId === ownId)) {
      // 只有 itemId,外链推不出来(新款目录段是服务端 nonce),所以没有预览图;
      // 点「使用」时后端走 protocol 换取,那条要在线实例。
      installed.unshift({
        itemId: ownId,
        name: `QQ 正在用的${kind === 'bubble' ? '气泡' : '字体'}`,
        installed: false,
        previewUrl: '',
      });
    }
    return installed;
  }, [manifest, kind, state.data]);

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
          disabled={busy || isActive || blocked}
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

  function renderList(): ReactElement {
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
                appId: kind === 'bubble' ? 2 : 5,
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
              m.previewUrl,
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
        </header>

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
                  onClick={() => void changeScope(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
            {activeId ? (
              <button type="button" className="weq-dress-clear" onClick={() => void clear()}>
                取消当前{kind === 'bubble' ? '气泡' : '字体'}
              </button>
            ) : null}
          </div>
        </div>

        {state.error ? (
          <div className="weq-dress-notice is-bad">
            <WifiOff size={14} />
            <span>读取装扮状态失败：{state.error.message}</span>
          </div>
        ) : !state.isInitialLoading && !online ? (
          <div className="weq-dress-notice">
            <WifiOff size={14} />
            <span>
              QQ 未在线：可浏览排行榜，商城里的气泡也能直接使用。搜索、字体下载、以及 「QQ
              正在用的那款」需要登录 QQ 客户端。
            </span>
          </div>
        ) : null}

        <div className="weq-dress-body">{renderList()}</div>
      </div>
    </div>
  );
}
