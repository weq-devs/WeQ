import { useState } from 'react';
import { trpc } from '../trpc/client';
import { useQQWriteSession } from '../hooks/useQQWriteSession';
import { QQWriteResult, QQWriteTextRow } from './QQWriteControls';

export function QQGroupMemberControls({ groupCode, uid }: { groupCode: string; uid: string }) {
  const [open, setOpen] = useState(false);
  if (!/^u_[A-Za-z0-9_-]+$/.test(uid) || !/^[1-9]\d*$/.test(groupCode)) return null;
  return (
    <details className="weq-qq-member-edit" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>群名片与头衔</summary>
      {open && <QQGroupMemberEditor key={`${groupCode}:${uid}`} groupCode={groupCode} uid={uid} />}
    </details>
  );
}

export function QQGroupMemberEditor({
  groupCode,
  uid,
  field = 'all',
}: {
  groupCode: string;
  uid: string;
  field?: 'all' | 'title';
}) {
  const session = useQQWriteSession(`member:${groupCode}:${uid}`);
  const groupId = Number(groupCode);
  const state = trpc.account.qqWrite.memberState.useQuery(
    {
      expectedAccountUin: session.binding?.expectedAccountUin ?? '',
      expectedAccountConfigId: session.binding?.expectedAccountConfigId ?? '',
      groupId,
      uid,
    },
    { enabled: Boolean(session.binding), refetchOnMount: 'always', staleTime: 0 },
  );
  const card = trpc.account.qqWrite.groupMemberCard.useMutation();
  const title = trpc.account.qqWrite.groupSpecialTitle.useMutation();
  const disabled = !session.available || session.busy;
  return (
    <div className="weq-qq-write-panel">
      <QQWriteResult result={session.result} />
      {state.error && <p role="alert">{state.error.message}</p>}
      <div key={`${session.binding?.expectedAccountConfigId}:${uid}`}>
        {field === 'all' && (
          <QQWriteTextRow
            label="群名片"
            initial={state.data?.card ?? null}
            disabled={disabled}
            maxLength={256}
            onSave={(value) =>
              session.run(
                (binding) => card.mutateAsync({ ...binding, groupId, targetUid: uid, card: value }),
                undefined,
                {
                  groupCode,
                  memberUid: uid,
                  readback: async () => {
                    const updated = await state.refetch();
                    if (updated.error) throw updated.error;
                    return updated.data?.card === value;
                  },
                },
              )
            }
          />
        )}
        <QQWriteTextRow
          label="专属头衔"
          initial={state.data?.title ?? null}
          readOnly={state.data?.role !== 'owner'}
          disabled={disabled}
          maxLength={256}
          onSave={(value) =>
            session.run(
              (binding) => title.mutateAsync({ ...binding, groupId, targetUid: uid, title: value }),
              undefined,
              {
                groupCode,
                memberUid: uid,
                readback: async () => {
                  const updated = await state.refetch();
                  if (updated.error) throw updated.error;
                  return updated.data?.title === value;
                },
              },
            )
          }
        />
      </div>
    </div>
  );
}
