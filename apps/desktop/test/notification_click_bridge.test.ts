import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useToast } from '../src/renderer/src/components/Toast';
import { NotificationClickBridge } from '../src/renderer/src/components/NotificationClickBridge';
import {
  registerNotificationClick,
  forgetNotificationClick,
} from '../src/renderer/src/lib/notificationSystemClick';

const state = vi.hoisted(() => ({
  queue: [] as string[],
  consume: vi.fn(),
  receive: undefined as (() => void) | undefined,
  unsubscribe: vi.fn(),
}));
vi.mock('../src/renderer/src/lib/target', () => ({ IS_WEB: false }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    bootstrap: {
      consumeNotificationClick: { mutate: state.consume },
      onNotificationClick: {
        subscribe: (_: unknown, handler: { onData: () => void }) => {
          state.receive = handler.onData;
          return { unsubscribe: state.unsubscribe };
        },
      },
    },
  },
}));
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.queue = [];
  state.receive = undefined;
  state.consume.mockReset().mockImplementation(async () => state.queue.shift() ?? null);
  state.unsubscribe.mockReset();
  useToast.setState({ toasts: [], leaving: [], seq: 0 });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});
async function mount() {
  const root = createRoot(document.createElement('div'));
  cleanups.push(() => act(() => root.unmount()));
  await act(async () => root.render(createElement(NotificationClickBridge)));
}
it('系统点击时原来源已不可用，提示真实原因且仍能消费后续点击', async () => {
  const id = registerNotificationClick(() => {
    throw Error('原来源不可用');
  });
  cleanups.push(() => forgetNotificationClick(id));
  state.queue.push(id);
  await mount();
  expect(useToast.getState().toasts[0]).toMatchObject({
    title: '暂时无法打开通知来源',
    detail: '原来源不可用',
  });
  expect(state.consume.mock.calls.length).toBeGreaterThanOrEqual(2);
});
it('空队列响应在途时收到新点击，不因正在消费而漏掉唤醒', async () => {
  let release!: (value: string | null) => void;
  state.consume.mockImplementationOnce(
    () =>
      new Promise<string | null>((resolve) => {
        release = resolve;
      }),
  );
  await mount();
  const open = vi.fn();
  const id = registerNotificationClick(open);
  cleanups.push(() => forgetNotificationClick(id));
  state.queue.push(id);
  await act(async () => {
    state.receive!();
    release(null);
  });
  expect(open).toHaveBeenCalledOnce();
  expect(state.queue).toHaveLength(0);
});
