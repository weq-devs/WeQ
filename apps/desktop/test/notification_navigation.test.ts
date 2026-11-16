import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ToastHost, useToast } from '../src/renderer/src/components/Toast';
import * as preferences from '../src/renderer/src/lib/clientPreferences';
import {
  NotificationSourceProvider,
  notificationSource,
  onNotificationNavigation,
  messageNotificationSource,
} from '../src/renderer/src/lib/notificationNavigation';

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(window, 'focus').mockImplementation(() => {});
  useToast.setState({ toasts: [], leaving: [], seq: 0 });
});

it.each([
  ['native', false, '17'],
  ['protocol', false, undefined],
  ['protocol', true, '17'],
] as const)(
  '消息来源 %s／已核验=%s 只使用可信 NT 序号，保留原始消息身份',
  (sourceFormat, ntSeqVerified, seq) => {
    const source = messageNotificationSource(
      { type: 'direct', id: 'peer' },
      { id: 'render-id', msgId: 'original-id', msgSeq: '17', sourceFormat, ntSeqVerified },
      null,
    );
    expect(source.target).toEqual({
      kind: 'conversation',
      conversationKind: 'c2c',
      conv: 'peer',
      msgId: 'original-id',
      seq,
    });
  },
);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('来源随操作闭包保留，不因页面切换而指向另一个对象；普通成功不添加主操作', () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  const pushers: Array<ReturnType<typeof useToast.getState>['push']> = [];
  function Writer() {
    pushers.push(useToast((state) => state.push));
    return null;
  }
  const render = (conv: string) =>
    act(() =>
      root.render(
        createElement(
          NotificationSourceProvider,
          {
            source: notificationSource({ kind: 'conversation', conversationKind: 'group', conv }),
          },
          createElement(Writer),
        ),
      ),
    );
  render('first');
  const original = pushers.at(-1)!;
  render('second');
  act(() => {
    original({ tone: 'error', title: '旧操作失败' });
    pushers.at(-1)!({ tone: 'success', title: '已复制' });
  });
  expect(useToast.getState().toasts[0]!.source?.target).toMatchObject({ conv: 'first' });
  const receive = vi.fn();
  const off = onNotificationNavigation(receive);
  act(() => root.render(createElement(ToastHost)));
  expect(host.querySelectorAll('.weq-toast-open')).toHaveLength(1);
  act(() => host.querySelector<HTMLButtonElement>('.weq-toast-open')!.click());
  expect(receive).toHaveBeenCalledWith(expect.objectContaining({ conv: 'first' }));
  off();
  act(() => root.unmount());
});

it('进度更新保留任务来源，显式清除来源后不再跳转', () => {
  const id = useToast.getState().push({
    title: '任务处理中',
    loading: true,
    source: notificationSource({ kind: 'task', id: 'resource:synthetic' }),
  });
  useToast.getState().update(id, { tone: 'error', loading: false, title: '任务失败' });
  expect(useToast.getState().toasts[0]!.source?.target).toMatchObject({ id: 'resource:synthetic' });
  useToast.getState().update(id, { source: null });
  expect(useToast.getState().toasts[0]!.source).toBeNull();
});

it('展开、复制和关闭不执行来源导航，横幅主动作支持键盘且不覆盖文字选择', () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  const receive = vi.fn();
  const off = onNotificationNavigation(receive);
  act(() => {
    useToast.getState().push({
      title: '读取失败',
      tone: 'error',
      detail: '合成详情',
      source: notificationSource({ kind: 'task', id: 'background:synthetic' }),
    });
    root.render(createElement(ToastHost));
  });
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="展开详情"]')!.click());
  expect(receive).not.toHaveBeenCalled();
  expect(host.querySelector('.weq-toast-title')?.closest('button')).toBeNull();
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click());
  expect(receive).not.toHaveBeenCalled();
  off();
  act(() => root.unmount());
});

it('同号切换来源后旧横幅不导航到新数据，原横幅内展开准确原因', async () => {
  vi.spyOn(preferences, 'accountBinding').mockReturnValue({
    expectedAccountUin: 'fixture',
    expectedAccountConfigId: 'new-source',
  });
  const receive = vi.fn();
  const off = onNotificationNavigation(receive);
  const host = document.createElement('div');
  const root = createRoot(host);
  act(() => {
    useToast.getState().push({
      tone: 'error',
      title: '原来源任务失败',
      source: notificationSource({ kind: 'task', id: 'export:original' }, '查看原任务', {
        expectedAccountUin: 'fixture',
        expectedAccountConfigId: 'old-source',
      }),
    });
    root.render(createElement(ToastHost));
  });
  await act(async () => host.querySelector<HTMLButtonElement>('.weq-toast-open')!.click());
  expect(receive).not.toHaveBeenCalled();
  expect(host.querySelector('.weq-toast')?.classList.contains('expanded')).toBe(true);
  expect(host.textContent).toContain('请先切回通知来源账号及原数据源');
  off();
  act(() => root.unmount());
});

it('异步打开保存结果失败时在同一横幅展示错误，不产生未处理拒绝', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  act(() => {
    useToast.getState().push({
      tone: 'success',
      title: '文件已保存',
      source: notificationSource(
        {
          kind: 'local',
          open: async () => {
            throw Error('合成路径不存在');
          },
        },
        '查看结果',
        null,
      ),
    });
    root.render(createElement(ToastHost));
  });
  await act(async () => host.querySelector<HTMLButtonElement>('.weq-toast-open')!.click());
  expect(useToast.getState().toasts).toHaveLength(1);
  expect(host.textContent).toContain('合成路径不存在');
  act(() => root.unmount());
});
