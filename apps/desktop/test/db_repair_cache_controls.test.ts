import { act, createElement as h, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DbRepairPanel } from '../src/renderer/src/components/DbRepairPanel';
import { useDialog } from '../src/renderer/src/components/Dialog.shared';
import { maintenanceQa, trpc } from './browser/database-maintenance.stub';

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
function button(
  name: string,
  parent: ParentNode = document.querySelector('[role="dialog"]') ?? document.body,
) {
  const found = [...parent.querySelectorAll('button:not([role="tab"])')].find(
    (item) => item.getAttribute('aria-label') === name || item.textContent?.trim() === name,
  );
  if (!found) throw new Error(`按钮不存在：${name}`);
  return found;
}
function tab(name: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (item) => item.textContent?.trim() === name,
  );
  if (!found) throw new Error(`页签不存在：${name}`);
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
  expect(button('开始体检').disabled).toBe(false);
  expect(button('深度体检').disabled).toBe(false);
});

it('暂停后保留就绪库，切换深度体检后按当前来源继续', async () => {
  await mount();
  const choiceToScan = (name: string) =>
    host.querySelector<HTMLInputElement>(`input[aria-label="体检 ${name}"]`);
  await act(async () => button('开始体检').click());
  expect(tab('体检进度与结果').getAttribute('aria-selected')).toBe('true');
  expect(maintenanceQa.calls.scan).toEqual([
    {
      uin: account.uin,
      configId: account.configId,
      kind: 'scan',
      dbNames: ['nt_msg.db', 'profile.db', 'unsupported.db'],
    },
  ]);
  expect(host.querySelector('[role="radiogroup"]')).toBeNull();
  await act(async () => maintenanceQa.completeFirst());
  await act(async () => button('暂停体检').click());
  expect(maintenanceQa.calls.stop).toBe(1);
  expect(maintenanceQa.calls.end).toBe(0);
  expect(maintenanceQa.snapshot()?.databases[0]?.scanStatus).toBe('completed');
  expect(button('继续体检').disabled).toBe(false);
  expect(host.querySelector('[role="radiogroup"]')).toBeNull();
  const profileCard = () =>
    [...host.querySelectorAll('li')].filter((item) => item.textContent?.includes('profile.db'));
  expect(profileCard()[0]?.textContent).toContain('等待快速体检');
  await act(async () => button('追加体检').click());
  expect(choiceToScan('nt_msg.db')).toBeNull();
  expect(choiceToScan('profile.db')).toBeNull();
  expect(choiceToScan('unsupported.db')).toBeNull();
  expect(button('继续体检').disabled).toBe(false);
  await act(async () => button('深度体检').click());
  expect(choiceToScan('profile.db')?.checked).toBe(true);
  expect(profileCard()).toHaveLength(1);
  expect(profileCard()[0]?.textContent).toContain('等待深度体检');
  expect(profileCard()[0]?.textContent).not.toContain('等待快速体检');
  await act(async () => button('继续体检').click());
  expect(tab('体检进度与结果').getAttribute('aria-selected')).toBe('true');
  expect(maintenanceQa.calls.scan[1]).toEqual({
    uin: account.uin,
    configId: account.configId,
    kind: 'checkup',
    dbNames: ['nt_msg.db', 'profile.db', 'unsupported.db'],
  });
});

it('排队深度体检的库在两种选库列表中都隐藏，取消全选仍可继续原队列', async () => {
  await mount();
  const choiceToScan = (name: string) =>
    host.querySelector<HTMLInputElement>(`input[aria-label="体检 ${name}"]`);
  await act(async () => button('深度体检').click());
  await act(async () => choiceToScan('profile.db')!.click());
  await act(async () => choiceToScan('unsupported.db')!.click());
  await act(async () => button('开始体检').click());
  await act(async () => button('暂停体检').click());
  expect(maintenanceQa.snapshot()?.locked).toBe(false);
  await act(async () => button('追加体检').click());
  expect(choiceToScan('nt_msg.db')).toBeNull();
  expect(choiceToScan('profile.db')).not.toBeNull();
  await act(async () => button('快速体检').click());
  expect(choiceToScan('nt_msg.db')).toBeNull();
  expect(choiceToScan('profile.db')).not.toBeNull();
  await act(async () => button('深度体检').click());
  await act(async () => button('全选').click());
  await act(async () => button('取消全选').click());
  await act(async () => button('继续体检').click());
  expect(maintenanceQa.calls.scan[1]).toMatchObject({ kind: 'checkup', dbNames: ['nt_msg.db'] });
});

