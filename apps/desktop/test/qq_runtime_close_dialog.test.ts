import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloseConfirmDialog } from '../src/renderer/src/components/CloseConfirmDialog';

const mocks = vi.hoisted(() => ({
  save: vi.fn(async (_input: unknown) => {}),
  invalidate: vi.fn(async () => {}),
  send: vi.fn(),
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  Modal: ({ children }: { children: ReactNode }) => h('div', null, children),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    bootstrap: {
      setWindowCloseBehavior: {
        useMutation: () => ({ mutateAsync: mocks.save, isLoading: false }),
      },
    },
    useUtils: () => ({ bootstrap: { getSettings: { invalidate: mocks.invalidate } } }),
  },
}));
let listener: (...args: unknown[]) => void = () => {},
  close = () => {};
let original: PropertyDescriptor | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  original = Object.getOwnPropertyDescriptor(window, 'electron');
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      ipcRenderer: {
        on: (_channel: string, callback: (...args: unknown[]) => void) => {
          listener = callback;
          return () => {};
        },
        send: mocks.send,
      },
    },
  });
});
afterEach(() => {
  close();
  if (original) Object.defineProperty(window, 'electron', original);
  else Reflect.deleteProperty(window, 'electron');
  vi.unstubAllGlobals();
});
function fixture() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  close = () => {
    act(() => root.unmount());
    host.remove();
  };
  act(() => root.render(h(CloseConfirmDialog)));
  return {
    host,
    show: (owned: boolean) =>
      act(() => listener({}, { canMinimizeToTray: true, managedQQ: owned })),
  };
}
describe('托管 QQ 的关闭选择', () => {
  it('托盘与退出明确区分自有后台任务，不把用户原有 QQ 纳入退出提示', async () => {
    const f = fixture();
    f.show(true);
    expect(f.host.textContent).toContain('保留 WeQ 与托管 QQ 的后台任务');
    expect(f.host.textContent).toContain('停止 WeQ 与本次托管 QQ');
    await act(async () => f.host.querySelector<HTMLButtonElement>('.weq-close-opt')!.click());
    expect(mocks.send).toHaveBeenCalledWith('window:respond-close', 'tray');
    f.show(false);
    expect(f.host.textContent).not.toContain('托管 QQ');
  });
  it('记住关闭选择时先保存全局策略再发退出请求', async () => {
    const f = fixture();
    f.show(true);
    const order: string[] = [];
    mocks.save.mockImplementationOnce(async () => {
      order.push('save');
    });
    mocks.send.mockImplementationOnce(() => {
      order.push('quit');
    });
    act(() => f.host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('.weq-close-opt.is-danger')!.click(),
    );
    expect(mocks.save).toHaveBeenCalledWith({ behavior: 'quit' });
    expect(order).toEqual(['save', 'quit']);
  });
});
