import { RefreshCw } from 'lucide-react';
import { trpc } from '../trpc/client';
import { useQQWriteSession } from '../hooks/useQQWriteSession';
import { QQWriteResult, QQWriteTextRow } from './QQWriteControls';
import { useQQAutoRefresh } from '../hooks/useQQAutoRefresh';
import { groupMemberEditing } from '../lib/groupMemberEditing';
import '../styles/group-member-edit.css';

export function QQGroupMemberControls({ groupCode, uid }: { groupCode: string; uid: string }) {
  if (!/^u_[A-Za-z0-9_-]+$/.test(uid) || !/^[1-9]\d*$/.test(groupCode)) return null;
  return <QQGroupMemberEditor key={`${groupCode}:${uid}`} groupCode={groupCode} uid={uid} />;
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
  const valid =
    /^u_[A-Za-z0-9_-]+$/.test(uid) &&
    /^[1-9]\d*$/.test(groupCode) &&
    Number.isSafeInteger(groupId) &&
    groupId > 0 &&
    groupId <= 0xffffffff;
  const autoRefresh = useQQAutoRefresh(Boolean(session.binding) && valid);
  const state = trpc.account.qqWrite.memberState.useQuery(
    {
      expectedAccountUin: session.binding?.expectedAccountUin ?? '',
      expectedAccountConfigId: session.binding?.expectedAccountConfigId ?? '',
      groupId,
      uid,
    },
    autoRefresh,
  );
  const card = trpc.account.qqWrite.groupMemberCard.useMutation();
  const title = trpc.account.qqWrite.groupSpecialTitle.useMutation();
  const matched = state.data?.uid === uid;
  const permissions = groupMemberEditing(matched ? state.data?.role : null, state.data?.targetRole);
  const disabled = !session.available || session.busy;
  if (!valid) return null;
  if (
    !matched ||
    (!permissions.card && !permissions.title) ||
    (field === 'title' && !permissions.title)
  ) {
    if (state.error)
      return (
        <p role="alert" className="weq-qq-write-result">
          {state.error.message}
          <button
            type="button"
            className="weq-set-iconbtn"
            title="重试读取成员权限"
            aria-label="重试读取成员权限"
            disabled={state.isFetching || !session.binding}
            onClick={() => void state.refetch()}
          >
            <RefreshCw size={15} />
          </button>
        </p>
      );
    return field === 'title' && matched ? (
      <p role="status" className="weq-qq-write-result">
        当前角色不能修改该成员头衔
      </p>
    ) : (
      <QQWriteResult result={session.result} />
    );
  }
  return (
    <section
      className={`weq-qq-write-panel weq-qq-member-editor${field === 'all' ? ' weq-qq-member-edit' : ''}`}
      aria-label="群成员资料编辑"
    >
      {field === 'all' && permissions.title && (
        <h4 className="weq-qq-member-edit-title">群名片与头衔</h4>
      )}
      <QQWriteResult result={session.result} />
      {state.error && <p role="alert">{state.error.message}</p>}
      <div
        key={`${session.binding?.expectedAccountUin}:${session.binding?.expectedAccountConfigId}:${groupCode}:${uid}`}
      >
        {field === 'all' && permissions.card && (
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
        {permissions.title && (
          <QQWriteTextRow
            label="专属头衔"
            initial={state.data?.title ?? null}
            disabled={disabled}
            maxLength={256}
            onSave={(value) =>
              session.run(
                (binding) =>
                  title.mutateAsync({ ...binding, groupId, targetUid: uid, title: value }),
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
        )}
      </div>
    </section>
  );
}
