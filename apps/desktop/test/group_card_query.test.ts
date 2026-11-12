import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { useGroupProfile } from '../src/renderer/src/hooks/useGroupProfile';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';
import type { GroupConversation } from '../src/renderer/src/im-template/template/types';
const mock = vi.hoisted(() => ({
  config: 'source-a',
  detail: vi.fn(),
  preview: vi.fn(),
  snapshots: vi.fn(),
  names: vi.fn(),
}));
vi.mock('../src/renderer/src/state/view', () => ({
  useViewState: (select) => select({ openedUin: '10001' }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: { getGroupDetail: { query: mock.detail }, getCardDisplayNames: { query: mock.names } },
  },
  trpc: {
    account: {
      getAccountConfig: { useQuery: () => ({ data: { uin: '10001', configId: mock.config } }) },
      groupMemberPreview: {
        useQuery: (input, options) =>
          useQuery({
            queryKey: ['preview', input],
            queryFn: () => mock.preview(input),
            ...options,
          }),
      },
      contactMetrics: {
        snapshot: {
          useQuery: (input, options) =>
            useQuery({
              queryKey: ['metrics', input],
              queryFn: () => mock.snapshots(input),
              ...options,
            }),
        },
      },
    },
  },
}));
const group = {
  id: '12345',
  type: 'group',
  group: { id: '12345', name: '本地群名', identityValue: '12345', memberCount: 20, role: 'member' },
  members: [],
} as unknown as GroupConversation;
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  vi.unstubAllGlobals();
});
function fixture(input = group, previewMembers = true) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mock.config = 'source-a';
  mock.detail.mockReset().mockResolvedValue(null);
  mock.preview
    .mockReset()
    .mockResolvedValue({ members: [], source: 'local', partial: true, error: null });
  mock.snapshots.mockReset().mockResolvedValue({ rows: {} });
  mock.names.mockReset().mockResolvedValue({ name: '补全的群名称' });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement('div'),
    root = createRoot(host);
  cleanup.push(() => {
    act(() => root.unmount());
    query.clear();
  });
  function Probe() {
    const result = useGroupProfile(input, previewMembers);
    return h(
      'span',
      null,
      `${result.scope}:${result.conversation.group.name}:${result.members.map((row) => row.displayName).join(',')}`,
    );
  }
  function render(active = true) {
    act(() =>
      root.render(h(QueryClientProvider, { client: query }, h(TabActivity, { active }, h(Probe)))),
    );
  }
  return { host, render };
}
it('快速名片关闭成员预览查询，完整资料页保留原来的预览读取', async () => {
  const { render } = fixture(group, false);
  render();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(mock.detail).toHaveBeenCalledOnce();
  expect(mock.preview).not.toHaveBeenCalled();
});
it('名片和资料页重用查询，不查询公告／扩展资料；inactive 不启动读取', async () => {
  const { render } = fixture();
  render(false);
  expect(mock.detail).not.toHaveBeenCalled();
  expect(mock.preview).not.toHaveBeenCalled();
  render();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  render();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(mock.detail).toHaveBeenCalledTimes(1);
  expect(mock.names).not.toHaveBeenCalled();
  expect(mock.preview).toHaveBeenCalledTimes(1);
  expect(mock.preview).toHaveBeenCalledWith({
    expectedAccountUin: '10001',
    expectedAccountConfigId: 'source-a',
    groupCode: '12345',
  });
});
it('只有本地和入口均缺群名时才补全，结果不回写传入会话', async () => {
  const input = { ...group, group: { ...group.group, name: group.id } };
  const { host, render } = fixture(input);
  render();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  expect(mock.names).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('补全的群名称');
  expect(input.group.name).toBe(group.id);
});
it('本地生成群不向真实群资料或成员接口查询', async () => {
  const { render } = fixture({
    ...group,
    generated: { kind: 'group', ownerId: 'local-group' },
  } as unknown as GroupConversation);
  render();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(mock.detail).not.toHaveBeenCalled();
  expect(mock.preview).not.toHaveBeenCalled();
  expect(mock.names).not.toHaveBeenCalled();
});
it.each([undefined, 'u_self'])(
  '本人占位与成员预览按 QQ 号合并，保留真实群成员资料（uid=%s）',
  async (uid) => {
    const { host, render } = fixture({
      ...group,
      members: [
        {
          id: 'self:10001',
          uid,
          username: 'uin-10001',
          displayName: '本人昵称',
          identityLabel: 'UIN',
          identityValue: '10001',
          avatarUrl: null,
          role: 'member',
          joinedAt: '',
        },
      ],
    });
    mock.preview.mockResolvedValue({
      members: [
        {
          uid: 'u_self',
          uin: '10001',
          nick: '本人昵称',
          card: '本人群名片',
          joinTime: 0,
          lastSpeakTime: 0,
          muteUntil: 0,
          adminFlag: 1,
          memberFlag: 0,
          customTitle: '',
          memberLevel: 0,
        },
      ],
      source: 'local',
      partial: true,
      error: null,
    });
    render();
    expect(host.textContent).toContain('本人昵称');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(host.textContent?.split(':').at(-1)).toBe('本人群名片');
  },
);
it('同号切换数据源后不显示旧成员或接收迟到响应', async () => {
  const { host, render } = fixture();
  let finish: (value: unknown) => void = () => {};
  mock.preview.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  mock.config = 'source-b';
  render();
  await act(async () => {
    finish({
      members: [
        {
          uid: 'u_old',
          uin: '20002',
          nick: '旧账号成员',
          card: '',
          joinTime: 0,
          lastSpeakTime: 0,
          muteUntil: 0,
          adminFlag: 0,
          memberFlag: 0,
          customTitle: '',
          memberLevel: 0,
        },
      ],
      source: 'local',
      partial: true,
      error: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(host.textContent).toContain('source-b');
  expect(host.textContent).not.toContain('旧账号成员');
  expect(mock.preview).toHaveBeenCalledTimes(2);
});
