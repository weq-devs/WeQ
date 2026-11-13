import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { client } from '../trpc/client';
import { PROFILE_QUERY_OPTIONS } from '../lib/profileQuery';
import { resolveGroupNoticePublishers, type GroupNoticeEntry } from '../lib/groupNotices';
import { useGroupReadScope } from './useGroupProfile';

export function useGroupNoticePublishers(groupCode: string, entries: GroupNoticeEntry[]) {
  const { active, binding, key } = useGroupReadScope();
  const identities = [
    ...new Set(
      entries
        .flatMap((entry) => [entry.publisherUid, entry.publisherUin])
        .filter((id): id is string => Boolean(id)),
    ),
  ].sort();
  const publishers = useQuery({
    queryKey: ['group-notice-publishers', key, groupCode, identities],
    ...PROFILE_QUERY_OPTIONS,
    enabled: active && Boolean(binding) && identities.length > 0,
    queryFn: async () => {
      const members = [];
      const profiles = [];
      // 只查公告引用的人，不读取整群成员；遵循现有批量接口的 200 人上限。
      for (let offset = 0; offset < identities.length; offset += 200) {
        const chunk = identities.slice(offset, offset + 200);
        const uids = chunk.filter((id) => id.startsWith('u_'));
        const uins = chunk.filter((id) => /^[1-9]\d{4,19}$/.test(id));
        const [byUid, byUin, localProfiles, byNumber] = await Promise.all([
          uids.length
            ? client.account.getGroupMembersByUids.query({ ...binding!, groupCode, uids })
            : [],
          uins.length
            ? client.account.getGroupMembersByUins.query({ ...binding!, groupCode, uins })
            : [],
          uids.length ? client.account.getProfilesByUids.query({ ...binding!, uids }) : [],
          Promise.all(
            uins.map((uin) => client.account.getProfileByUin.query({ ...binding!, uin })),
          ),
        ]);
        members.push(...byUid, ...byUin);
        profiles.push(...localProfiles);
        profiles.push(...byNumber.filter((profile) => profile !== null));
      }
      return { members, profiles };
    },
  });
  return useMemo(
    () =>
      resolveGroupNoticePublishers(
        entries,
        publishers.data?.members ?? [],
        publishers.data?.profiles ?? [],
      ),
    [entries, publishers.data],
  );
}
