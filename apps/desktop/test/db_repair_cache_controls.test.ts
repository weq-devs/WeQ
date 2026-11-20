import { act, createElement as h, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DbRepairPanel } from '../src/renderer/src/components/DbRepairPanel';
import { useDialog } from '../src/renderer/src/components/Dialog.shared';
import { maintenanceQa } from './browser/database-maintenance.stub';

vi.mock(
  '../src/renderer/src/trpc/client',
  async () => await import('./browser/database-maintenance.stub'),
);
vi.mock('../src/renderer/src/components/QqAvatar', () => ({ QqAvatar: () => null }));

let root: Root | null;
let host: HTMLDivElement;
const account = { uin: 'synthetic', configId: 'source', name: '合成账号', avatarUrl: '' };
async function mount(
  reportId?: string,
  resultRequest?: { uin: string; configId?: string; reportId?: string },
) {
  await act(async () =>
    root!.render(
      h(
        StrictMode,
        null,
        h(DbRepairPanel, {
          currentUin: account.uin,
          accounts: [account],
          reportId,
          resultRequest,
          onRefreshAccounts() {},
        }),
      ),
    ),
  );
}
function button(name: string) {
  const found = [...document.body.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === name,
  );
  if (!found) throw new Error(`按钮不存在：${name}`);
  return found;
}
function iconButton(name: string) {
  const found = document.body.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  if (!found) throw new Error(`按钮不存在：${name}`);
  return found;
}
function choice(name: string) {
  const found = host.querySelector<HTMLInputElement>(`input[aria-label="修复 ${name}"]`);
  if (!found) throw new Error(`数据库不存在：${name}`);
  return found;
}
async function confirm(accepted: boolean) {
  await act(async () => {
    const request = useDialog.getState().current;
    expect(request?.confirm).toBeDefined();
    request!.confirm!.resolve(accepted);
    useDialog.getState().close();
  });
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  maintenanceQa.reset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => {
    maintenanceQa.complete();
    useDialog.getState().close();
  });
  await act(async () => root?.unmount());
  root = null;
  host.remove();
  maintenanceQa.reset();
  vi.unstubAllGlobals();
});

it('打开修复和 StrictMode 重挂载均不启动检查或修复', async () => {
  await mount();
  expect(maintenanceQa.calls.scan).toEqual([]);
  expect(maintenanceQa.calls.repair).toEqual([]);
  expect(button('开始扫描').disabled).toBe(false);
  expect(button('深度体检').disabled).toBe(false);
});

it('扫描时不可切换模式，暂停后保留就绪库，切换深度体检后按当前来源继续', async () => {
  await mount();
  await act(async () => button('开始扫描').click());
  expect(maintenanceQa.calls.scan).toEqual([
    { uin: account.uin, configId: account.configId, kind: 'scan' },
  ]);
  expect(button('深度体检').disabled).toBe(true);
  await act(async () => maintenanceQa.completeFirst());
  await act(async () => button('暂停扫描').click());
  expect(maintenanceQa.calls.stop).toBe(1);
  expect(maintenanceQa.calls.end).toBe(0);
  expect(choice('nt_msg.db').disabled).toBe(false);
  expect(button('继续扫描').disabled).toBe(false);
  expect(button('深度体检').disabled).toBe(false);
  await act(async () => button('深度体检').click());
  await act(async () => button('继续扫描').click());
  expect(maintenanceQa.calls.scan[1]).toEqual({
    uin: account.uin,
    configId: account.configId,
    kind: 'checkup',
  });
});

it('重新扫描需确认，取消保留结果和维护锁，确认后结束旧维护再开始扫描', async () => {
  maintenanceQa.ready();
  await mount();
  const previous = maintenanceQa.snapshot();
  await act(async () => button('重新扫描').click());
  expect(maintenanceQa.calls.scan).toHaveLength(0);
  expect(maintenanceQa.calls.end).toBe(0);
  await confirm(false);
  expect(maintenanceQa.snapshot()).toBe(previous);
  expect(maintenanceQa.snapshot()?.locked).toBe(true);
  expect(choice('nt_msg.db').checked).toBe(true);
  await act(async () => button('重新扫描').click());
  await confirm(true);
  expect(maintenanceQa.calls.end).toBe(1);
  expect(maintenanceQa.calls.scan).toEqual([
    { uin: account.uin, configId: account.configId, kind: 'scan' },
  ]);
  expect(maintenanceQa.snapshot()?.state).toBe('scanning');
});

