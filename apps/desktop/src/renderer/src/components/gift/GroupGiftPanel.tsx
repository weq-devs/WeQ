/**
 * 群礼物面板 —— 输入框「红包 / 礼物」菜单里的「礼物」（群聊版）。
 *
 * 和私聊礼物商城（GiftMallPanel）同一个入口、同一套视觉，唯一差别是**纯查看**：
 * 没有祝福语、没有匿名开关，也没有「赠送」按钮。数据来自
 * `GiftMidgroundPanel.SsoGetSceneItem`（一个回包直接带回所有页签和礼物）。
 *
 * 兜底：没有在线 QQ / OIDB 能力时用本次真机抓包内置的目录把面板画出来，
 * 同时弹一条错误 toast —— 否则一屏「看起来正常」的礼物会让人以为请求成功了。
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { ArrowLeft, CircleAlert, Coins, Gift as GiftIcon, Sparkles, X } from 'lucide-react';
import type { GroupGiftItem, GroupGiftPanelResult } from '@weq/protocol';
import { client } from '../../trpc/client';
import { OverlayLayer } from '../OverlayLayer';
import { useToast } from '../Toast';
import { giftImageUrl } from '../../lib/resourceUrl';
import { cn } from '../../im-template/template/classNames';
import { GROUP_GIFT_FALLBACK } from './groupGiftFallback';
import '../../styles/gift-mall.css';
import '../../styles/group-gift.css';

const SKELETON_KEYS = Array.from({ length: 8 }, (_, index) => `group-gift-skel-${index}`);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 同一页签内服务端偶尔会重复下发同一件礼物，按条目 id 去重（同时当稳定 key）。 */
function uniqueGifts(gifts: GroupGiftItem[]): GroupGiftItem[] {
  const seen = new Set<number>();
  return gifts.filter((gift) => {
    if (seen.has(gift.entryId)) return false;
    seen.add(gift.entryId);
    return true;
  });
}

function countGifts(panel: GroupGiftPanelResult): number {
  return panel.tabs.reduce((total, tab) => total + uniqueGifts(tab.gifts).length, 0);
}

function tintStyle(gift: GroupGiftItem): CSSProperties {
  return gift.images.baseUrl
    ? ({ '--weq-gift-tint': 'var(--weq-accent-effective)' } as CSSProperties)
    : {};
}

