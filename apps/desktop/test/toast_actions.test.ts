import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ToastHost } from '../src/renderer/src/components/Toast';
import { useToast } from '../src/renderer/src/components/Toast.shared';
import { notificationSource } from '../src/renderer/src/lib/notificationNavigation.shared';
import { useNotificationPolicy } from '../src/renderer/src/lib/notificationPolicy';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(window, 'focus').mockImplementation(() => {});
  useToast.setState({ toasts: [], leaving: [], seq: 0 });
  useToast.getState().setDurations({ successSeconds: -1, failureSeconds: -1 });
  const events = useNotificationPolicy.getState().events;
  useNotificationPolicy
    .getState()
    .setEvents(
      Object.fromEntries(
        Object.keys(events).map((key) => [key, { banner: true, system: false }]),
      ) as typeof events,
    );
  host = document.createElement('div');
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function render(input: Parameters<ReturnType<typeof useToast.getState>['push']>[0]) {
  let id = 0;
  act(() => {
    id = useToast.getState().push(input);
    root.render(createElement(ToastHost));
  });
  return id;
}

function buttons() {
  return [...host.querySelectorAll<HTMLButtonElement>('.weq-toast-actions button')].filter(
    (button) => button.getAttribute('aria-label') !== '关闭',
  );
}

it('独立播放主动作使用播放图标，点击一次只执行一次', async () => {
  const play = vi.fn();
  const id = render({
    title: '样例已生成',
    action: { label: '播放样例语音', icon: 'play', run: play, keepOpen: true },
  });
  expect(buttons()[0]!.querySelector('.lucide-play')).not.toBeNull();
  expect(buttons()[0]!.querySelector('.lucide-arrow-up-right')).toBeNull();
  await act(async () => buttons()[0]!.click());
  expect(play).toHaveBeenCalledOnce();
  expect(useToast.getState().toasts[0]?.id).toBe(id);
});

it('来源切到失败任务后保留会话入口，两个动作使用任务与会话图标', () => {
  const source = notificationSource({ kind: 'local', open: vi.fn() }, '打开对话', null);
  const id = render({
    title: '正在转发',
    source,
    action: { label: '打开对话', source, icon: 'conversation', run: vi.fn() },
  });
  expect(buttons()).toHaveLength(1);
  expect(buttons()[0]!.querySelector('.lucide-messages-square')).not.toBeNull();
  act(() => {
    useToast.getState().update(id, {
      source: notificationSource({ kind: 'task', id: 'background:fixture' }, '查看任务', null),
    });
  });
  expect(buttons().map((button) => button.getAttribute('aria-label'))).toEqual([
    '查看任务',
    '打开对话',
  ]);
  expect(buttons()[0]!.querySelector('.lucide-list-todo')).not.toBeNull();
  expect(buttons()[1]!.querySelector('.lucide-messages-square')).not.toBeNull();
});

it('目标相同但文案不同仍合并，目标字段顺序不影响身份', () => {
  render({
    title: '任务结果',
    source: notificationSource({ kind: 'task', id: 'fixture' }, '查看这项任务', null),
    action: {
      label: '打开任务详情',
      source: notificationSource({ id: 'fixture', kind: 'task' }, '任务', null),
      run: vi.fn(),
    },
  });
  expect(buttons()).toHaveLength(1);
});

it('文案相同但目标不同保留两个动作，附加动作独立执行', async () => {
  const extra = vi.fn();
  render({
    title: '任务结果',
    source: notificationSource({ kind: 'task', id: 'first' }, '查看详情', null),
    action: {
      label: '查看详情',
      source: notificationSource(
        { kind: 'conversation', conversationKind: 'group', conv: 'second' },
        '会话',
        null,
      ),
      run: extra,
    },
  });
  expect(buttons()).toHaveLength(2);
  expect(buttons()[1]!.querySelector('.lucide-messages-square')).not.toBeNull();
  await act(async () => buttons()[1]!.click());
  expect(extra).toHaveBeenCalledOnce();
});

it('相同文案的普通回调不能被误认为来源导航而隐藏', () => {
  render({
    title: '任务结果',
    source: notificationSource({ kind: 'task', id: 'fixture' }, '查看详情', null),
    action: { label: '查看详情', run: vi.fn() },
  });
  expect(buttons()).toHaveLength(2);
});

it('同一目标不同账号或数据源不能合并', () => {
  render({
    title: '任务结果',
    source: notificationSource({ kind: 'task', id: 'fixture' }, '查看详情', {
      expectedAccountUin: 'fixture',
      expectedAccountConfigId: 'first',
    }),
    action: {
      label: '查看详情',
      source: notificationSource({ kind: 'task', id: 'fixture' }, '查看详情', {
        expectedAccountUin: 'fixture',
        expectedAccountConfigId: 'second',
      }),
      run: vi.fn(),
    },
  });
  expect(buttons()).toHaveLength(2);
});

it.each([true, false])('本地目标按回调身份比较，不把不同闭包合并：%s', (same) => {
  const open = vi.fn();
  render({
    title: '操作结果',
    source: notificationSource({ kind: 'local', open }, '打开', null),
    action: {
      label: '打开',
      source: notificationSource({ kind: 'local', open: same ? open : vi.fn() }, '打开', null),
      run: vi.fn(),
    },
  });
  expect(buttons()).toHaveLength(same ? 1 : 2);
});
