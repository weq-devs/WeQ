import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { GroupProfileExtras } from '@weq/protocol';
import { trpc } from '../trpc/client';
import type { QQWriteBinding } from '../hooks/useQQWriteSession';
import { useGroupReadScope } from '../hooks/useGroupProfile';
import { useTabActive } from './RetainedTabs';
import { groupProfileRows } from '../lib/groupProfileRows';
import {
  ContactEmptyState,
  ContactRow,
  ContactTechnicalDetails,
} from './contactProfile/ContactRow';
import '../styles/group-extended-profile.css';

const updated = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  dateStyle: 'short',
  timeStyle: 'short',
  hourCycle: 'h23',
});

export function GroupExtendedProfile({ groupCode }: { groupCode: string }) {
  const session = useGroupReadScope();
  const access = trpc.account.getGroupAlbumAccessState.useQuery(undefined, {
    enabled: session.active && Boolean(session.binding),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const groupId = Number(groupCode);
  if (
    !/^\d+$/.test(groupCode) ||
    !Number.isInteger(groupId) ||
    groupId <= 0 ||
    groupId > 0xffffffff
  )
    return null;
  return (
    <GroupProfileQuery
      key={`${session.binding?.expectedAccountUin}:${session.binding?.expectedAccountConfigId}:${groupId}`}
      groupId={groupId}
      binding={session.binding}
      online={Boolean(access.data?.qqOnline && access.data.attachEnabled)}
    />
  );
}

function GroupProfileQuery({
  groupId,
  binding,
  online,
}: {
  groupId: number;
  binding: QQWriteBinding | null;
  online: boolean;
}) {
  const active = useTabActive();
  const [force, setForce] = useState(false);
  const query = trpc.account.getGroupExtendedProfile.useQuery(
    {
      expectedAccountUin: binding?.expectedAccountUin ?? '',
      expectedAccountConfigId: binding?.expectedAccountConfigId ?? '',
      groupId,
      refresh: online,
      force,
    },
    {
      enabled: active && Boolean(binding),
      staleTime: 5 * 60_000,
      cacheTime: 5 * 60_000,
      retry: false,
      refetchOnWindowFocus: false,
      keepPreviousData: true,
    },
  );
  const data = query.data?.groupId === groupId ? query.data : undefined;
  return (
    <GroupExtendedProfileFields
      profile={data?.profile ?? null}
      updatedAt={data?.updatedAt ?? null}
      cached={data?.source === 'cache'}
      online={online}
      loading={query.isFetching}
      error={
        query.error ? 'read' : data?.error ? (data.source === 'online' ? 'cache' : 'read') : null
      }
      onRefresh={() => {
        if (force) void query.refetch();
        else setForce(true);
      }}
    />
  );
}

export function GroupExtendedProfileFields({
  profile,
  updatedAt,
  cached,
  online,
  loading,
  error,
  onRefresh,
}: {
  profile: GroupProfileExtras | null;
  updatedAt: number | null;
  cached: boolean;
  online: boolean;
  loading: boolean;
  error: 'read' | 'cache' | null;
  onRefresh: () => void;
}) {
  const rows = groupProfileRows(profile).filter((row) => !row[2]);
  const technical = groupProfileRows(profile).filter((row) => row[2]);
  const status = loading
    ? '读取中…'
    : error === 'cache'
      ? '缓存保存失败'
      : error
        ? profile
          ? '更新失败，保留缓存'
          : '读取失败'
        : !profile
          ? online
            ? '暂无资料'
            : '暂无缓存'
          : cached
            ? '缓存'
            : '已更新';
  return (
    <section className="weq-group-extras" aria-label="群扩展资料">
      <div className="weq-group-extras-toolbar">
        <strong>扩展资料</strong>
        <span
          role="status"
          title={updatedAt === null ? undefined : `更新于 ${updated.format(updatedAt)}（北京时间）`}
        >
          {status}
        </span>
        <button
          className="icon-button"
          type="button"
          title="刷新群扩展资料"
          aria-label="刷新群扩展资料"
          disabled={!online || loading}
          onClick={onRefresh}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="weq-group-extras-rows" data-privacy-sensitive>
        {rows.map(([label, value]) => (
          <ContactRow key={label} label={label} value={value} />
        ))}
        {!rows.length ? <ContactEmptyState>暂无可读取的扩展资料</ContactEmptyState> : null}
      </div>
      {technical.length ? (
        <ContactTechnicalDetails>
          {technical.map(([label, value]) => (
            <ContactRow key={label} label={label} value={value} mono />
          ))}
        </ContactTechnicalDetails>
      ) : null}
    </section>
  );
}