it('扫描选择只列未完成当前等级的库，补充深度体检只提交所选库', async () => {
  maintenanceQa.ready();
  await mount();
  const choiceToScan = (name: string) =>
    host.querySelector<HTMLInputElement>(`input[aria-label="体检 ${name}"]`);
  await act(async () => tab('开始体检').click());
  expect(choiceToScan('nt_msg.db')).toBeNull();
  expect(button('体检已完成').disabled).toBe(true);
  await act(async () => tab('体检进度与结果').click());
  await act(async () => button('追加体检').click());
  expect(button('深度体检').getAttribute('aria-checked')).toBe('true');
  expect(choiceToScan('nt_msg.db')?.checked).toBe(true);
  await act(async () => choiceToScan('profile.db')!.click());
  await act(async () => choiceToScan('unsupported.db')!.click());
  await act(async () => button('开始补充检查').click());
  expect(maintenanceQa.calls.end).toBe(0);
  expect(maintenanceQa.calls.scan).toEqual([
    {
      uin: account.uin,
      configId: account.configId,
      kind: 'checkup',
      dbNames: ['nt_msg.db'],
    },
  ]);
  await act(async () => tab('开始体检').click());
  await act(async () => maintenanceQa.complete());
  expect(tab('开始体检').getAttribute('aria-selected')).toBe('true');
  expect(choiceToScan('nt_msg.db')).toBeNull();
  expect(choiceToScan('profile.db')).not.toBeNull();
  await act(async () => button('快速体检').click());
  expect(choiceToScan('profile.db')).toBeNull();
});

it('体检完成后可在原扫描页选中其他库，追加体检不结束维护', async () => {
  await mount();
  const choiceToScan = (name: string) =>
    host.querySelector<HTMLInputElement>(`input[aria-label="体检 ${name}"]`)!;
  await act(async () => choiceToScan('profile.db').click());
  await act(async () => choiceToScan('unsupported.db').click());
  await act(async () => button('开始体检').click());
  await act(async () => maintenanceQa.complete());
  await act(async () => tab('开始体检').click());
  await act(async () => button('深度体检').click());
  await act(async () => tab('体检进度与结果').click());
  await act(async () => button('追加体检').click());
  expect(button('快速体检').getAttribute('aria-checked')).toBe('true');
  expect(host.querySelector('input[aria-label="体检 nt_msg.db"]')).toBeNull();
  expect(button('追加体检').disabled).toBe(true);
  await act(async () => choiceToScan('profile.db').click());
  await act(async () => button('追加体检').click());
  expect(maintenanceQa.calls.end).toBe(0);
  expect(maintenanceQa.calls.scan[1]).toMatchObject({ dbNames: ['profile.db'] });
  expect(maintenanceQa.snapshot()?.databases[0]?.scanStatus).toBe('completed');
});

it('当前批次在追加选库期间完成时，保留所选数据库供追加体检', async () => {
  await mount();
  const choiceToScan = (name: string) =>
    host.querySelector<HTMLInputElement>(`input[aria-label="体检 ${name}"]`);
  await act(async () => choiceToScan('profile.db')!.click());
  await act(async () => choiceToScan('unsupported.db')!.click());
  await act(async () => button('开始体检').click());
  await act(async () => button('追加体检').click());
  expect(choiceToScan('nt_msg.db')).toBeNull();
  await act(async () => choiceToScan('profile.db')!.click());
  expect(button('加入本轮体检').disabled).toBe(false);

  await act(async () => maintenanceQa.complete());
  expect(choiceToScan('profile.db')?.checked).toBe(true);
  await act(async () => button('追加体检').click());
  expect(maintenanceQa.calls.scan[1]).toMatchObject({ kind: 'scan', dbNames: ['profile.db'] });
  expect(maintenanceQa.calls.end).toBe(0);
  expect(maintenanceQa.snapshot()?.databases[0]?.scanStatus).toBe('completed');
});

