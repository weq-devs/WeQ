import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import { client, trpc } from '../../trpc/client';
import { FormSelect } from '../FormSelect';
import { Row, Toggle } from '../settings/controls';
import { ActionFeedback } from './shared';
import { useQQAction } from './shared.shared';

const memberSwitches = [
  ['newMemberHistory', '新成员可查看历史消息'],
  ['allowMemberTemporarySession', '允许成员发起临时会话'],
  ['allowMemberCreateGroup', '允许成员发起群聊'],
  ['allowMemberUploadAlbum', '允许成员上传群相册'],
] as const;
const robotSwitches = [
  ['robotMemberSwitch', '允许邀请群机器人'],
  ['robotMemberExamine', '群机器人入群需要审核'],
] as const;
const searchModes = {
  keyword_or_number: '允许通过关键词或群号搜索',
  number_only: '仅允许通过群号搜索',
  disabled: '禁止搜索',
} as const;
const inviteModes = {
  disabled: '禁止成员邀请',
  require_approval: '需要审核',
  no_approval: '无需审核',
  no_approval_under_100: '群人数不足 100 时无需审核',
} as const;
type Change =
  | { key: (typeof memberSwitches | typeof robotSwitches)[number][0]; value: boolean }
  | { key: 'searchMode'; value: keyof typeof searchModes }
  | { key: 'invitePolicy'; value: keyof typeof inviteModes };

export function GroupAdvancedSettings({ groupId }: { groupId: number }) {
  const action = useQQAction(`group-advanced-settings:${groupId}`);
  const query = trpc.account.qqActions.groupAdvancedSettings.useQuery(
    { ...action.binding!, groupId },
    useQQAutoRefresh(action.available),
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
  function renderSwitch([key, label]: (typeof memberSwitches | typeof robotSwitches)[number]) {
    const value = query.data?.[key];
    return (
      <Row
        key={key}
        label={label}
        indent={key === 'robotMemberExamine'}
        control={
          value == null ? (
            <span className="weq-set-row-status">{query.isFetching ? '读取中…' : '状态未知'}</span>
          ) : (
            <Toggle
              label={label}
              checked={value}
              disabled={disabled}
              onChange={(value) => update({ key, value })}
            />
          )
        }
      />
    );
  }
  return (
    <div>
      <Row
        label="群搜索方式"
        control={
          <FormSelect
            aria-label="群搜索方式"
            value={query.data?.searchMode ?? ''}
            disabled={action.disabled || query.isFetching}
            onChange={(event) => {
              const value = event.target.value;
              if (Object.hasOwn(searchModes, value))
                update({ key: 'searchMode', value: value as keyof typeof searchModes });
            }}
          >
            <option value="" disabled>
              {query.isFetching ? '读取中…' : '状态未知'}
            </option>
            {Object.entries(searchModes).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </FormSelect>
        }
      />
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
      {robotSwitches.map(renderSwitch)}
      <section className="weq-group-member-settings" aria-label="入群后权限">
        <h4>入群后权限</h4>
        {memberSwitches.map(renderSwitch)}
      </section>
      {query.error ? <p role="alert">{query.error.message}</p> : null}
      <ActionFeedback action={action} />
    </div>
  );
}
