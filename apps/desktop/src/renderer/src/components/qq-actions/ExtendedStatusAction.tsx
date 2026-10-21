import { Sparkles } from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import { QQWriteSelectRow } from '../QQWriteControls';
import { OnlineStatusIcon } from '../OnlineStatus';
import { ActionFeedback, useQQAction } from './shared';

export function ExtendedStatusAction({ onSaved }: { onSaved?: () => void } = {}) {
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
        icon={<Sparkles size={14} strokeWidth={1.8} />}
        initial={
          status.data?.status?.type === 10 && status.data.status.subType
            ? status.data.status.subType
            : null
        }
        disabled={a.disabled || options.isFetching || !options.data?.length}
        options={options.data ?? []}
        unlistedLabel={(value) => (value === 2000 ? '自定义状态' : `未识别 (${value})`)}
        preview={(value) => {
          const selected = options.data?.find((option) => option.value === value);
          return selected ? (
            <output className="weq-qq-status-preview" aria-label="扩展状态预览" aria-live="polite">
              <OnlineStatusIcon type={10} subType={selected.value} />
              <span>{selected.label}</span>
            </output>
          ) : null;
        }}
        onSave={async (extStatus) => {
          const saved = await a.perform(
            (b) => client.account.qqWrite.onlineStatus.mutate({ ...b, status: 10, extStatus }),
            async () => {
              await status.refetch();
            },
          );
          if (saved) onSaved?.();
          return saved;
        }}
      />
      {options.error && <p role="alert">{options.error.message}</p>}
      <ActionFeedback action={a} />
    </>
  );
}
