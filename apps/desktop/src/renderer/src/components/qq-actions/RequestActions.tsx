import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import type { NoticeOperation } from '../../lib/contactNotice';
import { ActionFeedback } from './shared';
import { useQQAction } from './shared.shared';

/** 处理后的回执沿用审核区容器，避免在通知网格中落入头像列。 */
export function RequestActions({ operation }: { operation: NoticeOperation }) {
  const a = useQQAction(`request:${operation.kind}:${operation.token}`);
  const utils = trpc.useUtils();
  const [handled, setHandled] = useState(false);
  const [reason, setReason] = useState('');
  return (
    <div className="notice-request-actions">
      {!handled && operation.groupId && (
        <input
          aria-label="拒绝理由"
          placeholder="拒绝理由（可选）"
          maxLength={256}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      )}
      {!handled && (
        <div className="notice-request-buttons">
          {[true, false].map((approve) => (
            <button
              type="button"
              key={String(approve)}
              aria-label={approve ? '同意申请' : '拒绝申请'}
              data-danger={approve ? undefined : 'outline'}
              disabled={a.disabled}
              onClick={() =>
                void a.perform(
                  (b) =>
                    client.account.qqActions.request.mutate({
                      ...b,
                      kind: operation.kind,
                      token: operation.token,
                      approve,
                      reason,
                    }),
                  async () => {
                    setHandled(true);
                    await (operation.groupId
                      ? utils.account.listGroupNotifies.invalidate()
                      : utils.account.listBuddyRequests.invalidate());
                    await utils.account.qqActions.requests.invalidate();
                  },
                  `${approve ? '同意' : '拒绝'} ${operation.name}${operation.groupId ? ` 加入 ${operation.groupName}` : ' 的好友申请'}？`,
                  {
                    danger: approve ? undefined : 'outline',
                    readback: async () => {
                      const rows = await client.account.qqActions.requests.query({
                        ...a.binding!,
                        kind: operation.kind,
                      });
                      return !rows.some((row) => row.token === operation.token);
                    },
                  },
                )
              }
            >
              {approve ? <Check size={14} /> : <X size={14} />}
              {approve ? '同意' : '拒绝'}
            </button>
          ))}
        </div>
      )}
      <ActionFeedback action={a} />
    </div>
  );
}
