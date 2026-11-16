import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BackupSection, backupApi } from '../src/renderer/src/components/settings/BackupSection';
import { localBackgroundTasks } from '../src/renderer/src/state/backgroundTasks';
import {
  SettingsResetButton,
  SettingsResetProvider,
} from '../src/renderer/src/components/settings/SettingsReset';
import type { SettingsResetItem, SettingsResetResult } from '../src/shared/settings_reset';

const reset = vi.hoisted(() => ({ preview: vi.fn(), restore: vi.fn(), snapshot: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    settingsReset: { preview: { query: reset.preview }, restore: { mutate: reset.restore } },
    clientState: { snapshot: { query: reset.snapshot } },
  },
  trpc: {
    useUtils: () => ({
      bootstrap: { getSettings: { invalidate: vi.fn() } },
      remote: { status: { invalidate: vi.fn() }, webStatus: { invalidate: vi.fn() } },
    }),
  },
}));
const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  reset.preview.mockReset().mockResolvedValue({
    source: null,
    items: [
      {
        id: 'web:enabled',
        label: 'Web 服务',
        scope: '全局',
        current: true,
        defaultValue: false,
        stopsService: true,
      },
    ],
  });
  reset.restore.mockReset().mockResolvedValue([{ id: 'web:enabled', ok: true }]);
  reset.snapshot.mockReset().mockResolvedValue({ revision: 1, values: {}, records: {} });
});
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.unstubAllGlobals();
  for (const task of localBackgroundTasks.snapshot()) {
    localBackgroundTasks.finish(task.id, 'cancelled');
    localBackgroundTasks.remove(task.id);
  }
});
function fixture() {
  const summary = {
    createdAt: '2026-10-22T00:00:00Z',
    parts: [{ part: 'settings' as const, files: 1, bytes: 100 }],
    accountConfigIds: [],
    cloneConfigIds: [],
    warnings: [],
  };
  const api = {
    ...backupApi,
    defaultsInfo: vi.fn(
      async (): Promise<Awaited<ReturnType<typeof backupApi.defaultsInfo>>> => ({
        hasApi: false,
        paths: [],
        connections: [],
      }),
    ),
    inventory: vi.fn(async () => ({
      accounts: [],
      cloneScopes: [],
      restore: { pending: null, result: null },
      canPickFile: true,
      canRestart: false,
      maxArchiveBytes: 260 * 1024 * 1024,
      chunkBytes: 65536,
    })),
    pick: vi.fn(async () => ({ id: 'source-1', name: 'synthetic.zip', summary })),
    prepare: vi.fn(async () => ({
      id: 'preview-1',
      summary,
      planned: ['config'],
      skipped: [],
      warnings: [],
    })),
    stage: vi.fn(async () => ({
      id: 'staged-1',
      status: 'applied' as const,
      completedAt: '2026-11-05T00:00:00Z',
      applied: ['settings'],
      skipped: [],
      warnings: [],
      clientPending: false,
    })),
    defaults: vi.fn(async () => ({
      id: 'defaults-1',
      status: 'applied' as const,
      completedAt: '2026-11-05T00:00:00Z',
      applied: ['settings'],
      skipped: [],
      warnings: [],
      clientPending: false,
    })),
    dispose: vi.fn(async () => true),
    export: vi.fn(async () => null),
  };
  return { api };
}
async function mount(api: typeof backupApi) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(BackupSection, { api })));
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const button = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === text,
    )!;
  const click = async (text: string) => {
    await act(async () => button(text).click());
  };
  return { host, button, click };
}
async function mountReset(items?: SettingsResetItem[]) {
  if (items) reset.preview.mockResolvedValue({ source: null, items });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(SettingsResetProvider, { page: 'remote' }, createElement(SettingsResetButton)),
    ),
  );
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const button = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === text || node.getAttribute('aria-label') === text,
    )!;
  const click = async (text: string) => {
    await act(async () => button(text).click());
  };
  const settled = async () => {
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
  };
  return { host, button, click, settled };
}
it('读取文件不直接写入，明确预览并确认后直接恢复；改选使旧确认失效', async () => {
  const f = fixture(),
    ui = await mount(f.api);
  await ui.click('选择备份文件');
  expect(f.api.stage).not.toHaveBeenCalled();
  await ui.click('预览恢复');
  expect(ui.host.textContent).toContain('确认恢复范围');
  await act(async () => {
    ui.host.querySelectorAll<HTMLButtonElement>('[aria-label="同名数据处理"] button')[1]!.click();
  });
  expect(ui.host.textContent).not.toContain('确认恢复范围');
  await ui.click('预览恢复');
  expect(ui.host.textContent).toContain('无需重启 WeQ');
  await ui.click('确认恢复');
  expect(f.api.stage).toHaveBeenCalledWith('preview-1');
});
it('配置备份页保留全局恢复入口，先读取范围、取消不提交，确认才恢复全部设置', async () => {
  const f = fixture();
  const ui = await mount(f.api);
  expect(ui.host.querySelector('[data-setting-id="weq-config-management"]')).not.toBeNull();
  expect(ui.button('恢复全局默认设置').dataset.danger).toBe('solid');
  await ui.click('恢复全局默认设置');
  expect(f.api.defaultsInfo).toHaveBeenCalledOnce();
  expect(f.api.defaults).not.toHaveBeenCalled();
  const modal = document.querySelector('[role="dialog"]')!;
  expect(ui.button('确认恢复默认').dataset.danger).toBe('solid');
  expect(modal.textContent).toContain('所有账号');
  expect(modal.textContent).toContain('默认保留');
  expect(document.activeElement).toBe(ui.button('取消'));
  await ui.click('取消');
  expect(f.api.defaults).not.toHaveBeenCalled();
  await ui.click('恢复全局默认设置');
  await ui.click('确认恢复默认');
  expect(f.api.defaults).toHaveBeenCalledWith(expect.any(String), {});
  expect(reset.restore).not.toHaveBeenCalled();
});
it.each([{ warnings: [] }, { warnings: ['账号配置不包含 QQ 数据库，装扮资源需在本机重新获取。'] }])(
  '恢复成功后不再显示常驻结果卡片（警告：%j）',
  async ({ warnings }) => {
    const f = fixture();
    const result = { ...(await f.api.defaults()), warnings };
    const ui = await mount({
      ...f.api,
      inventory: async () => ({
        ...(await f.api.inventory()),
        restore: { pending: null, result },
      }),
    });
    expect(ui.host.textContent).not.toContain('最近一次恢复已应用');
    expect(ui.host.textContent).not.toContain('已应用 1 项');
    for (const warning of warnings) expect(ui.host.textContent).not.toContain(warning);
    expect(ui.button('恢复全局默认设置').disabled).toBe(false);
  },
);
it.each(['failed', 'clientPending'] as const)('恢复仍需处理时保留必要信息：%s', async (kind) => {
  const f = fixture();
  const result = {
    ...(await f.api.defaults()),
    status: kind === 'failed' ? ('failed' as const) : ('applied' as const),
    clientPending: kind === 'clientPending',
    error: kind === 'failed' ? '合成恢复失败' : undefined,
  };
  const ui = await mount({
    ...f.api,
    inventory: async () => ({
      ...(await f.api.inventory()),
      restore: { pending: null, result },
    }),
  });
  if (kind === 'failed') {
    expect(ui.host.textContent).toContain('最近一次恢复失败');
    expect(ui.host.textContent).toContain('合成恢复失败');
  } else {
    expect(ui.host.textContent).toContain('界面偏好待恢复');
    expect(ui.button('改在此设备恢复')).toBeDefined();
    expect(ui.button('保留本机界面偏好')).toBeDefined();
    expect(ui.button('恢复全局默认设置').disabled).toBe(true);
  }
});
it('全局恢复读取失败不能提交，可重试', async () => {
  const f = fixture();
  f.api.defaultsInfo.mockRejectedValueOnce(new Error('合成范围读取失败'));
  const ui = await mount(f.api);
  await ui.click('恢复全局默认设置');
  expect(ui.button('确认恢复默认').disabled).toBe(true);
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain(
    '合成范围读取失败',
  );
  await ui.click('重新读取恢复范围');
  expect(ui.button('确认恢复默认').disabled).toBe(false);
  expect(f.api.defaultsInfo).toHaveBeenCalledTimes(2);
  await ui.click('取消');
  expect(f.api.defaults).not.toHaveBeenCalled();
});
it('全局恢复读取及提交期间禁用取消和重复提交，提交失败保留弹窗与所选项', async () => {
  const f = fixture();
  let finishRead!: (value: Awaited<ReturnType<typeof backupApi.defaultsInfo>>) => void;
  let failRestore!: (reason: Error) => void;
  f.api.defaultsInfo.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRead = resolve;
      }),
  );
  f.api.defaults.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        failRestore = reject;
      }),
  );
  const ui = await mount(f.api);
  await ui.click('恢复全局默认设置');
  expect(ui.button('取消').disabled).toBe(true);
  expect(ui.button('正在恢复…').disabled).toBe(true);
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => finishRead({ hasApi: true, paths: [], connections: [] }));
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="清除 API 配置"]')!.click(),
  );
  await ui.click('确认恢复默认');
  expect(ui.button('取消').disabled).toBe(true);
  await ui.click('正在恢复…');
  expect(f.api.defaults).toHaveBeenCalledOnce();
  await act(async () => failRestore(new Error('合成恢复失败')));
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain(
    '合成恢复失败',
  );
  expect(document.querySelector('[aria-label="清除 API 配置"]')?.getAttribute('aria-checked')).toBe(
    'true',
  );
  await ui.click('确认恢复默认');
  expect(f.api.defaults).toHaveBeenCalledTimes(2);
  expect(f.api.defaults).toHaveBeenLastCalledWith(expect.any(String), { clearApi: true });
});
it('全局恢复的 API、服务与目录仅在显式选择后重置，重新打开恢复默认保留', async () => {
  const f = fixture();
  const info: Awaited<ReturnType<typeof backupApi.defaultsInfo>> = {
    hasApi: true,
    paths: [{ id: 'defaultExportDir', label: '导出目录', value: '/synthetic/exports' }],
    connections: [{ id: 'webEnabled', label: 'Web 服务', value: '运行中' }],
  };
  const ui = await mount({ ...f.api, defaultsInfo: vi.fn(async () => info) });
  await ui.click('恢复全局默认设置');
  const modal = document.querySelector('[role="dialog"]')!;
  const apiToggle = modal.querySelector<HTMLButtonElement>('[aria-label="清除 API 配置"]')!;
  const services = modal.querySelector<HTMLButtonElement>('[aria-label="清除 WeQ 服务配置"]')!;
  const directory = modal.querySelector<HTMLSelectElement>('[aria-label="导出目录"]')!;
  expect(apiToggle.getAttribute('aria-checked')).toBe('false');
  expect(services.getAttribute('aria-checked')).toBe('false');
  expect(directory.value).toBe('keep');
  await act(async () => apiToggle.click());
  await act(async () => services.click());
  await act(async () => {
    directory.value = 'reset';
    directory.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(modal.textContent).toContain('断开');
  expect(modal.textContent).toContain('不迁移或删除已有文件');
  await ui.click('确认恢复默认');
  expect(f.api.defaults).toHaveBeenCalledWith(expect.any(String), {
    clearApi: true,
    resetConnections: ['webEnabled'],
    resetPaths: ['defaultExportDir'],
  });
  await ui.click('恢复全局默认设置');
  expect(document.querySelector('[aria-label="清除 API 配置"]')?.getAttribute('aria-checked')).toBe(
    'false',
  );
});
it('恢复默认需二次确认，未变化的命令仍可再次主动执行', async () => {
  const ui = await mountReset();
  expect(ui.button('恢复本页默认设置').disabled).toBe(false);
  expect(ui.button('恢复本页默认设置').dataset.danger).toBe('outline');
  await ui.click('恢复本页默认设置');
  expect(reset.restore).not.toHaveBeenCalled();
  await ui.click('确认恢复默认');
  await ui.settled();
  expect(reset.restore).toHaveBeenCalledTimes(1);
  expect(ui.button('恢复本页默认设置').disabled).toBe(false);
  await ui.click('恢复本页默认设置');
  await ui.click('确认恢复默认');
  await ui.settled();
  expect(reset.restore).toHaveBeenCalledTimes(2);
});
it('按页重置注明服务停用范围，目录默认保留且显式选择后才重置', async () => {
  const ui = await mountReset([
    {
      id: 'web:enabled',
      label: 'Web 服务',
      scope: '全局',
      current: true,
      defaultValue: false,
      stopsService: true,
    },
    {
      id: 'web:directory',
      label: '缓存目录',
      scope: '全局',
      current: '/synthetic/custom-cache',
      defaultValue: '/synthetic/cache',
      directory: true,
    },
  ]);
  await ui.click('恢复本页默认设置');
  const modal = document.querySelector('[role="dialog"]')!;
  expect(modal.textContent).toContain('将停用：Web 服务');
  // 目录处置改成设置页统一的分段控件（保留当前 / 恢复默认），不再是原生下拉。
  const group = modal.querySelector<HTMLElement>('[role="radiogroup"][aria-label="缓存目录"]')!;
  expect(group.textContent).toContain('保留当前');
  expect(group.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain(
    '保留当前',
  );
  await act(async () => {
    const resetChoice = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
      (node) => node.textContent?.includes('恢复默认'),
    )!;
    resetChoice.click();
  });
  expect(modal.textContent).toContain('不迁移或删除已有文件');
  await ui.click('确认恢复默认');
  await ui.settled();
  expect(reset.restore).toHaveBeenCalledWith(
    expect.objectContaining({ page: 'remote', directories: ['web:directory'] }),
  );
});

it('读取恢复范围失败可重试，未读取成功时不能确认恢复', async () => {
  reset.preview.mockRejectedValueOnce(new Error('合成读取失败'));
  const ui = await mountReset();
  await ui.click('恢复本页默认设置');
  expect(ui.button('确认恢复默认').disabled).toBe(true);
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain(
    '合成读取失败',
  );
  await ui.click('重新读取');
  expect(ui.button('确认恢复默认').disabled).toBe(false);
  expect(document.querySelector('[role="dialog"] input[type="checkbox"]')).toBeNull();
  expect(reset.preview).toHaveBeenCalledTimes(2);
  expect(reset.preview).toHaveBeenLastCalledWith({ page: 'remote', card: undefined });
  await ui.click('取消');
  expect(reset.restore).not.toHaveBeenCalled();
});
it('恢复默认使用居中模态确认，焦点落在取消，取消不提交恢复', async () => {
  const ui = await mountReset();
  await ui.click('恢复本页默认设置');
  const confirmation = document.querySelector('[role="dialog"][aria-modal="true"]');
  expect(confirmation).not.toBeNull();
  expect(ui.host.contains(confirmation)).toBe(false);
  expect(confirmation?.textContent).toContain('默认设置？');
  expect(document.activeElement).toBe(ui.button('取消'));
  await ui.click('取消');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(reset.restore).not.toHaveBeenCalled();
});
it('旧暂存任务可确认后直接应用，Web 同样不要求重启服务', async () => {
  const f = fixture();
  let pending = true;
  const api: typeof backupApi = {
    ...f.api,
    inventory: async () => ({
      ...(await f.api.inventory()),
      canRestart: false,
      restore: {
        result: null,
        pending: pending
          ? { id: 'old', phase: 'ready', summary: (await f.api.pick())!.summary }
          : null,
      },
    }),
    apply: vi.fn(async () => {
      pending = false;
      return f.api.defaults();
    }),
  };
  const ui = await mount(api);
  expect(ui.host.textContent).toContain('存在待恢复数据');
  expect(ui.button('恢复全局默认设置').disabled).toBe(true);
  expect(ui.button('重启 WeQ')).toBeUndefined();
  expect(api.apply).not.toHaveBeenCalled();
  await ui.click('应用恢复');
  const confirmation = document.querySelector('[role="dialog"]');
  expect(confirmation?.textContent).toContain('应用待恢复数据？');
  await act(async () => {
    confirmation?.querySelectorAll<HTMLButtonElement>('button')[1]?.click();
  });
  expect(api.apply).toHaveBeenCalledTimes(1);
  expect(ui.button('选择备份文件')).toBeDefined();
});

it('Esc 可取消确认，提交中不能重复或关闭，失败留在弹窗且可重试', async () => {
  let reject: (error: Error) => void = () => {};
  reset.restore.mockImplementationOnce(
    () =>
      new Promise<SettingsResetResult[]>((_, fail) => {
        reject = fail;
      }),
  );
  const ui = await mountReset();
  await ui.click('恢复本页默认设置');
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await ui.click('恢复本页默认设置');
  await ui.click('确认恢复默认');
  expect(ui.button('确认恢复默认').disabled).toBe(true);
  expect(ui.button('取消').disabled).toBe(true);
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => reject(new Error('合成暂存失败')));
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain(
    '合成暂存失败',
  );
  await ui.click('确认恢复默认');
  await ui.settled();
  expect(reset.restore).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it('组件关闭后迟到文件被释放，不把旧选择留作可确认输入', async () => {
  const f = fixture();
  let finish: ((value: Awaited<ReturnType<typeof f.api.pick>>) => void) | undefined;
  f.api.pick.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const ui = await mount(f.api);
  await ui.click('选择备份文件');
  const close = cleanups.pop()!;
  close();
  await act(async () => {
    finish?.({
      id: 'late-source',
      name: 'late.zip',
      summary: {
        createdAt: new Date(0).toISOString(),
        parts: [],
        accountConfigIds: [],
        cloneConfigIds: [],
        warnings: [],
      },
    });
  });
  expect(f.api.dispose).toHaveBeenCalledWith('late-source');
  expect(f.api.stage).not.toHaveBeenCalled();
});

it('浏览器备份传输不创建任务，关闭页面后等待在途分片并清理暂存，不执行恢复', async () => {
  const f = fixture();
  let release!: (value: number) => void;
  const api: typeof backupApi = {
    ...f.api,
    begin: vi.fn(async () => 'synthetic-upload'),
    chunk: vi.fn(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    ),
    finish: vi.fn(async () => (await f.api.pick())!),
  };
  const ui = await mount(api);
  const input = ui.host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [new File([new Uint8Array(100_000)], 'synthetic.zip')],
  });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  expect(api.chunk).toHaveBeenCalledOnce();
  expect(localBackgroundTasks.snapshot()).toEqual([]);
  cleanups.pop()!();
  await act(async () => release(65536));
  expect(localBackgroundTasks.snapshot()).toEqual([]);
  expect(api.chunk).toHaveBeenCalledOnce();
  expect(api.finish).not.toHaveBeenCalled();
  expect(f.api.dispose).toHaveBeenCalledWith('synthetic-upload');
  expect(f.api.stage).not.toHaveBeenCalled();
});

it('本地分片读取期间关闭页面，不会在读取完成后再发送一个新分片或创建任务', async () => {
  const f = fixture();
  let release!: (value: ArrayBuffer) => void;
  const file = new File([new Uint8Array(10)], 'synthetic.zip');
  const blob = new Blob();
  vi.spyOn(blob, 'arrayBuffer').mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  vi.spyOn(file, 'slice').mockReturnValue(blob);
  const api: typeof backupApi = {
    ...f.api,
    begin: vi.fn(async () => 'synthetic-upload'),
    chunk: vi.fn(async () => 10),
    finish: vi.fn(async () => (await f.api.pick())!),
  };
  const ui = await mount(api);
  const input = ui.host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  expect(localBackgroundTasks.snapshot()).toEqual([]);
  cleanups.pop()!();
  await act(async () => release(new ArrayBuffer(10)));
  expect(api.chunk).not.toHaveBeenCalled();
  expect(api.finish).not.toHaveBeenCalled();
  expect(localBackgroundTasks.snapshot()).toEqual([]);
});

it('浏览器分片上传完成后在设置页显示备份预览，不创建任务', async () => {
  const f = fixture();
  const api: typeof backupApi = {
    ...f.api,
    begin: vi.fn(async () => 'synthetic-upload'),
    chunk: vi.fn(async () => 10),
    finish: vi.fn(async () => (await f.api.pick())!),
  };
  const ui = await mount(api);
  const input = ui.host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [new File([new Uint8Array(10)], 'synthetic.zip')],
  });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  expect(api.chunk).toHaveBeenCalledOnce();
  expect(api.finish).toHaveBeenCalledWith('synthetic-upload');
  expect(ui.host.textContent).toContain('synthetic.zip');
  expect(localBackgroundTasks.snapshot()).toEqual([]);
});
