// @ts-nocheck
/**
 * 红包领取明细灯箱。
 *
 * 布局：整块以**红包封面**为底（自定义 skin 优先，缺省用仓库里的通用封面），顶部一条
 * 向下的弧线把卡片分成两半 —— 弧线以上露背景、弧线以下用纯白/深色遮住，弧线正中嵌
 * 发红包者头像。弧线下方是领取列表（头像 / 昵称 / 金额 / 时间），自己的那一条底灰
 * 高亮，手气王戴一枚皇冠图标（用 lucide 组件，不是 emoji）。
 *
 * 打开前先确认 QQ 在线且已注入 —— 与发消息按钮同条件（见 MainView 的 sendAvailable）。
 * 数据由主进程 `account.redbagDetail` 现取；skeleton / 空列表 / 报错都有对应态。
 */

import { useEffect, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { Crown, RefreshCw, X } from 'lucide-react';
import { client } from '../trpc/client';
import { QqAvatar } from './QqAvatar';
import { redbagSkinUrl, resourceUrl } from '../lib/resourceUrl';
import { useOverlayLayer } from '../lib/overlayStack';
import { useEscapeToClose } from '../im-template/template/modalUtils';

export interface RedBagClaimWire {
  uin: string;
  nickname: string;
  /** 单位：分。 */
  amount: number;
  /** unix 秒。 */
  claimTime: number;
}

export interface RedBagDetailWire {
  totalNum: number;
  totalAmount: number;
  claimedCount: number;
  wishing: string;
  senderUin: string;
  senderNickname: string;
  lucky: boolean;
  claims: RedBagClaimWire[];
  expireTime: number;
}

export interface RedBagDetailTarget {
  msgId: string;
  kind: 'c2c' | 'group';
  conv: string;
  /** 自定义封面 id（存在时优先于通用封面）。 */
  skinId?: number;
  /** 发红包者头像用的 uin（拿不到时回退领取人 / 占位）。 */
  senderUin?: string;
}

/** 分 → 元，保留两位（0.02 → 「0.02」）。 */
function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}

