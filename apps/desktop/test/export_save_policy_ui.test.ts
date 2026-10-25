import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ExportSavePolicy } from '@weq/service';
import { useExportSavePolicy } from '../src/renderer/src/hooks/useExportSavePolicy';

const fixture = vi.hoisted(() => ({
  account: 'account-a',
  configId: 'source-a',
  loading: false,
  missing: false,
  web: false,
  settings: {
    exportSaveMode: 'before' as ExportSavePolicy['mode'],
    defaultExportDir: '/fixture/default',
  },
  prepare: vi.fn(async (policy: ExportSavePolicy) => policy),
}));
vi.mock('../src/renderer/src/lib/target', () => ({
  get IS_WEB() {
    return fixture.web;
  },
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    bootstrap: {
      getSettings: {
        useQuery: () => ({
          data: fixture.missing ? undefined : fixture.settings,
          isLoading: fixture.loading,
        }),
      },
    },
    account: {
      getAccountConfig: {
        useQuery: () => ({
          data: { uin: fixture.account, configId: fixture.configId },
          isLoading: false,
        }),
      },
    },
  },
  client: { bootstrap: { prepareExportSave: { mutate: fixture.prepare } } },
}));
vi.mock('../src/renderer/src/state/view', () => ({
  useViewState: Object.assign(
    (selector: (state: { openedUin: string }) => unknown) =>
      selector({ openedUin: fixture.account }),
    { getState: () => ({ openedUin: fixture.account }) },
  ),
}));
function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  let result!: ReturnType<typeof useExportSavePolicy>;
  function Harness() {
    result = useExportSavePolicy();
    return null;
  }
  const render = () => act(() => root.render(createElement(Harness)));
  render();
  return {
    get result() {
      return result;
    },
    render,
    close: () => act(() => root.unmount()),
  };
}
afterEach(() => {
  Object.assign(fixture, {
    account: 'account-a',
    configId: 'source-a',
    loading: false,
    missing: false,
    web: false,
  });
  fixture.settings.exportSaveMode = 'before';
  fixture.prepare.mockReset().mockImplementation(async (policy) => policy);
  vi.unstubAllGlobals();
});

it('只跟随全局保存方式，不接受页面临时模式或目录覆盖，设置变化立即生效', async () => {
  const f = mount();
  try {
    expect(f.result.policy).toEqual({ mode: 'before' });
    await act(async () => {
      await f.result.prepareSave({ mode: 'preset', directory: '/ignored' });
    });
    expect(fixture.prepare).toHaveBeenLastCalledWith({
      mode: 'before',
      expectedAccountUin: 'account-a',
      expectedAccountConfigId: 'source-a',
    });
    fixture.settings.exportSaveMode = 'preset';
    f.render();
    await act(async () => {
      await f.result.prepareSave({ mode: 'before' });
    });
    expect(fixture.prepare).toHaveBeenLastCalledWith({
      mode: 'preset',
      directory: '/fixture/default',
      expectedAccountUin: 'account-a',
      expectedAccountConfigId: 'source-a',
    });
    expect(f.result).not.toHaveProperty('setOverride');
  } finally {
    f.close();
  }
});
it('偏好缺失或账号资料未就绪时明确失败，读取中不启动保存', async () => {
  const f = mount();
  try {
    fixture.missing = true;
    f.render();
    await expect(f.result.prepareSave()).rejects.toThrow('保存偏好读取失败');
    fixture.missing = false;
    fixture.loading = true;
    f.render();
    expect(await f.result.prepareSave()).toBeNull();
    fixture.loading = false;
    fixture.configId = '';
    f.render();
    await expect(f.result.prepareSave()).rejects.toThrow('账号资料尚未就绪');
    expect(fixture.prepare).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});
it('准备期间合并重复点击并显示忙碌状态，不叠加系统选择器', async () => {
  let finish!: (policy: ExportSavePolicy) => void;
  fixture.prepare.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const f = mount();
  try {
    let pending!: Promise<ExportSavePolicy | null>;
    act(() => {
      pending = f.result.prepareSave();
    });
    expect(f.result.picking).toBe(true);
    expect(await f.result.prepareSave()).toBeNull();
    expect(fixture.prepare).toHaveBeenCalledOnce();
    await act(async () => {
      finish({ mode: 'before', directory: '/fixture/chosen' });
      await pending;
    });
    expect(f.result.picking).toBe(false);
  } finally {
    f.close();
  }
});
it.each(['account', 'configId'] as const)(
  '切换 %s 或卸载后，旧结果不能保存到另一个来源',
  async (field) => {
    let finish!: (policy: ExportSavePolicy) => void;
    fixture.prepare.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const f = mount();
    const old = f.result;
    let pending!: Promise<ExportSavePolicy | null>;
    act(() => {
      pending = old.prepareSave();
    });
    fixture[field] = 'another-source';
    f.render();
    await act(async () => {
      finish({ mode: 'before', directory: '/fixture/old' });
      expect(await pending).toBeNull();
    });
    f.close();
    fixture.prepare.mockClear();
    expect(await old.prepareSave()).toBeNull();
    expect(fixture.prepare).not.toHaveBeenCalled();
  },
);
it('Web 每次询问显示位置选择，自动保存不再弹窗；取消不创建保存请求', async () => {
  fixture.web = true;
  const f = mount();
  try {
    let pending!: Promise<ExportSavePolicy | null>;
    act(() => {
      pending = f.result.prepareSave();
    });
    expect(f.result.serverLocation).not.toBeNull();
    await act(async () => {
      f.result.chooseServerLocation(null);
      expect(await pending).toBeNull();
    });
    expect(fixture.prepare).not.toHaveBeenCalled();
    fixture.settings.exportSaveMode = 'preset';
    f.render();
    await act(async () => {
      await f.result.prepareSave();
    });
    expect(f.result.serverLocation).toBeNull();
    expect(fixture.prepare).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: 'preset', directory: '/fixture/default' }),
    );
  } finally {
    f.close();
  }
});
