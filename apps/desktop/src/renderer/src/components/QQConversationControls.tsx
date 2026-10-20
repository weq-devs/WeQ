import { useState } from 'react';
import { ImageUp, RefreshCw } from 'lucide-react';
import { trpc } from '../trpc/client';
import { useQQWriteSession } from '../hooks/useQQWriteSession';
import { refreshGroupAvatar } from '../hooks/useAvatarUrl';
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
  const session = useQQWriteSession(`${kind}:${conv}`);
  const target = kind === 'c2c' ? { kind, uid: conv } : { kind, groupId: Number(conv) };
  const queryInput = {
    expectedAccountUin: session.binding?.expectedAccountUin ?? '',
    expectedAccountConfigId: session.binding?.expectedAccountConfigId ?? '',
    target,
  };
  const snapshot = trpc.account.qqWrite.peerState.useQuery(queryInput, {
    enabled: Boolean(session.binding),
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });
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
  const disabled = session.busy || !session.available || !state || picking;
  const friendDisabled = disabled || !state?.friend;
  async function refresh() {
    const result = await snapshot.refetch();
    if (result.error) throw result.error;
  }
  const act = (action: Parameters<typeof session.run>[0]) => session.run(action, refresh);
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
    return act((binding) =>
      policy.mutateAsync({ ...binding, groupId: Number(conv), policy: value }),
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
    <div className="weq-qq-write-panel" key={`${kind}:${conv}`}>
      <div className="weq-qq-write-toolbar">
        <span>{session.available ? 'QQ 在线' : 'QQ 在线能力未就绪'}</span>
        <button
          type="button"
          className="weq-set-iconbtn"
          title="重新读取"
          aria-label="重新读取 QQ 会话设置"
          disabled={session.busy || picking || snapshot.isFetching}
          onClick={() => {
            void refresh()
              .then(() => setRevision((value) => value + 1))
              .catch(() => {});
          }}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {snapshot.error && <p role="alert">{snapshot.error.message}</p>}
      {pickerError && <p role="alert">{pickerError}</p>}
      <QQWriteResult result={session.result} />
      {state && (
        <div key={`${kind}:${conv}:${revision}`}>
          {!management && (
            <Card>
              <QQWriteTextRow
                label={kind === 'group' ? '群备注' : '好友备注'}
                initial={state.remark}
                disabled={kind === 'c2c' ? friendDisabled : disabled}
                onSave={(value) =>
                  act((binding) =>
                    kind === 'c2c'
                      ? remark.mutateAsync({ ...binding, uid: conv, remark: value })
                      : groupRemark.mutateAsync({
                          ...binding,
                          groupId: Number(conv),
                          remark: value,
                        }),
                  )
                }
              />
              <QQWriteToggleRow
                label="置顶会话"
                initial={state.pinned}
                disabled={kind === 'c2c' ? friendDisabled : disabled}
                onSave={(enabled) =>
                  act((binding) => pin.mutateAsync({ ...binding, target, enabled }))
                }
              />
              {kind === 'c2c' ? (
                <>
                  <QQWriteToggleRow
                    label="消息免打扰"
                    initial={
                      state.notifyLevel === null
                        ? null
                        : state.notifyLevel !== 0 && state.notifyLevel !== 1
                    }
                    disabled={friendDisabled}
                    onSave={(enabled) =>
                      act((binding) => disturb.mutateAsync({ ...binding, uid: conv, enabled }))
                    }
                  />
                  <QQWriteSelectRow
                    label="好友分组"
                    initial={state.categoryId}
                    disabled={friendDisabled || categories.isLoading}
                    options={[
                      { value: 0, label: '默认分组' },
                      ...(categories.data ?? [])
                        .filter((item) => item.id !== 0)
                        .map((item) => ({ value: item.id, label: item.name })),
                    ]}
                    onSave={(categoryId) =>
                      act((binding) => category.mutateAsync({ ...binding, uid: conv, categoryId }))
                    }
                  />
                </>
              ) : (
                <QQWriteSelectRow
                  label="消息接收"
                  initial={state.notifyLevel}
                  options={GROUP_MESSAGE_POLICY_OPTIONS}
                  disabled={disabled}
                  onSave={changePolicy}
                />
              )}
            </Card>
          )}
          {kind === 'group' && !management && (
            <Card>
              <QQWriteTextRow
                label="我在本群的昵称"
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
                initial={state.selfTitle}
                readOnly={state.role !== 'owner'}
                disabled={disabled || !state.selfUid}
                onSave={(value) =>
                  act((binding) =>
                    title.mutateAsync({
                      ...binding,
                      groupId: Number(conv),
                      targetUid: state.selfUid,
                      title: value,
                    }),
                  )
                }
              />
            </Card>
          )}
          {management && (
            <Card>
              <QQWriteTextRow
                label="群名称"
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
