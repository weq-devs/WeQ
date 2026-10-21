import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import type { NoticeOperation } from '../../lib/contactNotice';
import { ActionFeedback, useQQAction } from './shared';

/** 同一弹窗共用两类收件箱，卡片不逐个发起在线读取。 */
export function useNoticeOperations(group: boolean, open: boolean) {
  const a = useQQAction(`requests:${group ? 'group' : 'friend'}`);
  const options = useQQAutoRefresh(open && a.available);
  const normal = trpc.account.qqActions.requests.useQuery(
    { ...a.binding!, kind: group ? 'group' : 'friend' },
    options,
  );
  const filtered = trpc.account.qqActions.requests.useQuery(
    { ...a.binding!, kind: group ? 'filteredGroup' : 'doubtFriend' },
    options,
  );
  const operations: NoticeOperation[] = a.available
    ? [
        ...(normal.data ?? []).map((r) => ({
          ...r,
          kind: group ? ('group' as const) : ('friend' as const),
        })),
        ...(filtered.data ?? []).map((r) => ({
          ...r,
          kind: group ? ('filteredGroup' as const) : ('doubtFriend' as const),
        })),
      ]
    : [];
  return { operations, error: normal.error?.message || filtered.error?.message };
}

export function RequestActions({ operation }: { operation: NoticeOperation }) {
  const a = useQQAction(`request:${operation.kind}:${operation.token}`);
  const utils = trpc.useUtils();
  const [handled, setHandled] = useState(false);
  const [reason, setReason] = useState('');
  if (handled) return <ActionFeedback action={a} />;
  return (
    <div className="notice-request-actions">
      {operation.groupId && (
        <input
          aria-label="拒绝理由"
          placeholder="拒绝理由（可选）"
          maxLength={256}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      )}
      <div className="notice-request-buttons">
        {[true, false].map((approve) => (
          <button
            type="button"
            key={String(approve)}
            aria-label={approve ? '同意申请' : '拒绝申请'}
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
      <ActionFeedback action={a} />
    </div>
  );
}
