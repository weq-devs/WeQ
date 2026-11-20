import { useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { useDraftClose } from '../../lib/draftClose';
import { client, trpc } from '../../trpc/client';
import { FormSelect } from '../FormSelect';
import { GroupFeatureSurface } from '../GroupFeatureSurface';
import { SegmentedControl } from '../SegmentedControl';
import { Row } from '../settings/controls';
import { ActionFeedback } from './shared';
import { useQQAction, withQQAccountScope } from './shared.shared';
import '../../styles/group-admin-permissions.css';

type Draft = { recall?: boolean; kick?: boolean; quota?: number };

function GroupAdminPermissionsEditor({
  groupId,
  targetUid,
  name,
  anchor,
  onClose,
}: {
  groupId: number;
  targetUid: string;
  name: string;
  anchor: HTMLElement | null;
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
    if (verification.data === enable) return;
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
  const quotaChoices = before?.kickMemberPerDayChoices ?? [];
  const recall = draft.recall ?? before?.recallMemberMessage;
  const kick = draft.kick ?? before?.kickMember;
  const quota = draft.quota ?? before?.kickMemberPerDay;
  const recallChanged = draft.recall !== undefined && recall !== before?.recallMemberMessage;
  const kickChanged =
    kick !== before?.kickMember || (kick === true && quota !== before?.kickMemberPerDay);
  const changed = recallChanged || kickChanged;
  const disabled = action.disabled || !before || query.isFetching || query.isError;
  const validQuota = kick !== true || quotaChoices.some((limit) => limit === quota);
  const canEditPermissions = recall != null || kick != null;
  const refreshing = query.isFetching || verification.isFetching;
  const close = useDraftClose(onClose, changed ? draft : null, action.pending);

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
    if (value == null)
      return (
        <span className="weq-admin-permissions-status">
          {query.isFetching ? '读取中…' : query.isError ? '读取失败' : '未确认'}
        </span>
      );
    return (
      <SegmentedControl
        label={label}
        value={value ? 'allow' : 'deny'}
        options={[
          { value: 'allow', label: '允许' },
          { value: 'deny', label: '禁止' },
        ]}
        disabled={disabled}
        onChange={(next) => {
          const allowed = next === 'allow';
          if (allowed !== value) change(allowed);
        }}
      />
    );
  }

  return (
    <GroupFeatureSurface
      title="管理员权限"
      presentation="popover"
      anchor={anchor}
      className="weq-admin-permissions-layer"
      onClose={() => {
        if (anchor?.isConnected === false) onClose();
        else close.requestClose();
      }}
    >
      <section className="weq-admin-permissions" aria-label={`${name}的管理员权限`}>
        <header>
          <div className="weq-admin-permissions-heading">
            <strong>管理员权限</strong>
            <span title={name}>{name}</span>
          </div>
          <button
            type="button"
            className="icon-button"
            title="刷新权限"
            aria-label="刷新权限"
            disabled={action.disabled || refreshing}
            onClick={() => void Promise.all([query.refetch(), verification.refetch()])}
          >
            <RefreshCw size={15} className={refreshing ? 'weq-spin' : undefined} aria-hidden />
          </button>
          <button
            type="button"
            className="icon-button"
            title="关闭管理员权限"
            aria-label="关闭管理员权限"
            disabled={action.pending}
            onClick={close.requestClose}
          >
            <X size={17} aria-hidden />
          </button>
        </header>
        <form
          className="weq-admin-permissions-form"
          aria-busy={action.pending || refreshing}
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <Row
            label="接收验证消息"
            control={
              verification.data == null ? (
                <span className="weq-admin-permissions-status">
                  {verification.isFetching
                    ? '读取中…'
                    : verification.isError
                      ? '读取失败'
                      : '未确认'}
                </span>
              ) : (
                <SegmentedControl
                  label="接收验证消息"
                  value={verification.data ? 'receive' : 'off'}
                  options={[
                    { value: 'receive', label: '接收' },
                    { value: 'off', label: '关闭' },
                  ]}
                  disabled={action.disabled || verification.isFetching || verification.isError}
                  onChange={(next) => changeVerification(next === 'receive')}
                />
              )
            }
          />
          {verification.error ? <p role="alert">{verification.error.message}</p> : null}
          <div className="weq-admin-permissions-member-actions">
            <Row
              label="撤回成员消息"
              control={switchControl('撤回成员消息', recall, (value) =>
                setDraft((old) => ({ ...old, recall: value })),
              )}
            />
            <Row
              label="移除群成员"
              control={switchControl('移除群成员', kick, (value) =>
                setDraft((old) => ({ ...old, kick: value })),
              )}
            />
            {kick === true ? (
              <Row
                label="每日可移除人数上限"
                control={
                  <FormSelect
                    aria-label="每日可移除人数上限"
                    value={quota ?? ''}
                    disabled={disabled}
                    onChange={(event) =>
                      setDraft((old) => ({ ...old, quota: Number(event.target.value) }))
                    }
                  >
                    <option value="" disabled>
                      请选择上限
                    </option>
                    {quotaChoices.map((limit) => (
                      <option key={limit} value={limit}>
                        {limit === 0 ? '不限' : limit}
                      </option>
                    ))}
                  </FormSelect>
                }
              />
            ) : null}
          </div>
          {query.error ? (
            <p role="alert">{query.error.message}</p>
          ) : before && (before.recallMemberMessage === null || before.kickMember === null) ? (
            <p className="weq-admin-permissions-status">QQ 未给出「未确认」项的允许或禁止状态。</p>
          ) : null}
          {!action.available ? (
            <p className="weq-admin-permissions-status">需要 QQ 在线能力才能读取和编辑权限。</p>
          ) : null}
          {canEditPermissions ? (
            <div className="weq-qq-action-bar">
              <button
                type="submit"
                className="weq-set-btn weq-set-btn-primary"
                disabled={disabled || !changed || (kickChanged && !validQuota)}
              >
                保存权限
              </button>
            </div>
          ) : null}
          <ActionFeedback action={action} />
        </form>
      </section>
    </GroupFeatureSurface>
  );
}

export const GroupAdminPermissionsPopover = withQQAccountScope(GroupAdminPermissionsEditor);
