import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { GroupWorkspace } from '../src/renderer/src/components/groupProfile/GroupWorkspace';
import type { useGroupProfile } from '../src/renderer/src/hooks/useGroupProfile';
import type { GroupWorkspaceTab } from '../src/renderer/src/lib/profileNavigation';

vi.mock('../src/renderer/src/components/groupProfile/GroupProfileData', () => ({
  GroupProfileData: ({ onOpenMembers }: { onOpenMembers: () => void }) =>
    h('button', { onClick: onOpenMembers }, '查看群成员'),
}));
vi.mock('../src/renderer/src/im-template/template/groupInfoPanel', () => ({
  GroupInfoPanel: () => h('input', { 'aria-label': '搜索群成员' }),
}));
vi.mock('../src/renderer/src/hooks/useGroupProfile', () => ({
  useGroupReadScope: () => ({
    active: true,
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'source' },
    key: 'source',
  }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { listGroupMembers: { query: async () => [] } } },
  trpc: { account: { listGroupLeftMembers: { useQuery: () => ({}) } } },
}));
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});
function mount(section?: GroupWorkspaceTab, generated = false) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const data = {
    conversation: {
      id: '12345',
      type: 'group',
      group: { name: '群' },
      members: [],
      ...(generated ? { generated: {} } : {}),
    },
  } as ReturnType<typeof useGroupProfile>;
  act(() =>
    root.render(
      h(
        QueryClientProvider,
        { client: cache },
        h(GroupWorkspace, { data, section, onOpenMember: vi.fn() }),
      ),
    ),
  );
  cleanups.push(() => {
    act(() => root.unmount());
    cache.clear();
    host.remove();
  });
  return host;
}
it.each(['profile', 'details', 'history', 'members'] as const)(
  '%s 入口同时展示资料与成员，不恢复目录或技术详情',
  async (section) => {
    const host = mount(section);
    await act(async () => {});
    expect(host.querySelector('nav')).toBeNull();
    expect(host.querySelector('.weq-group-profile-information')).not.toBeNull();
    expect(host.querySelector('.weq-group-profile-members input')).not.toBeNull();
    expect(host.querySelector('.weq-profile-tech')).toBeNull();
    if (section === 'members') expect(document.activeElement).toBe(host.querySelector('input'));
  },
);
it.each([false, true])('成员数原地聚焦搜索，合成群=%s', async (generated) => {
  const host = mount(undefined, generated);
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
  expect(document.activeElement).toBe(host.querySelector('input'));
  expect(host.querySelector('.weq-group-profile-information')).not.toBeNull();
});
