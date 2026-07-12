/**
 * Renders a `wallet` element (QQ 钱包：转账 / 红包) from its `walletDetail`.
 *
 * 类型判定优先用元素级 walletRedbagType (wire tag 48412，见 codec RedbagType)，
 * 它能细分拼手气 / 专属 / 语音等；仅当缺失时回退到 walletDetail.redbagType
 * (tag 48442，粗粒度：1=转账 / 2=口令 / 4=普通)。
 *
 *   - 转账 (TRANSFER=1)：蓝色转账卡片。
 *   - 口令红包 (PASSWORD=6)：password_bag.png 封面。
 *   - 其它红包：normal_bag.png 封面。
 *
 * 除转账外，卡片上方居中用小字标注红包类型（普通 / 拼手气 / 口令 / 语音）。
 * 专属红包 (DESIGNATED=8) 额外带 walletDesignatedUin：显示该群友的小头像 +
 * 「给{昵称}的专属红包」（昵称按 uin 走 getProfileByUin 解析）。
 *
 * `walletDetail` / walletRedbagType / walletDesignatedUin 均由 mapWallet 透出
 * （无需后端改动）。Bag 图存在仓库 `resources/img/`，经 `weq-asset://` 提供
 * （CSP 放行），从不走网络。
 */

import { useEffect, useState, type ReactElement } from 'react';
import { resourceUrl } from '../lib/resourceUrl';
import { QqAvatar } from './QqAvatar';
import { client } from '../trpc/client';

// ---- helpers -------------------------------------------------------------

function str(o: Record<string, unknown>, key: string): string {
  return typeof o[key] === 'string' ? (o[key] as string) : '';
}

/** Format the transfer amount: keep an existing ¥/￥, else prefix one. */
function formatAmount(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  if (/[¥￥]/.test(t)) return t;
  if (/\d/.test(t)) return `¥ ${t}`;
  return t;
}

/** 红包类型小字（walletRedbagType / wire tag 48412，见 codec RedbagType）。 */
const REDBAG_LABEL: Record<number, string> = {
  2: '普通红包',
  3: '拼手气红包',
  6: '口令红包',
  8: '专属红包',
  15: '语音红包',
};

/** 按 uin 解析昵称（专属红包指定领取人）。查无则回退显示 uin。 */
function useNickByUin(uin: string | null): string | null {
  const [nick, setNick] = useState<string | null>(null);
  useEffect(() => {
    setNick(null);
    if (!uin) return;
    let alive = true;
    void client.account.getProfileByUin
      .query({ uin })
      .then((p) => {
        if (alive) setNick(p?.nick || null);
      })
      .catch(() => {
        /* 离线 / 查无：保持 null，调用方回退 uin */
      });
    return () => {
      alive = false;
    };
  }, [uin]);
  return nick;
}

// ---- the wallet card -----------------------------------------------------

export function QqWallet({
  detail,
  redbagType,
  designatedUin,
}: {
  detail: unknown;
  /** 元素级 walletRedbagType（tag 48412）。 */
  redbagType?: unknown;
  /** 专属红包指定领取人 uin（tag 48420）。 */
  designatedUin?: unknown;
}): ReactElement {
  const d = detail && typeof detail === 'object' ? (detail as Record<string, unknown>) : {};
  // 细粒度类型（48412）优先；缺失时回退粗粒度嵌套类型（48442）。
  const fine = Number(redbagType);
  const fineKnown = Number.isFinite(fine) && fine > 0;
  const coarse = Number(d.redbagType);
  const title = str(d, 'redbagTitle');
  const prompt = str(d, 'openPrompt');

  const uin =
    designatedUin != null && String(designatedUin) !== '0' ? String(designatedUin) : null;
  const isDesignated = (fine === 8 || uin != null) && uin != null;
  const nick = useNickByUin(isDesignated ? uin : null);

  // redbagType 1 → 转账卡片。
  const isTransfer = fine === 1 || (!fineKnown && coarse === 1);
  if (isTransfer) {
    const amount = formatAmount(title);
    return (
      <div className="weq-transfer-card">
        <div className="weq-transfer-body">
          <div className="weq-transfer-icon-box">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#ffffff"
              strokeWidth="2.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ transform: 'rotate(45deg)' }}
              aria-hidden
            >
              <line x1="9" y1="5" x2="9" y2="19" />
              <polyline points="5 9 9 5 13 9" />
              <line x1="15" y1="19" x2="15" y2="5" />
              <polyline points="11 15 15 19 19 15" />
            </svg>
          </div>
          <div className="weq-transfer-info">
            <div className="weq-transfer-amount">{amount}</div>
            {prompt ? <div className="weq-transfer-remark">{prompt}</div> : null}
          </div>
        </div>
        <div className="weq-transfer-footer">转账</div>
      </div>
    );
  }

  // 口令红包（48412=6，或缺失时嵌套 48442=2）→ password_bag，其余 → normal_bag。
  const isPassword = fine === 6 || (!fineKnown && coarse === 2);
  const bagImage = isPassword ? 'password_bag.png' : 'normal_bag.png';
  const label = fineKnown ? REDBAG_LABEL[fine] : undefined;

  return (
    <div
      className={`weq-redbag-card${isDesignated ? ' weq-redbag-card--designated' : ''}`}
      title={title || undefined}
    >
      <img
        className="weq-redbag-img"
        src={resourceUrl('img', bagImage)}
        alt=""
        draggable={false}
      />
      {isDesignated ? (
        <div className="weq-redbag-tag weq-redbag-tag--designated">
          <QqAvatar uin={uin} size={22} className="weq-redbag-tag-avatar" />
          <span>给{nick || uin}的专属红包</span>
        </div>
      ) : label ? (
        <div className="weq-redbag-tag">{label}</div>
      ) : null}
      {title ? <span className="weq-redbag-title">{title}</span> : null}
    </div>
  );
}
