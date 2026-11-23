import { useSyncExternalStore } from 'react';
import { trpc as baseTrpc, client as baseClient } from './qq-debug-copy.stub';

const params = new URLSearchParams(location.search);
const listeners = new Set<() => void>();
let settings = {
  realtimeEnabled: true,
  autoAttachQq: true,
  restrictedModeBannerEnabled: true,
  restrictedModeIndicatorEnabled: true,
  databaseReadConcurrency: 4,
};
export const saves: string[] = [];
const bootstrap = new Proxy(Reflect.get(baseTrpc as object, 'bootstrap'), {
  get(target, key) {
    if (key === 'getWelcomeAcknowledged') return { useQuery: () => ({ data: false }) };
    if (key === 'systemInfo')
      return { useQuery: () => ({ data: { platformKind: params.get('platform') ?? 'darwin' } }) };
    if (key === 'sipEnabled')
      return {
        useQuery: () => ({
          data: params.has('sip-error') ? undefined : !params.has('sip-off'),
          error: params.has('sip-error') ? new Error('合成的 SIP 检测失败') : null,
          refetch: async () => ({}),
        }),
      };
    if (key === 'getSettings')
      return {
        useQuery: () => ({
          data: useSyncExternalStore(
            (listener) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            () => settings,
          ),
          refetch: async () => ({ data: settings }),
        }),
      };
    if (
      key === 'setAutoAttachQq' ||
      key === 'setRestrictedModeBannerEnabled' ||
      key === 'setRestrictedModeIndicatorEnabled'
    )
      return {
        useMutation: () => ({
          mutateAsync: async ({ enabled }: { enabled: boolean }) => {
            saves.push(String(key));
            settings = {
              ...settings,
              [key === 'setAutoAttachQq'
                ? 'autoAttachQq'
                : key === 'setRestrictedModeIndicatorEnabled'
                  ? 'restrictedModeIndicatorEnabled'
                  : 'restrictedModeBannerEnabled']: enabled,
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
