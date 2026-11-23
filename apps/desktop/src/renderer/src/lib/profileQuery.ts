import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { QQWriteBinding } from '../hooks/useQQWriteSession';

export const PROFILE_QUERY_OPTIONS = {
  staleTime: 5 * 60_000,
  cacheTime: 5 * 60_000,
  retry: false as const,
  refetchOnWindowFocus: false,
};

export const contactCardSettingsKey = (binding: QQWriteBinding | null) =>
  ['contact-card-settings', binding] as const;

const profileKeys = new Set([
  'contact-profile',
  'contact-cloud-name',
  'contact-dress',
  'contact-qqshow',
  'contact-bot',
  'group-profile',
  'group-profile-name',
  'group-profile-joined-at',
]);

const profileProcedures = new Set([
  'dressup.peerStats',
  'profileExtras.details',
  'profileExtras.region',
  'profileExtras.educationHistory',
  'profileExtras.energy',
  'profileExtras.personalityLabels',
  'mutualMark.get',
  'qqWrite.commonRelationships',
]);

export function configureProfileQueries(client: QueryClient) {
  for (const key of profileKeys) client.setQueryDefaults([key], { refetchOnMount: true });
  for (const path of profileProcedures)
    client.setQueryDefaults([['account', ...path.split('.')]], { refetchOnMount: true });
}

export function isProfileCacheQuery(key: QueryKey, binding: QQWriteBinding) {
  const [path, target, configId] = key;
  if (path === 'contact-profile')
    return target === binding.expectedAccountUin && configId === binding.expectedAccountConfigId;

  const wireKey = target as { type?: string; input?: QQWriteBinding } | undefined;
  const input =
    typeof path === 'string' && (profileKeys.has(path) || path === 'contact-card-settings')
      ? (target as QQWriteBinding | null)
      : Array.isArray(path) &&
          path[0] === 'account' &&
          profileProcedures.has(path.slice(1).join('.')) &&
          wireKey?.type === 'query'
        ? wireKey.input
        : undefined;
  return (
    input?.expectedAccountUin === binding.expectedAccountUin &&
    input?.expectedAccountConfigId === binding.expectedAccountConfigId
  );
}
