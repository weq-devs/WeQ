import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BackupSection, backupApi } from '../src/renderer/src/components/settings/BackupSection';

vi.mock('../src/renderer/src/trpc/client', () => ({ client: {} }));
const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
});
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.unstubAllGlobals();
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
    stage: vi.fn(async () => ({ id: 'staged-1', summary })),
    defaults: vi.fn(async () => ({ id: 'defaults-1', summary })),
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
    [...host.querySelectorAll('button')].find((node) => node.textContent === text)!;
  const click = async (text: string) => {
    await act(async () => button(text).click());
  };
  return { host, button, click };
}
it('读取文件不直接写入，明确预览并确认后才暂存；改选使旧确认失效', async () => {
  const f = fixture(),
    ui = await mount(f.api);
  await ui.click('选择备份文件');
  expect(f.api.stage).not.toHaveBeenCalled();
  await ui.click('预览恢复');
  expect(ui.host.textContent).toContain('确认恢复范围');
  const select = ui.host.querySelector<HTMLSelectElement>('[aria-label="同名数据处理"]')!;
  await act(async () => {
    select.value = 'overwrite';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(ui.host.textContent).not.toContain('确认恢复范围');
  await ui.click('预览恢复');
  await ui.click('确认并暂存');
  expect(f.api.stage).toHaveBeenCalledWith('preview-1');
});
it('恢复默认需二次确认，未变化的命令仍可再次主动执行', async () => {
  const f = fixture(),
    ui = await mount(f.api);
  expect(ui.button('恢复默认设置').disabled).toBe(false);
  await ui.click('恢复默认设置');
  expect(f.api.defaults).not.toHaveBeenCalled();
  await ui.click('确认');
  expect(f.api.defaults).toHaveBeenCalledTimes(1);
  expect(ui.button('恢复默认设置').disabled).toBe(false);
  await ui.click('恢复默认设置');
  await ui.click('确认');
  expect(f.api.defaults).toHaveBeenCalledTimes(2);
});
it('恢复默认确认区紧随下方按钮，取消不提交恢复', async () => {
  const f = fixture(),
    ui = await mount(f.api);
  await ui.click('恢复默认设置');
  const trigger = ui.button('恢复默认设置');
  const confirmation = ui.host.querySelector('[aria-label="确认操作"]');
  expect(confirmation).not.toBeNull();
  expect(trigger.closest('section')?.nextElementSibling).toBe(confirmation);
  expect(confirmation?.textContent).toContain('确认恢复默认设置');
  await ui.click('返回');
  expect(ui.host.querySelector('[aria-label="确认操作"]')).toBeNull();
  expect(f.api.defaults).not.toHaveBeenCalled();
});
it('默认恢复暂存后的重启提示与重启确认都位于页面下方', async () => {
  const f = fixture();
  const staged = await f.api.defaults();
  f.api.defaults.mockClear();
  let pending = false;
  const api: typeof backupApi = {
    ...f.api,
    inventory: async () => ({
      ...(await f.api.inventory()),
      canRestart: true,
      restore: {
        result: null,
        pending: pending ? { id: staged.id, phase: 'ready', summary: staged.summary } : null,
      },
    }),
    defaults: async () => {
      pending = true;
      return staged;
    },
    restart: vi.fn(async () => true),
  };
  const ui = await mount(api);
  await ui.click('恢复默认设置');
  await ui.click('确认');
  const defaultsSection = ui.button('恢复默认设置').closest('section');
  const restartSection = ui.button('重启 WeQ').closest('section');
  expect(defaultsSection?.nextElementSibling).toBe(restartSection);
  expect(restartSection?.textContent).toContain('已暂存，等待重启');
  expect(api.restart).not.toHaveBeenCalled();
  await ui.click('重启 WeQ');
  const confirmation = ui.host.querySelector('[aria-label="确认操作"]');
  expect(restartSection?.nextElementSibling).toBe(confirmation);
  expect(confirmation?.textContent).toContain('确认重启 WeQ');
  await ui.click('确认');
  expect(api.restart).toHaveBeenCalledTimes(1);
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
