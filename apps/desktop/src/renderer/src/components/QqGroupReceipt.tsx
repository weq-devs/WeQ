/**
 * 群收款卡片组件（elementType=9, walletRedbagType=16）
 *
 * 渲染橙色卡片显示收款标题和当前用户需支付的金额。
 * 点击卡片弹出 Dialog 查看所有收款人详情（uin + 金额）。
 *
 * 数据结构：
 * - walletDetail.openPrompt: 收款标题（如"喵喵喵"）
 * - walletDetail.subTitle: "群收款"
 * - walletDetail.receiptList.payers: [{uin, amount}] 收款人列表（金额单位：分）
 */

import { useEffect, useState, type ReactElement } from 'react';
import { X } from 'lucide-react';
import { client } from '../trpc/client';
import { QqAvatar } from './QqAvatar';
import { Modal } from './Dialog';
import { useViewState } from '../state/view';
import { closeFromScrim } from '../im-template/template/modalUtils';

// ---- helpers -------------------------------------------------------------

function str(o: Record<string, unknown>, key: string): string {
  return typeof o[key] === 'string' ? (o[key] as string) : '';
}

/** 格式化金额（分 → 元），保留两位小数 */
function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}

// ---- 群收款详情 Dialog ----------------------------------------------------

interface ReceiptPayer {
  uin?: string;
  amount?: number;
}

function GroupReceiptDialog({
  title,
  payers,
  groupCode,
  onClose,
}: {
  title: string;
  payers: ReceiptPayer[];
  groupCode: string;
  onClose: () => void;
}): ReactElement {
  const [profiles, setProfiles] = useState<Record<string, { nick?: string; card?: string }>>({});

  // 批量获取群成员信息（payer.uin 是数字 QQ 号，用 getGroupMembersByUins 查）
  useEffect(() => {
    const uins = payers.map((p) => p.uin).filter(Boolean) as string[];
    if (uins.length === 0) return;

    void client.account.getGroupMembersByUins
      .query({ groupCode, uins })
      .then((members) => {
        const profileMap: Record<string, { nick?: string; card?: string }> = {};
        for (const member of members) {
          profileMap[member.uin] = {
            nick: member.nick,
            card: member.card,
          };
        }
        setProfiles(profileMap);
      })
      .catch((err) => {
        console.error('[GroupReceipt] Failed to fetch member profiles', err);
      });
  }, [payers, groupCode]);

  return (
    <Modal onClose={onClose} width={400}>
      <div className="weq-modal-scrim" onMouseDown={closeFromScrim(onClose)} />
      <div className="weq-group-receipt-dialog">
        {/* 标题栏 */}
        <div className="weq-group-receipt-dialog-header">
          <div className="weq-group-receipt-dialog-title-block">
            <span className="weq-group-receipt-dialog-tag">群收款</span>
            <span className="weq-group-receipt-dialog-title">{title || '收款'}</span>
          </div>
          <button className="weq-group-receipt-dialog-close" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        {/* 收款人列表 */}
        <div className="weq-group-receipt-list">
          {payers.map((payer) => {
            if (!payer.uin) return null;
            const profile = profiles[payer.uin];
            const displayName = profile?.card || profile?.nick || payer.uin;
            const amount = payer.amount ?? 0;
            return (
              <div key={payer.uin} className="weq-group-receipt-item">
                <QqAvatar uin={payer.uin} size={36} />
                <span className="weq-group-receipt-item-name">{displayName}</span>
                <span className="weq-group-receipt-item-amount">¥{formatAmount(amount)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}

// ---- 群收款卡片 ----------------------------------------------------------

export function QqGroupReceipt({
  detail,
  groupCode,
}: {
  detail: unknown;
  /** 当前群号（用于解析成员信息）*/
  groupCode?: string;
}): ReactElement {
  const [showDialog, setShowDialog] = useState(false);
  const openedUin = useViewState((s) => s.openedUin);
  const currentUserUin = openedUin ? String(openedUin) : null;

  const d = detail && typeof detail === 'object' ? (detail as Record<string, unknown>) : {};
  const title = str(d, 'openPrompt');
  const subTitle = str(d, 'subTitle');

  const receiptListRaw = d.receiptList as Record<string, unknown> | undefined;
  let payers: ReceiptPayer[] = [];

  if (receiptListRaw?.payers && Array.isArray(receiptListRaw.payers)) {
    payers = receiptListRaw.payers as ReceiptPayer[];
  }

  // 查找当前用户需支付的金额（payer.uin 是数字 QQ 号，openedUin 也是数字 QQ 号）
  const myPayer = currentUserUin ? payers.find((p) => p.uin === currentUserUin) : undefined;
  const myAmount = myPayer?.amount ?? null;

  const handleClick = () => {
    if (groupCode) {
      setShowDialog(true);
    }
  };

  return (
    <>
      <div className="weq-group-receipt-card" onClick={handleClick}>
        <div
          style={{ display: 'flex', alignItems: 'center', padding: '12px 14px 10px', gap: '12px' }}
        >
          <div className="weq-group-receipt-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="white">
              <text
                x="50%"
                y="58%"
                fontSize="16"
                fontWeight="bold"
                textAnchor="middle"
                dominantBaseline="middle"
              >
                ¥
              </text>
            </svg>
          </div>
          <div className="weq-group-receipt-content">
            <div className="weq-group-receipt-title">{title || '群收款'}</div>
            <div className="weq-group-receipt-amount">
              {myAmount !== null
                ? `你需支付${formatAmount(myAmount)}元`
                : `共${payers.length}人收款`}
            </div>
          </div>
        </div>
        <div className="weq-group-receipt-footer">{subTitle || '群收款'}</div>
      </div>

      {showDialog && groupCode && (
        <GroupReceiptDialog
          title={title}
          payers={payers}
          groupCode={groupCode}
          onClose={() => setShowDialog(false)}
        />
      )}
    </>
  );
}
