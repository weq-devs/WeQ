import { useSyncExternalStore } from 'react';
import { DEFAULT_CONTACT_CARD, normalizeContactCard } from '@weq/service/contact-card';
const listeners = new Set<() => void>();
let revision = 0;
const seen = new Set<string>();
export const qa = {
  calls: [] as Array<{ path: string; input: Record<string, unknown> }>,
  settings: normalizeContactCard(DEFAULT_CONTACT_CARD),
  account: '10001',
  config: 'source',
  online: true,
  mode: 'friend' as 'friend' | 'nonfriend' | 'self' | 'bot' | 'enterprise' | 'clone',
  inGroup: true,
  muted: false,
  preferencesReady: !new URLSearchParams(location.search).has('preferences-loading'),
  failLabels: false,
  noConversation: false,
  pendingProfiles: 0,
  notify() {
    revision++;
    for (const listener of listeners) listener();
  },
  configure(value: unknown) {
    qa.settings = normalizeContactCard(value);
    qa.notify();
  },
};
if (new URLSearchParams(location.search).has('minimal'))
  qa.settings = normalizeContactCard({
    visible: Object.fromEntries(
      Object.keys(DEFAULT_CONTACT_CARD.visible).map((key) => [key, false]),
    ),
  });
export function useFixture() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => revision,
  );
}
const result = (data?: unknown) => ({
  data,
  isLoading: false,
  isFetching: false,
  isSuccess: true,
  error: null,
  refetch: async () => ({ data }),
});
function value(path: string, input: Record<string, unknown>) {
  const uin = String(input.uin || '10002');
  if (path === 'bootstrap.getSettings')
    return qa.preferencesReady ? { contactCard: qa.settings } : undefined;
  if (path === 'account.getAccountConfig') return { uin: qa.account, configId: qa.config };
  if (path === 'account.getGroupAlbumAccessState')
    return {
      qqOnline: true,
      attachEnabled: true,
      hasA2: true,
      hasD2: true,
      hasD2Key: true,
      hasGuid: true,
      ssoReady: true,
      source: { expectedAccountUin: qa.account, expectedAccountConfigId: qa.config },
    };
  if (path === 'account.getProfile' || path === 'account.getProfileByUin') return null;
  if (path === 'account.getCardDisplayNames')
    return { name: qa.mode === 'self' ? '我' : '林同学', remark: qa.mode === 'self' ? '' : '小林' };
  if (path === 'account.getBotProfile') return null;
  if (path === 'account.conversationBoundary')
    return qa.noConversation ? null : { msgId: '1', msgSeq: '1', sendTime: 1794390000 };
  if (path === 'account.dressup.peerQqShow') return { hasShow: false, url: '' };
  if (path === 'account.dressup.peerHome') return {};
  if (path === 'account.dressup.peerStats') return { level: 32, likeCount: 128 };
  if (path === 'account.profileExtras.energy') return { targetUin: uin, score: 831, level: 987 };
  if (path === 'account.profileExtras.details')
    return {
      targetUin: uin,
      company: '示例工作室',
      personalDescription: '合成说明\n保留换行。',
      email: 'sample@example.invalid',
      errors: {},
    };
  if (path === 'account.profileExtras.personalityLabels')
    return {
      targetUin: uin,
      closed: false,
      labels: [
        { id: 'empty', text: '没有照片的标签', photoCount: 0, photos: [], likeUsers: [], likes: 0 },
      ],
    };
  if (path === 'account.profileExtras.educationHistory') return { targetUin: uin, items: [] };
  if (
    path === 'account.profileExtras.signatureHistory' ||
    path === 'account.profileExtras.anonymousQuestions'
  )
    return { targetUin: uin, items: [], nextCursor: null, hasMore: false, paginationError: null };
  if (path === 'account.qqWrite.commonRelationships')
    return { friendCount: 3, groups: [{ groupCode: '10003', name: '合成共同群' }] };
  if (path === 'account.qqWrite.friendClue')
    return {
      uid: input.uid,
      addedAt: 1794300000,
      direction: 'outgoing',
      source: '合成来源',
      sourceGroupCode: null,
      verificationMessage: '',
    };
  if (path === 'account.qqWrite.friendNotesState')
    return {
      company: '我备注的公司',
      phones: ['10000'],
      descriptions: ['合成备注'],
      revision: '1',
    };
  if (path === 'account.browseConversation')
    return {
      items: [{ msgId: '11', sendTime: '1794390000', content: '合成本群发言' }],
      hasMore: false,
      cursor: null,
    };
  if (path === 'account.qzone.posts')
    return {
      list: [{ tid: '1', content: '合成空间预览', time: 1794390000, images: [], videos: [] }],
      total: 1,
    };
  if (path === 'account.intentSense.getStatus') return { profileEnabled: false };
  if (path === 'contactMetrics.history.categories') return [];
  return undefined;
}
function record(path: string, input: Record<string, unknown>, once = false) {
  const key = JSON.stringify([qa.account, qa.config, path, input]);
  if (once && seen.has(key)) return;
  seen.add(key);
  qa.calls.push({ path, input });
}
function rpc(path: string[] = []): unknown {
  return new Proxy(() => {}, {
    get(_target, key) {
      const name = path.join('.');
      if (key === 'useUtils') return () => rpc();
      if (key === 'invalidate' || key === 'cancel') return async () => {};
      if (key === 'useQuery')
        return (input: Record<string, unknown> = {}, options: { enabled?: boolean } = {}) => {
          useFixture();
          if (options.enabled !== false) record(name, input, true);
          const data = options.enabled === false ? undefined : value(name, input);
          return name.endsWith('personalityLabels') && qa.failLabels
            ? { ...result(), error: new Error('合成标签失败') }
            : result(data);
        };
      if (key === 'useInfiniteQuery')
        return (input: Record<string, unknown> = {}, options: { enabled?: boolean } = {}) => {
          useFixture();
          if (options.enabled !== false) record(name, input, true);
          return {
            ...result({
              pages:
                options.enabled === false || value(name, input) === undefined
                  ? []
                  : [value(name, input)],
            }),
            hasNextPage: false,
            isFetchNextPageError: false,
            fetchNextPage: async () => {},
          };
        };
      if (key === 'useMutation')
        return () => ({
          isLoading: false,
          error: null,
          mutateAsync: async (input: Record<string, unknown>) => {
            record(name, input);
            if (name === 'bootstrap.setContactCard') {
              qa.configure(input);
              return qa.settings;
            }
            return { status: 'accepted' };
          },
        });
      if (key === 'query')
        return async (input: Record<string, unknown> = {}) => {
          record(name, input);
          if (name === 'account.getProfile' && new URLSearchParams(location.search).has('slow')) {
            qa.pendingProfiles++;
            await new Promise((resolve) => setTimeout(resolve, 2000));
            qa.pendingProfiles--;
          }
          return value(name, input);
        };
      if (key === 'mutate') return async () => {};
      if (key === 'getData') return () => undefined;
      return rpc([...path, String(key)]);
    },
  });
}
export const trpc = rpc();
export const client = rpc();
export function useQQWriteSession() {
  useFixture();
  return {
    binding: { expectedAccountUin: qa.account, expectedAccountConfigId: qa.config },
    available: qa.online,
    busy: false,
    result: null,
    run: async () => true,
  };
}
