import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, focusManager, useQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QzoneFriendPermissions } from '../src/renderer/src/components/qq-actions/QzoneFriendPermissions';
import { useGroupProfile } from '../src/renderer/src/hooks/useGroupProfile';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';
import { createTemplateDemoData } from './support/templateDemoData';

const rpc = vi.hoisted(() => ({
  permissions: vi.fn(async () => [{ uin: '10002', name: '合成好友' }]),
  extended: vi.fn(async (_input: unknown) => ({ groupId: 123456, profile: { grade: 1 } })),
  detail: vi.fn(async () => null),
}));
const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' };
vi.mock('../src/renderer/src/state/view', () => ({
  useViewState: (selector: (value: { openedUin: string }) => unknown) =>
    selector({ openedUin: '10001' }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      getGroupDetail: { query: rpc.detail },
      getGroupExtendedProfile: { query: rpc.extended },
    },
  },
  trpc: {
    account: {
      getAccountConfig: { useQuery: () => ({ data: { uin: '10001', configId: 'source-a' } }) },
      getProfileByUin: { useQuery: () => ({ data: null }) },
      contactMetrics: { snapshot: { useQuery: () => ({ data: { rows: {} } }) } },
      groupMemberPreview: { useQuery: () => ({}) },
      qqActions: {
        qzoneFriendPermissionList: {
          useQuery: (input: { kind: string }, options: object) =>
            useQuery(['permissions', input], rpc.permissions, options),
        },
        qzoneFriendPermission: { useMutation: () => ({}) },
      },
    },
  },
}));
vi.mock('../src/renderer/src/components/QqAvatar', () => ({ QqAvatar: () => null }));
vi.mock('../src/renderer/src/components/qq-actions/shared', () => ({
  withQQAccountScope: (component: unknown) => component,
  useQQAction: () => ({ binding, available: true, disabled: false }),
  ActionFeedback: () => null,
  ActionIcon: ({
    label,
    onClick,
    children,
  }: {
    label: string;
    onClick: () => void;
    children: ReactNode;
  }) => h('button', { 'aria-label': label, onClick }, children),
}));
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rpc.permissions.mockClear();
  rpc.extended.mockClear();
  focusManager.setFocused(true);
});
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  focusManager.setFocused(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function fixture(node: ReactNode) {
  const client = new QueryClient({ logger: { log() {}, warn() {}, error() {} } });
  const host = document.createElement('div');
  const root = createRoot(host);
  cleanups.push(() => {
    act(() => root.unmount());
    client.clear();
  });
  const render = async (active = true) => {
    await act(async () => {
      root.render(h(QueryClientProvider, { client }, h(TabActivity, { active }, node)));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  };
  await render();
  return { host, render };
}
async function focus() {
  await act(async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
it('空间权限名单进入、重新进入与恢复前台自动读取，不显示常驻刷新', async () => {
  const f = await fixture(h(QzoneFriendPermissions));
  expect(rpc.permissions).toHaveBeenCalledTimes(2);
  expect(f.host.textContent).toContain('合成好友');
  expect(f.host.querySelector('[aria-label^="刷新"]')).toBeNull();
  await focus();
  expect(rpc.permissions).toHaveBeenCalledTimes(4);
  await f.render(false);
  await focus();
  expect(rpc.permissions).toHaveBeenCalledTimes(4);
  await f.render(true);
  expect(rpc.permissions).toHaveBeenCalledTimes(6);
});
it('群状态恢复前台自动重读，不强制绕过服务端缓存，失活页不发请求', async () => {
  const original = createTemplateDemoData().conversations.find((row) => row.type === 'group')!;
  const conversation = { ...original, id: '123456' };
  function Reader() {
    const data = useGroupProfile(conversation, false);
    return h('span', null, String(data.extended?.profile?.grade ?? 'loading'));
  }
  const f = await fixture(h(Reader));
  expect(rpc.extended).toHaveBeenCalledTimes(1);
  expect(rpc.extended).toHaveBeenLastCalledWith({ ...binding, groupId: 123456, refresh: true });
  await focus();
  expect(rpc.extended).toHaveBeenCalledTimes(2);
  await f.render(false);
  await focus();
  expect(rpc.extended).toHaveBeenCalledTimes(2);
  expect(f.host.textContent).toBe('loading');
});
