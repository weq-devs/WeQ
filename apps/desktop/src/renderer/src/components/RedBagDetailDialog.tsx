// @ts-nocheck
/**
 * 红包灯箱 —— 三态共用同一张卡片，尺寸固定不跳动：
 *
 *   1. **领取记录**：自己已经领过这个红包 → 顶部封面 + 向下弧线，弧线正中嵌发红包者
 *      头像，弧线以下白板（深色模式用表面色）铺领取列表（头像 / 昵称 / 金额 / 时间）；
 *      自己那条底灰、手气王戴皇冠（lucide 图标，不是 emoji）。
 *   2. **开**：自己还没领过 → 不渲染列表、不渲染白板和弧线，封面铺满整张卡片，中间一个
 *      圆形「开」按钮 + 小字「点击查看领取结果」。
 *   3. **领取结果**：点了「开」之后原地换成结果态 —— 同样没有弧线和白板，发送者头像落在
 *      原来弧线头像的位置，下面写「你领取到了 ¥x.xx」。
 *
 * 自己发的红包（`senderUin === selfUin`）不给「开」按钮 —— 抢自己的红包没有意义，
 * 点了服务端也会拒。
 *
 * 打开前先确认 QQ 在线且已注入 —— 与发消息按钮同条件（见 MainView 的 sendAvailable）。
 * 详情由主进程 `account.redbagDetail` 现取；抢红包走 `account.redbagGrab`（**真的会扣钱**）。
 *
 * 查详情失败**不挡「开」按钮**：失败时就当没查到，封面照常给「开」。其中业务码
 * 私聊 109026670（「您的操作已提交，请确认是否已生效」）/ 群聊 66243906 是预期情况
 * —— 别人发来的红包自己没领本来就不让看领取情况 —— 静默吞掉；其余报错用 toast 一下。
 */