it('等待首条进度时可选择追加库，确认后加入正在运行的同一轮体检', async () => {
  const begin = Promise.withResolvers<void>();
  const scanAccount = trpc.dbRepair.scanAccount.useMutation();
  const delayedScan = vi.spyOn(trpc.dbRepair.scanAccount, 'useMutation').mockReturnValue({
    ...scanAccount,
    async mutateAsync(input) {
      await begin.promise;
      return scanAccount.mutateAsync(input);
    },
  });
  try {
    await mount();
    const choiceToScan = (name: string) =>
      host.querySelector<HTMLInputElement>(`input[aria-label="体检 ${name}"]`);
    await act(async () => choiceToScan('profile.db')!.click());
    await act(async () => choiceToScan('unsupported.db')!.click());
    await act(async () => button('深度体检').click());
    await act(async () => button('开始体检').click());
    await act(async () => button('追加体检').click());
    expect(choiceToScan('nt_msg.db')).toBeNull();
    await act(async () => choiceToScan('profile.db')!.click());
    expect(button('加入本轮体检').disabled).toBe(true);

    await act(async () => begin.resolve());
    const operationId = maintenanceQa.snapshot()?.operation?.id;
    expect(button('深度体检').disabled).toBe(false);
    expect(choiceToScan('profile.db')?.checked).toBe(true);
    await act(async () => button('加入本轮体检').click());
    expect(maintenanceQa.calls.append).toEqual([
      {
        uin: account.uin,
        configId: account.configId,
        operationId,
        dbNames: ['profile.db'],
        kind: 'checkup',
      },
    ]);
    expect(maintenanceQa.calls.scan).toHaveLength(1);
    expect(maintenanceQa.calls.stop).toBe(0);
    expect(maintenanceQa.snapshot()?.operation).toMatchObject({
      id: operationId,
      kind: 'checkup',
      status: 'running',
      databaseNames: ['nt_msg.db', 'profile.db'],
    });
    expect(tab('体检进度与结果').getAttribute('aria-selected')).toBe('true');
  } finally {
    await act(async () => begin.resolve());
    delayedScan.mockRestore();
  }
});

it('所有库都在快速体检队列时，可以给同一库追加深度体检', async () => {
  await mount();
  await act(async () => button('开始体检').click());
  const operationId = maintenanceQa.snapshot()?.operation?.id;
  await act(async () => button('追加体检').click());
  expect(button('深度体检').getAttribute('aria-checked')).toBe('true');
  expect(button('快速体检').disabled).toBe(false);
  expect(button('深度体检').disabled).toBe(false);
  await act(async () => button('快速体检').click());
  expect(button('快速体检').getAttribute('aria-checked')).toBe('true');
  expect(button('加入本轮体检').disabled).toBe(true);
  await act(async () => button('深度体检').click());
  const profile = host.querySelector<HTMLInputElement>('input[aria-label="体检 profile.db"]');
  expect(profile?.checked).toBe(false);
  await act(async () => profile!.click());
  await act(async () => button('加入本轮体检').click());

  expect(maintenanceQa.calls.append).toEqual([
    {
      uin: account.uin,
      configId: account.configId,
      operationId,
      dbNames: ['profile.db'],
      kind: 'checkup',
    },
  ]);
  expect(maintenanceQa.calls.scan).toHaveLength(1);
  expect(maintenanceQa.calls.stop).toBe(0);
  expect(maintenanceQa.snapshot()?.operation).toMatchObject({
    id: operationId,
    status: 'running',
    totalDatabases: 3,
    databaseScanKinds: { 'profile.db': 'checkup' },
  });
  const card = [...host.querySelectorAll('li')].find((item) =>
    item.textContent?.includes('profile.db'),
  );
  expect(card?.textContent).toContain('等待深度体检');
});

