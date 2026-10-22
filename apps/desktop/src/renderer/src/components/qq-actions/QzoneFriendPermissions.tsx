import { trpc } from '../../trpc/client';
import { QQWriteToggleRow } from '../QQWriteControls';
import { useQQAction, withQQAccountScope } from './shared';
import { Card } from '../settings/controls';
import { RefreshCw } from 'lucide-react';

function PermissionKind({
  targetUin,
  kind,
  label,
  action,
}: {
  targetUin?: string;
  kind: 'blocked' | 'hidden';
  label: string;
  action: ReturnType<typeof useQQAction>;
}) {
  const lists = trpc.account.qqActions.qzoneFriendPermissionList.useQuery(
    { ...action.binding!, kind },
    {
      enabled: action.available,
      staleTime: 0,
      retry: false,
    },
  );
  const mutate = trpc.account.qqActions.qzoneFriendPermission.useMutation();
  const toggle = (target: string, enabled: boolean) =>
    action.perform(
      (binding) => mutate.mutateAsync({ ...binding, kind, targetUin: target, enabled }),
      undefined,
      undefined,
      {
        requireReadback: true,
        readbackSuccessText: '空间权限已更新',
        readback: async () => {
          const result = await lists.refetch();
          if (result.error) throw result.error;
          return (
            Array.isArray(result.data) && result.data.some((row) => row.uin === target) === enabled
          );
        },
      },
    );
  return (
    <>
      {lists.error && (
        <div role="alert" className="weq-qq-permission-error">
          <span>
            {label}：{lists.error.message}
          </span>
          <button
            type="button"
            className="weq-set-iconbtn"
            title={`重新读取${label}`}
            aria-label={`重新读取${label}`}
            disabled={lists.isFetching}
            onClick={() => void lists.refetch()}
          >
            <RefreshCw size={15} />
          </button>
        </div>
      )}
      {targetUin ? (
        <QQWriteToggleRow
          key={kind}
          label={label}
          disabled={action.disabled || !Array.isArray(lists.data) || Boolean(lists.error)}
          initial={
            !lists.error && lists.data ? lists.data.some((row) => row.uin === targetUin) : null
          }
          onSave={(enabled) => toggle(targetUin, enabled)}
        />
      ) : (
        <Card key={kind} title={label}>
          {!lists.error && lists.data?.length === 0 && <p className="weq-set-empty">暂无好友</p>}
          {!lists.error &&
            lists.data?.map((row) => (
              <QQWriteToggleRow
                key={row.uin}
                label={row.name || row.uin}
                initial={true}
                disabled={action.disabled}
                onSave={(enabled) => toggle(row.uin, enabled)}
              />
            ))}
        </Card>
      )}
    </>
  );
}
function QzoneFriendPermissionsBody({ targetUin }: { targetUin?: string }) {
  const action = useQQAction(`space-permissions:${targetUin ?? 'lists'}`);
  return (
    <>
      <PermissionKind
        action={action}
        targetUin={targetUin}
        kind="blocked"
        label="不让 ta 看我的空间"
      />
      <PermissionKind action={action} targetUin={targetUin} kind="hidden" label="不看 ta 的动态" />
    </>
  );
}
export const QzoneFriendPermissions = withQQAccountScope(QzoneFriendPermissionsBody);
