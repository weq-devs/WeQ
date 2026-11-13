import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  GroupReadTools,
  GROUP_SIGN_PAGE_SIZE,
} from '../src/renderer/src/components/qq-actions/GroupReadTools';
import { ProfileNavigationContext } from '../src/renderer/src/lib/profileNavigation';

const state = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { qqActions: { groupReadTools: { query: state.read } } } },
  trpc: {
    useUtils: () => ({ account: { qqActions: { groupReadTools: { invalidate: vi.fn() } } } }),
  },
}));
vi.mock('../src/renderer/src/hooks/useQQAutoRefresh', () => ({
  useQQAutoRefresh: (enabled: boolean) => ({ enabled, retry: false, refetchOnWindowFocus: false }),
}));
vi.mock('../src/renderer/src/components/qq-actions/shared', () => ({
  useQQAction: () => ({
    available: true,
    disabled: false,
    binding: { expectedAccountUin: '99999', expectedAccountConfigId: 'source-a' },
  }),
  ActionFeedback: () => null,
}));
vi.mock('../src/renderer/src/components/QqAvatar', () => ({
  QqAvatar: ({ uin }: { uin?: string }) => h('img', { alt: '', 'data-avatar-uin': uin }),
}));

type Member = { userId: number; nick: string; rank: number; time: number };
function members(start: number, count: number): Member[] {
  return Array.from({ length: count }, (_, index) => ({
    userId: 10000 + start + index,
    nick: `成员 ${start + index}`,
    rank: start + index + 1,
    time: 1800000000 + start + index,
  }));
}
function page(signed: Member[]) {
  return { signed, atAll: { canAtAll: true, remainCountForUin: 1, remainCountForGroup: 1 } };
}
let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.read.mockReset().mockResolvedValue(page([]));
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.unstubAllGlobals();
});
async function settle() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
}
async function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const open = vi.fn();
  dispose = () => {
    act(() => root.unmount());
    cache.clear();
    host.remove();
  };
  await act(async () =>
    root.render(
      h(
        QueryClientProvider,
        { client: cache },
        h(
          ProfileNavigationContext.Provider,
          { value: open },
          h(GroupReadTools, { groupId: 12345, groupName: '合成群', signing: true }),
        ),
      ),
    ),
  );
  await settle();
  return { host, open };
}
function rows() {
  return document.querySelectorAll('.weq-group-sign-list > li');
}
function bottom() {
  const list = document.querySelector<HTMLUListElement>('.weq-group-sign-list')!;
  Object.defineProperties(list, {
    clientHeight: { configurable: true, value: 240 },
    scrollHeight: { configurable: true, get: () => list.children.length * 32 },
  });
  list.scrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
  act(() => list.dispatchEvent(new Event('scroll', { bubbles: true })));
}

it('无页码与翻页按钮，滚到底部追加、去重，并按原始批次数量继续读取', async () => {
  let finish!: (value: ReturnType<typeof page>) => void;
  state.read.mockImplementation(({ offset }: { offset: number }) =>
    offset === 0
      ? Promise.resolve(page(members(0, GROUP_SIGN_PAGE_SIZE)))
      : offset === GROUP_SIGN_PAGE_SIZE
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(page(members(GROUP_SIGN_PAGE_SIZE * 2 - 1, 1))),
  );
  const { host } = await mount();
  expect(rows()).toHaveLength(GROUP_SIGN_PAGE_SIZE);
  expect(host.textContent).not.toContain('第 1 页');
  expect(host.querySelector('[aria-label="下一页打卡记录"]')).toBeNull();
  bottom();
  bottom();
  await settle();
  expect(
    state.read.mock.calls.filter(([input]) => input.offset === GROUP_SIGN_PAGE_SIZE),
  ).toHaveLength(1);
  expect(rows()).toHaveLength(GROUP_SIGN_PAGE_SIZE);
  await act(async () => finish(page(members(GROUP_SIGN_PAGE_SIZE - 1, GROUP_SIGN_PAGE_SIZE))));
  await settle();
  expect(rows()).toHaveLength(GROUP_SIGN_PAGE_SIZE * 2 - 1);
  bottom();
  await settle();
  expect(state.read).toHaveBeenLastCalledWith(
    expect.objectContaining({ offset: GROUP_SIGN_PAGE_SIZE * 2 }),
  );
  expect(rows()).toHaveLength(GROUP_SIGN_PAGE_SIZE * 2);
  const calls = state.read.mock.calls.length;
  bottom();
  await settle();
  expect(state.read).toHaveBeenCalledTimes(calls);
});

it('头像和昵称整体打开名片，传递真实 QQ 号及当前群，不把 QQ 号伪造为 UID', async () => {
  state.read.mockResolvedValue(
    page([...members(0, 1), { userId: 0, nick: '无有效账号', rank: 2, time: 1 }]),
  );
  const { host, open } = await mount();
  const person = host.querySelector<HTMLButtonElement>('[aria-label="查看 成员 0 的名片"]')!;
  expect(person.querySelector('[data-avatar-uin="10000"]')).not.toBeNull();
  expect(person.textContent).toBe('成员 0');
  act(() => person.click());
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({ id: '', identityValue: '10000', displayName: '成员 0' }),
    expect.anything(),
    { code: '12345', name: '合成群' },
  );
  expect(host.querySelector('[aria-label="查看 无有效账号 的名片"]')).toBeNull();
});

it('下一批失败保留已有成员，不自动反复读取，手动重试同一偏移后继续', async () => {
  state.read
    .mockResolvedValueOnce(page(members(0, GROUP_SIGN_PAGE_SIZE)))
    .mockRejectedValueOnce(new Error('下一批读取失败'))
    .mockResolvedValue(page(members(GROUP_SIGN_PAGE_SIZE, 1)));
  await mount();
  bottom();
  await settle();
  expect(rows()).toHaveLength(GROUP_SIGN_PAGE_SIZE);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('下一批读取失败');
  bottom();
  await settle();
  expect(state.read).toHaveBeenCalledTimes(2);
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="重试读取打卡记录"]')!.click(),
  );
  await settle();
  expect(state.read).toHaveBeenLastCalledWith(
    expect.objectContaining({ offset: GROUP_SIGN_PAGE_SIZE }),
  );
  expect(rows()).toHaveLength(GROUP_SIGN_PAGE_SIZE + 1);
});

it('换日期重新从首批读取，旧日期的迟到响应不追加到新日期', async () => {
  let finish!: (value: ReturnType<typeof page>) => void;
  let originalDay = '';
  state.read.mockImplementation(({ offset, day }: { offset: number; day: string }) => {
    originalDay ||= day;
    if (day !== originalDay)
      return Promise.resolve(page([{ userId: 30000, nick: '另一天', rank: 1, time: 2 }]));
    if (offset === 0) return Promise.resolve(page(members(0, GROUP_SIGN_PAGE_SIZE)));
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  await mount();
  bottom();
  await settle();
  const date = document.querySelector<HTMLInputElement>('[aria-label="打卡日期"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      date,
      '2020-01-02',
    );
    date.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  expect(rows()).toHaveLength(1);
  expect(rows()[0].textContent).toContain('另一天');
  await act(async () => finish(page(members(GROUP_SIGN_PAGE_SIZE, 1))));
  await settle();
  expect(rows()).toHaveLength(1);
  expect(rows()[0].textContent).toContain('另一天');
  expect(state.read).toHaveBeenLastCalledWith(
    expect.objectContaining({ day: '20200102', offset: 0 }),
  );
});
