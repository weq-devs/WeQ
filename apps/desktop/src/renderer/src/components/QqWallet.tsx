/**
 * Renders a `wallet` element (QQ 钱包：转账 / 红包) from its `walletDetail`.
 *
 * The kind is decided by `walletDetail.redbagType`:
 *   - 1 → 转账 (transfer): the blue card ported from the demo. The amount line
 *         comes from `redbagTitle`, the note from `openPrompt`, footer is 转账.
 *   - 2 → 口令红包 (password packet): the `password_bag.png` bag, `redbagTitle`
 *         written cream-coloured dead-centre.
 *   - 4 → 普通红包 (normal packet): the `normal_bag.png` bag, same overlay.
 *   - anything else → treated as 4 (normal packet).
 *
 * `walletDetail` already reaches the renderer via mapWallet (no backend change).
 * Bag images live in the repo `resources/img/` tree and are served over
 * `weq-asset://` (CSP-allowed); we never hit the network.
 */

import type { ReactElement } from 'react';
import { resourceUrl } from '../lib/resourceUrl';

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

// ---- the wallet card -----------------------------------------------------

export function QqWallet({
  detail,
  fallbackType,
}: {
  detail: unknown;
  fallbackType?: unknown;
}): ReactElement {
  const d = detail && typeof detail === 'object' ? (detail as Record<string, unknown>) : {};
  const type = Number(d.redbagType ?? fallbackType);
  const title = str(d, 'redbagTitle');
  const prompt = str(d, 'openPrompt');

  // redbagType 1 → 转账卡片。
  if (type === 1) {
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

  // 其余按红包处理：2 → 口令红包，其它(含 4) → 普通红包。
  const bagImage = type === 2 ? 'password_bag.png' : 'normal_bag.png';
  return (
    <div className="weq-redbag-card" title={title || undefined}>
      <img className="weq-redbag-img" src={resourceUrl('img', bagImage)} alt="" draggable={false} />
      {title ? <span className="weq-redbag-title">{title}</span> : null}
    </div>
  );
}
