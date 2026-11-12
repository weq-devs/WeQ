import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContactGroupWorkspace } from '../src/renderer/src/components/contactProfile/ContactGroupWorkspace';
import { useDraftProtection } from '../src/renderer/src/lib/draftClose';
import type { Contact } from '../src/renderer/src/im-template/template/types';

const rpc = vi.hoisted(() => ({
  config: 'source-a',
  busy: false,
  groups: vi.fn(),
  detail: vi.fn(),
}));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: rpc.config },
  }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: { listUserGroups: { query: rpc.groups }, getGroupDetail: { query: rpc.detail } },
  },
}));
vi.mock('../src/renderer/src/components/contactProfile/ContactContent', () => ({
  ContactGroupContent: ({ person }: { person: Contact }) => {
    useDraftProtection(null, rpc.busy);
    return h(
      'p',
      { 'data-member': true },
      `${person.profileContext?.groupCode}:${person.profileContext?.member?.card}`,
    );
  },
}));
vi.mock('../src/renderer/src/components/contactProfile/ContactActions', () => ({
  ContactActions: ({ person }: { person: Contact }) =>
    h('p', { 'data-actions': true }, person.profileContext?.groupCode),
}));
const contact: Contact = {
  id: 'u_group_test',
  uid: 'u_group_test',
  identityLabel: 'QQ',
  identityValue: '10002',
  displayName: '测试',
  username: 'test',
  avatarUrl: null,
  createdAt: '',
  profileContext: { groupCode: '99999', groupName: '来源群', member: { card: '来源群昵称' } },
};
const roots: Array<{ root: ReturnType<typeof createRoot>; cache: QueryClient }> = [];
beforeEach(() => {
  rpc.config = 'source-a';
  rpc.busy = false;
  vi.clearAllMocks();
  rpc.groups.mockResolvedValue([
    { groupCode: '10003', uid: contact.id, card: '另一个群昵称', joinTime: 1725120000 },
  ]);
  rpc.detail.mockImplementation(async ({ groupCode }) => ({
    groupCode,
    groupName: `群${groupCode}`,
    ownerUid: 'u_owner',
  }));
});
afterEach(() => {
  for (const { root, cache } of roots) {
    act(() => root.unmount());
    cache.clear();
  }
  roots.length = 0;
  document.body.innerHTML = '';
});
function fixture() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
    logger: { log() {}, warn() {}, error() {} },
  });
  roots.push({ root, cache });
  const render = async () => {
    await act(async () => {
      root.render(h(QueryClientProvider, { client: cache }, h(ContactGroupWorkspace, { contact })));
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
  };
  return { host, render };
}
async function select(host: HTMLElement, value: string) {
  await act(async () => {
    const input = host.querySelector('select')!;
    input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
}
it('来源群不在当前所在群名单中仍可浏览，切群仅改变成员与操作上下文', async () => {
  const { host, render } = fixture();
  await render();
  await render();
  expect(host.querySelectorAll('option')).toHaveLength(2);
  expect(host.querySelector('[data-member]')?.textContent).toBe('99999:来源群昵称');
  await select(host, '10003');
  expect(host.querySelector('[data-member]')?.textContent).toBe('10003:另一个群昵称');
  expect(host.querySelector('[data-actions]')?.textContent).toBe('10003');
  expect(contact.profileContext?.groupCode).toBe('99999');
  expect(rpc.groups).toHaveBeenCalledWith(
    expect.objectContaining({ expectedAccountConfigId: 'source-a', uid: contact.id, offset: 0 }),
  );
});
it('保存进行中不会切群或丢掉当前编辑上下文', async () => {
  rpc.busy = true;
  const { host, render } = fixture();
  await render();
  await render();
  await select(host, '10003');
  expect(host.querySelector('[data-member]')?.textContent).toBe('99999:来源群昵称');
});
it('切换数据源后迟到的群列表不进入新页面', async () => {
  let finish: (value: unknown) => void = () => {};
  rpc.groups.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { host, render } = fixture();
  await render();
  rpc.config = 'source-b';
  rpc.groups.mockResolvedValue([
    { groupCode: '20003', uid: contact.id, card: '新来源昵称', joinTime: 1725120000 },
  ]);
  await render();
  await render();
  await act(async () => {
    finish([{ groupCode: '10003', uid: contact.id, card: '旧来源昵称', joinTime: 1725120000 }]);
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
  expect([...host.querySelectorAll('option')].map((node) => node.value)).toEqual([
    '99999',
    '20003',
  ]);
  await select(host, '20003');
  expect(host.querySelector('[data-member]')?.textContent).toBe('20003:新来源昵称');
});