export function GroupGiftPanel({
  groupUin,
  groupName,
  onClose,
}: {
  /** 群号。 */
  groupUin: number;
  /** 面板标题里显示的群名。 */
  groupName: string;
  onClose: () => void;
}) {
  const pushToast = useToast((state) => state.push);
  const [panel, setPanel] = useState<GroupGiftPanelResult | null>(null);
  const [activeId, setActiveId] = useState('');
  const [selected, setSelected] = useState<GroupGiftItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [usingFallback, setUsingFallback] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setSelected(null);
    void client.account.groupGift.scene
      .query({ groupUin })
      .then((result) => {
        if (cancelled) return;
        setPanel(result);
        setActiveId(
          result.tabs.find((tab) => tab.gifts.length > 0)?.id ?? result.tabs[0]?.id ?? '',
        );
        setUsingFallback(false);
        pushToast({
          key: 'group-gift-panel',
          tone: 'success',
          title: '群礼物加载成功',
          message: `${countGifts(result)} 件礼物`,
        });
      })
      .catch((cause) => {
        if (cancelled) return;
        const message = messageOf(cause);
        setPanel(GROUP_GIFT_FALLBACK);
        setActiveId(
          GROUP_GIFT_FALLBACK.tabs.find((tab) => tab.gifts.length > 0)?.id ??
            GROUP_GIFT_FALLBACK.tabs[0]?.id ??
            '',
        );
        setUsingFallback(true);
        setError(message);
        pushToast({
          key: 'group-gift-panel',
          tone: 'error',
          title: '群礼物加载失败，已展示内置抓包示例',
          detail: message,
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [groupUin, pushToast]);

  const tabs = useMemo(() => panel?.tabs ?? [], [panel]);
  const activeTab = tabs.find((tab) => tab.id === activeId) ?? tabs[0];
  const gifts = useMemo(() => (activeTab ? uniqueGifts(activeTab.gifts) : []), [activeTab]);

  return (
    <OverlayLayer presentation="modal" className="weq-gift-layer" onClose={onClose}>
      <div className="weq-gift-dialog" role="dialog" aria-label="群礼物">
        <header className="weq-gift-head">
          <div className="weq-gift-title">
            <span className="weq-gift-title-icon">
              <GiftIcon size={15} strokeWidth={2} />
            </span>
            <div>
              <h2>群礼物</h2>
              <small>{groupName ? `${groupName} 的礼物面板` : '群礼物面板'}</small>
            </div>
          </div>
          <span className="weq-group-gift-mode">仅供查看 · 赠送请到手机 QQ</span>
          <button type="button" className="weq-gift-close" title="关闭" onClick={onClose}>
            <X size={17} strokeWidth={2.1} />
          </button>
        </header>

        {selected ? (
          <GroupGiftDetail gift={selected} onBack={() => setSelected(null)} onClose={onClose} />
        ) : (
          <>
            <div className="weq-gift-tabs" role="tablist" aria-label="礼物分类">
              {tabs.map((tab) => (
                <button
                  key={tab.id || tab.name}
                  type="button"
                  role="tab"
                  aria-selected={activeTab?.id === tab.id}
                  className={cn('weq-gift-tab', activeTab?.id === tab.id && 'is-active')}
                  onClick={() => setActiveId(tab.id)}
                >
                  {tab.name}
                </button>
              ))}
            </div>

            {usingFallback ? (
              <div className="weq-group-gift-fallback" role="status">
                <CircleAlert size={14} strokeWidth={2} />
                <span>
                  这是 2026-11-03 抓包的内置示例，不是当前群的实时礼物。
                  {error ? `原因：${error}` : ''}
                </span>
              </div>
            ) : (
              <div className="weq-gift-subtabs">
                <span className="weq-gift-count">
                  {activeTab?.subtitle || '挑一份礼物看看，赠送需要到手机 QQ'}
                </span>
              </div>
            )}

            <div className="weq-gift-body">
              {loading && !panel ? (
                <div className="weq-gift-skeleton" aria-hidden>
                  {SKELETON_KEYS.map((key) => (
                    <div className="weq-gift-skel-card" key={key} />
                  ))}
                </div>
              ) : gifts.length === 0 ? (
                <div className="weq-gift-state">
                  <Sparkles size={26} strokeWidth={1.6} />
                  <p>这个分类还没有礼物</p>
                  <span>切到别的分类看看。</span>
                </div>
              ) : (
                <div className="weq-gift-grid">
                  {gifts.map((gift) => (
                    <GroupGiftCard
                      key={gift.entryId}
                      gift={gift}
                      onOpen={() => setSelected(gift)}
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </OverlayLayer>
  );
}

/** 一张群礼物卡：预览图 + 名称 + 标语 + 金币价 + 魅力值。 */
function GroupGiftCard({ gift, onOpen }: { gift: GroupGiftItem; onOpen: () => void }) {
  const src = giftImageUrl(gift.images.staticUrl);
  return (
    <button type="button" className="weq-gift-card" onClick={onOpen}>
      <span className="weq-gift-card-media" style={tintStyle(gift)}>
        {src ? (
          <img src={src} alt={gift.name} loading="lazy" decoding="async" draggable={false} />
        ) : (
          <span className="weq-gift-card-fallback">
            <GiftIcon size={26} strokeWidth={1.5} />
            暂无预览
          </span>
        )}
        {gift.corner?.label ? (
          <span className="weq-gift-card-badge">{gift.corner.label}</span>
        ) : null}
      </span>
      <span className="weq-gift-card-body">
        <strong title={gift.name}>{gift.name}</strong>
        <small title={gift.slogan}>{gift.slogan || gift.description || '一份小小的心意'}</small>
        <span className="weq-gift-card-price">
          <Coins size={12} strokeWidth={2} />
          {gift.price}
          <span className="weq-group-gift-unit">金币</span>
          {gift.charm > 0 ? (
            <span className="weq-group-gift-charm">魅力值 +{gift.charm}</span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

/** 详情：大图 + 名称 / 标语 / 价格 / 魅力值 / 标签；没有发送按钮。 */
function GroupGiftDetail({
  gift,
  onBack,
  onClose,
}: {
  gift: GroupGiftItem;
  onBack: () => void;
  onClose: () => void;
}) {
  const src = giftImageUrl(gift.images.staticUrl);
  const tags = gift.tags.filter((tag) => tag.trim() !== '');
  return (
    <div className="weq-gift-detail">
      <div className="weq-gift-detail-preview">
        <button type="button" className="weq-gift-detail-back" onClick={onBack}>
          <ArrowLeft size={13} strokeWidth={2.2} />
          返回礼物列表
        </button>
        <div className="weq-gift-detail-stage" style={tintStyle(gift)}>
          {src ? (
            <img src={src} alt={gift.name} draggable={false} />
          ) : (
            <span className="weq-gift-card-fallback">
              <GiftIcon size={30} strokeWidth={1.4} />
              暂无预览
            </span>
          )}
        </div>
      </div>

      <div className="weq-gift-detail-info">
        <h3 className="weq-gift-detail-name">{gift.name}</h3>

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
          {gift.price}
          <small>金币</small>
          {gift.charm > 0 ? (
            <span className="weq-group-gift-detail-charm">
              <Sparkles size={14} strokeWidth={2} />
              魅力值 +{gift.charm}
            </span>
          ) : null}
        </div>

        {gift.description || gift.slogan ? (
          <p className="weq-gift-detail-desc">{gift.description || gift.slogan}</p>
        ) : null}

        <div className="weq-group-gift-note">
          WeQ 目前只能查看群礼物。想送这份礼物，请到手机 QQ 的群聊礼物面板里操作。
        </div>

        <div className="weq-gift-detail-actions">
          <button type="button" className="weq-gift-detail-back" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
