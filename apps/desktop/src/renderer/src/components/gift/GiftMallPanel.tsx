/**
 * 私聊礼物商城面板 —— 输入框工具栏「红包 / 礼物」菜单里的「礼物」。
 *
 * 一栏到底：头部是标题 + 搜索，下面分栏（全部 / 礼品卡 / 个性化装扮）和子栏
 * （最近上新 / 鲜花 / 玩偶摆件 …）。点一张礼物卡进详情，详情里写祝福、可匿名，点
 * 「赠送」才下**一单**。
 *
 * 关键取舍：
 *  - 礼物图一律经 `weq-media://gift` 由主进程代取落盘（见 media_protocol），渲染进程
 *    不直连 CDN，也不为它放开 CSP。
 *  - 卡片刻意做大（每张至少 206px 宽、预览 1:1），图片 `object-fit: contain` —— 礼物
 *    的形状五花八门，裁切会毁掉观感，密排会让它们糊成一团。
 *  - 需要支付时后端会抛错，这里把**原文**摊在详情里：WeQ 没有收银台，不能假装送出去了。
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  ArrowLeft,
  Check,
  CircleAlert,
  Coins,
  Gift as GiftIcon,
  Loader2,
  Search,
  SendHorizontal,
  Sparkles,
  WifiOff,
  X,
} from 'lucide-react';
import { client } from '../../trpc/client';
import { OverlayLayer } from '../OverlayLayer';
import { giftImageUrl } from '../../lib/resourceUrl';
import { cn } from '../../im-template/template/classNames';
import '../../styles/gift-mall.css';

/** 与 `@weq/protocol` 的 GIFT_MALL_TABS 同一套文案（空串 = 全部）。 */
const TABS = [
  { id: '', label: '全部' },
  { id: '礼品卡', label: '礼品卡' },
  { id: '个性化装扮', label: '个性化装扮' },
] as const;

type TabName = (typeof TABS)[number]['id'];

/** 与 `@weq/protocol` 的 GIFT_MALL_SUBTABS 一致；按分栏分组（服务端只认这些名字）。 */
const SUBTABS: Record<TabName, readonly string[]> = {
  '': ['最近上新', '鲜花', '玩偶摆件', '礼品卡', '蛋糕'],
  礼品卡: ['音乐会员', '视频会员', '其他会员', 'QQ权益'],
  个性化装扮: ['主题', '气泡', '头像挂件'],
};

type SubTabName =
  | '最近上新'
  | '鲜花'
  | '玩偶摆件'
  | '礼品卡'
  | '蛋糕'
  | '音乐会员'
  | '视频会员'
  | '其他会员'
  | 'QQ权益'
  | '主题'
  | '气泡'
  | '头像挂件';

type GiftItem = {
  giftId: number;
  giftName: string;
  giftDesc?: string;
  desc?: string;
  homepageDesc?: string;
  giftPrice?: number;
  svipDiscount?: number;
  staticPic?: string;
  squareStaticPic?: string;
  backgroundColor?: string;
  vecTags?: string[];
};

/** 列表优先用方图（真机商城同款），没有才退回详情兜底图。 */
function previewOf(gift: GiftItem): string {
  return gift.squareStaticPic || gift.staticPic || '';
}

function priceOf(gift: GiftItem): { price: number; original: number; discounted: boolean } {
  const original = gift.giftPrice ?? 0;
  const discount = gift.svipDiscount ?? 0;
  return discount > 0 && discount < original
    ? { price: discount, original, discounted: true }
    : { price: original, original, discounted: false };
}

