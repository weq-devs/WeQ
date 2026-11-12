import { useSyncExternalStore } from 'react';
import { DEFAULT_CONTACT_CARD, normalizeContactCard } from '@weq/service/contact-card';
const listeners = new Set<() => void>();
let revision = 0;
const seen = new Set<string>();
export const fixturePrivileges = [
  { bizId: 1, opened: true, level: 3, iconUrl: 'https://fixture.invalid/privilege-square.png' },
  { bizId: 2, opened: true, level: 2, iconUrl: 'https://fixture.invalid/privilege-wide.png' },
  { bizId: 3, opened: false, level: 1, iconUrl: 'https://fixture.invalid/privilege-closed.png' },
];
export const qa = {
  calls: [] as Array<{ path: string; input: Record<string, unknown> }>,
  settings: normalizeContactCard(DEFAULT_CONTACT_CARD),
  account: '10001',
  config: 'source',
  online: true,
  mode: 'friend' as 'friend' | 'nonfriend' | 'self' | 'bot' | 'enterprise' | 'clone',
  inGroup: true,
  muted: false,
  noRemark: new URLSearchParams(location.search).has('no-remark'),
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
  // 名片设置预览要「本人真实资料」，这里给当前登录账号的一份自述资料（不含任何示例联系人）。
  if (path === 'account.getSelfProfile')
    return {
      uid: 'u_self',
      uin: qa.account,
      nick: '本人的昵称',
      avatarUrl: '',
      signature: '这是我自己的签名，用来预览名片效果。',
      gender: 1,
      age: 31,
      birthYear: 1994,
      birthMonth: 3,
      birthDay: 8,
      qid: 'self-qid',
      customStatus: { desc: '在线' },
      extInfo: {
        country: '中国',
        province: '福建',
        city: '厦门',
        school: '自己的学校',
        degree: '本科',
        privileges: fixturePrivileges,
        interactMarks: [],
        album: [],
        interests: [],
      },
    };
  if (path === 'account.getCardDisplayNames')
    return {
      name: qa.mode === 'self' || String(input.target) === qa.account ? '我' : '林同学',
      remark:
        qa.noRemark || qa.mode === 'self' || String(input.target) === qa.account ? '' : '小林',
    };
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
      company: uin === qa.account ? '自己的公司' : '示例工作室',
      personalDescription: '合成说明\n保留换行。',
      email: uin === qa.account ? 'self@example.com' : 'sample@example.invalid',
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
  if (path === 'account.profileExtras.educationHistory')
    return {
      targetUin: uin,
      // 默认空列表；带 ?education=1 的审计页用两段合成经历压换行与分行。
      items: new URLSearchParams(location.search).has('education')
        ? [
            {
              index: 1,
              category: 3,
              schoolId: 'school',
              schoolName: '示例大学',
              departmentId: 'department',
              departmentName: '计算机学院',
              degree: 6,
              enrollmentYear: 2019,
              graduationYear: 2023,
              allowRecommend: 0,
              createSource: null,
              createdAt: null,
              updateSource: null,
              updatedAt: null,
              hidden: 0,
              verifyStatus: 2,
              verifyType: 1,
            },
            {
              index: 2,
              category: 3,
              schoolId: 'school2',
              schoolName: '示例附属中学',
              departmentId: null,
              departmentName: null,
              degree: 7,
              enrollmentYear: 2016,
              graduationYear: 2019,
              allowRecommend: 0,
              createSource: null,
              createdAt: null,
              updateSource: null,
              updatedAt: null,
              hidden: 1,
              verifyStatus: 0,
              verifyType: 0,
            },
          ]
        : [],
    };
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
