import { BadgeCheck } from 'lucide-react';
import { Fragment } from 'react';
import { trpc } from '../trpc/client';
import { useQQAutoRefresh } from '../hooks/useQQAutoRefresh';
import type { useQQWriteSession } from '../hooks/useQQWriteSession';
import { QueryError, Row } from './settings/controls';
import { QQWriteSelectRow } from './QQWriteControls';

export function GroupIdentityControls({
  groupId,
  session,
  disabled,
}: {
  groupId: number;
  session: ReturnType<typeof useQQWriteSession>;
  disabled: boolean;
}) {
  const activity = useQQAutoRefresh(session.available);
  const query = trpc.account.qqWrite.groupIdentityState.useQuery(
    {
      expectedAccountUin: session.binding?.expectedAccountUin ?? '',
      expectedAccountConfigId: session.binding?.expectedAccountConfigId ?? '',
      groupId,
    },
    {
      ...activity,
      // 规则拒绝不自动重试；恢复在线或用户主动重读即可。
      retry: false,
      refetchOnWindowFocus: false,
    },
  );
  const mutation = trpc.account.qqWrite.groupIdentity.useMutation();
  const catalog = query.error ? undefined : query.data;
  const selected = catalog?.titles.find((title) => title.id === catalog.selectedTitleId);
  const options = (catalog?.titles ?? []).flatMap((title) =>
    title.settableId === null
      ? []
      : [
          {
            value: title.settableId,
            label: title.name || title.id,
          },
        ],
  );
  return (
    <Fragment
      key={`${session.binding?.expectedAccountUin}:${session.binding?.expectedAccountConfigId}:${groupId}`}
    >
      {query.error && (
        <QueryError
          message={`展示头衔读取失败：${query.error.message}`}
          retryLabel="重试读取展示头衔"
          retrying={query.isFetching || session.busy || disabled}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}
      <QQWriteSelectRow
        label="展示头衔"
        icon={<BadgeCheck size={14} strokeWidth={1.8} />}
        initial={selected?.settableId ?? null}
        options={options}
        disabled={
          disabled ||
          session.busy ||
          !session.available ||
          query.isFetching ||
          !catalog ||
          options.length === 0
        }
        preview={() => {
          const status = query.isFetching
            ? '正在读取'
            : selected?.settableId === null
              ? `当前展示：${selected.name || selected.id}`
              : catalog?.selectionKnown && !selected
                ? '尚未选择'
                : catalog && !catalog.selectionKnown
                  ? '未返回明确选中状态'
                  : null;
          return status ? <span role="status">{status}</span> : null;
        }}
        onSave={(titleId) =>
          session.run(
            (binding) => mutation.mutateAsync({ ...binding, groupId, titleId }),
            undefined,
            {
              requireReadback: true,
              readbackSuccessText: '展示头衔已保存',
              readback: async () => {
                const updated = await query.refetch();
                if (updated.error) throw updated.error;
                return (
                  updated.data?.selectionKnown === true &&
                  updated.data.selectedTitleId === String(titleId)
                );
              },
            },
          )
        }
      />
      <Row
        label="云端群等级"
        control={
          <span>
            {catalog?.level?.value != null
              ? [`Lv${catalog.level.value}`, catalog.level.name].filter(Boolean).join(' · ')
              : '尚未读取'}
          </span>
        }
      />
    </Fragment>
  );
}
