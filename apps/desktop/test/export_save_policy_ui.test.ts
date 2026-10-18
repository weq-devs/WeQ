import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExportSavePolicy } from '@weq/service';
import { ExportSaveControl } from '../src/renderer/src/views/export/ExportSaveControl';
import { useExportSavePolicy } from '../src/renderer/src/hooks/useExportSavePolicy';

const fixture = vi.hoisted(() => ({
  account: 'account-a',
  settings: {
    exportSaveMode: 'after' as ExportSavePolicy['mode'],
    defaultExportDir: '/fixture/default',
  },
  prepare: vi.fn(async (policy: ExportSavePolicy) => policy),
  defaults: vi.fn(async () => ({})),
  pick: vi.fn<() => Promise<string | null>>(async () => null),
  toast: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ bootstrap: { getSettings: { invalidate: vi.fn() } } }),
    bootstrap: { getSettings: { useQuery: () => ({ data: fixture.settings, isLoading: false }) } },
  },
  client: {
    bootstrap: {
      prepareExportSave: { mutate: fixture.prepare },
      setExportSaveDefaults: { mutate: fixture.defaults },
      pickExportSaveDirectory: { mutate: fixture.pick },
    },
  },
}));
vi.mock('../src/renderer/src/state/view', () => ({
  useViewState: Object.assign(
    (selector: (state: { openedUin: string }) => unknown) =>
      selector({ openedUin: fixture.account }),
    { getState: () => ({ openedUin: fixture.account }) },
  ),
}));
vi.mock('../src/renderer/src/lib/dialogUtils', () => ({
  useAppDialog: () => ({ error: vi.fn() }),
}));
vi.mock('../src/renderer/src/components/Toast', () => ({
  useToast: (selector: (state: { push: typeof fixture.toast }) => unknown) =>
    selector({ push: fixture.toast }),
}));

function mountHook(withControl = false) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let result!: ReturnType<typeof useExportSavePolicy>;
  function Harness() {
    result = useExportSavePolicy();
    return withControl
      ? createElement(ExportSaveControl, {
          value: result.policy,
          onChange: result.setOverride,
          onReset: () => result.setOverride(null),
          overridden: result.hasOverride,
          onPickDirectory: () => void result.pickDirectory(),
          picking: result.picking,
        })
      : null;
  }
  act(() => root.render(createElement(Harness)));
  return {
    host,
    get result() {
      return result;
    },
    close() {
      act(() => root.unmount());
      host.remove();
    },
  };
}
afterEach(() => {
  fixture.account = 'account-a';
  fixture.settings.exportSaveMode = 'after';
  fixture.prepare.mockReset().mockImplementation(async (policy) => policy);
  fixture.defaults.mockClear();
  fixture.pick.mockReset().mockResolvedValue(null);
  fixture.toast.mockClear();
  vi.unstubAllGlobals();
});

