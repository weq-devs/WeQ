import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ExportSavePolicy } from '@weq/service';
import { useExportSavePolicy } from '../src/renderer/src/hooks/useExportSavePolicy';
import { ServerSavePrompt } from '../src/renderer/src/components/ServerSavePrompt';

const state = vi.hoisted(() => ({
  configId: 'source-a',
  mode: 'before' as ExportSavePolicy['mode'],
  prepare: vi.fn(async (policy: ExportSavePolicy) => ({
    mode: policy.mode,
    directory: `/server/${policy.directory ?? ''}`,
  })),
}));
vi.mock('../src/renderer/src/lib/target', () => ({ IS_WEB: true }));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  Modal: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../src/renderer/src/lib/dialogUtils', () => ({
  useAppDialog: () => ({ error: vi.fn() }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({}),
    bootstrap: {
      getSettings: {
        useQuery: () => ({
          data: { exportSaveMode: state.mode, defaultExportDir: null },
          isLoading: false,
        }),
      },
    },
    account: {
      getAccountConfig: {
        useQuery: () => ({ data: { uin: '10001', configId: state.configId }, isLoading: false }),
      },
    },
  },
  client: { bootstrap: { prepareExportSave: { mutate: state.prepare } } },
}));
vi.mock('../src/renderer/src/state/view', () => ({
  useViewState: Object.assign(
    (selector: (s: { openedUin: string }) => unknown) => selector({ openedUin: '10001' }),
    { getState: () => ({ openedUin: '10001' }) },
  ),
}));
afterEach(() => {
  state.prepare.mockClear();
  state.configId = 'source-a';
  state.mode = 'before';
  vi.unstubAllGlobals();
});
function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let result!: ReturnType<typeof useExportSavePolicy>;
  function View() {
    result = useExportSavePolicy();
    return result.serverLocation
      ? h(ServerSavePrompt, {
          name: result.serverLocation.name,
          onChoose: result.chooseServerLocation,
        })
      : null;
  }
  act(() => root.render(h(View)));
  return {
    host,
    get result() {
      return result;
    },
    render: () => act(() => root.render(h(View))),
    close() {
      act(() => root.unmount());
      host.remove();
    },
  };
}
it('Web 开始前询问的是服务器子目录，确认前不生成保存参数，取消不报错', async () => {
  const f = mount();
  let pending!: Promise<ExportSavePolicy | null>;
  try {
    act(() => {
      pending = f.result.prepareSave();
    });
    expect(state.prepare).not.toHaveBeenCalled();
    expect(f.host.textContent).toContain('到服务器');
    const input = f.host.querySelector<HTMLInputElement>('[aria-label="服务器保存子目录"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'one-time',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      f.host
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await pending;
    });
    expect(state.prepare).toHaveBeenLastCalledWith({
      mode: 'before',
      directory: 'one-time',
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
    });
    expect(f.result.policy).toEqual({ mode: 'before' });
    act(() => {
      pending = f.result.prepareSave();
    });
    await act(async () => {
      f.result.chooseServerLocation(null);
      expect(await pending).toBeNull();
    });
    expect(state.prepare).toHaveBeenCalledOnce();
  } finally {
    f.close();
  }
});
it('关闭工具时取消尚未确认的服务器位置选择', async () => {
  const f = mount();
  let pending!: Promise<ExportSavePolicy | null>;
  act(() => {
    pending = f.result.prepareSave();
  });
  f.close();
  expect(await pending).toBeNull();
  expect(state.prepare).not.toHaveBeenCalled();
});
it('Web 缺省默认文件夹仍询问本次位置，输出描述在等待前固定且不改全局模式', async () => {
  state.mode = 'preset';
  const f = mount();
  const output = { kind: 'file' as const, name: '单文件导出', format: 'json' };
  let pending!: Promise<ExportSavePolicy | null>;
  try {
    act(() => {
      pending = f.result.prepareSave(undefined, output);
    });
    expect(f.result.serverLocation?.name).toBe('单文件导出');
    expect(state.prepare).not.toHaveBeenCalled();
    output.name = '后续修改';
    await act(async () => {
      f.result.chooseServerLocation('child');
      await pending;
    });
    expect(state.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'before',
        directory: 'child',
        output: { kind: 'file', name: '单文件导出', format: 'json' },
      }),
    );
    expect(f.result.policy).toEqual({ mode: 'preset' });
  } finally {
    f.close();
  }
});
it('同号切换数据源关闭旧服务器位置弹窗且不提交位置', async () => {
  const f = mount();
  let pending!: Promise<ExportSavePolicy | null>;
  try {
    act(() => {
      pending = f.result.prepareSave();
    });
    state.configId = 'source-b';
    f.render();
    expect(await pending).toBeNull();
    expect(state.prepare).not.toHaveBeenCalled();
    expect(f.result.serverLocation).toBeNull();
  } finally {
    f.close();
  }
});
