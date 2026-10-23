import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DbRepairPanel } from '../src/renderer/src/components/DbRepairPanel';

const fixture = vi.hoisted(() => ({
  freeBytes: 1,
  detailedBudget: true,
  pick: vi.fn(async () => ({ override: '/synthetic/changed' })),
  reset: vi.fn(async () => ({ override: null })),
  invalidate: vi.fn(async () => {}),
  checkup: vi.fn<() => Promise<unknown>>(),
  start: vi.fn<() => Promise<unknown>>(),
  backup: vi.fn<() => Promise<unknown>>(),
}));

vi.mock('../src/renderer/src/components/QqAvatar', () => ({ QqAvatar: () => null }));
vi.mock('../src/renderer/src/components/Toast', () => ({ useToast: () => vi.fn() }));
vi.mock('../src/renderer/src/hooks/useQQAutoRefresh', () => ({
  useQQAutoRefresh: () => ({ enabled: true }),
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const query = (data: unknown) => ({ useQuery: () => ({ data }) });
  const mutation = (mutateAsync: () => Promise<unknown> = async () => ({})) => ({
    useMutation: () => ({ isLoading: false, mutateAsync }),
  });
  const database = { dbName: 'nt_msg.db', exists: true, bytes: 1024, lastRecord: null };
  const status = { keyPresent: true, qqPid: null, busy: false, databases: [database] };
  const utils = { invalidate: fixture.invalidate };
  return {
    trpc: {
      useUtils: () => ({
        dbRepair: {
          status: utils,
          preflight: utils,
          detectLayout: utils,
          history: utils,
          cacheLocation: utils,
        },
      }),
      dbRepair: {
        status: query(status),
        history: query([]),
        detectLayout: query({ needsMigration: false }),
        preflight: {
          useQuery: () => ({
            data: {
              readiness: 'ready',
              qqHolders: [],
              cachePath: '/synthetic/cache',
              pendingWalBytes: 0,
              dbBytes: 1024,
              space: [
                {
                  paths: ['/synthetic/cache'],
                  freeBytes: fixture.freeBytes,
                  requiredBytes: 100,
                  ...(fixture.detailedBudget ? { recommendedBytes: 125 } : {}),
                },
              ],
            },
          }),
        },
        cacheLocation: query({ override: '/synthetic/cache' }),
        pickCacheLocation: mutation(fixture.pick),
        resetCacheLocation: mutation(fixture.reset),
        checkup: mutation(fixture.checkup),
        start: mutation(fixture.start),
        killQq: mutation(),
        restore: mutation(),
        deleteRecord: mutation(),
        backup: mutation(fixture.backup),
      },
    },
    client: { dbRepair: { onProgress: { subscribe: () => ({ unsubscribe() {} }) } } },
  };
});

let root: Root | null = null;
let host: HTMLDivElement;
let sequence = 0;
let finishCheckup: () => void;
let finishRepair: () => void;
let finishBackup: () => void;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.freeBytes = 1;
  fixture.detailedBudget = true;
  fixture.pick.mockClear();
  fixture.reset.mockClear();
  fixture.invalidate.mockClear();
  fixture.start.mockClear();
  fixture.backup.mockClear();
  fixture.checkup.mockImplementation(
    () =>
      new Promise((_, reject) => {
        finishCheckup = () => reject(new Error('synthetic checkup finished'));
      }),
  );
  fixture.start.mockImplementation(
    () =>
      new Promise((_, reject) => {
        finishRepair = () => reject(new Error('synthetic repair finished'));
      }),
  );
  finishRepair = () => {};
  finishBackup = () => {};
  fixture.backup.mockImplementation(
    () =>
      new Promise((_, reject) => {
        finishBackup = () => reject(new Error('synthetic backup finished'));
      }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  sequence += 1;
  const account = { uin: `synthetic-${sequence}`, name: '合成账号', avatarUrl: '' };
  act(() =>
    root!.render(
      h(DbRepairPanel, { currentUin: account.uin, accounts: [account], onRefreshAccounts() {} }),
    ),
  );
});

afterEach(async () => {
  await act(async () => {
    finishCheckup();
    finishRepair();
    finishBackup();
  });
  act(() => root?.unmount());
  root = null;
  host.remove();
  vi.unstubAllGlobals();
});

function button(name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(
    (item) => item.getAttribute('aria-label') === name || item.textContent?.trim() === name,
  );
  if (!found) throw new Error(`按钮不存在：${name}`);
  return found;
}

function selectDatabase(): void {
  act(() => button('跳过体检，直接选数据库 →').click());
  const pick = host.querySelector<HTMLButtonElement>('.weq-rp-pick');
  if (!pick) throw new Error('数据库选项不存在');
  act(() => pick.click());
}

it('体检尚未结束且空间不足时，仍可选择缓存位置或恢复默认，不启动修复', async () => {
  selectDatabase();
  expect(button('开始修复').disabled).toBe(true);
  expect(button('选择修复缓存位置').disabled).toBe(false);
  expect(button('恢复默认修复缓存位置').disabled).toBe(false);
  await act(async () => button('选择修复缓存位置').click());
  expect(fixture.pick).toHaveBeenCalledOnce();
  await act(async () => button('恢复默认修复缓存位置').click());
  expect(fixture.reset).toHaveBeenCalledOnce();
  expect(fixture.start).not.toHaveBeenCalled();
});

it('体检完成后空间不足仍只拦修复，不拦缓存位置', async () => {
  await act(async () => finishCheckup());
  selectDatabase();
  expect(button('开始修复').disabled).toBe(true);
  expect(button('选择修复缓存位置').disabled).toBe(false);
});

it('真正开始修复后，缓存选择与恢复默认仍保持禁用', async () => {
  fixture.freeBytes = 1000;
  await act(async () => finishCheckup());
  selectDatabase();
  act(() => button('开始修复').click());
  await act(async () => button('确认替换并修复').click());
  expect(fixture.start).toHaveBeenCalledOnce();
  expect(button('选择修复缓存位置').disabled).toBe(true);
  expect(button('恢复默认修复缓存位置').disabled).toBe(true);
});

it('仅建议余量不足时可以打开确认，明确接受风险后才提交强制继续', async () => {
  fixture.freeBytes = 110;
  await act(async () => finishCheckup());
  selectDatabase();
  expect(button('开始修复').disabled).toBe(false);
  act(() => button('开始修复').click());
  expect(button('仍要继续并修复').disabled).toBe(true);
  const consent = host.querySelector<HTMLInputElement>('input[aria-label="余量不足时仍继续"]');
  expect(consent).not.toBeNull();
  act(() => consent!.click());
  expect(button('仍要继续并修复').disabled).toBe(false);
  await act(async () => button('仍要继续并修复').click());
  expect(fixture.start).toHaveBeenCalledWith(expect.objectContaining({ allowLowSpace: true }));
});

it('热更新遇到旧主进程预算时明确提示重启，不把旧建议值冒称峰值或锁住缓存位置', async () => {
  fixture.freeBytes = 110;
  fixture.detailedBudget = false;
  await act(async () => finishCheckup());
  selectDatabase();
  expect(host.textContent).toContain('主进程仍返回旧版空间预检结果');
  expect(host.textContent).toContain('旧版预检值');
  expect(button('开始修复').disabled).toBe(true);
  expect(button('选择修复缓存位置').disabled).toBe(false);
  expect(fixture.start).not.toHaveBeenCalled();
});

it('余量风险确认不沿用到取消后重新打开的修复', async () => {
  fixture.freeBytes = 110;
  await act(async () => finishCheckup());
  selectDatabase();
  act(() => button('开始修复').click());
  const consent = host.querySelector<HTMLInputElement>('input[aria-label="余量不足时仍继续"]')!;
  act(() => consent.click());
  expect(button('仍要继续并修复').disabled).toBe(false);
  act(() => button('取消').click());
  act(() => button('开始修复').click());
  expect(
    host.querySelector<HTMLInputElement>('input[aria-label="余量不足时仍继续"]')!.checked,
  ).toBe(false);
  expect(button('仍要继续并修复').disabled).toBe(true);
  expect(fixture.start).not.toHaveBeenCalled();
});

it('只备份正在使用缓存时，目录控件仍保持禁用', async () => {
  await act(async () => finishCheckup());
  selectDatabase();
  await act(async () => button('只备份').click());
  expect(fixture.backup).toHaveBeenCalledOnce();
  expect(button('选择修复缓存位置').disabled).toBe(true);
  expect(button('恢复默认修复缓存位置').disabled).toBe(true);
});
