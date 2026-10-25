import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ExportOutputPlan, ExportSavePolicy } from '@weq/service';
import { DatabasePlainExport } from '../src/renderer/src/views/export/DatabasePlainExport';
import {
  createDatabaseExportTarget,
  type DatabaseExportTarget,
} from '../src/shared/database_export_target';

const state = vi.hoisted(() => ({
  uin: '10001',
  configId: 'fixture-source',
  online: false,
  prepare: vi.fn(
    async (
      _intent?: ExportSavePolicy,
      _output?: ExportOutputPlan,
    ): Promise<ExportSavePolicy | null> => ({ mode: 'before', directory: '/fixture/export' }),
  ),
  start: vi.fn(async (_input: unknown) => 'db-task'),
  confirm: vi.fn(async () => true),
}));
vi.mock('../src/renderer/src/state/view', () => ({
  useViewState: { getState: () => ({ openedUin: state.uin }) },
}));
vi.mock('../src/renderer/src/lib/dialogUtils', () => ({
  useAppDialog: () => ({ confirm: state.confirm }),
}));
vi.mock('../src/renderer/src/hooks/useExportSavePolicy', () => ({
  useExportSavePolicy: () => {
    const configId = state.configId;
    return {
      binding: { expectedAccountUin: state.uin, expectedAccountConfigId: configId },
      prepareSave: state.prepare,
      isCurrent: () => configId === state.configId,
    };
  },
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      listDatabases: {
        useQuery: () => ({
          data: [
            { name: 'msg.db', path: '/synthetic/msg.db', bytes: 1024, kind: 'account' },
            { name: 'login.db', path: '/synthetic/login.db', bytes: 512, kind: 'login' },
          ],
          isLoading: false,
          isError: false,
        }),
      },
    },
  },
  client: {
    account: {
      startDatabasePlainExport: { mutate: state.start },
      isQqLoggedIn: { query: async () => state.online },
    },
  },
}));
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.uin = '10001';
  state.configId = 'fixture-source';
  state.online = false;
  state.prepare.mockReset().mockResolvedValue({ mode: 'before', directory: '/fixture/export' });
  state.start.mockClear();
  state.confirm.mockReset().mockResolvedValue(true);
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});
async function mount(target?: DatabaseExportTarget) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const started = vi.fn();
  const render = async () =>
    act(async () =>
      root.render(h(DatabasePlainExport, { accountUin: '10001', onStarted: started, target })),
    );
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  await render();
  return { host, render, started };
}
function select(host: HTMLElement, index = 0) {
  act(() => host.querySelectorAll<HTMLButtonElement>('.weq-db-card')[index]!.click());
}
it('浏览器带入精确当前库，仍可在同一来源显式扩选，不默认为全部', async () => {
  const f = await mount(
    createDatabaseExportTarget(
      {
        expectedAccountUin: '10001',
        expectedAccountConfigId: 'fixture-source',
      },
      ['/synthetic/login.db'],
    ),
  );
  expect(f.host.querySelectorAll('.weq-db-card.is-on')).toHaveLength(1);
  expect(f.host.querySelector('.weq-db-card.is-on')?.textContent).toContain('login.db');
  await act(async () => f.host.querySelector<HTMLButtonElement>('.is-safe')!.click());
  expect(state.start).toHaveBeenCalledWith(
    expect.objectContaining({ dbPaths: ['/synthetic/login.db'] }),
  );
  expect(f.host.querySelectorAll('.weq-db-card.is-on')).toHaveLength(0);
  await f.render();
  expect(f.host.querySelectorAll('.weq-db-card.is-on')).toHaveLength(0);
});
it.each(['other-source', 'fixture-source'])(
  '失效来源或已不在清单的库不静默导出其他库：%s',
  async (configId) => {
    const f = await mount(
      createDatabaseExportTarget(
        {
          expectedAccountUin: '10001',
          expectedAccountConfigId: configId,
        },
        ['/synthetic/missing.db'],
      ),
    );
    expect(f.host.querySelectorAll('.weq-db-card.is-on')).toHaveLength(0);
    expect(f.host.querySelector<HTMLButtonElement>('.is-safe')!.disabled).toBe(true);
    expect(f.host.querySelector('[role="alert"]')?.textContent).toMatch(/来源|不存在/);
    expect(state.start).not.toHaveBeenCalled();
  },
);
it.each([1, 2])('选择 %i 个库后由普通按钮准备文件／整包，不需要正文位置栏', async (count) => {
  const f = await mount();
  select(f.host);
  if (count === 2) select(f.host, 1);
  expect(f.host.querySelector('.weq-db-actionbar-target')).toBeNull();
  expect(f.host.querySelector<HTMLButtonElement>('.is-safe')!.disabled).toBe(false);
  const output = process.env.WEQ_DB_LAYOUT_DIR;
  if (output) {
    mkdirSync(output, { recursive: true });
    const links = [
      'index.css',
      'export.css',
      'database-plain-export.css',
      'export-save-actions.css',
    ]
      .map(
        (file) => `<link rel="stylesheet" href="/@fs${resolve('src/renderer/src/styles', file)}">`,
      )
      .join('');
    writeFileSync(
      resolve(output, `database-${count}.html`),
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8">${links}<style>body{margin:0;padding:16px;background:var(--background);font-family:system-ui}*,*::before,*::after{box-sizing:border-box}main{height:calc(100vh - 32px);max-width:1000px;margin:auto;display:flex;flex-direction:column}button{font:inherit}</style><body><main>${f.host.innerHTML}</main></body></html>`,
    );
  }
  await act(async () => f.host.querySelector<HTMLButtonElement>('.is-safe')!.click());
  expect(state.prepare).toHaveBeenCalledWith(
    undefined,
    count === 1
      ? { kind: 'file', name: 'msg', format: 'db' }
      : { kind: 'bundle', name: '数据库明文' },
  );
  expect(state.start).toHaveBeenCalledWith({
    expectedAccountUin: '10001',
    expectedAccountConfigId: 'fixture-source',
    mode: 'safe',
    savePolicy: { mode: 'before', directory: '/fixture/export' },
    dbPaths: count === 1 ? ['/synthetic/msg.db'] : ['/synthetic/msg.db', '/synthetic/login.db'],
  });
  expect(f.started).toHaveBeenCalledOnce();
});
it('保存只提供主按钮，取消位置选择保留勾选且不建任务', async () => {
  const f = await mount();
  select(f.host);
  state.prepare.mockResolvedValueOnce(null);
  expect(f.host.querySelector('.weq-save-options')).toBeNull();
  await act(async () => f.host.querySelector<HTMLButtonElement>('.is-safe')!.click());
  expect(state.prepare).toHaveBeenCalledWith(undefined, {
    kind: 'file',
    name: 'msg',
    format: 'db',
  });
  expect(state.start).not.toHaveBeenCalled();
  expect(f.host.querySelector('.weq-db-card.is-on')).not.toBeNull();
});
it('快速模式保留在线风险确认，拒绝后不准备位置或建任务', async () => {
  const f = await mount();
  select(f.host);
  state.online = true;
  state.confirm.mockResolvedValueOnce(false);
  await act(async () => f.host.querySelector<HTMLButtonElement>('.is-fast')!.click());
  expect(state.confirm).toHaveBeenCalledOnce();
  expect(state.prepare).not.toHaveBeenCalled();
  expect(state.start).not.toHaveBeenCalled();
});
it('准备期间切换同号来源停止旧任务创建并清空旧选择', async () => {
  const f = await mount();
  select(f.host);
  let finish!: (policy: ExportSavePolicy) => void;
  state.prepare.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  act(() => f.host.querySelector<HTMLButtonElement>('.is-safe')!.click());
  state.configId = 'other-source';
  await f.render();
  await act(async () => finish({ mode: 'before', directory: '/fixture/export' }));
  expect(state.start).not.toHaveBeenCalled();
  expect(f.host.querySelector('.weq-db-card.is-on')).toBeNull();
});
