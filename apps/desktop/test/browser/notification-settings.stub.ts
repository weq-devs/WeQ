import { useSyncExternalStore } from 'react';
import {
  normalizeNotificationEvents,
  type NotificationEvent,
} from '@weq/service/notification-settings';

const listeners = new Set<() => void>();
let revision = 0;
const notify = () => {
  revision++;
  for (const listener of listeners) listener();
};
const settings = {
  notificationEvents: normalizeNotificationEvents(undefined, {
    messageNotifications: false,
    mailNotifications: true,
    recallNotifications: true,
    restrictedModeBannerEnabled: false,
  }),
  showMessageUnreadBadge: false,
  showContactUnreadCount: true,
  restrictedModeBannerEnabled: false,
  toastDurations: { successSeconds: 3, failureSeconds: -1 },
  typingStatus: { scope: 'off', hidden: [] },
};
const mail = { showUnread: false, notifications: true, pollIntervalMinutes: 1 };
const recall = {
  enabled: true,
  mode: 'selected',
  targets: [{ kind: 'group', id: '20001' }],
  notifyEnabled: true,
  notifyTargets: ['group:20001'],
  installed: [],
  qqRunning: false,
};
const values: Record<string, unknown> = {
  'bootstrap.getSettings': settings,
  'account.getAccountConfig': { uin: '10001', configId: 'notification-fixture' },
  'settings.mail.get': mail,
  'settings.antiRecall.getStatus': recall,
  'account.antiRecall.getStatus': recall,
  'account.listConversationsWithCount': [
    {
      chatType: 'KCHATTYPEGROUP',
      targetUid: '20001',
      targetUin: '20001',
      targetDisplayName: '合成提醒群',
      messageCount: 3,
    },
  ],
};
const calls: Array<{ path: string; input: Record<string, unknown> }> = [];
const preferences: Record<string, unknown> = {
  messageNotifications: false,
  applicationBadge: true,
};
const records: Record<string, Record<string, unknown>> = {};
Object.assign(window, {
  notificationFixture: { calls, settings, mail, recall, preferences, records },
});
async function mutate(path: string, input: Record<string, unknown>) {
  calls.push({ path, input });
  if (path === 'clientState.accountPatch') {
    const namespace = String(input.namespace);
    records[namespace] = { ...records[namespace], ...(input.values as object) };
    revision++;
    return { revision, values: {}, records: structuredClone(records) };
  }
  if (path === 'bootstrap.setNotificationEvents') {
    for (const event of input.events as NotificationEvent[])
      Object.assign(
        settings.notificationEvents[event],
        input.channels ?? { [input.channel as 'banner' | 'system']: input.enabled },
      );
    notify();
    return structuredClone(settings.notificationEvents);
  }
  if (path === 'clientState.patch') {
    Object.assign(preferences, input);
    revision++;
    return { revision, values: { ...preferences }, records: {} };
  }
  if (path === 'settings.mail.patch') Object.assign(mail, input);
  else if (path === 'settings.antiRecall.setNotify') {
    if ('enabled' in input) recall.notifyEnabled = input.enabled as boolean;
    if ('targets' in input) recall.notifyTargets = input.targets as string[];
  } else {
    const key = {
      'bootstrap.setShowMessageUnreadBadge': 'showMessageUnreadBadge',
      'bootstrap.setShowContactUnreadCount': 'showContactUnreadCount',
      'bootstrap.setRestrictedModeBannerEnabled': 'restrictedModeBannerEnabled',
    }[path];
    if (key) Object.assign(settings, { [key]: input.enabled ?? input.suppressed });
  }
  notify();
  return path.includes('antiRecall') ? recall : mail;
}
function proxy(path = ''): unknown {
  return new Proxy(() => {}, {
    apply: () => proxy(path),
    get: (_target, key) => {
      if (key === 'useQuery')
        return () => {
          useSyncExternalStore(
            (listener) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            () => revision,
          );
          return {
            data: values[path],
            error: null,
            isLoading: false,
            isFetching: false,
            isError: false,
            refetch: async () => ({ data: values[path] }),
          };
        };
      if (key === 'useMutation')
        return () => ({
          isLoading: false,
          mutateAsync: (input: Record<string, unknown>) => mutate(path, input),
          mutate: (input: Record<string, unknown>, callbacks: { onSuccess?: () => void }) => {
            void mutate(path, input).then(() => callbacks?.onSuccess?.());
          },
        });
      if (key === 'useSubscription') return () => {};
      if (key === 'subscribe') return () => ({ unsubscribe() {} });
      if (key === 'setData') return () => notify();
      if (key === 'invalidate') return async () => notify();
      if (key === 'then') return undefined;
      if (key === 'query' || key === 'fetch')
        return async () =>
          path === 'clientState.snapshot'
            ? { revision, values: { ...preferences }, records: {} }
            : (values[path] ?? []);
      if (key === 'mutate') return (input: Record<string, unknown>) => mutate(path, input);
      return proxy(path ? `${path}.${String(key)}` : String(key));
    },
  });
}
export const trpc = proxy();
export const client = proxy();
