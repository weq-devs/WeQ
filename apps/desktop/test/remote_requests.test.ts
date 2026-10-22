import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteRequests } from '../src/renderer/src/components/RemoteRequests';
import { useDialog } from '../src/renderer/src/components/Dialog';

const fixture = vi.hoisted(() => ({
  pending: [] as { id: string; name: string; code: string }[],
  decide: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    remote: {
      status: {
        useQuery: () => ({ data: { pending: fixture.pending }, refetch: fixture.refetch }),
      },
      decide: { useMutation: () => ({ mutateAsync: fixture.decide }) },
    },
  },
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  useDialog.getState().close();
  fixture.pending = [{ id: 'fixture-request', name: '测试手机', code: '123456' }];
  fixture.decide.mockImplementation(async () => {
    fixture.pending = [];
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    useDialog.getState().current?.confirm?.resolve(false);
    useDialog.getState().close();
  });
  await act(async () => root.unmount());
  container.remove();
});
it('不打开设置也弹出连接请求，但必须由用户明确批准才授权', async () => {
  await act(async () => root.render(createElement(RemoteRequests)));
  const dialog = useDialog.getState().current!;
  expect(dialog.title).toBe('手机请求连接 WeQ');
  expect(dialog.message).toContain('123456');
  expect(fixture.decide).not.toHaveBeenCalled();
  await act(async () => dialog.confirm!.resolve(true));
  expect(fixture.decide).toHaveBeenCalledOnce();
  expect(fixture.decide).toHaveBeenCalledWith({ id: 'fixture-request', approve: true });
});
it('不覆盖已有确认窗，关闭后再呈现连接请求', async () => {
  useDialog.getState().showInfo('已有窗口', '内容');
  await act(async () => root.render(createElement(RemoteRequests)));
  expect(useDialog.getState().current?.title).toBe('已有窗口');
  await act(async () => useDialog.getState().close());
  expect(useDialog.getState().current?.title).toBe('手机请求连接 WeQ');
  await act(async () => useDialog.getState().current?.confirm?.resolve(false));
  expect(fixture.decide).toHaveBeenCalledOnce();
  expect(fixture.decide).toHaveBeenCalledWith({ id: 'fixture-request', approve: false });
});
