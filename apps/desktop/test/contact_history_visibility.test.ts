import { act, createElement as h } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createQueryRoot } from './support/query_root';
import { ContactHistory } from '../src/renderer/src/components/ContactHistory';
import { ContactRow } from '../src/renderer/src/components/contactProfile/ContactRow';
import {
  ContactFieldHistoryProvider,
  useContactFieldHistoryAvailable,
} from '../src/renderer/src/components/contactProfile/ContactFieldHistory';
import { ContactFieldHistoryContext } from '../src/renderer/src/lib/contactFieldHistoryContext';
import { CONTACT_HISTORY_DISPLAY_ENABLED } from '../src/renderer/src/lib/contactHistoryVisibility';
import { SelfAvatarHistory } from '../src/renderer/src/components/SelfAvatarHistory';
import { ProfileExtras } from '../src/renderer/src/components/ProfileExtras';
const rpc = vi.hoisted(() => ({
  summary: vi.fn(),
  versions: vi.fn(),
  categories: vi.fn(),
  signatures: vi.fn(),
  avatars: vi.fn(),
}));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({
    available: true,
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' },
  }),
}));
vi.mock('../src/renderer/src/hooks/useQQAutoRefresh', () => ({
  useQQReadActivity: () => ({ enabled: true }),
}));
vi.mock('../src/renderer/src/components/MediaSaveControls', () => ({
  MediaSourceSave: () => null,
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      contactMetrics: {
        history: { fieldSummary: { query: rpc.summary }, fieldVersions: { query: rpc.versions } },
      },
    },
  },
  trpc: {
    account: {
      contactMetrics: { history: { categories: { useQuery: rpc.categories } } },
      profileExtras: {
        energy: { useQuery: () => ({ data: undefined }) },
        signatureHistory: { useInfiniteQuery: rpc.signatures },
        signatureLikes: { useInfiniteQuery: () => ({}) },
        avatarHistory: { useInfiniteQuery: rpc.avatars },
      },
    },
  },
}));
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  rpc.signatures.mockReturnValue({
    data: { pages: [{ targetUin: '10002', items: [], hasMore: false, nextCursor: null }] },
    isFetching: false,
    hasNextPage: false,
    error: null,
  });
  rpc.avatars.mockReturnValue({
    data: {
      pages: [
        {
          items: [
            {
              id: 'a',
              url: 'https://q1.qlogo.cn/synthetic/a',
              thumbnailUrl: 'https://q1.qlogo.cn/synthetic/a',
              firstUsedAt: 1700000000,
              lastUsedAt: 1700100000,
            },
          ],
          hasMore: false,
          nextCursor: null,
        },
      ],
    },
    isFetching: false,
    hasNextPage: false,
    error: null,
  });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) act(cleanup);
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});
async function render(node: ReturnType<typeof h>) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createQueryRoot(host);
  cleanups.push(() => root.unmount());
  await act(async () => root.render(node));
  return host;
}
function Availability() {
  return h('output', null, String(useContactFieldHistoryAvailable('昵称')));
}
it.each([
  ['friend:u_peer', undefined],
  ['group:12345', undefined],
  ['group:12345', 'u_peer'],
] as const)(
  '撤下 %s 的所有自建历史入口和汇总展示，保留当前资料且不查询历史',
  async (entity, memberUid) => {
    expect(CONTACT_HISTORY_DISPLAY_ENABLED).toBe(false);
    const host = await render(
      h(
        ContactFieldHistoryProvider,
        { entity, memberUid },
        ...['昵称', '个性签名', '头像', '累计获赞', '群成员数', '学校', '标签'].map((label) =>
          h(ContactRow, { key: label, label, value: `当前${label}` }),
        ),
        h(ContactRow, { label: '公司', value: '' }),
        h(ContactHistory, { entity }),
      ),
    );
    expect(host.querySelectorAll('.weq-profile-field-history, .contact-history')).toHaveLength(0);
    expect(host.textContent).toContain('当前昵称');
    expect(host.textContent).not.toContain('暂无当前资料');
    expect(rpc.summary).not.toHaveBeenCalled();
    expect(rpc.versions).not.toHaveBeenCalled();
    expect(rpc.categories).not.toHaveBeenCalled();
  },
);
it('旧上下文仍有字段变化时也不显示入口或保留仅供历史的空行', async () => {
  const host = await render(
    h(
      ContactFieldHistoryContext.Provider,
      { value: { entity: 'friend:u_peer', fields: ['nick', 'company', 'avatar'] } },
      h(Availability),
      h(ContactRow, { label: '公司', value: '' }),
      h(ContactRow, { label: '昵称', value: '当前昵称' }),
    ),
  );
  expect(host.querySelector('output')?.textContent).toBe('false');
  expect(host.querySelector('[aria-label="显示昵称历史"]')).toBeNull();
  expect(host.textContent).not.toContain('公司');
});
it('QQ 原生签名历史仍按需打开，并使用原签名历史接口', async () => {
  const host = await render(h(ProfileExtras, { uin: '10002', section: 'signature' }));
  expect(rpc.signatures).not.toHaveBeenCalled();
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('历史签名'))!
      .click(),
  );
  expect(rpc.signatures).toHaveBeenCalledWith(
    expect.objectContaining({
      uin: '10002',
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'fixture',
    }),
    expect.anything(),
  );
  expect(document.body.textContent).toContain('暂无历史签名');
  expect(rpc.summary).not.toHaveBeenCalled();
});
it('QQ 原生本人头像历史仍按需打开，并显示原头像历史接口的结果', async () => {
  const host = await render(h(SelfAvatarHistory));
  expect(rpc.avatars).not.toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
  expect(rpc.avatars).toHaveBeenCalledWith(
    { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' },
    expect.anything(),
  );
  expect(document.querySelector('[aria-label="关闭历史头像"]')).not.toBeNull();
  expect(document.querySelectorAll('.weq-avatar-history-grid img')).toHaveLength(1);
  expect(rpc.summary).not.toHaveBeenCalled();
});
