import { client, trpc } from '../../trpc/client';
import { QQWriteSelectRow } from '../QQWriteControls';
import { ActionFeedback, useQQAction } from './shared';

export function ExtendedStatusAction() {
  const a = useQQAction('extended-status');
  const options = trpc.account.qqActions.extendedStatuses.useQuery(
    { ...a.binding! },
    { enabled: a.available, retry: false, staleTime: 60_000 },
  );
  const status = trpc.account.qqWrite.selfState.useQuery(
    { ...a.binding! },
    { enabled: Boolean(a.binding), retry: false },
  );
  return (
    <>
      <QQWriteSelectRow
        label="扩展在线状态"
        initial={
          status.data?.status?.type === 10 && status.data.status.subType
            ? status.data.status.subType
            : null
        }
        disabled={a.disabled || options.isFetching || !options.data?.length}
        options={options.data ?? []}
        onSave={(extStatus) =>
          a.perform(
            (b) => client.account.qqWrite.onlineStatus.mutate({ ...b, status: 10, extStatus }),
            async () => {
              await status.refetch();
            },
          )
        }
      />
      {options.error && <p role="alert">{options.error.message}</p>}
      <ActionFeedback action={a} />
    </>
  );
}
