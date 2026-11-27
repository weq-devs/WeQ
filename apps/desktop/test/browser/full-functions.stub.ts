import { useSyncExternalStore } from 'react';
import { normalizeNotificationEvents } from '@weq/service/notification-settings';
import { qqCapabilityAllowsOnline, type QqCapabilityMode } from '@weq/service/qq-capability-mode';
import { trpc as baseTrpc, client as baseClient, setOnlineFixture } from './qq-debug-copy.stub';

const params = new URLSearchParams(location.search);
const listeners = new Set<() => void>();
let settings = {
  realtimeEnabled: true,
  autoAttachQq: true,
  qqCapabilityMode: 'online' as QqCapabilityMode,
  qqStatusIndicatorEnabled: true,
  databaseReadConcurrency: 4,
  notificationEvents: normalizeNotificationEvents(undefined),
};
let proxyStatus = {
  accountUin: '10001',
  accountConfigId: 'synthetic',
  enabled: true,
  connected: true,
  connectionExpected: true,
  connecting: false,
  running: true,
  port: 19081,
  error: '',
  uses: { sync: true, liveMessages: false, antiRecall: false },
};
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function setProxyFixture(patch: Partial<typeof proxyStatus>) {
  proxyStatus = { ...proxyStatus, ...patch };
  for (const listener of listeners) listener();
}
export const saves: string[] = [];
const bootstrap = new Proxy(Reflect.get(baseTrpc as object, 'bootstrap'), {
  get(target, key) {
    if (key === 'getWelcomeAcknowledged') return { useQuery: () => ({ data: false }) };
    if (key === 'qqDataAccess') return { useQuery: () => ({ data: { status: 'readable' } }) };
    if (key === 'getQqClientSyncStatus')
      return {
        useQuery: () => ({
          data: useSyncExternalStore(subscribe, () => proxyStatus),
        }),
      };
    if (key === 'systemInfo')
      return { useQuery: () => ({ data: { platformKind: params.get('platform') ?? 'darwin' } }) };
    if (key === 'sipEnabled')
      return {
        useQuery: () => ({
          data: params.has('sip-error') ? undefined : !params.has('sip-off'),
          isError: params.has('sip-error'),
          error: params.has('sip-error') ? new Error('合成的 SIP 检测失败') : null,
          refetch: async () => ({}),
        }),
      };
    if (key === 'getSettings')
      return {
        useQuery: () => ({
          data: useSyncExternalStore(subscribe, () => settings),
          refetch: async () => ({ data: settings }),
        }),
      };
    if (key === 'setQqCapabilityMode')
      return {
        useMutation: () => ({
          mutateAsync: async ({ mode }: { mode: QqCapabilityMode }) => {
            saves.push(mode);
            settings = {
              ...settings,
              qqCapabilityMode: mode,
              autoAttachQq: qqCapabilityAllowsOnline(mode),
            };
            setOnlineFixture({ attachEnabled: settings.autoAttachQq });
            for (const listener of listeners) listener();
            return { status: 'saved', mode };
          },
        }),
      };
    if (key === 'setQqStatusIndicatorEnabled')
      return {
        useMutation: () => ({
          mutateAsync: async ({ enabled }: { enabled: boolean }) => {
            saves.push(String(key));
            settings = {
              ...settings,
              qqStatusIndicatorEnabled: enabled,
            };
            for (const listener of listeners) listener();
          },
        }),
      };
    return Reflect.get(target, key);
  },
});
export const trpc = new Proxy(baseTrpc as object, {
  get: (target, key) => (key === 'bootstrap' ? bootstrap : Reflect.get(target, key)),
});
export const client = baseClient;
