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
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === text,
    )!;
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
  await act(async () => {
    ui.host.querySelectorAll<HTMLButtonElement>('[aria-label="同名数据处理"] button')[1]!.click();
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
  await ui.click('确认恢复默认');
  expect(f.api.defaults).toHaveBeenCalledTimes(1);
  expect(ui.button('恢复默认设置').disabled).toBe(false);
  await ui.click('恢复默认设置');
  await ui.click('确认恢复默认');
  expect(f.api.defaults).toHaveBeenCalledTimes(2);
});
it('恢复默认使用居中模态确认，焦点落在取消，取消不提交恢复', async () => {
  const f = fixture(),
    ui = await mount(f.api);
  await ui.click('恢复默认设置');
  const confirmation = document.querySelector('[role="dialog"][aria-modal="true"]');
  expect(confirmation).not.toBeNull();
  expect(ui.host.contains(confirmation)).toBe(false);
  expect(confirmation?.textContent).toContain('恢复默认设置？');
  expect(document.activeElement).toBe(ui.button('取消'));
  await ui.click('取消');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(f.api.defaults).not.toHaveBeenCalled();
});
it('默认恢复暂存后原操作区显示重启状态，重启仍需弹窗确认', async () => {
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
  await ui.click('确认恢复默认');
  const restartSection = ui.button('重启 WeQ').closest('section');
  expect(restartSection?.textContent).toContain('已暂存，等待重启');
  expect(ui.button('恢复默认设置')).toBeUndefined();
  expect(api.restart).not.toHaveBeenCalled();
  await ui.click('重启 WeQ');
  const confirmation = document.querySelector('[role="dialog"]');
  expect(confirmation?.textContent).toContain('重启 WeQ？');
  await act(async () => {
    confirmation?.querySelectorAll<HTMLButtonElement>('button')[1]?.click();
  });
  expect(api.restart).toHaveBeenCalledTimes(1);
});

it('Esc 可取消确认，提交中不能重复或关闭，失败留在弹窗且可重试', async () => {
  const f = fixture();
  let reject: (error: Error) => void = () => {};
  f.api.defaults.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  const ui = await mount(f.api);
  await ui.click('恢复默认设置');
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await ui.click('恢复默认设置');
  await ui.click('确认恢复默认');
  expect(ui.button('正在暂存…').disabled).toBe(true);
  expect(ui.button('取消').disabled).toBe(true);
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => reject(new Error('合成暂存失败')));
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain(
    '合成暂存失败',
  );
  await ui.click('确认恢复默认');
  expect(f.api.defaults).toHaveBeenCalledTimes(2);
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
