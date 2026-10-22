import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QQRemarkDialog } from '../src/renderer/src/components/QQRemarkDialog';
import type { QQWriteBinding, QQWriteOutcome } from '../src/renderer/src/hooks/useQQWriteSession';
import { useViewState } from '../src/renderer/src/state/view';

const state = vi.hoisted(() => ({
  configId: 'source-a',
  remark: '原备注',
  friend: true,
  confirm: vi.fn(async () => true),
  write: vi.fn(async (_input: unknown): Promise<QQWriteOutcome> => ({ state: 'accepted' })),
  refetch: vi.fn(async () => ({ error: null })),
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  Modal: ({ children }: { children: ReactNode }) => h('div', { role: 'dialog' }, children),
  useDialog: (selector: (s: { confirm: typeof state.confirm }) => unknown) =>
    selector({ confirm: state.confirm }),
}));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: state.configId },
    available: true,
    busy: false,
    result: null,
    run: async (
      action: (binding: QQWriteBinding) => Promise<QQWriteOutcome>,
      refresh?: () => Promise<unknown>,
      options?: { readback?: () => Promise<boolean> },
    ) => {
      await action({ expectedAccountUin: '10001', expectedAccountConfigId: state.configId });
      await options?.readback?.();
      await refresh?.();
      return true;
    },
  }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {},
  trpc: {
    account: {
      getAccountConfig: { useQuery: () => ({ data: { uin: '10001', configId: state.configId } }) },
      qqWrite: {
        friendRemarkState: {
          useQuery: () => ({
            data: { uid: 'u_peer', remark: state.remark },
            refetch: state.refetch,
          }),
        },
        peerState: {
          useQuery: () => ({
            data: { remark: state.remark, friend: state.friend },
            refetch: state.refetch,
          }),
        },
        friendRemark: { useMutation: () => ({ mutateAsync: state.write }) },
        groupRemark: { useMutation: () => ({ mutateAsync: state.write }) },
      },
    },
  },
}));
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.configId = 'source-a';
  state.remark = '原备注';
  state.friend = true;
  state.write.mockReset().mockImplementation(async (input) => {
    if (input && typeof input === 'object' && 'remark' in input && typeof input.remark === 'string')
      state.remark = input.remark;
    return { state: 'accepted' };
  });
  state.refetch
    .mockReset()
    .mockImplementation(async () => ({ error: null, data: { remark: state.remark } }));
  state.confirm.mockReset().mockResolvedValue(true);
  useViewState.setState({ openedUin: '10001' });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  useViewState.setState({ openedUin: null });
  vi.unstubAllGlobals();
});
function fixture(kind: 'group' | 'c2c') {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host),
    close = vi.fn();
  const render = () =>
    act(() =>
      root.render(
        h(QQRemarkDialog, {
          target: { kind, conv: kind === 'group' ? '123' : 'u_peer', name: '目标会话' },
          onClose: close,
        }),
      ),
    );
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  render();
  return { host, render, close };
}
function input(host: HTMLElement, value: string) {
  const node = host.querySelector('input')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
describe('右键备注编辑器', () => {
  it.each(['group', 'c2c'] as const)(
    '%s 使用实际目标和账号绑定保存，可清空并回读',
    async (kind) => {
      const f = fixture(kind);
      input(f.host, '');
      await act(async () =>
        f.host.querySelector<HTMLButtonElement>('[aria-label^="保存"]')!.click(),
      );
      expect(state.write).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedAccountUin: '10001',
          expectedAccountConfigId: 'source-a',
          remark: '',
          ...(kind === 'group' ? { groupId: 123 } : { uid: 'u_peer' }),
        }),
      );
      expect(state.refetch).toHaveBeenCalledOnce();
      await act(async () =>
        f.host.querySelector<HTMLButtonElement>('[aria-label="关闭备注编辑"]')!.click(),
      );
      expect(state.confirm).not.toHaveBeenCalled();
      expect(f.close).toHaveBeenCalledOnce();
    },
  );
  it('未保存的修改关闭前确认，同号切数据源不保留旧草稿', async () => {
    const f = fixture('c2c');
    input(f.host, '未保存');
    state.confirm.mockResolvedValueOnce(false);
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="关闭备注编辑"]')!.click(),
    );
    expect(f.close).not.toHaveBeenCalled();
    state.configId = 'source-b';
    f.render();
    expect(f.host.querySelector('input')!.value).toBe('原备注');
    expect(state.write).not.toHaveBeenCalled();
  });
  it('不是好友时不提供可用的备注写入', () => {
    state.friend = false;
    const f = fixture('c2c');
    expect(f.host.querySelector('input')!.disabled).toBe(true);
    expect(f.host.querySelector<HTMLButtonElement>('[aria-label^="保存"]')!.disabled).toBe(true);
  });
});