import { useEffect, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { Crown, RefreshCw, X } from 'lucide-react';
import { client } from '../trpc/client';
import { QqAvatar } from './QqAvatar';
import { useToast } from './Toast';
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
  /** 当前登录账号的 QQ 号。 */
  selfUin: string;
  /** 自己在这个红包里的那一条；没领过是 null。 */
  selfClaim: RedBagClaimWire | null;
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

/** 抢红包结果（主进程 `account.redbagGrab`）。 */
export interface RedBagGrabWire {
  amount: number;
  claimTime: number;
  uin: string;
  nickname: string;
  senderUin: string;
  senderNickname: string;
  wishing: string;
  lucky: boolean;
  claimedCount: number;
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

/**
 * `hb_pc_detail` 对「别人发给自己、自己还没领」的红包会回业务码 —— 不点「开」本来
 * 就不让看领取情况，属于设计如此，不是故障。这些码静默吞掉：不弹 toast，照常给「开」。
 *   - 109026670「您的操作已提交，请确认是否已生效」：私聊红包
 *   - 66243906：群聊红包
 */
const RED_BAG_DETAIL_EXPECTED_CODES = ['109026670', '66243906'] as const;
function isExpectedDetailMiss(message: string): boolean {
  return RED_BAG_DETAIL_EXPECTED_CODES.some((code) => message.includes(code));
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

/** 命令式打开红包灯箱（QqWallet 点击时调用）。 */
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
  const pushToast = useToast((s) => s.push);
  const [detail, setDetail] = useState<RedBagDetailWire | null>(null);
  const [loading, setLoading] = useState(true);
  const [grabbing, setGrabbing] = useState(false);
  const [grabError, setGrabError] = useState<string | null>(null);
  const [result, setResult] = useState<RedBagGrabWire | null>(null);
  // 自定义封面是从 moggy CDN 现取的：skinId 有值但图挂掉（404 / 下架）时回退默认封面。
  const [coverBroken, setCoverBroken] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setCoverBroken(false);
    setResult(null);
    setGrabError(null);
    client.account.redbagDetail
      .query({ msgId: target.msgId, kind: target.kind, conv: target.conv })
      .then((res: RedBagDetailWire) => {
        if (!alive) return;
        setDetail(res);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const message = e instanceof Error ? e.message : String(e);
        // 预期情况静默吞掉；其余报错 Toast 一下即可 —— 无论哪种，卡片都照常给「开」按钮。
        if (!isExpectedDetailMiss(message)) {
          pushToast({ tone: 'error', title: '红包详情查询失败', detail: message });
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [target.msgId, target.kind, target.conv, pushToast]);

  const cover =
    target.skinId && !coverBroken
      ? redbagSkinUrl(String(target.skinId))
      : resourceUrl('img', 'normal_bag.png');

  const selfUin = detail?.selfUin ?? '';
  const hasOwnClaim = Boolean(detail?.selfClaim);
  // 自己发的红包：自己永远不在领取列表里，但发送者关心的恰恰是「谁领了」——
  // 所以照样铺白板显示列表，不给「开」按钮（抢自己的红包没有意义）。
  const isMine = Boolean(detail && selfUin && detail.senderUin === selfUin);
  const senderUin = detail?.senderUin || target.senderUin || '';
  const senderLabel = senderUin && senderUin === selfUin ? '我' : detail?.senderNickname || '红包';
  const sheetVisible = Boolean(detail && (hasOwnClaim || isMine));

  // 手气王：金额最高的那一条（拼手气才有意义；等额时按服务器顺序取第一个）。
  const kingUin = (() => {
    if (!detail || detail.claims.length === 0) return null;
    return detail.claims.reduce((best, c) => (c.amount > best.amount ? c : best), detail.claims[0]!)
      .uin;
  })();

  const handleGrab = (): void => {
    if (grabbing || result) return;
    setGrabbing(true);
    setGrabError(null);
    void client.account.redbagGrab
      .mutate({ msgId: target.msgId, kind: target.kind, conv: target.conv })
      .then((res: RedBagGrabWire) => {
        setResult(res);
      })
      .catch((e: unknown) => {
        setGrabError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        setGrabbing(false);
      });
  };

  /** 结果态用的头像：抢到之后服务端会回发红包者 uin。 */
  const resultSenderUin = result?.senderUin || senderUin;
  /** 结果态 / 开态共用的封面文字：发送者 + 祝福语。 */
  const coverText = (
    <div className="weq-redbag-detail-plain-text">
      <span className="weq-redbag-detail-hero-name">{senderLabel}</span>
      {detail?.wishing ? (
        <span className="weq-redbag-detail-hero-wishing">{detail.wishing}</span>
      ) : null}
    </div>
  );

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
        className={`weq-redbag-detail${sheetVisible ? ' has-sheet' : ' is-plain'}`}
        role="dialog"
        aria-modal="true"
        aria-label="红包领取详情"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button className="weq-redbag-detail-close" type="button" title="关闭" onClick={onClose}>
          <X size={18} />
        </button>

        {sheetVisible ? (
          <>
            {/* 封面底 + 顶部向下弧线：弧线以上露出封面，弧线以下由白板盖住，头像骑在弧线正中 */}
            <div className="weq-redbag-detail-hero">
              <img
                className="weq-redbag-detail-cover"
                src={cover}
                alt=""
                draggable={false}
                onError={() => {
                  if (target.skinId) setCoverBroken(true);
                }}
              />
              <div className="weq-redbag-detail-hero-text">
                <span className="weq-redbag-detail-hero-name">{senderLabel}</span>
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
                {/* 向下弧线（中间最低），填充弧线**下方** —— 与下面的白板连成一片 */}
                <path d="M0,12 Q50,34 100,12 L100,40 L0,40 Z" />
              </svg>
              <div className="weq-redbag-detail-avatar">
                <QqAvatar uin={senderUin || null} size={56} />
              </div>
            </div>

            <div className="weq-redbag-detail-sheet">
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
                    const mine = selfUin !== '' && c.uin === selfUin;
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
            </div>
          </>
        ) : (
          /* 无白板态：封面铺满整张卡片（开 / 领取结果 / 自己发的 都走这里） */
          <div className="weq-redbag-detail-plain">
            <img
              className="weq-redbag-detail-cover"
              src={cover}
              alt=""
              draggable={false}
              onError={() => {
                if (target.skinId) setCoverBroken(true);
              }}
            />
            {coverText}
            {loading ? (
              <div className="weq-redbag-detail-plain-loading">
                <RefreshCw size={20} className="weq-gap-spin" />
                <span>正在查询…</span>
              </div>
            ) : result ? (
              /* 领取结果：发送者头像落在领取记录弧线头像的同一位置，下面一行金额 */
              <>
                <div className="weq-redbag-detail-avatar is-standalone">
                  <QqAvatar uin={resultSenderUin || null} size={56} />
                </div>
                <div className="weq-redbag-detail-result">
                  <div className="weq-redbag-detail-result-amount">
                    你领取到了 <strong>{formatAmount(result.amount)}</strong> 元
                  </div>
                  {/* grab 响应的概况不带已领人数，拿不到就整行不显示。 */}
                  {result.claimedCount > 0 ? (
                    <div className="weq-redbag-detail-result-meta">
                      已领取 {result.claimedCount}/{detail?.totalNum || '?'} 个
                    </div>
                  ) : null}
                </div>
              </>
            ) : (
              <div className="weq-redbag-detail-open">
                <button
                  className="weq-redbag-detail-open-btn"
                  type="button"
                  disabled={grabbing}
                  onClick={handleGrab}
                  aria-label="开红包"
                >
                  {grabbing ? <RefreshCw size={22} className="weq-gap-spin" /> : '开'}
                </button>
                <span className={`weq-redbag-detail-open-hint${grabError ? ' is-error' : ''}`}>
                  {grabError || '点击查看领取结果'}
                </span>
              </div>
            )}
          </div>
        )}
      </section>
    </div>,
    document.body,
  );
}

/** 挂一次（放在 App 根部），渲染当前打开的红包灯箱。 */
export function RedBagDetailHost(): ReactElement | null {
  const target = useRedBagStore((s) => s.target);
  const close = useRedBagStore((s) => s.close);
  if (!target) return null;
  return <RedBagDetailDialog target={target} onClose={close} />;
}
