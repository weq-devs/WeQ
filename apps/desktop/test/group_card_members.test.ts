import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { GroupCardMemberList } from '../src/renderer/src/components/groupProfile/GroupCardMemberList';
import { RelationshipDirectoryContext } from '../src/renderer/src/lib/contactRelationship';
import type { GroupConversation } from '../src/renderer/src/im-template/template/types';
import { displayGroupMemberName } from '../src/renderer/src/im-template/template/user';

const mock = vi.hoisted(() => ({
  scope: 'source-a',
  list: vi.fn(),
  search: vi.fn(),
  profiles: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      listGroupMembers: { query: mock.list },
      searchGroupMembers: { query: mock.search },
      getProfilesByUids: { query: mock.profiles },
    },
  },
  trpc: {},
}));
vi.mock('../src/renderer/src/hooks/useGroupProfile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/src/hooks/useGroupProfile')>()),
  useGroupReadScope: () => ({
    active: true,
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: mock.scope },
    key: `10001:${mock.scope}`,
  }),
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  Modal: ({ children }) => h('div', null, children),
}));
vi.mock('../src/renderer/src/im-template/template/primitives', () => ({ Avatar: () => h('span') }));

const group = {
  id: '12345',
  type: 'group',
  group: { name: '测试群' },
  members: [],
} as unknown as GroupConversation;
const wire = (n: number) => ({
  uid: `u_${n}`,
  uin: String(20000 + n),
  card: `成员${n}`,
  nick: `昵称${n}`,
  memberFlag: 0,
  adminFlag: 0,
  joinTime: 0,
  lastSpeakTime: 0,
  muteUntil: 0,
  memberLevel: 0,
  customTitle: '',
});
const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => {
    fn();
  });
  vi.unstubAllGlobals();
});
function fixture(kind: 'members' | 'friends' = 'members', complete = true, conversation = group) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mock.scope = 'source-a';
  mock.list.mockReset().mockResolvedValue([wire(1)]);
  mock.search.mockReset().mockResolvedValue({ members: [], total: 0 });
  mock.profiles.mockReset().mockResolvedValue([]);
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement('div');
  const anchor = document.createElement('button');
  document.body.append(host, anchor);
  const root = createRoot(host);
  const close = vi.fn();
  const open = vi.fn();
  function render() {
    act(() =>
      root.render(
        h(
          QueryClientProvider,
          { client: query },
          h(
            RelationshipDirectoryContext.Provider,
            {
              value: {
                friends: new Map([
                  ['u_101', {}],
                  ['20102', {}],
                ]),
                friendsComplete: complete,
                groups: new Map(),
              },
            },
            h(GroupCardMemberList, {
              conversation,
              kind,
              anchor,
              onClose: close,
              onOpenMember: open,
            }),
          ),
        ),
      ),
    );
  }
  cleanup.push(() => {
    act(() => root.unmount());
    query.clear();
    host.remove();
    anchor.remove();
  });
  return { host, render, open, close };
}
async function until(predicate: () => boolean) {
  for (let n = 0; n < 30 && !predicate(); n++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  expect(predicate()).toBe(true);
}
it('成员名单按当前账号分页读取，点击头像与名称整体打开个人名片而不关闭名单', async () => {
  const { host, render, open, close } = fixture();
  render();
  await until(() => host.querySelectorAll('li').length === 1);
  expect(mock.list).toHaveBeenCalledWith({
    expectedAccountUin: '10001',
    expectedAccountConfigId: 'source-a',
    groupCode: '12345',
    limit: 100,
    offset: 0,
  });
  act(() => (host.querySelector('li button') as HTMLButtonElement).click());
  expect(open.mock.calls[0][0].id).toBe('u_1');
  expect(close).not.toHaveBeenCalled();
});
it('好友名单继续读取空候选页，按原始页推进游标并按 UID 或 QQ 号识别好友', async () => {
  const { host, render } = fixture('friends');
  mock.list.mockImplementation(async ({ offset }) =>
    offset === 0
      ? Array.from({ length: 100 }, (_, i) => wire(i + 1))
      : [wire(101), wire(102), { ...wire(103), memberFlag: 1 }],
  );
  render();
  await until(() => host.querySelectorAll('li').length === 2);
  expect(mock.list.mock.calls.map(([input]) => input.offset)).toEqual([0, 100]);
  expect([...host.querySelectorAll('strong')].map((node) => node.textContent)).toEqual([
    '昵称101',
    '昵称102',
  ]);
  expect(host.textContent).not.toContain('暂无本地群内好友记录');
});
it('好友目录未齐时不把成员列表当成好友列表，也不显示假的空名单', () => {
  const { host, render } = fixture('friends', false);
  render();
  expect(mock.list).not.toHaveBeenCalled();
  expect(host.textContent).toContain('好友名单尚未就绪');
  expect(host.textContent).not.toContain('暂无本地');
});
it('读取失败提供重试，成功后恢复名单', async () => {
  const { host, render } = fixture();
  mock.list.mockRejectedValueOnce(new Error('数据库暂不可用'));
  render();
  await until(() => Boolean(host.querySelector('[role="alert"]')));
  act(() => (host.querySelector('[role="alert"] button') as HTMLButtonElement).click());
  await until(() => host.querySelectorAll('li').length === 1);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
it('同号切换数据源后不显示上一数据源名单', async () => {
  const { host, render } = fixture();
  render();
  await until(() => host.querySelectorAll('li').length === 1);
  mock.scope = 'source-b';
  mock.list.mockResolvedValue([wire(2)]);
  render();
  expect(host.querySelector('li')).toBeNull();
  await until(() => host.querySelector('strong')?.textContent === '昵称2');
  expect(mock.list.mock.calls.at(-1)?.[0].expectedAccountConfigId).toBe('source-b');
});
it('本地合成群只读自身完整成员，不请求真实 QQ 成员接口', () => {
  const conversation = {
    ...group,
    generated: { kind: 'group', ownerId: 'local' },
    members: [
      {
        id: 'virtual:user',
        displayName: '本地成员',
        identityValue: 'virtual:user',
        role: 'member',
      },
    ],
  } as GroupConversation;
  const { host, render } = fixture('members', true, conversation);
  render();
  expect(host.querySelector('strong')?.textContent).toBe('本地成员');
  expect(mock.list).not.toHaveBeenCalled();
  expect(mock.profiles).not.toHaveBeenCalled();
});

it.each(['members', 'friends'] as const)(
  '%s 名单优先备注、其次昵称，空白值跳过且永不回退群昵称',
  async (kind) => {
    const { host, render, open } = fixture(kind);
    mock.list.mockResolvedValue([wire(101), { ...wire(102), nick: '  ' }]);
    mock.profiles.mockResolvedValue([
      { uid: 'u_101', remark: '  好友备注  ', nick: '资料昵称101' },
      { uid: 'u_102', remark: '  ', nick: '  资料昵称102  ' },
    ]);
    render();
    await until(() => host.querySelectorAll('li').length === 2);
    expect([...host.querySelectorAll('strong')].map((node) => node.textContent)).toEqual([
      '好友备注',
      '资料昵称102',
    ]);
    expect(mock.profiles).toHaveBeenCalledWith({
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
      uids: ['u_101', 'u_102'],
    });
    const button = host.querySelector('li button') as HTMLButtonElement;
    expect(button.title).toBe('查看 好友备注 的资料');
    expect(button.getAttribute('aria-label')).toBe(button.title);
    act(() => button.click());
    expect(open.mock.calls[0][0]).toMatchObject({
      displayName: '好友备注',
      remark: '  好友备注  ',
      card: '成员101',
    });
  },
);

it('昵称与备注均缺失时显示 QQ 号，不泄漏群昵称', async () => {
  const { host, render } = fixture();
  mock.list.mockResolvedValue([{ ...wire(1), nick: '' }]);
  render();
  await until(() => host.querySelectorAll('li').length === 1);
  expect(host.querySelector('strong')?.textContent).toBe('20001');
  expect(host.textContent).not.toContain('成员1');
});

it('会话侧栏的名称函数仍优先群昵称，再依次回退备注、昵称和标识', () => {
  expect(displayGroupMemberName('群昵称', '备注', '昵称', '20001')).toBe('群昵称');
  expect(displayGroupMemberName(' ', '备注', '昵称', '20001')).toBe('备注');
  expect(displayGroupMemberName('', ' ', '昵称', '20001')).toBe('昵称');
  expect(displayGroupMemberName('', '', '', '20001')).toBe('20001');
});

it('批量资料读取失败时可重试，不退回群昵称', async () => {
  const { host, render } = fixture();
  mock.profiles.mockRejectedValueOnce(new Error('资料读取失败'));
  render();
  await until(() => Boolean(host.querySelector('[role="alert"]')));
  expect(host.querySelector('li')).toBeNull();
  act(() => (host.querySelector('[role="alert"] button') as HTMLButtonElement).click());
  await until(() => host.querySelector('strong')?.textContent === '昵称1');
});
