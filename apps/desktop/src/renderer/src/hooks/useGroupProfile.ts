import { useQuery } from '@tanstack/react-query';
import { useRef } from 'react';
import { client, trpc } from '../trpc/client';
import { useViewState } from '../state/view';
import { useTabActive } from '../components/RetainedTabs';
import type { GroupConversation, GroupMember } from '../im-template/template/types';
import { avatarFromUin } from '../lib/avatarResolver';
import { PROFILE_QUERY_OPTIONS } from '../lib/profileQuery';
import { mergeGroupPreviewMembers } from '../lib/groupPreviewMembers';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../../shared/router';

type MemberWire = inferRouterOutputs<AppRouter>['account']['groupMemberPreview']['members'][number];
const iso = (value: number) => (value > 0 ? new Date(value * 1000).toISOString() : null);
export function previewMemberView(row: MemberWire, owner?: string): GroupMember {
  return {
    id: row.uid,
    username: row.uid,
    identityLabel: 'QQ',
    identityValue: row.uin,
    uin: row.uin,
    nick: row.nick,
    card: row.card,
    displayName: row.card || row.nick || row.uin,
    avatarUrl: avatarFromUin(row.uin),
    role: row.uid === owner ? 'owner' : row.adminFlag > 0 ? 'admin' : 'member',
    joinedAt: iso(row.joinTime) ?? '',
    lastSpeakAt: iso(row.lastSpeakTime),
    muteUntil: iso(row.muteUntil),
    memberLevel: row.memberLevel,
    levelName: row.memberLevel > 0 ? `Lv${row.memberLevel}` : null,
    memberFlag: row.memberFlag,
    customTitle: row.customTitle,
  };
}
export function useGroupReadScope() {
  const active = useTabActive();
  const uin = useViewState((state) => state.openedUin);
  const config = trpc.account.getAccountConfig.useQuery(undefined, {
    ...PROFILE_QUERY_OPTIONS,
    staleTime: 0,
    refetchOnMount: 'always',
    enabled: active && Boolean(uin),
  });
  const binding =
    config.data?.uin === uin && config.data.configId
      ? { expectedAccountUin: uin!, expectedAccountConfigId: config.data.configId }
      : null;
  return {
    active,
    binding,
    key: `${uin}:${binding?.expectedAccountConfigId ?? ''}`,
    refreshScope: config.refetch,
  };
}
export function useGroupProfile(conversation: GroupConversation, previewMembers = true) {
  const { active, binding, key, refreshScope } = useGroupReadScope();
  const enabled =
    active && Boolean(binding) && !conversation.generated && /^[1-9]\d{0,9}$/.test(conversation.id);
  const detail = useQuery({
    queryKey: ['group-profile', key, conversation.id],
    queryFn: () => client.account.getGroupDetail.query({ ...binding!, groupCode: conversation.id }),
    enabled,
    ...PROFILE_QUERY_OPTIONS,
  });
  const preview = trpc.account.groupMemberPreview.useQuery(
    { ...binding!, groupCode: conversation.id },
    {
      ...PROFILE_QUERY_OPTIONS,
      enabled:
        enabled &&
        previewMembers &&
        conversation.members
          .slice(0, 32)
          .filter((member) => member.memberFlag !== 1 && member.identityValue !== '0').length < 8,
    },
  );
  const metrics = trpc.account.contactMetrics.snapshot.useQuery(binding!, {
    ...PROFILE_QUERY_OPTIONS,
    enabled,
  });
  const forceExtended = useRef(false);
  const extended = useQuery({
    queryKey: ['group-profile-joined-at', key, conversation.id],
    queryFn: () => {
      const force = forceExtended.current;
      forceExtended.current = false;
      return client.account.getGroupExtendedProfile.query({
        ...binding!,
        groupId: Number(conversation.id),
        refresh: true,
        ...(force ? { force: true } : {}),
      });
    },
    enabled,
    ...PROFILE_QUERY_OPTIONS,
    staleTime: 5 * 60_000,
  });
  const joinedAt =
    enabled && extended.data?.groupId === Number(conversation.id) ? extended.data.joinedAt : null;
  const cachedJoin = enabled
    ? metrics.data?.rows[`group:${conversation.id}`]?.joinedAt?.value
    : null;
  const local = detail.data;
  const knownName = local?.groupName?.trim() || conversation.group.name?.trim();
  const cloudName = useQuery({
    queryKey: ['group-profile-name', key, conversation.id],
    queryFn: () =>
      client.account.getCardDisplayNames.query({
        kind: 'group',
        target: conversation.id,
        ...binding!,
      }),
    enabled: enabled && !detail.isFetching && (!knownName?.trim() || knownName === conversation.id),
    ...PROFILE_QUERY_OPTIONS,
  });
  const displayName =
    knownName && knownName !== conversation.id
      ? knownName
      : cloudName.data?.name || knownName || conversation.id;
  const group = local
    ? {
        ...conversation.group,
        name: displayName,
        remark: local.remark || null,
        description: local.description || conversation.group.description,
        memberCount: local.memberCount >= 0 ? local.memberCount : conversation.group.memberCount,
        maxMemberCount: local.maxMemberCount || conversation.group.maxMemberCount,
        createTime: iso(local.createTime) || conversation.group.createTime,
        labels: local.labels || conversation.group.labels,
        entranceQ: local.entranceQ || conversation.group.entranceQ,
        announcement: local.pinnedAnnounce || conversation.group.announcement,
        customLabels: local.customLabels
          .map((label) => label.content)
          .filter((value): value is string => Boolean(value)),
        customLabelRecords: local.customLabels,
        addressName: local.address?.locationName ?? conversation.group.addressName,
      }
    : { ...conversation.group, name: displayName };
  return {
    conversation: { ...conversation, group },
    ownerUid: local?.ownerUid,
    memberCountKnown: Boolean(local),
    extended:
      enabled && extended.data?.groupId === Number(conversation.id) ? extended.data : undefined,
    extendedRefreshing: extended.isFetching,
    extendedError: extended.error ? '群扩展资料读取失败，保留已有内容' : extended.data?.error,
    refreshExtended: () => {
      if (!enabled || extended.isFetching) return;
      forceExtended.current = true;
      void extended.refetch();
    },
    joinedAt: joinedAt ?? (typeof cachedJoin === 'number' && cachedJoin > 1 ? cachedJoin : null),
    binding,
    scope: key,
    members: mergeGroupPreviewMembers([
      ...(preview.data?.members ?? []).map((row) => previewMemberView(row, local?.ownerUid)),
      ...conversation.members.slice(0, 32),
    ]),
    metrics: enabled ? metrics.data?.rows[`group:${conversation.id}`] : undefined,
    previewLoading: preview.isFetching,
    profileRefreshing: detail.isFetching || cloudName.isFetching,
    profileError: detail.error
      ? '群资料读取失败，保留已有内容'
      : cloudName.error
        ? '群名称暂未补全'
        : null,
    retryProfile: async () => {
      await refreshScope();
      void detail.refetch();
      if (cloudName.error) void cloudName.refetch();
    },
    previewError: preview.error?.message || preview.data?.error,
    retryPreview: () => void preview.refetch(),
  };
}