/** 礼物自带的主题底色，作为预览格的淡色铺底（CSS 里再和 surface 混一遍）。 */
function tintStyle(gift: GiftItem): CSSProperties {
  return gift.backgroundColor ? ({ '--weq-gift-tint': gift.backgroundColor } as CSSProperties) : {};
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 首屏骨架卡片(纯装饰节点,固定集合)。 */
const SKELETON_KEYS = Array.from({ length: 8 }, (_, index) => `gift-skel-${index}`);

export function GiftMallPanel({
  peer,
  peerName,
  onClose,
}: {
  /** 会话对方的 uid 或 QQ 号（主进程负责换成 uin）。 */
  peer: string;
  /** 面板标题里显示的收礼人名字。 */
  peerName: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<TabName>('');
  const [subTab, setSubTab] = useState<SubTabName | ''>('');
  const [draft, setDraft] = useState('');
  const [keyword, setKeyword] = useState('');
  const [items, setItems] = useState<GiftItem[]>([]);
  const [isEnd, setIsEnd] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<GiftItem | null>(null);

  // 游标只在「继续看」时用；换分栏 / 换关键词一律从头取。
  const cursor = useRef({ attach: '', page: 1 });
  const requestId = useRef(0);

  const loadPage = useCallback(
    async (mode: 'reset' | 'more') => {
      const id = ++requestId.current;
      const nextPage = mode === 'reset' ? 1 : cursor.current.page + 1;
      const attachInfo = mode === 'reset' ? '' : cursor.current.attach;
      setLoading(true);
      setError('');
      try {
        const result = keyword
          ? await client.account.giftMall.search.query({
              peer,
              keyword,
              pageNo: nextPage,
              attachInfo,
            })
          : await client.account.giftMall.list.query({
              peer,
              tabName: tab,
              subTabName: subTab ? [subTab] : [],
              attachInfo,
              crowdTab: '',
            });
        if (id !== requestId.current) return;
        cursor.current = { attach: result.attachInfo, page: nextPage };
        const list = result.giftList as unknown as GiftItem[];
        // 按 giftId 去重：翻页 / 换页时服务端偶尔会重复给同一个礼物，
        // 它同时也充当卡片的稳定 key，不用下标。
        setItems((prev) => {
          if (mode === 'reset') return list;
          const seen = new Set(prev.map((item) => item.giftId));
          return [...prev, ...list.filter((item) => !seen.has(item.giftId))];
        });
        setIsEnd(result.isEnd);
      } catch (e) {
        if (id !== requestId.current) return;
        setError(messageOf(e));
        if (mode === 'reset') setItems([]);
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [keyword, peer, subTab, tab],
  );

  useEffect(() => {
    cursor.current = { attach: '', page: 1 };
    setItems([]);
    setIsEnd(false);
    void loadPage('reset');
  }, [loadPage]);

  const subtabs = SUBTABS[tab];

  return (
    <OverlayLayer presentation="modal" className="weq-gift-layer" onClose={onClose}>
      <div className="weq-gift-dialog" role="dialog" aria-label="礼物">
        <header className="weq-gift-head">
          <div className="weq-gift-title">
            <span className="weq-gift-title-icon">
              <GiftIcon size={15} strokeWidth={2} />
            </span>
            <div>
              <h2>礼物</h2>
              <small>送给 {peerName || '对方'}</small>
            </div>
          </div>

          <form
            className="weq-gift-search"
            onSubmit={(event) => {
              event.preventDefault();
              const next = draft.trim();
              setSelected(null);
              if (next === keyword) {
                void loadPage('reset');
                return;
              }
              // 关键词一变 loadPage 就重建、effect 重跑，这里不用再手动请求。
              setKeyword(next);
            }}
          >
            <Search size={14} strokeWidth={1.9} />
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="搜索礼物名，回车确认"
              aria-label="搜索礼物"
              spellCheck={false}
            />
            {draft ? (
              <button
                type="button"
                className="weq-gift-search-clear"
                title="清空搜索"
                aria-label="清空搜索"
                // 清空同样交给 effect（keyword 变了就回到分栏列表）。
                onClick={() => {
                  setDraft('');
                  setKeyword('');
                  setSelected(null);
                }}
              >
                <X size={11} strokeWidth={2.4} />
              </button>
            ) : null}
          </form>

          <button type="button" className="weq-gift-close" title="关闭" onClick={onClose}>
            <X size={17} strokeWidth={2.1} />
          </button>
        </header>

        {selected ? (
          <GiftDetail
            key={selected.giftId}
            peer={peer}
            gift={selected}
            onBack={() => setSelected(null)}
            onClose={onClose}
          />
        ) : (
          <>
            <div className="weq-gift-tabs" role="tablist" aria-label="礼物分栏">
              {TABS.map((item) => (
                <button
                  key={item.id || 'all'}
                  type="button"
                  role="tab"
                  aria-selected={tab === item.id}
                  className={cn('weq-gift-tab', tab === item.id && 'is-active')}
                  onClick={() => {
                    setTab(item.id);
                    setSubTab('');
                    setKeyword('');
                    setDraft('');
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>

            {/* 有关键词时子栏没有意义 —— 搜索结果不按分类切。 */}
            {!keyword && subtabs.length > 0 ? (
              <div className="weq-gift-subtabs" role="tablist" aria-label="礼物子栏">
                <button
                  type="button"
                  role="tab"
                  aria-selected={subTab === ''}
                  className={cn('weq-gift-subtab', subTab === '' && 'is-active')}
                  onClick={() => setSubTab('')}
                >
                  推荐
                </button>
                {subtabs.map((name) => (
                  <button
                    key={name}
                    type="button"
                    role="tab"
                    aria-selected={subTab === name}
                    className={cn('weq-gift-subtab', subTab === name && 'is-active')}
                    onClick={() => setSubTab(name as SubTabName)}
                  >
                    {name}
                  </button>
                ))}
              </div>
            ) : (
              <div className="weq-gift-subtabs">
                <span className="weq-gift-count">
                  {keyword ? `“${keyword}”的搜索结果` : '按分类挑一份礼物'}
                </span>
              </div>
            )}

            <div className="weq-gift-body">
              {loading && items.length === 0 ? (
                <div className="weq-gift-skeleton" aria-hidden>
                  {SKELETON_KEYS.map((key) => (
                    <div className="weq-gift-skel-card" key={key} />
                  ))}
                </div>
              ) : error ? (
                <div className="weq-gift-state is-error">
                  {/在线|登录 QQ|客户端/.test(error) ? (
                    <WifiOff size={26} strokeWidth={1.6} />
                  ) : (
                    <CircleAlert size={26} strokeWidth={1.6} />
                  )}
                  <p>礼物商城没打开</p>
                  <span>{error}</span>
                  <button
                    type="button"
                    className="weq-gift-subtab"
                    onClick={() => void loadPage('reset')}
                  >
                    重试
                  </button>
                </div>
              ) : items.length === 0 ? (
                <div className="weq-gift-state">
                  <Sparkles size={26} strokeWidth={1.6} />
                  <p>{keyword ? '没有匹配的礼物' : '这个分类还没有礼物'}</p>
                  <span>
                    {keyword
                      ? '换个关键词试试，或者切到「全部」随便逛逛。'
                      : '试试别的分栏，或者直接搜索礼物名。'}
                  </span>
                </div>
              ) : (
                <>
                  <div className="weq-gift-grid">
                    {items.map((gift) => (
                      <GiftCard key={gift.giftId} gift={gift} onOpen={() => setSelected(gift)} />
                    ))}
                  </div>
                  {!isEnd ? (
                    <div className="weq-gift-more">
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => void loadPage('more')}
                      >
                        {loading ? (
                          <Loader2 size={13} className="weq-gift-spin" />
                        ) : (
                          <GiftIcon size={13} strokeWidth={1.9} />
                        )}
                        继续看
                      </button>
                    </div>
                  ) : (
                    <div className="weq-gift-more">
                      <span className="weq-gift-count">已经到底啦</span>
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </OverlayLayer>
  );
}

/** 一张礼物卡：大预览图 + 名字 + 一句话 + 价格。 */
function GiftCard({ gift, onOpen }: { gift: GiftItem; onOpen: () => void }) {
  const src = giftImageUrl(previewOf(gift));
  const { price, original, discounted } = priceOf(gift);
  const blurb = gift.homepageDesc || gift.giftDesc || gift.desc || '';
  return (
    <button type="button" className="weq-gift-card" onClick={onOpen}>
      <span className="weq-gift-card-media" style={tintStyle(gift)}>
        {src ? (
          <img src={src} alt={gift.giftName} loading="lazy" decoding="async" draggable={false} />
        ) : (
          <span className="weq-gift-card-fallback">
            <GiftIcon size={26} strokeWidth={1.5} />
            暂无预览
          </span>
        )}
        {discounted ? <span className="weq-gift-card-badge">SVIP</span> : null}
      </span>
      <span className="weq-gift-card-body">
        <strong title={gift.giftName}>{gift.giftName}</strong>
        <small title={blurb}>{blurb || '一份小小的心意'}</small>
        <span className="weq-gift-card-price">
          <Coins size={12} strokeWidth={2} />
          {price}
          {discounted ? <s>{original}</s> : null}
        </span>
      </span>
    </button>
  );
}

/** 详情：左边大图，右边说明 / 祝福 / 赠送。 */
function GiftDetail({
  peer,
  gift,
  onBack,
  onClose,
}: {
  peer: string;
  gift: GiftItem;
  onBack: () => void;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<GiftItem>(gift);
  const [message, setMessage] = useState('送你一份小心意，愿它替我陪着你。');
  const [anonymous, setAnonymous] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  // 列表里的字段够画卡片，但折扣 / 资格要以详情为准；详情失败就继续用列表那份。
  useEffect(() => {
    let cancelled = false;
    void client.account.giftMall.detail
      .query({ peer, giftId: gift.giftId })
      .then((result) => {
        if (!cancelled) setDetail({ ...gift, ...(result.giftInfo as unknown as GiftItem) });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [gift, peer]);

  const src = giftImageUrl(detail.staticPic || previewOf(detail));
  const { price, original, discounted } = priceOf(detail);
  const tags = (detail.vecTags ?? []).filter((tag) => tag.trim() !== '');
  const description = detail.desc || detail.giftDesc || '';

  async function send(): Promise<void> {
    if (sending) return;
    setSending(true);
    setError('');
    setSent(false);
    try {
      await client.account.giftMall.send.mutate({
        peer,
        giftId: detail.giftId,
        giftPrice: detail.giftPrice ?? 0,
        ...(detail.svipDiscount ? { svipDiscount: detail.svipDiscount } : {}),
        message: message.trim(),
        anonymous,
      });
      setSent(true);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="weq-gift-detail">
      <div className="weq-gift-detail-preview">
        <button type="button" className="weq-gift-detail-back" onClick={onBack}>
          <ArrowLeft size={13} strokeWidth={2.2} />
          返回礼物列表
        </button>
        <div className="weq-gift-detail-stage" style={tintStyle(detail)}>
          {src ? (
            <img src={src} alt={detail.giftName} draggable={false} />
          ) : (
            <span className="weq-gift-card-fallback">
              <GiftIcon size={30} strokeWidth={1.4} />
              暂无预览
            </span>
          )}
        </div>
      </div>

      <div className="weq-gift-detail-info">
        <h3 className="weq-gift-detail-name">{detail.giftName}</h3>

        {tags.length > 0 ? (
          <div className="weq-gift-detail-tags">
            {tags.map((tag) => (
              <span className="weq-gift-tag" key={tag}>
                {tag}
              </span>
            ))}
          </div>
        ) : null}

        <div className="weq-gift-detail-price">
          <Coins size={16} strokeWidth={2} />
          {price}
          {discounted ? <s>{original}</s> : null}
          <small>{discounted ? 'SVIP 价' : '礼物价格'}</small>
        </div>

        {description ? <p className="weq-gift-detail-desc">{description}</p> : null}

        <label className="weq-gift-detail-field">
          <span>祝福语</span>
          <textarea
            value={message}
            maxLength={60}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="写一句随礼物一起送到的话"
          />
        </label>

        <label className="weq-gift-detail-option">
          <input
            type="checkbox"
            checked={anonymous}
            onChange={(event) => setAnonymous(event.target.checked)}
          />
          匿名赠送
        </label>

        {error ? (
          <div className="weq-gift-detail-result is-error">
            <CircleAlert size={15} strokeWidth={2} />
            <span>{error}</span>
          </div>
        ) : null}

        {sent ? (
          <div className="weq-gift-detail-result is-ok">
            <Check size={15} strokeWidth={2.2} />
            <span>礼物已经送出，等对方在手机 QQ 里收下它。</span>
          </div>
        ) : null}

        <div className="weq-gift-detail-actions">
          <button
            type="button"
            className="weq-gift-send"
            disabled={sending || sent}
            onClick={() => void send()}
          >
            {sending ? (
              <Loader2 size={14} className="weq-gift-spin" />
            ) : (
              <SendHorizontal size={14} strokeWidth={2.2} />
            )}
            {sending ? '送出中…' : '赠送'}
          </button>
          <button type="button" className="weq-gift-detail-back" onClick={onClose}>
            关闭
          </button>
        </div>

        <span className="weq-gift-detail-hint">
          需要付款的礼物 WeQ 送不出去（没有收银台），会在这里如实提示，请回手机 QQ 操作。
        </span>
      </div>
    </div>
  );
}
