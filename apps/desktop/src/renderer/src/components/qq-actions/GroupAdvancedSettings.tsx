import { useState } from 'react';
import { client, trpc } from '../../trpc/client';
import { FormSelect } from '../FormSelect';
import { Row } from '../settings/controls';
import { ActionFeedback } from './shared';
import { useQQAction } from './shared.shared';

const switches = [
  ['searchByName', '允许通过关键词搜索'],
  ['searchByNumber', '允许通过群号搜索'],
  ['newMemberHistory', '新成员可查看历史消息'],
  ['allowMemberTemporarySession', '允许成员发起临时会话'],
  ['allowMemberCreateGroup', '允许成员发起群聊'],
  ['allowMemberUploadAlbum', '允许成员上传群相册'],
  ['robotMemberSwitch', '允许邀请群机器人'],
  ['robotMemberExamine', '群机器人入群需要审核'],
] as const;
const inviteModes = {
  disabled: '禁止成员邀请',
  require_approval: '需要审核',
  no_approval: '无需审核',
  no_approval_under_100: '群人数不足 100 时无需审核',
} as const;
type Change =
  | { key: (typeof switches)[number][0]; value: boolean }
  | { key: 'invitePolicy'; value: keyof typeof inviteModes };

function Options({ groupId }: { groupId: number }) {
  const action = useQQAction(`group-advanced-settings:${groupId}`);
  const query = trpc.account.qqActions.groupAdvancedSettings.useQuery(
    { ...action.binding!, groupId },
    { enabled: action.available, refetchOnWindowFocus: false, retry: false },
  );
  const disabled = action.disabled || query.isFetching || query.isError;
  function update(change: Change) {
    void action.perform(
      (binding) =>
        client.account.qqActions.setGroupAdvancedSetting.mutate({ ...binding, groupId, change }),
      undefined,
      undefined,
      {
        requireReadback: true,
        readback: async () => {
          const result = await query.refetch();
          if (result.error) throw result.error;
          return result.data?.[change.key] === change.value;
        },
      },
    );
  }
  return (
    <div className="weq-join-settings">
      {switches.map(([key, label]) => {
        const value = query.data?.[key];
        return (
          <Row
            key={key}
            label={label}
            control={
              <FormSelect
                aria-label={label}
                value={value == null ? '' : String(value)}
                disabled={disabled || value == null}
                onChange={(event) => update({ key, value: event.target.value === 'true' })}
              >
                <option value="" disabled>
                  状态未知
                </option>
                <option value="true">开启</option>
                <option value="false">关闭</option>
              </FormSelect>
            }
          />
        );
      })}
      <Row
        label="成员邀请"
        control={
          <FormSelect
            aria-label="成员邀请"
            value={query.data?.invitePolicy ?? ''}
            disabled={disabled || query.data?.invitePolicy == null}
            onChange={(event) => {
              const value = event.target.value;
              if (Object.hasOwn(inviteModes, value))
                update({ key: 'invitePolicy', value: value as keyof typeof inviteModes });
            }}
          >
            <option value="" disabled>
              状态未知
            </option>
            {Object.entries(inviteModes).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </FormSelect>
        }
      />
      {query.error ? <p role="alert">{query.error.message}</p> : null}
      <button
        type="button"
        className="weq-set-btn"
        disabled={!action.available || action.pending || query.isFetching}
        onClick={() => void query.refetch()}
      >
        刷新群设置
      </button>
      <ActionFeedback action={action} />
    </div>
  );
}

export function GroupAdvancedSettings({ groupId }: { groupId: number }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>更多群设置</summary>
      {open ? <Options groupId={groupId} /> : null}
    </details>
  );
}
