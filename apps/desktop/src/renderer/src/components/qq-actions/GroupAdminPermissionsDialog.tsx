import { useState } from 'react';
import { KICK_MEMBER_PER_DAY_CHOICES } from '@weqbot/protocol';
import { client, trpc } from '../../trpc/client';
import { EditorDialog } from '../EditorDialog';
import { FormSelect } from '../FormSelect';
import { Row } from '../settings/controls';
import { ActionFeedback } from './shared';
import { useQQAction, withQQAccountScope } from './shared.shared';

type Draft = { recall?: boolean; kick?: boolean; quota?: number };

function GroupAdminPermissionsEditor({
  groupId,
  targetUid,
  name,
  onClose,
}: {
  groupId: number;
  targetUid: string;
  name: string;
  onClose: () => void;
}) {
  const action = useQQAction(`group-admin-permissions:${groupId}:${targetUid}`);
  const query = trpc.account.qqActions.groupAdminPermissions.useQuery(
    { ...action.binding!, groupId, targetUid },
    { enabled: action.available, refetchOnWindowFocus: false, retry: false },
  );
  const verification = trpc.account.qqActions.groupAdminReceiveVerify.useQuery(
    { ...action.binding!, groupId, targetUid },
    { enabled: action.available, refetchOnWindowFocus: false, retry: false },
  );
  function changeVerification(enable: boolean) {
    void action.perform(
      (binding) =>
        client.account.qqActions.setGroupAdminReceiveVerify.mutate({
          ...binding,
          groupId,
          targetUid,
          enable,
        }),
      undefined,
      undefined,
      {
        requireReadback: true,
        readback: async () => {
          const result = await verification.refetch();
          if (result.error) throw result.error;
          return result.data === enable;
        },
      },
    );
  }
  const [draft, setDraft] = useState<Draft>({});
  const before = query.data;
  const recall = draft.recall ?? before?.recallMemberMessage;
  const kick = draft.kick ?? before?.kickMember;
  const quota = draft.quota ?? before?.kickMemberPerDay;
  const recallChanged = draft.recall !== undefined && recall !== before?.recallMemberMessage;
  const kickChanged =
    kick !== before?.kickMember || (kick === true && quota !== before?.kickMemberPerDay);
  const changed = recallChanged || kickChanged;
  const disabled = action.disabled || !before || query.isFetching || query.isError;
  const validQuota =
    kick !== true ||
    (quota != null && KICK_MEMBER_PER_DAY_CHOICES.some((limit) => limit === quota));

  function save() {
    if (disabled || !changed || (kickChanged && !validQuota)) return;
    const patch = {
      ...(recallChanged && typeof recall === 'boolean' ? { recallMemberMessage: recall } : {}),
      ...(kickChanged && typeof kick === 'boolean' ? { kickMember: kick } : {}),
      ...(kickChanged && kick === true && quota != null ? { kickMemberPerDay: quota } : {}),
    };
    void action.perform(
      (binding) =>
        client.account.qqActions.setGroupAdminPermissions.mutate({
          ...binding,
          groupId,
          targetUid,
          ...patch,
        }),
      undefined,
      undefined,
      {
        requireReadback: true,
        readbackSuccessText: '管理员权限已更新',
        readback: async () => {
          const result = await query.refetch();
          if (result.error) throw result.error;
          const matches =
            !!result.data &&
            Object.entries(patch).every(
              ([key, value]) => result.data?.[key as keyof typeof patch] === value,
            );
          if (matches) setDraft({});
          return matches;
        },
      },
    );
  }

  function switchControl(
    label: string,
    value: boolean | null | undefined,
    change: (value: boolean) => void,
  ) {
    return (
      <FormSelect
        aria-label={label}
        value={value == null ? '' : String(value)}
        disabled={disabled || value == null}
        onChange={(event) => change(event.target.value === 'true')}
      >
        <option value="" disabled>
          状态未知
        </option>
        <option value="true">允许</option>
        <option value="false">禁止</option>
      </FormSelect>
    );
  }

  return (
    <EditorDialog
      title={`${name}的管理员权限`}
      onClose={onClose}
      draft={changed ? draft : null}
      busy={action.pending}
    >
      <form
        className="weq-join-settings"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <Row
          label="撤回群成员消息"
          control={switchControl('撤回群成员消息', recall, (value) =>
            setDraft((old) => ({ ...old, recall: value })),
          )}
        />
        <Row
          label="踢出群成员"
          control={switchControl('踢出群成员', kick, (value) =>
            setDraft((old) => ({ ...old, kick: value })),
          )}
        />
        {kick === true ? (
          <Row
            label="每日踢人上限"
            control={
              <FormSelect
                aria-label="每日踢人上限"
                value={quota ?? ''}
                disabled={disabled}
                onChange={(event) =>
                  setDraft((old) => ({ ...old, quota: Number(event.target.value) }))
                }
              >
                <option value="" disabled>
                  请选择上限
                </option>
                {KICK_MEMBER_PER_DAY_CHOICES.map((limit) => (
                  <option key={limit} value={limit}>
                    {limit === 0 ? '不限' : limit}
                  </option>
                ))}
              </FormSelect>
            }
          />
        ) : null}
        <Row
          label="收取入群验证"
          control={
            <FormSelect
              aria-label="收取入群验证"
              value={verification.data == null ? '' : String(verification.data)}
              disabled={
                action.disabled ||
                verification.data == null ||
                verification.isFetching ||
                verification.isError
              }
              onChange={(event) => changeVerification(event.target.value === 'true')}
            >
              <option value="" disabled>
                状态未知
              </option>
              <option value="true">收取</option>
              <option value="false">关闭</option>
            </FormSelect>
          }
        />
        {verification.error ? <p role="alert">{verification.error.message}</p> : null}
        {query.isFetching && !before ? <p role="status">正在读取管理员权限…</p> : null}
        {query.error ? <p role="alert">{query.error.message}</p> : null}
        <div className="weq-qq-action-bar">
          <button
            type="button"
            className="weq-set-btn"
            disabled={!action.available || query.isFetching}
            onClick={() => void Promise.all([query.refetch(), verification.refetch()])}
          >
            刷新权限
          </button>
          <button
            type="submit"
            className="weq-set-btn weq-set-btn-primary"
            disabled={disabled || !changed || (kickChanged && !validQuota)}
          >
            保存权限
          </button>
        </div>
        <ActionFeedback action={action} />
      </form>
    </EditorDialog>
  );
}

export const GroupAdminPermissionsDialog = withQQAccountScope(GroupAdminPermissionsEditor);