it('界面卸载不取消扫描、不删除已有结果或结束维护', async () => {
  await mount();
  await act(async () => button('深度体检').click());
  await act(async () => button('开始扫描').click());
  await act(async () => root!.unmount());
  root = null;
  expect(maintenanceQa.calls.scan).toHaveLength(1);
  expect(maintenanceQa.calls.stop).toBe(0);
  expect(maintenanceQa.calls.end).toBe(0);
});

it('默认勾选支持修复的异常库，健康库可手选，不支持的库不能提交', async () => {
  maintenanceQa.ready();
  await mount();
  expect(choice('nt_msg.db').checked).toBe(true);
  expect(choice('profile.db').checked).toBe(false);
  expect(choice('profile.db').disabled).toBe(false);
  expect(host.querySelector('input[aria-label="修复 unsupported.db"]')).toBeNull();
  await act(async () => iconButton('查看 profile.db 检查详情').click());
  expect(host.querySelector('[aria-label="profile.db检查结果"]')).not.toBeNull();
  expect(choice('profile.db').checked).toBe(false);
  await act(async () => iconButton('查看 nt_msg.db 检查详情').click());
  expect(host.querySelector('[aria-label="nt_msg.db检查结果"]')).not.toBeNull();
  expect(choice('nt_msg.db').checked).toBe(true);
  await act(async () => choice('profile.db').click());
  await act(async () => button('修复所选数据库').click());
  expect(maintenanceQa.calls.repair).toHaveLength(0);
  await confirm(true);
  expect(maintenanceQa.calls.repair).toEqual([
    expect.objectContaining({ dbNames: ['nt_msg.db', 'profile.db'], backup: true }),
  ]);
  expect(button('停止修复').disabled).toBe(false);
  await act(async () => button('停止修复').click());
  expect(maintenanceQa.calls.stop).toBe(1);
  expect(maintenanceQa.snapshot()?.locked).toBe(false);
});

it('空间不足和持锁等待不阻止改缓存位置，开始修复后禁止更改', async () => {
  maintenanceQa.lowSpace();
  await mount();
  await act(async () => button('开始扫描').click());
  await act(async () => iconButton('数据库修复设置').click());
  expect(button('更改位置').disabled).toBe(false);
  await act(async () => button('更改位置').click());
  expect(maintenanceQa.calls.pick).toBe(1);
  await act(async () => maintenanceQa.complete());
  expect(button('使用默认位置').disabled).toBe(false);
  await act(async () => button('修复所选数据库').click());
  await confirm(true);
  expect(button('更改位置').disabled).toBe(true);
  expect(button('使用默认位置').disabled).toBe(true);
});

it('等待修复时，空间告警只跟随当前勾选的数据库', async () => {
  maintenanceQa.ready();
  maintenanceQa.lowSpace(500_000);
  maintenanceQa.snapshot()!.storage = {
    dbName: 'nt_msg.db',
    cachePath: '/synthetic/cache',
    phase: 'preparing',
    warning: 'insufficient-space',
    space: [
      {
        paths: ['/synthetic/cache'],
        freeBytes: 500_000,
        requiredBytes: 1_000_000,
        recommendedBytes: 1_250_000,
      },
    ],
  };
  const warning = () => host.querySelector('[role="alert"][aria-label="磁盘空间警告"]');
  await mount();
  expect(warning()).not.toBeNull();
  await act(async () => choice('nt_msg.db').click());
  expect(warning()).toBeNull();
  await act(async () => choice('profile.db').click());
  expect(warning()).toBeNull();
  await act(async () => choice('nt_msg.db').click());
  expect(warning()).not.toBeNull();
});

it('查看历史结果与三种导出都不重新体检，导出仍指向原报告', async () => {
  maintenanceQa.ready();
  maintenanceQa.archive();
  await mount('old-report');
  for (const format of ['HTML', 'Markdown', 'JSON']) await act(async () => button(format).click());
  expect(maintenanceQa.calls.scan).toHaveLength(0);
  expect(maintenanceQa.calls.repair).toHaveLength(0);
  expect(maintenanceQa.calls.export).toEqual(
    ['html', 'md', 'json'].map((format) => ({
      uin: account.uin,
      configId: account.configId,
      reportId: 'old-report',
      format,
    })),
  );
});