it('深度体检运行时可切换到快速体检并追加未排队的库', async () => {
  await mount();
  await act(async () => button('深度体检').click());
  const profile = () => host.querySelector<HTMLInputElement>('input[aria-label="体检 profile.db"]');
  await act(async () => profile()!.click());
  await act(async () => button('开始体检').click());
  await act(async () => button('追加体检').click());
  await act(async () => button('快速体检').click());
  expect(host.querySelector('input[aria-label="体检 nt_msg.db"]')).toBeNull();
  await act(async () => profile()!.click());
  await act(async () => button('加入本轮体检').click());
  expect(maintenanceQa.calls.append).toEqual([
    expect.objectContaining({ kind: 'scan', dbNames: ['profile.db'] }),
  ]);
  expect(maintenanceQa.calls.stop).toBe(0);
  await act(async () => maintenanceQa.complete());
  const result = maintenanceQa.snapshot()?.databases.find((row) => row.dbName === 'profile.db');
  expect(result?.scanStatus).toBe('completed');
  expect(result?.deepStatus).toBeUndefined();
});

it('界面卸载不取消扫描、不删除已有结果或结束维护', async () => {
  await mount();
  await act(async () => button('深度体检').click());
  await act(async () => button('开始体检').click());
  await act(async () => root!.unmount());
  root = null;
  expect(maintenanceQa.calls.scan).toHaveLength(1);
  expect(maintenanceQa.calls.stop).toBe(0);
  expect(maintenanceQa.calls.end).toBe(0);
});

it('报告可查看健康数据库，修复只选择本轮有方案的数据库', async () => {
  maintenanceQa.ready('checkup');
  await mount();
  expect(
    [...host.querySelectorAll('button')].map((item) => item.textContent?.trim()),
  ).not.toContain('追加体检');
  await act(async () => iconButton('查看 profile.db 检查详情').click());
  expect(host.querySelector('[aria-label="profile.db检查结果"]')).not.toBeNull();
  await act(async () => button('进入修复').click());
  expect(choice('nt_msg.db').checked).toBe(true);
  expect(host.querySelector('input[aria-label="修复 profile.db"]')).toBeNull();
  expect(host.querySelector('input[aria-label="修复 unsupported.db"]')).toBeNull();
  await act(async () => button('开始修复').click());
  expect(maintenanceQa.calls.repair).toHaveLength(0);
  await confirm(true);
  expect(tab('修复进度与结果').getAttribute('aria-selected')).toBe('true');
  expect(maintenanceQa.calls.repair).toEqual([
    expect.objectContaining({ dbNames: ['nt_msg.db'], backups: { 'nt_msg.db': true } }),
  ]);
  expect(button('停止修复').disabled).toBe(false);
  await act(async () => button('停止修复').click());
  expect(maintenanceQa.calls.stop).toBe(1);
  expect(maintenanceQa.snapshot()?.locked).toBe(false);
  expect(tab('开始修复').disabled).toBe(true);
  expect(tab('修复进度与结果').getAttribute('aria-selected')).toBe('true');
  expect(host.querySelector('[aria-label="nt_msg.db修复结果"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="查看 profile.db 修复详情"]')).toBeNull();
  await act(async () => tab('体检进度与结果').click());
  expect(iconButton('查看 profile.db 检查详情')).toBeDefined();

  await act(async () => root!.unmount());
  root = createRoot(host);
  await mount();
  expect(tab('体检进度与结果').disabled).toBe(true);
  expect(tab('开始修复').disabled).toBe(true);
  expect(button('开始体检').disabled).toBe(false);
  await act(async () => iconButton('历史报告与恢复').click());
  expect(button('查看结果')).toBeDefined();
});

it('空间不足和持锁等待不阻止改缓存位置，开始修复后禁止更改', async () => {
  maintenanceQa.lowSpace();
  await mount();
  await act(async () => button('深度体检').click());
  await act(async () => button('开始体检').click());
  await act(async () => iconButton('数据库修复设置').click());
  expect(button('更改位置').disabled).toBe(false);
  await act(async () => button('更改位置').click());
  expect(maintenanceQa.calls.pick).toBe(1);
  await act(async () => maintenanceQa.complete());
  expect(button('使用默认位置').disabled).toBe(false);
  await act(async () => iconButton('数据库修复设置').click());
  await act(async () => button('进入修复').click());
  expect(button('开始修复').disabled).toBe(true);
  await act(async () => maintenanceQa.lowSpace(10_000_000_000));
  await act(async () => button('开始修复').click());
  await confirm(true);
  await act(async () => iconButton('数据库修复设置').click());
  expect(button('更改位置').disabled).toBe(true);
  expect(button('使用默认位置').disabled).toBe(true);
});

