import { RefreshCw, X } from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import { GroupFeatureSurface } from '../GroupFeatureSurface';
import { Row, Toggle } from '../settings/controls';
import { ActionFeedback } from './shared';
import { useQQAction, withQQAccountScope } from './shared.shared';
import '../../styles/group-admin-permissions.css';

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
  const verification = trpc.account.qqActions.groupAdminReceiveVerify.useQuery(
    { ...action.binding!, groupId, targetUid },
    { enabled: action.available, refetchOnWindowFocus: false, retry: false },
  );
  const refreshing = verification.isFetching;

  function close() {
    if (!action.pending || anchor?.isConnected === false) onClose();
  }

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

  return (
    <GroupFeatureSurface
      title="管理员权限"
      presentation="popover"
      anchor={anchor}
      className="weq-admin-permissions-layer"
      onClose={close}
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
            onClick={() => void verification.refetch()}
          >
            <RefreshCw size={15} className={refreshing ? 'weq-spin' : undefined} aria-hidden />
          </button>
          <button
            type="button"
            className="icon-button"
            title="关闭管理员权限"
            aria-label="关闭管理员权限"
            disabled={action.pending}
            onClick={close}
          >
            <X size={17} aria-hidden />
          </button>
        </header>
        <div className="weq-admin-permissions-body" aria-busy={action.pending || refreshing}>
          <Row
            label="接收验证消息"
            control={
              verification.data == null ? (
                <span className="weq-set-row-status" role="status">
                  {refreshing ? '读取中…' : verification.isError ? '读取失败' : '未确认'}
                </span>
              ) : (
                <Toggle
                  label="接收验证消息"
                  checked={verification.data}
                  disabled={action.disabled || refreshing || verification.isError}
                  onChange={changeVerification}
                />
              )
            }
          />
          {verification.error ? <p role="alert">{verification.error.message}</p> : null}
          {!action.available ? (
            <p className="weq-admin-permissions-status">需要 QQ 在线能力才能更改此设置。</p>
          ) : null}
          <ActionFeedback action={action} />
        </div>
      </section>
    </GroupFeatureSurface>
  );
}

export const GroupAdminPermissionsPopover = withQQAccountScope(GroupAdminPermissionsEditor);
