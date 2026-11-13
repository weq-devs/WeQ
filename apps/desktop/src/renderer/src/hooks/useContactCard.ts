import { useQuery, useQueryClient } from '@tanstack/react-query';
import { normalizeContactCard } from '@weq/service/contact-card';
import { client, trpc } from '../trpc/client';
import { useQQWriteSession } from './useQQWriteSession';
import type { Contact, GroupMember, User } from '../im-template/template/types';
import { useTabActive } from '../components/RetainedTabs';
import { resolveAvatar } from '../lib/avatarResolver';

import { PROFILE_QUERY_OPTIONS } from '../lib/profileQuery';
export { PROFILE_QUERY_OPTIONS } from '../lib/profileQuery';
export type ProfilePerson = User &
  Partial<Contact> &
  Omit<Partial<GroupMember>, keyof User | keyof Contact> & {
    leftGroup?: boolean;
  };
export function useContactCardSettings() {
  const query = trpc.bootstrap.getSettings.useQuery(undefined, PROFILE_QUERY_OPTIONS);
  return { ...normalizeContactCard(query.data?.contactCard), ready: Boolean(query.data) };
}
export function useContactQqShow(uin: string, enabled = true) {
  const session = useQQWriteSession(`contact-show:${uin}`, true);
  const active = useTabActive();
  return useQuery({
    queryKey: ['contact-qqshow', session.binding, uin],
    queryFn: () => client.account.dressup.peerQqShow.query({ uin, ...session.binding }),
    enabled: active && enabled && Boolean(session.binding) && /^[1-9]\d{4,19}$/.test(uin),
    ...PROFILE_QUERY_OPTIONS,
  });
}
export function useContactDress(uin: string, enabled = true) {
  const session = useQQWriteSession(`contact-pendant:${uin}`, true);
  const active = useTabActive();
  return useQuery<Awaited<ReturnType<typeof client.account.dressup.peerHome.query>>, Error>({
    queryKey: ['contact-dress', session.binding, uin],
    queryFn: () => client.account.dressup.peerHome.query({ uin, ...session.binding }),
    enabled: active && enabled && Boolean(session.binding) && /^[1-9]\d{4,19}$/.test(uin),
    ...PROFILE_QUERY_OPTIONS,
  });
}
export function useContactStats(
  uin: string,
  uid: string,
  field: 'level' | 'likeCount',
  enabled = true,
) {
  const session = useQQWriteSession(`contact-stats:${uin}`, true);
  const active = useTabActive();
  return trpc.account.dressup.peerStats.useQuery(
    { uin, uid, fields: [field], ...session.binding },
    {
      ...PROFILE_QUERY_OPTIONS,
      enabled:
        active &&
        enabled &&
        session.available &&
        /^[1-9]\d{4,19}$/.test(uin) &&
        (field === 'level' || /^u_/.test(uid)),
    },
  );
}
export function useContactProfile(person: ProfilePerson) {
  const cache = useQueryClient();
  const session = useQQWriteSession(
    `contact-profile:${person.uid || person.id || person.identityValue}`,
    true,
  );
  const scope = [session.binding?.expectedAccountUin, session.binding?.expectedAccountConfigId];
  const uid = person.uid || (person.id.startsWith('u_') ? person.id : '');
  const uin = ['QQ', 'UIN'].includes(person.identityLabel) ? person.identityValue : '';
  const enabled = !person.clone && Boolean(uid || /^[1-9]\d{4,19}$/.test(uin));
  const query = useQuery({
    queryKey: ['contact-profile', ...scope, uid || uin],
    queryFn: async () => {
      const data = uid
        ? await client.account.getProfile.query({ uid, ...session.binding })
        : await client.account.getProfileByUin.query({ uin, ...session.binding });
      if (data)
        for (const identity of [data.uid, data.uin]) {
          if (
            identity &&
            identity !== (uid || uin) &&
            (/^u_/.test(identity) || /^[1-9]\d{4,19}$/.test(identity))
          )
            cache.setQueryData(['contact-profile', ...scope, identity], data);
        }
      return data;
    },
    enabled: enabled && Boolean(session.binding),
    ...PROFILE_QUERY_OPTIONS,
  });
  const local = query.data;
  const actualUin = local?.uin && /^[1-9]\d{4,19}$/.test(local.uin) ? local.uin : uin;
  const profile: ProfilePerson = local
    ? {
        ...person,
        ...local,
        id: local.uid || person.id,
        uid: local.uid || uid,
        identityValue: actualUin || person.identityValue,
        identityLabel: actualUin ? 'QQ' : person.identityLabel,
        kind: local.isBot ? 'bot' : person.kind,
        avatarUrl:
          person.avatarUrl ||
          resolveAvatar({ uin: local.uin || uin, profileAvatarUrl: local.avatarUrl }),
        customStatus:
          typeof local.customStatus === 'string'
            ? local.customStatus
            : (local.customStatus?.desc ?? person.customStatus),
      }
    : { ...person, avatarUrl: person.avatarUrl || resolveAvatar({ uin }) };
  return { profile, session, scope, loading: enabled && query.isFetching };
}
