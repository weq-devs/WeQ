import { act, createElement as h, useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GroupAnnouncementsDialog } from '../src/renderer/src/components/GroupAnnouncementsDialog';
import { GroupFeatureSurface } from '../src/renderer/src/components/GroupFeatureSurface';
import type { QQWriteBinding, QQWriteOutcome } from '../src/renderer/src/hooks/useQQWriteSession';

const state = vi.hoisted(() => ({ publish: vi.fn(), confirm: vi.fn(async () => true) }));
const binding: QQWriteBinding = {
  expectedAccountUin: '10001',
  expectedAccountConfigId: 'receipt-source',
};

vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: { qqActions: { notice: { mutate: (...args: unknown[]) => state.publish(...args) } } },
  },
  trpc: {
    account: {
      qqActions: {
        notices: {
          useQuery: () => ({
            data: [],
            isFetching: false,
            refetch: async () => ({ data: [], error: null }),
          }),
        },
      },
    },
  },
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  Modal: ({ children }: { children: ReactNode }) => children,
  useDialog: Object.assign(() => state.confirm, { getState: () => ({ confirm: state.confirm }) }),
}));
vi.mock('../src/renderer/src/hooks/useGroupNoticePublishers', () => ({
  useGroupNoticePublishers: (_groupCode: string, entries: unknown[]) => entries,
}));
vi.mock('../src/renderer/src/components/GroupBulletinList', () => ({
  GroupBulletinList: () => null,
}));
vi.mock('../src/renderer/src/hooks/useQQAutoRefresh', () => ({
  useQQAutoRefresh: () => ({ enabled: true }),
}));
vi.mock('../src/renderer/src/components/qq-actions/shared', () => ({
  withQQAccountScope: (Component: (props: object) => ReactNode) => Component,
  useQQGroupPermissions: () => ({ data: { canManage: true } }),
  useQQAction: () => {
    const mounted = useRef(true);
    useEffect(() => {
      mounted.current = true;
      return () => {
        mounted.current = false;
      };
    }, []);
    return {
      binding,
      available: true,
      disabled: false,
      busy: false,
      pending: false,
      perform: async (
        action: (source: QQWriteBinding) => Promise<QQWriteOutcome>,
        refresh?: () => Promise<unknown>,
      ) => {
        await action(binding);
        // 对照真实写会话：原组件卸载后不再调用其读回／刷新回调。
        if (mounted.current) await refresh?.();
        return true;
      },
    };
  },
  ActionFeedback: () => null,
  ActionIcon: ({ label, children, ...props }: { label: string; children: ReactNode }) =>
    h('button', { type: 'button', 'aria-label': label, ...props }, children),
  ImageAction: () => null,
}));

const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  state.publish.mockReset();
  state.confirm.mockClear();
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

function mount(element: ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(element));
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}
function click(label: string) {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button, label).not.toBeNull();
  act(() => button!.click());
}
function edit(value: string) {
  const input = document.querySelector<HTMLTextAreaElement>('[aria-label="新公告内容"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function Fixture() {
  const [opened, setOpened] = useState(true);
  return h(
    'div',
    null,
    h('button', { 'aria-label': '重新打开公告', onClick: () => setOpened(true) }, '公告'),
    opened
      ? h(GroupAnnouncementsDialog, {
          groupCode: '123',
          groupName: '回执合成群',
          presentation: 'popover',
          onClose: () => setOpened(false),
        })
      : null,
  );
}
function deferredReceipt() {
  let resolve!: (outcome: QQWriteOutcome) => void;
  const pending = new Promise<QQWriteOutcome>((complete) => {
    resolve = complete;
  });
  state.publish.mockReturnValue(pending);
  return resolve;
}

it('公告发布后关闭并重开，晚到受理回执清除完全相同的草稿', async () => {
  const resolve = deferredReceipt();
  mount(h(Fixture));
  click('新建公告');
  edit('等待受理的公告');
  click('发布公告');
  expect(state.publish).toHaveBeenCalledOnce();
  click('关闭群公告');
  click('重新打开公告');
  expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('等待受理的公告');
  await act(async () => resolve({ state: 'accepted' }));
  expect(document.querySelector('textarea')).toBeNull();
  click('关闭群公告');
  click('重新打开公告');
  expect(document.querySelector('textarea')).toBeNull();
  expect(state.publish).toHaveBeenCalledOnce();
  expect(state.confirm).not.toHaveBeenCalled();
});

it('重新打开后已写入新内容，旧请求的受理回执不清掉新稿', async () => {
  const resolve = deferredReceipt();
  mount(h(Fixture));
  click('新建公告');
  edit('旧公告');
  click('发布公告');
  click('关闭群公告');
  click('重新打开公告');
  edit('回执期间的新公告');
  await act(async () => resolve({ state: 'confirmed' }));
  expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('回执期间的新公告');
  click('关闭群公告');
  click('重新打开公告');
  expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('回执期间的新公告');
  expect(state.publish).toHaveBeenCalledOnce();
});

it.each([false, true])(
  '回执到达时没有公告编辑器，仍按正文确认草稿（新稿：%s）',
  async (changed) => {
    const resolve = deferredReceipt();
    mount(h(Fixture));
    click('新建公告');
    edit('已提交公告');
    click('发布公告');
    click('关闭群公告');
    if (changed) {
      click('重新打开公告');
      edit('另一份待发公告');
      click('关闭群公告');
    }
    await act(async () => resolve({ state: 'accepted' }));
    click('重新打开公告');
    if (changed)
      expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('另一份待发公告');
    else expect(document.querySelector('textarea')).toBeNull();
    expect(state.publish).toHaveBeenCalledOnce();
  },
);

it('未确认回执不清除关闭后保留的公告草稿', async () => {
  const resolve = deferredReceipt();
  mount(h(Fixture));
  click('新建公告');
  edit('尚未确认的公告');
  click('发布公告');
  click('关闭群公告');
  await act(async () => resolve({ state: 'unconfirmed' }));
  click('重新打开公告');
  expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('尚未确认的公告');
  expect(state.publish).toHaveBeenCalledOnce();
});

it.each(['detach', 'hide'] as const)('群功能入口 %s 后自动关闭浮窗', async (mode) => {
  const close = vi.fn();
  const ancestor = document.createElement('div');
  const anchor = document.createElement('button');
  ancestor.append(anchor);
  document.body.append(ancestor);
  cleanups.push(() => ancestor.remove());
  mount(
    h(
      GroupFeatureSurface,
      { presentation: 'popover', anchor, title: '群打卡', onClose: close },
      h('section', null, '打卡内容'),
    ),
  );
  expect(close).not.toHaveBeenCalled();
  await act(async () => {
    if (mode === 'detach') anchor.remove();
    else ancestor.style.display = 'none';
    await Promise.resolve();
  });
  expect(close).toHaveBeenCalledOnce();
});
