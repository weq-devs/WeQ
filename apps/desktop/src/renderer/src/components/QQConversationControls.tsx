import { useState } from 'react';
import {
  BellOff,
  ImageUp,
  MessagesSquare,
  MessageSquareText,
  Pin,
  Sparkles,
  RefreshCw,
  Tag,
  UserPen,
  UserRound,
  UserRoundCog,
  UsersRound,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { trpc } from '../trpc/client';
import { useQQAutoRefresh } from '../hooks/useQQAutoRefresh';
import { useQQWriteSession } from '../hooks/useQQWriteSession';
import { refreshGroupAvatar } from '../hooks/useAvatarUrl';
import { groupMemberEditing } from '../lib/groupMemberEditing';
import { Card } from './settings/controls';
import { useDialog } from './Dialog';
import { GroupActions } from './qq-actions/GroupActions';
import {
  QQWriteActionRow,
  QQWriteResult,
  QQWriteSelectRow,
  QQWriteTextRow,
  QQWriteToggleRow,
  qqWriteNeedsConfirmation,
} from './QQWriteControls';

export const GROUP_MESSAGE_POLICY_OPTIONS = [
  { value: 1, label: '正常提醒' },
  { value: 4, label: '接收但不提醒' },
  { value: 2, label: '收进群助手' },
  { value: 3, label: '屏蔽消息' },
] as const;

export function QQConversationControls({
  kind,
  conv,
  section = 'conversation',
}: {
  kind: 'c2c' | 'group';
  conv: string;
  section?: 'conversation' | 'group-management';
}) {
  const management = kind === 'group' && section === 'group-management';
  const autoRefresh = useQQAutoRefresh(true);
  const session = useQQWriteSession(`${kind}:${conv}`);
  const target = kind === 'c2c' ? { kind, uid: conv } : { kind, groupId: Number(conv) };
  const queryInput = {
    expectedAccountUin: session.binding?.expectedAccountUin ?? '',
    expectedAccountConfigId: session.binding?.expectedAccountConfigId ?? '',
    target,
  };
  const snapshot = trpc.account.qqWrite.peerState.useQuery(queryInput, {
    ...autoRefresh,
    enabled: autoRefresh.enabled && Boolean(session.binding),
  });
  const policySnapshot = trpc.account.qqWrite.groupPolicyState.useQuery(
    {
      expectedAccountUin: session.binding?.expectedAccountUin ?? '',
      expectedAccountConfigId: session.binding?.expectedAccountConfigId ?? '',
      groupId: kind === 'group' ? Number(conv) : 0,
    },
    {
      ...autoRefresh,
      enabled: autoRefresh.enabled && kind === 'group' && !management && session.available,
      refetchOnMount: 'always',
      refetchOnWindowFocus: false,
    },
  );
  const categories = trpc.account.listCategories.useQuery(undefined, { enabled: kind === 'c2c' });
  const remark = trpc.account.qqWrite.friendRemark.useMutation();
  const groupRemark = trpc.account.qqWrite.groupRemark.useMutation();
  const pin = trpc.account.qqWrite.pin.useMutation();
  const disturb = trpc.account.qqWrite.friendDisturb.useMutation();
  const policy = trpc.account.qqWrite.groupMessagePolicy.useMutation();
  const category = trpc.account.qqWrite.friendCategory.useMutation();
  const groupName = trpc.account.qqWrite.groupName.useMutation();
  const card = trpc.account.qqWrite.groupMemberCard.useMutation();
  const title = trpc.account.qqWrite.groupSpecialTitle.useMutation();
  const avatar = trpc.account.qqWrite.groupAvatar.useMutation();
  const picker = trpc.account.pickSendFile.useMutation();
  const confirm = useDialog((state) => state.confirm);
  const [revision, setRevision] = useState(0);
  const [picking, setPicking] = useState(false);
  const [pickerError, setPickerError] = useState('');
  const state = snapshot.data;
  const ownEditing = groupMemberEditing(state?.role, state?.role);
  const disabled = session.busy || !session.available || !state || picking;
  const friendDisabled = disabled || !state?.friend;
  async function refresh(includePolicy = false) {
    const result = await snapshot.refetch();
    if (result.error) throw result.error;
    if (includePolicy && kind === 'group' && !management) {
      const policyResult = await policySnapshot.refetch();
      if (policyResult.error) throw policyResult.error;
    }
  }
  const act = (action: Parameters<typeof session.run>[0]) => session.run(action, refresh);
  function changePeerToggle(field: 'pinned' | 'friendDisturb', enabled: boolean) {
    return session.run(
      (binding) =>
        field === 'pinned'
          ? pin.mutateAsync({ ...binding, target, enabled })
          : disturb.mutateAsync({ ...binding, uid: conv, enabled }),
      refresh,
      {
        profileUid: field === 'friendDisturb' ? conv : undefined,
        requireReadback: true,
        readbackSuccessText: `${field === 'pinned' ? '置顶' : '免打扰'}状态已与本机 QQ 核对一致`,
        readback: async () => {
          const updated = await snapshot.refetch();
          if (updated.error) throw updated.error;
          return updated.data?.[field] === enabled;
        },
      },
    );
  }
  async function changePolicy(value: number): Promise<boolean> {
    if (value !== 1 && value !== 2 && value !== 3 && value !== 4) return false;
    if (
      qqWriteNeedsConfirmation(value) &&
      !(await confirm(
        value === 3 ? '屏蔽群消息' : '收进群助手',
        '将修改 QQ 的群消息接收策略，是否继续？',
      ))
    )
      return false;
    return session.run(
      (binding) => policy.mutateAsync({ ...binding, groupId: Number(conv), policy: value }),
      undefined,
      {
        readback: async () => {
          const [remote, local] = await Promise.all([policySnapshot.refetch(), snapshot.refetch()]);
          if (remote.error) throw remote.error;
          if (local.error) throw local.error;
          return remote.data?.policy === value;
        },
      },
    );
  }
  async function pickAvatar() {
    setPicking(true);
    setPickerError('');
    try {
      const file = await picker.mutateAsync({ kind: 'image' });
      if (file) {
        const saved = await act((binding) =>
          avatar.mutateAsync({ ...binding, groupId: Number(conv), source: file.path }),
        );
        if (saved) refreshGroupAvatar(conv);
      }
    } catch (error) {
      setPickerError(error instanceof Error ? error.message : String(error));
    } finally {
      setPicking(false);
    }
  }
  return (
    <div
      className="weq-qq-write-panel"
      key={`${session.binding?.expectedAccountUin}:${session.binding?.expectedAccountConfigId}:${kind}:${conv}`}
    >
      <div className="weq-qq-write-toolbar">
        <span className="weq-qq-write-status">
          {session.available ? (
            <Wifi size={13} strokeWidth={2} aria-hidden />
          ) : (
            <WifiOff size={13} strokeWidth={2} aria-hidden />
          )}
          {session.available ? 'QQ 在线' : 'QQ 在线能力未就绪'}
        </span>
        {(snapshot.error || (kind === 'group' && policySnapshot.error)) && (
          <button
            type="button"
            className="weq-set-iconbtn"
            title="重试读取"
            aria-label="重试读取 QQ 会话设置"
            disabled={
              session.busy ||
              picking ||
              snapshot.isFetching ||
              (kind === 'group' && policySnapshot.isFetching)
            }
            onClick={() => {
              void refresh(true)
                .then(() => setRevision((value) => value + 1))
                .catch(() => {});
            }}
          >
            <RefreshCw size={16} />
          </button>
        )}
      </div>
      {snapshot.error && <p role="alert">{snapshot.error.message}</p>}
      {kind === 'group' && !management && policySnapshot.error && (
        <p role="alert">消息策略读取失败：{policySnapshot.error.message}</p>
      )}
      {kind === 'group' &&
        !management &&
        policySnapshot.data?.policy != null &&
        state?.notifyLevel != null &&
        policySnapshot.data.policy !== state.notifyLevel && (
          <p role="status">服务端与本机消息策略尚未同步</p>
        )}
      {pickerError && <p role="alert">{pickerError}</p>}
      <QQWriteResult result={session.result} />
      {state && (
        <div key={`${kind}:${conv}:${revision}`}>
          {!management && (
            <Card
              title={kind === 'group' ? '群会话' : '好友会话'}
              icon={<MessageSquareText size={15} strokeWidth={1.9} />}
            >
              <QQWriteTextRow
                label={kind === 'group' ? '群备注' : '好友备注'}
                icon={<UserPen size={14} strokeWidth={1.8} />}
                initial={state.remark}
                disabled={kind === 'c2c' ? friendDisabled : disabled}
                onSave={(value) =>
                  session.run(
                    (binding) =>
                      kind === 'c2c'
                        ? remark.mutateAsync({ ...binding, uid: conv, remark: value })
                        : groupRemark.mutateAsync({
                            ...binding,
                            groupId: Number(conv),
                            remark: value,
                          }),
                    undefined,
                    {
                      profileUid: kind === 'c2c' ? conv : undefined,
                      readback: async () => {
                        const updated = await snapshot.refetch();
                        if (updated.error) throw updated.error;
                        return updated.data?.remark === value;
                      },
                    },
                  )
                }
              />
              <QQWriteToggleRow
                label="置顶会话"
                icon={<Pin size={14} strokeWidth={1.8} />}
                initial={state.pinned}
                disabled={kind === 'c2c' ? friendDisabled : disabled}
                onSave={(enabled) => changePeerToggle('pinned', enabled)}
              />
              {kind === 'c2c' ? (
                <>
                  {/* 只采用好友资料的明确布尔值，不从 recent_contact 提醒级别推断。 */}
                  <QQWriteToggleRow
                    label="消息免打扰"
                    icon={<BellOff size={14} strokeWidth={1.8} />}
                    initial={state.friendDisturb ?? null}
                    disabled={friendDisabled}
                    onSave={(enabled) => changePeerToggle('friendDisturb', enabled)}
                  />
                  <QQWriteSelectRow
                    label="好友分组"
                    icon={<Tag size={14} strokeWidth={1.8} />}
                    initial={state.categoryId}
                    disabled={friendDisabled || categories.isLoading}
                    options={[
                      { value: 0, label: '默认分组' },
                      ...(categories.data ?? [])
                        .filter((item) => item.id !== 0)
                        .map((item) => ({ value: item.id, label: item.name })),
                    ]}
                    onSave={(categoryId) =>
                      session.run(
                        (binding) => category.mutateAsync({ ...binding, uid: conv, categoryId }),
                        async () => {
                          const updated = await categories.refetch();
                          if (updated.error) throw updated.error;
                        },
                        {
                          profileUid: conv,
                          readback: async () => {
                            const updated = await snapshot.refetch();
                            if (updated.error) throw updated.error;
                            return updated.data?.categoryId === categoryId;
                          },
                        },
                      )
                    }
                  />
                </>
              ) : (
                <QQWriteSelectRow
                  label="消息接收"
                  icon={<BellOff size={14} strokeWidth={1.8} />}
                  autoSave
                  initial={policySnapshot.data?.rawPolicy ?? null}
                  options={GROUP_MESSAGE_POLICY_OPTIONS}
                  disabled={disabled || policySnapshot.isFetching || !policySnapshot.data}
                  onSave={changePolicy}
                />
              )}
            </Card>
          )}
          {kind === 'group' && !management && (
            <Card title="我的群身份" icon={<UserRoundCog size={15} strokeWidth={1.9} />}>
              <QQWriteTextRow
                label="我在本群的昵称"
                icon={<UserRound size={14} strokeWidth={1.8} />}
                readOnly={!ownEditing.card}
                initial={state.selfCard}
                disabled={disabled || !state.selfUid}
                onSave={(value) =>
                  session.run(
                    (binding) =>
                      card.mutateAsync({
                        ...binding,
                        groupId: Number(conv),
                        targetUid: state.selfUid,
                        card: value,
                      }),
                    undefined,
                    {
                      groupCode: conv,
                      memberUid: state.selfUid,
                      readback: async () => {
                        const updated = await snapshot.refetch();
                        if (updated.error) throw updated.error;
                        return updated.data?.selfCard === value;
                      },
                    },
                  )
                }
              />
              <QQWriteTextRow
                label="我的专属头衔"
                icon={<Sparkles size={14} strokeWidth={1.8} />}
                initial={state.selfTitle}
                readOnly={state.role !== 'owner'}
                disabled={disabled || !state.selfUid}
                onSave={(value) =>
                  session.run(
                    (binding) =>
                      title.mutateAsync({
                        ...binding,
                        groupId: Number(conv),
                        targetUid: state.selfUid,
                        title: value,
                      }),
                    undefined,
                    {
                      groupCode: conv,
                      memberUid: state.selfUid,
                      readback: async () => {
                        const updated = await snapshot.refetch();
                        if (updated.error) throw updated.error;
                        return updated.data?.selfTitle === value;
                      },
                    },
                  )
                }
              />
            </Card>
          )}
          {management && (
            <Card title="群资料" icon={<UsersRound size={15} strokeWidth={1.9} />}>
              <QQWriteTextRow
                label="群名称"
                icon={<MessagesSquare size={14} strokeWidth={1.8} />}
                allowEmpty={false}
                initial={state.groupName}
                disabled={disabled}
                onSave={(value) =>
                  act((binding) =>
                    groupName.mutateAsync({ ...binding, groupId: Number(conv), name: value }),
                  )
                }
              />
              <QQWriteActionRow
                label="更换群头像"
                disabled={disabled}
                icon={<ImageUp size={15} />}
                onClick={() => {
                  void pickAvatar();
                }}
              />
            </Card>
          )}
          {management && <GroupActions key={conv} groupId={Number(conv)} />}
        </div>
      )}
    </div>
  );
}
