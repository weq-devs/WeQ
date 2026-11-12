import { useQuery, useQueryClient } from '@tanstack/react-query';

const binding = { expectedAccountUin: '99999', expectedAccountConfigId: 'fixture' };
const toggles = { pinned: false, disturb: false, care: true };
const preferences = { epoch: 'fixture', revision: 0, values: {}, records: {} };
const calls: unknown[] = [];
Object.assign(window, { settingsCalls: calls });
async function reply(path: string, input: Record<string, unknown> = {}) {
  calls.push({ path, input });
  if (path === 'clientState.patch') {
    preferences.revision++;
    Object.assign(preferences.values, input);
    return structuredClone(preferences);
  }
  if (path === 'account.getAccountConfig') return { uin: '99999', configId: 'fixture' };
  if (path === 'account.getGroupAlbumAccessState')
    return {
      qqOnline: true,
      attachEnabled: true,
      hasA2: true,
      hasD2: true,
      hasD2Key: true,
      hasGuid: true,
      ssoReady: true,
      source: binding,
    };
  if (path === 'account.qqWrite.peerState')
    return { friend: true, friendUin: '10002', pinned: toggles.pinned };
  if (path === 'account.qqWrite.friendDisturbState') return { enabled: toggles.disturb };
  if (path === 'account.qqWrite.friendSpecialCareState')
    return { enabled: toggles.care, zone: toggles.care, ring: toggles.care };
  if (path === 'account.qqWrite.pin') toggles.pinned = Boolean(input.enabled);
  if (path === 'account.qqWrite.friendDisturb') toggles.disturb = Boolean(input.enabled);
  if (path === 'account.qqWrite.friendSpecialCare') toggles.care = Boolean(input.enabled);
  if (path === 'account.antiRecall.getStatus')
    return {
      enabled: false,
      mode: 'selected',
      targets: [],
      notifyEnabled: false,
      notifyTargets: [],
    };
  if (path === 'account.intentSense.getStatus')
    return { enabled: false, engine: 'api', apiConfigured: true, conversationOverrides: {} };
  if (path === 'account.qqActions.qzoneFriendPermissionList') return [];
  if (path === 'clientState.get') return structuredClone(preferences);
  if (path === 'bootstrap.getSettings') return {};
  return { state: 'confirmed' };
}
function proxy(parts: string[] = []): unknown {
  return new Proxy(() => {}, {
    get(_target, key) {
      const path = parts.join('.');
      if (key === 'then') return undefined;
      if (key === 'query' || key === 'mutate') return (input) => reply(path, input);
      if (key === 'useQuery')
        return (input, options = {}) =>
          useQuery({
            queryKey: ['settings-fixture', path, input],
            queryFn: () => reply(path, input),
            ...options,
          });
      if (key === 'useMutation') return () => ({ mutateAsync: (input) => reply(path, input) });
      if (key === 'useUtils')
        return () => {
          const client = useQueryClient();
          return proxyUtils(client);
        };
      if (key === 'useSubscription') return () => {};
      return proxy([...parts, String(key)]);
    },
  });
}
function proxyUtils(client: ReturnType<typeof useQueryClient>, parts: string[] = []): unknown {
  return new Proxy(
    {},
    {
      get(_target, key) {
        if (key === 'invalidate')
          return () => client.invalidateQueries(['settings-fixture', parts.join('.')]);
        return proxyUtils(client, [...parts, String(key)]);
      },
    },
  );
}
export const trpc = proxy();
export const client = proxy();
export const useTrpcReady = () => true;
export const waitForTransport = async () => {};
export const ensureTransport = async () => {};