describe('保存方式目录语义', () => {
  it('目录选择期间合并重复请求，冻结保存控件且不使用旧位置启动导出', async () => {
    let resolve!: (value: string | null) => void;
    fixture.pick.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const f = mountHook(true);
    try {
      act(() => f.result.setOverride({ mode: 'preset' }));
      let pending!: Promise<void>;
      act(() => {
        pending = f.result.pickDirectory();
      });
      expect(f.result.picking).toBe(true);
      expect(f.host.querySelector('fieldset')?.disabled).toBe(true);
      expect(f.host.querySelector('fieldset')?.getAttribute('aria-busy')).toBe('true');
      await f.result.pickDirectory();
      expect(fixture.pick).toHaveBeenCalledOnce();
      expect(await f.result.prepareSave()).toBeNull();
      expect(fixture.prepare).not.toHaveBeenCalled();
      await act(async () => {
        resolve('/fixture/chosen');
        await pending;
      });
      expect(f.result.picking).toBe(false);
      expect(f.result.policy).toEqual({ mode: 'preset', directory: '/fixture/chosen' });
      expect(f.host.querySelector('fieldset')?.disabled).toBe(false);
    } finally {
      f.close();
    }
  });
  it('卸载后的目录选择不启动 RPC，进行中的旧账号结果不写入草稿', async () => {
    let resolve!: (value: string | null) => void;
    fixture.pick.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const f = mountHook();
    const old = f.result;
    let pending!: Promise<void>;
    act(() => {
      pending = old.pickDirectory();
    });
    fixture.account = 'account-b';
    await act(async () => {
      resolve('/fixture/old-account');
      await pending;
    });
    expect(f.result.hasOverride).toBe(false);
    f.close();
    fixture.account = 'account-a';
    fixture.pick.mockClear();
    await old.pickDirectory();
    expect(fixture.pick).not.toHaveBeenCalled();
  });
  it('恢复默认控件只清除本次保存草稿，不写全局设置', () => {
    const f = mountHook(true);
    try {
      const reset = () =>
        f.host.querySelector<HTMLButtonElement>('[aria-label="恢复默认保存设置"]')!;
      expect(reset().disabled).toBe(true);
      act(() => f.result.setOverride({ mode: 'preset', directory: '/fixture/temporary' }));
      expect(reset().disabled).toBe(false);
      act(() => reset().click());
      expect(f.result.policy).toEqual({ mode: 'after' });
      expect(f.result.hasOverride).toBe(false);
      expect(reset().disabled).toBe(true);
      expect(fixture.defaults).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });
  it('各模式保留独立的本次目录草稿，切换不丢临时覆盖，明确重置才恢复默认', () => {
    const f = mountHook();
    try {
      act(() => f.result.setOverride({ mode: 'preset', directory: '/fixture/one-time' }));
      act(() => f.result.setOverride({ mode: 'before', directory: 'relative/one-time' }));
      act(() => f.result.setOverride({ mode: 'after' }));
      expect(f.result.policy).toEqual({ mode: 'after' });
      act(() => f.result.setOverride({ mode: 'preset' }));
      expect(f.result.policy).toEqual({ mode: 'preset', directory: '/fixture/one-time' });
      act(() => f.result.setOverride({ mode: 'before' }));
      expect(f.result.policy).toEqual({ mode: 'before', directory: 'relative/one-time' });
      act(() => f.result.setOverride({ mode: 'before' }));
      expect(f.result.policy).toEqual({ mode: 'before' });
      act(() => f.result.setOverride(null));
      act(() => f.result.setOverride({ mode: 'preset' }));
      expect(f.result.policy).toEqual({ mode: 'preset', directory: '/fixture/default' });
      expect(fixture.defaults).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });
  it('从开始前的相对子目录切到预设模式，不将其冒充预设保存位置', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const change = vi.fn();
    try {
      act(() =>
        root.render(
          createElement(ExportSaveControl, {
            value: { mode: 'before', directory: 'relative/subfolder' },
            onChange: change,
            onPickDirectory: vi.fn(),
          }),
        ),
      );
      act(() => {
        const select = host.querySelector('select')!;
        select.value = 'preset';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(change).toHaveBeenCalledWith({ mode: 'preset' });
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it.each(['before', 'after'] as const)('默认 %s 模式不携带属于预设模式的旧目录', (mode) => {
    fixture.settings.exportSaveMode = mode;
    const f = mountHook();
    try {
      expect(f.result.policy).toEqual({ mode });
    } finally {
      f.close();
    }
  });

  it('重新切回预设时显示并使用全局预设位置，单次覆盖不自动修改默认', async () => {
    const f = mountHook();
    const override: ExportSavePolicy = { mode: 'preset' };
    try {
      act(() => f.result.setOverride({ mode: 'before', directory: 'relative/subfolder' }));
      expect(f.result.policy).toEqual({ mode: 'before', directory: 'relative/subfolder' });
      act(() => f.result.setOverride(override));
      expect(f.result.policy).toEqual({ mode: 'preset', directory: '/fixture/default' });
      await act(async () => {
        await f.result.prepareSave();
      });
      expect(fixture.prepare).toHaveBeenCalledWith({
        mode: 'preset',
        directory: '/fixture/default',
      });
      expect(override).toEqual({ mode: 'preset' });
      expect(fixture.defaults).not.toHaveBeenCalled();
      await act(async () => {
        await f.result.setDefault();
      });
      expect(fixture.defaults).toHaveBeenCalledOnce();
    } finally {
      f.close();
    }
  });

  it('准备保存期间切号或卸载后，不返回旧账号的可执行保存参数', async () => {
    let resolve!: (policy: ExportSavePolicy) => void;
    fixture.prepare.mockReturnValueOnce(
      new Promise<ExportSavePolicy>((done) => {
        resolve = done;
      }),
    );
    const f = mountHook();
    const old = f.result;
    const pending = old.prepareSave();
    fixture.account = 'account-b';
    resolve({ mode: 'after' });
    expect(await pending).toBeNull();
    f.close();
    fixture.account = 'account-a';
    fixture.prepare.mockClear();
    expect(await old.prepareSave()).toBeNull();
    expect(fixture.prepare).not.toHaveBeenCalled();
  });
});