it('等待修复时，空间告警只跟随当前勾选的数据库', async () => {
  maintenanceQa.ready('checkup', { secondIssue: true });
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
  await mount();
  await act(async () => tab('开始修复').click());
  const warning = () => button('开始修复').textContent?.includes('磁盘空间不足');
  expect(warning()).toBe(true);
  await act(async () => choice('nt_msg.db').click());
  expect(warning()).toBe(false);
  await act(async () => choice('profile.db').click());
  expect(warning()).toBe(false);
  await act(async () => choice('nt_msg.db').click());
  expect(warning()).toBe(true);
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

it('放弃体检结果必须明确确认，取消继续持锁，确认后仍能查看历史结果', async () => {
  maintenanceQa.ready();
  await mount();
  await act(async () => tab('开始体检').click());
  const release = iconButton('维护中，解除占用');
  await act(async () => release.click());
  await confirm(false);
  expect(maintenanceQa.calls.end).toBe(0);
  expect(maintenanceQa.snapshot()?.locked).toBe(true);
  await act(async () => release.click());
  await confirm(true);
  expect(maintenanceQa.calls.end).toBe(1);
  expect(tab('体检进度与结果').disabled).toBe(true);
  expect(tab('开始修复').disabled).toBe(true);
  expect(tab('开始体检').getAttribute('aria-selected')).toBe('true');
  await act(async () => iconButton('历史报告与恢复').click());
  expect(button('查看结果')).toBeDefined();
  await act(async () => button('查看结果').click());
  expect(maintenanceQa.calls.scan).toHaveLength(0);
});

it('仅建议余量不足时要求继续确认，取消确认会清除勾选', async () => {
  maintenanceQa.ready('checkup');
  await mount();
  await act(async () => tab('开始修复').click());
  const lowSpaceOption = () =>
    [...host.querySelectorAll('label')]
      .find((label) => label.textContent?.includes('仍尝试修复'))
      ?.querySelector('input');
  expect(lowSpaceOption()).toBeUndefined();
  await act(async () => maintenanceQa.lowSpace(1_100_000));
  expect(button('开始修复').disabled).toBe(true);
  await act(async () => lowSpaceOption()!.click());
  await act(async () => button('开始修复').click());
  await confirm(false);
  expect(lowSpaceOption()?.checked).toBe(false);
  expect(button('开始修复').disabled).toBe(true);
  await act(async () => lowSpaceOption()!.click());
  await act(async () => button('开始修复').click());
  await confirm(true);
  expect(maintenanceQa.calls.repair[0]?.allowLowSpace).toBe(true);
});

it('统一使用深度修复和备份，切到快速修复时将不支持的库置灰', async () => {
  maintenanceQa.ready('checkup', { secondIssue: true });
  await mount();
  await act(async () => tab('开始修复').click());
  expect(button('深度修复').getAttribute('aria-checked')).toBe('true');
  expect(choice('profile.db').checked).toBe(true);
  await act(async () => button('快速修复').click());
  expect(choice('profile.db').disabled).toBe(true);
  expect(choice('profile.db').labels?.[0]?.textContent).toContain('不符合快速修复条件');
  await act(async () => button('深度修复').click());
  expect(choice('profile.db').checked).toBe(true);
  const backup = [...host.querySelectorAll('label')]
    .find((label) => label.textContent?.trim() === '保留备份')!
    .querySelector('input')!;
  expect(backup.checked).toBe(true);
  await act(async () => backup.click());
  await act(async () => button('开始修复').click());
  await confirm(true);
  expect(maintenanceQa.calls.repair[0]).toMatchObject({
    dbNames: ['nt_msg.db', 'profile.db'],
    methods: { 'nt_msg.db': 'deep', 'profile.db': 'deep' },
    backups: { 'nt_msg.db': false, 'profile.db': false },
  });
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
