import { useSyncExternalStore } from 'react';
import { trpc as fallback, client } from './settings-audit.stub';

const listeners = new Set<() => void>();
let revision = 0;
const settings = {
  showChatQqShow: true,
  showAvatarPendant: true,
  showMessageBubble: true,
  showMessageFont: true,
  showMessageSeq: false,
  showMessageDate: false,
  showMessageTime: false,
  readFromFirstUnread: false,
  autoFollowLatestMessages: true,
  jumpToLatestAfterSend: true,
  showScrollToBottomButton: true,
  renderTextMarkdown: false,
  qqShowCacheMinutes: 5,
  chatImageCacheMiB: 256,
  linkPreview: { enabled: true, autoFetch: false, screenshot: false },
  voiceTranscribe: { autoTranscribe: false },
};
const clearCalls: unknown[] = [];
Object.assign(window, { messageSettingsQa: { settings, clearCalls } });
const queryData: Record<string, unknown> = {
  getSettings: settings,
  getAccountConfig: { uin: '10001', configId: 'fixture' },
  systemInfo: { platformKind: 'linux' },
};
const mutationFields: Record<string, string> = {
  setRenderTextMarkdown: 'renderTextMarkdown',
  setReadFromFirstUnread: 'readFromFirstUnread',
  setAutoFollowLatestMessages: 'autoFollowLatestMessages',
  setJumpToLatestAfterSend: 'jumpToLatestAfterSend',
  setShowScrollToBottomButton: 'showScrollToBottomButton',
};
function save(name: string, input: Record<string, unknown>) {
  if (name === 'clearLocalReadRecords') {
    clearCalls.push(input);
    return { cleared: true };
  }
  if (name === 'setLinkPreview') Object.assign(settings.linkPreview, input);
  else if (name === 'setAutoTranscribeVoice')
    settings.voiceTranscribe.autoTranscribe = input.enabled === true;
  else if (mutationFields[name])
    Object.assign(settings, { [mutationFields[name]!]: input.enabled });
  revision++;
  for (const listener of listeners) listener();
  return true;
}
function at(path: string[]): Record<string, (...args: unknown[]) => unknown> {
  return path.reduce((value, key) => value[key], fallback as never) as never;
}
function proxy(path: string[] = []): unknown {
  return new Proxy(() => {}, {
    get: (_target, key) => {
      const name = path.at(-1) ?? '';
      if (key === 'useUtils') return () => (fallback as { useUtils(): unknown }).useUtils();
      if (key === 'useQuery' && Object.hasOwn(queryData, name))
        return () => {
          useSyncExternalStore(
            (listener) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            () => revision,
          );
          return {
            data: queryData[name],
            isLoading: false,
            isFetching: false,
            refetch: async () => ({ data: queryData[name] }),
          };
        };
      if (
        key === 'useMutation' &&
        (mutationFields[name] ||
          ['clearLocalReadRecords', 'setLinkPreview', 'setAutoTranscribeVoice'].includes(name))
      )
        return () => ({
          isLoading: false,
          mutateAsync: async (input: Record<string, unknown>) => save(name, input),
          mutate: (input: Record<string, unknown>, callbacks?: { onSuccess?(): void }) => {
            save(name, input);
            callbacks?.onSuccess?.();
          },
        });
      if (key === 'useQuery' || key === 'useMutation' || key === 'useSubscription')
        return at(path)[key];
      return proxy([...path, String(key)]);
    },
  });
}
export const trpc = proxy();
export { client };
