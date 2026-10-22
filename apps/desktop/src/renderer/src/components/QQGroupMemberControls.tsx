import { BadgeCheck, Check, Pencil, RefreshCw, UserRound, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { trpc } from '../trpc/client';
import { useQQWriteSession } from '../hooks/useQQWriteSession';
import { QQWriteResult, QQWriteTextRow } from './QQWriteControls';
import { useQQAutoRefresh } from '../hooks/useQQAutoRefresh';
import { groupMemberEditing } from '../lib/groupMemberEditing';
import { ProfileRow } from '../im-template/template/profilePanes';
import '../styles/group-member-edit.css';

export function QQGroupMemberControls({
  groupCode,
  uid,
  profile,
}: {
  groupCode: string;
  uid: string;
  profile?: { card?: string; title?: string };
}) {
  if (!/^u_[A-Za-z0-9_-]+$/.test(uid) || !/^[1-9]\d*$/.test(groupCode)) return null;
  return (
    <QQGroupMemberEditor
      key={`${groupCode}:${uid}`}
      groupCode={groupCode}
      uid={uid}
      profile={profile}
    />
  );
}

export function QQGroupMemberEditor({
  groupCode,
  uid,
  field = 'all',
  profile,
}: {
  groupCode: string;
  uid: string;
  field?: 'all' | 'title';
  profile?: { card?: string; title?: string };
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
  const permissions = groupMemberEditing(
    matched ? state.data?.role : null,
    state.data?.targetRole,
    matched && state.data?.isSelf === true,
  );
  const disabled = !session.available || session.busy;
  if (!valid) return null;
  if (profile)
    return (
      <div
        className="weq-qq-member-profile"
        key={`${session.binding?.expectedAccountUin}:${session.binding?.expectedAccountConfigId}:${groupCode}:${uid}`}
      >
        <MemberProfileField
          label="群昵称"
          icon={<UserRound size={13} />}
          initial={matched ? (state.data?.card ?? '') : (profile.card ?? '')}
          editable={matched && permissions.card}
          disabled={disabled}
          onSave={(value) =>
            session.run(
              (binding) => card.mutateAsync({ ...binding, groupId, targetUid: uid, card: value }),
              undefined,
              {
                groupCode,
                memberUid: uid,
                readbackSuccessText: value ? '群昵称已保存' : '群昵称已清空',
                readback: async () => {
                  const updated = await state.refetch();
                  if (updated.error) throw updated.error;
                  return updated.data?.card === value;
                },
              },
            )
          }
        />
        <MemberProfileField
          label="专属头衔"
          icon={<BadgeCheck size={13} />}
          initial={matched ? (state.data?.title ?? '') : (profile.title ?? '')}
          editable={matched && permissions.title}
          disabled={disabled}
          onSave={(value) =>
            session.run(
              (binding) => title.mutateAsync({ ...binding, groupId, targetUid: uid, title: value }),
              undefined,
              {
                groupCode,
                memberUid: uid,
                readbackSuccessText: value ? '专属头衔已保存' : '专属头衔已清空',
                readback: async () => {
                  const updated = await state.refetch();
                  if (updated.error) throw updated.error;
                  return updated.data?.title === value;
                },
              },
            )
          }
        />
        <QQWriteResult result={session.result} />
        {state.error ? (
          <p role="alert" className="weq-qq-write-result">
            {state.error.message}
            <button
              type="button"
              className="weq-set-iconbtn"
              aria-label="重试读取成员权限"
              title="重试读取成员权限"
              disabled={state.isFetching || !session.binding}
              onClick={() => void state.refetch()}
            >
              <RefreshCw size={15} />
            </button>
          </p>
        ) : null}
      </div>
    );
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
        <h4 className="weq-qq-member-edit-title">群昵称与头衔</h4>
      )}
      <QQWriteResult result={session.result} />
      {state.error && <p role="alert">{state.error.message}</p>}
      <div
        key={`${session.binding?.expectedAccountUin}:${session.binding?.expectedAccountConfigId}:${groupCode}:${uid}`}
      >
        {field === 'all' && permissions.card && (
          <QQWriteTextRow
            label="群昵称"
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
                  readbackSuccessText: value ? '群昵称已保存' : '群昵称已清空',
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
                  readbackSuccessText: value ? '专属头衔已保存' : '专属头衔已清空',
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

function MemberProfileField({
  label,
  icon,
  initial,
  editable,
  disabled,
  onSave,
}: {
  label: string;
  icon: ReactNode;
  initial: string;
  editable: boolean;
  disabled: boolean;
  onSave: (value: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initial);
  return editing && editable ? (
    <form
      className="weq-member-inline-field"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled)
          void onSave(draft).then((ok) => {
            if (ok) setEditing(false);
          });
      }}
    >
      <label>
        <span>
          {icon}
          {label}
        </span>
        <input
          aria-label={label}
          value={draft}
          maxLength={256}
          disabled={disabled}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <button
        type="submit"
        className="weq-profile-row-copy"
        aria-label={`保存${label}`}
        title={`保存${label}`}
        disabled={disabled}
      >
        <Check size={14} />
      </button>
      <button
        type="button"
        className="weq-profile-row-copy"
        aria-label={`取消编辑${label}`}
        title="取消编辑"
        disabled={disabled}
        onClick={() => setEditing(false)}
      >
        <X size={14} />
      </button>
    </form>
  ) : (
    <ProfileRow
      icon={icon}
      label={label}
      value={initial || '未设置'}
      action={
        editable ? (
          <button
            type="button"
            className="weq-profile-row-copy"
            aria-label={`编辑${label}`}
            title={`编辑${label}`}
            disabled={disabled}
            onClick={() => {
              setDraft(initial);
              setEditing(true);
            }}
          >
            <Pencil size={13} />
          </button>
        ) : undefined
      }
    />
  );
}