it('跨数据源查看报告不切换正在维护的账号，返回当前结果后导出恢复原来源', async () => {
  maintenanceQa.ready();
  maintenanceQa.archive({ uin: 'other', configId: 'other-source' });
  await mount(undefined, { uin: 'other', configId: 'other-source', reportId: 'old-report' });
  await act(async () => button('JSON').click());
  expect(maintenanceQa.calls.export[0]).toMatchObject({
    uin: 'other',
    configId: 'other-source',
    reportId: 'old-report',
  });
  expect(maintenanceQa.snapshot()?.uin).toBe(account.uin);
  expect(maintenanceQa.snapshot()?.locked).toBe(true);
  await act(async () => button('返回历史报告').click());
  await act(async () => button('查看结果').click());
  await act(async () => button('JSON').click());
  expect(maintenanceQa.calls.export[1]).toMatchObject({
    uin: account.uin,
    configId: account.configId,
    reportId: maintenanceQa.snapshot()?.operation?.id,
  });
  expect(maintenanceQa.calls.scan).toHaveLength(0);
});

it('放弃扫描结果必须明确确认，取消继续持锁，确认后仍能查看历史结果', async () => {
  maintenanceQa.ready();
  await mount();
  await act(async () => button('结束维护').click());
  await confirm(false);
  expect(maintenanceQa.calls.end).toBe(0);
  expect(maintenanceQa.snapshot()?.locked).toBe(true);
  await act(async () => button('结束维护').click());
  await confirm(true);
  expect(maintenanceQa.calls.end).toBe(1);
  await act(async () => iconButton('历史报告与恢复').click());
  expect(button('查看结果')).toBeDefined();
  await act(async () => button('查看结果').click());
  expect(maintenanceQa.calls.scan).toHaveLength(0);
});

it('建议余量确认不沿用到取消后重新打开的修复', async () => {
  maintenanceQa.ready();
  await mount();
  const input = [...host.querySelectorAll('label')]
    .find((label) => label.textContent?.includes('预留空间不足时仍尝试修复'))!
    .querySelector('input')!;
  await act(async () => input.click());
  await act(async () => button('修复所选数据库').click());
  await confirm(false);
  expect(input.checked).toBe(false);
  await act(async () => button('修复所选数据库').click());
  await confirm(true);
  expect(maintenanceQa.calls.repair[0]?.allowLowSpace).toBe(false);
});

it('修复选项内部点击不关闭，外部点击关闭但保留选项，Esc 仍可关闭', async () => {
  maintenanceQa.ready();
  await mount();
  const summary = [...host.querySelectorAll('summary')].find((item) =>
    item.textContent?.includes('修复选项'),
  )!;
  const options = summary.parentElement as HTMLDetailsElement;
  const input = options.querySelector<HTMLInputElement>('input')!;
  await act(async () => summary.click());
  expect(options.open).toBe(true);
  await act(async () => {
    input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    input.click();
  });
  expect(options.open).toBe(true);
  expect(input.checked).toBe(false);
  await act(async () => {
    host.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });
  expect(options.open).toBe(false);
  await act(async () => summary.click());
  expect(options.open).toBe(true);
  expect(input.checked).toBe(false);
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  expect(options.open).toBe(false);
});

it('历史报告独立打开，删除需确认且不会结束维护或重扫', async () => {
  maintenanceQa.ready();
  await mount();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => iconButton('历史报告与恢复').click());
  expect(document.querySelector('[role="dialog"][aria-label="历史报告与恢复"]')).not.toBeNull();
  await act(async () => iconButton('删除报告').click());
  await confirm(false);
  expect(maintenanceQa.calls.delete).toHaveLength(0);
  await act(async () => iconButton('删除报告').click());
  await confirm(true);
  expect(maintenanceQa.calls.delete).toEqual([
    {
      uin: account.uin,
      configId: account.configId,
      reportId: maintenanceQa.snapshot()?.operation?.id,
    },
  ]);
  expect(maintenanceQa.snapshot()?.locked).toBe(true);
  expect(maintenanceQa.calls.scan).toHaveLength(0);
  expect(maintenanceQa.calls.end).toBe(0);
});