function formatTime(sec: number): string {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---- store ----------------------------------------------------------------

interface RedBagStore {
  target: RedBagDetailTarget | null;
  open(target: RedBagDetailTarget): void;
  close(): void;
}

const useRedBagStore = create<RedBagStore>((set) => ({
  target: null,
  open(target) {
    set({ target });
  },
  close() {
    set({ target: null });
  },
}));

/** 命令式打开红包明细灯箱（QqWallet 点击时调用）。 */
export function openRedBagDetail(target: RedBagDetailTarget): void {
  useRedBagStore.getState().open(target);
}

// ---- the dialog -----------------------------------------------------------

function RedBagDetailDialog({
  target,
  onClose,
}: {
  target: RedBagDetailTarget;
  onClose: () => void;
}): ReactElement {
  useEscapeToClose(onClose);
  const layer = useOverlayLayer(true);
  const [detail, setDetail] = useState<RedBagDetailWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selfUin, setSelfUin] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void client.account.getSelfProfile
      .query()
      .then((p) => {
        if (alive && p?.uin) setSelfUin(String(p.uin));
      })
      .catch(() => {
        /* 拿不到就不高亮自己那一条 */
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    client.account.redbagDetail
      .query({ msgId: target.msgId, kind: target.kind, conv: target.conv })
      .then((res: RedBagDetailWire) => {
        if (!alive) return;
        setDetail(res);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [target.msgId, target.kind, target.conv]);

  const cover = target.skinId
    ? redbagSkinUrl(String(target.skinId))
    : resourceUrl('img', 'normal_bag.png');
  // 手气王：金额最高的那一条（拼手气才有意义；等额时按服务器顺序取第一个）。
  const kingUin = (() => {
    if (!detail || detail.claims.length === 0) return null;
    return detail.claims.reduce((best, c) => (c.amount > best.amount ? c : best), detail.claims[0]!)
      .uin;
  })();
  const senderUin = detail?.senderUin || target.senderUin || '';

  return createPortal(
    <div
      className="weq-redbag-detail-layer weq-anim-fade"
      style={layer ? { zIndex: layer } : undefined}
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className="weq-redbag-detail"
        role="dialog"
        aria-modal="true"
        aria-label="红包领取详情"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button className="weq-redbag-detail-close" type="button" title="关闭" onClick={onClose}>
          <X size={18} />
        </button>

        {/* 封面底 + 顶部向下弧线：弧线以上露出封面，弧线以下由白色盖住，头像骑在弧线正中 */}
        <div className="weq-redbag-detail-hero">
          <img className="weq-redbag-detail-cover" src={cover} alt="" draggable={false} />
          <div className="weq-redbag-detail-hero-text">
            <span className="weq-redbag-detail-hero-name">
              {senderUin && senderUin === selfUin ? '我' : detail?.senderNickname || '红包'}
            </span>
            {detail?.wishing ? (
              <span className="weq-redbag-detail-hero-wishing">{detail.wishing}</span>
            ) : null}
          </div>
          <svg
            className="weq-redbag-detail-arc"
            viewBox="0 0 100 40"
            preserveAspectRatio="none"
            aria-hidden
          >
            {/* 向下弧线（中间最低），填充弧线**下方** —— 与下面的白色区域连成一片 */}
            <path d="M0,12 Q50,34 100,12 L100,40 L0,40 Z" />
          </svg>
          <div className="weq-redbag-detail-avatar">
            <QqAvatar uin={senderUin || null} size={56} />
          </div>
        </div>

        <div className="weq-redbag-detail-sheet">
          {loading ? (
            <div className="weq-redbag-detail-empty">
              <RefreshCw size={20} className="weq-gap-spin" />
              <span>正在查询领取记录…</span>
            </div>
          ) : error ? (
            <div className="weq-redbag-detail-empty is-error">
              <span>{error}</span>
              <span className="weq-redbag-detail-hint">查明细需要 QQ 在线且已注入。</span>
            </div>
          ) : (
            <>
              <div className="weq-redbag-detail-meta">
                <span>
                  已领取 {detail?.claimedCount ?? 0}/{detail?.totalNum || '?'} 个
                </span>
                {detail?.totalAmount ? (
                  <span>
                    {detail.lucky ? '总金额' : '金额'} ¥{formatAmount(detail.totalAmount)}
                  </span>
                ) : null}
              </div>
              {detail && detail.claims.length > 0 ? (
                <ul className="weq-redbag-detail-list">
                  {detail.claims.map((c) => {
                    const mine = selfUin !== null && c.uin === selfUin;
                    const king = kingUin === c.uin;
                    return (
                      <li
                        key={`${c.uin}-${c.claimTime}`}
                        className={`weq-redbag-detail-item${mine ? ' is-mine' : ''}`}
                      >
                        <QqAvatar uin={c.uin} size={36} />
                        <div className="weq-redbag-detail-item-main">
                          <span className="weq-redbag-detail-item-name">
                            {mine ? '我' : c.nickname || c.uin}
                            {king ? (
                              <Crown
                                size={13}
                                className="weq-redbag-detail-crown"
                                strokeWidth={2.2}
                                aria-label="手气最佳"
                              />
                            ) : null}
                          </span>
                          <span className="weq-redbag-detail-item-time">
                            {formatTime(c.claimTime)}
                          </span>
                        </div>
                        <span className="weq-redbag-detail-item-amount">
                          ¥{formatAmount(c.amount)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="weq-redbag-detail-empty">
                  <span>还没有人领取</span>
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}

/** 挂一次（放在 App 根部），渲染当前打开的红包明细。 */
export function RedBagDetailHost(): ReactElement | null {
  const target = useRedBagStore((s) => s.target);
  const close = useRedBagStore((s) => s.close);
  if (!target) return null;
  return <RedBagDetailDialog target={target} onClose={close} />;
}
