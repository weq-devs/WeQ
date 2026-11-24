import { Bot, ShieldCheck, UsersRound } from 'lucide-react';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import { client, trpc } from '../../trpc/client';
import { FormSelect } from '../FormSelect';
import { Card, Row, Toggle } from '../settings/controls';
import { GroupJoinSettings } from './GroupJoinSettings';
import { ActionFeedback } from './shared';
import { useQQAction } from './shared.shared';

const memberSwitches = [
  ['newMemberHistory', '新成员可查看历史消息'],
  ['allowMemberTemporarySession', '允许成员发起临时会话'],
  ['allowMemberCreateGroup', '允许成员发起群聊'],
  ['allowMemberUploadAlbum', '允许成员上传群相册'],
] as const;
const robotSwitches = [
  ['robotMemberSwitch', '允许群成员邀请机器人'],
  ['robotMemberExamine', '群机器人入群需要审核'],
] as const;
const searchModes = {
  keyword_or_number: '关键词或群号',
  number_only: '仅群号',
  disabled: '禁止搜索',
} as const;
const inviteModes = {
  disabled: '禁止成员邀请',
  require_approval: '需要审核',
  no_approval: '无需审核',
  no_approval_under_100: '100 人以内免审核',
} as const;
type Change =
  | { key: (typeof memberSwitches | typeof robotSwitches)[number][0]; value: boolean }
  | { key: 'searchMode'; value: keyof typeof searchModes }
  | { key: 'invitePolicy'; value: keyof typeof inviteModes };

export function GroupManagementRules({
  groupId,
  canManage,
}: {
  groupId: number;
  canManage: boolean;
}) {
  const action = useQQAction(`group-advanced-settings:${groupId}`);
  const autoRefresh = useQQAutoRefresh(action.available && canManage);
  const query = trpc.account.qqActions.groupAdvancedSettings.useQuery(
    { ...action.binding!, groupId },
    autoRefresh,
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
    const direct =
      key === 'newMemberHistory' || key === 'robotMemberSwitch' || key === 'robotMemberExamine';
    return (
      <Row
        key={key}
        label={label}
        control={
          value == null && direct ? (
            <FormSelect
              className="weq-set-input"
              aria-label={label}
              value=""
              disabled={action.disabled || query.isFetching}
              onChange={(event) => update({ key, value: event.target.value === 'on' })}
            >
              <option value="" disabled>
                {query.isFetching ? '读取中…' : '状态未知'}
              </option>
              <option value="on">开启</option>
              <option value="off">关闭</option>
            </FormSelect>
          ) : value == null ? (
            <span className="weq-set-row-status">{query.isFetching ? '读取中…' : '状态未知'}</span>
          ) : (
            <Toggle
              label={label}
              checked={value}
              disabled={direct ? action.disabled || query.isFetching : disabled}
              onChange={(value) => update({ key, value })}
            />
          )
        }
      />
    );
  }
  return (
    <>
      <Card title="加群方式" icon={<UsersRound />}>
        <GroupJoinSettings groupId={groupId} canManage={canManage} />
        {canManage && (
          <>
            <Row
              label="群搜索方式"
              control={
                <FormSelect
                  className="weq-set-input"
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
                  className="weq-set-input"
                  aria-label="成员邀请"
                  value={query.data?.invitePolicy ?? ''}
                  disabled={disabled}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (Object.hasOwn(inviteModes, value))
                      update({ key: 'invitePolicy', value: value as keyof typeof inviteModes });
                  }}
                >
                  <option value="" disabled>
                    {query.isFetching ? '读取中…' : '状态未知'}
                  </option>
                  {Object.entries(inviteModes).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </FormSelect>
              }
            />
            {query.error ? (
              <p className="weq-qq-write-result" role="alert">
                群管理设置读取失败：{query.error.message}
              </p>
            ) : null}
          </>
        )}
      </Card>
      {canManage && (
        <>
          <Card title="成员权限" icon={<ShieldCheck />}>
            {memberSwitches.map(renderSwitch)}
          </Card>
          <Card title="群机器人" icon={<Bot />}>
            {robotSwitches.map(renderSwitch)}
          </Card>
          <ActionFeedback action={action} />
        </>
      )}
    </>
  );
}
