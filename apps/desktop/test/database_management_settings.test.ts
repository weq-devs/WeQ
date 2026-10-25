import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DatabaseManagementSection } from '../src/renderer/src/components/settings/DatabaseManagementSection';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';
import { useViewState } from '../src/renderer/src/state/view';
import type { DatabaseExportTarget } from '../src/shared/database_export_target';

const f = vi.hoisted(() => ({
  configId: 'synthetic-source',
  query: vi.fn(),
  run: vi.fn(),
  targets: [] as DatabaseExportTarget[],
  databases: [
    { name: 'msg.db', path: '/synthetic/msg.db', bytes: 100 },
    { name: 'other.db', path: '/synthetic/other.db', bytes: 200 },
  ],
  objects: [{ type: 'table', name: 'synthetic_table', tableName: 'synthetic_table', sql: '' }],
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      getAccountConfig: {
        useQuery: (_input: unknown, options: unknown) => {
          f.query('config', options);
          return { data: { uin: '10001', configId: f.configId }, isFetching: false };
        },
      },
      dbExplorer: {
        listDatabases: {
          useQuery: (_input: unknown, options: unknown) => {
            f.query('databases', options);
            return { data: f.databases, isFetching: false };
          },
        },
        listObjects: {
          useQuery: (_input: unknown, options: unknown) => {
            f.query('objects', options);
            return { data: f.objects };
          },
        },
      },
    },
  },
  client: { account: { dbExplorer: { runSql: { mutate: f.run } } } },
}));
vi.mock('../src/renderer/src/views/cache/DbDataGrid', () => ({
  DbDataGrid: ({ dbPath, table, editable }: { dbPath: string; table: string; editable: boolean }) =>
    h('div', { 'data-grid': true, 'data-editable': String(editable) }, `${dbPath}:${table}`),
}));
vi.mock('../src/renderer/src/views/ExportView', () => ({
  ExportTool: ({
    databaseTarget,
    onClose,
  }: {
    databaseTarget: DatabaseExportTarget;
    onClose: () => void;
  }) => {
    f.targets.push(databaseTarget);
    return h('button', { onClick: onClose }, '取消合成导出');
  },
}));

const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useViewState.setState({ openedUin: '10001' });
  f.configId = 'synthetic-source';
  f.query.mockClear();
  f.run
    .mockReset()
    .mockResolvedValue({ kind: 'rows', columns: ['n'], rows: [[1]], truncated: false });
  f.targets.length = 0;
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  useViewState.setState({ openedUin: null });
  vi.unstubAllGlobals();
});
function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (active = true) =>
    act(() => root.render(h(TabActivity, { active }, h(DatabaseManagementSection))));
  render();
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const button = (text: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === text,
    )!;
  const exportCurrent = () =>
    act(() =>
      host.querySelector<HTMLButtonElement>('[data-setting-id="database-export"]')!.click(),
    );
  return { host, render, button, exportCurrent };
}

it('设置直接显示浏览器、表、SQL 和编辑模式；公共导出关闭后保留原 SQL 草稿', () => {
  const page = mount();
  expect(page.host.querySelector('[data-grid]')?.textContent).toContain('synthetic_table');
  expect(page.host.querySelector('.weq-maintenance-entry')).toBeNull();
  const browser = page.host.querySelector('.weq-cache-db');
  act(() => page.host.querySelector<HTMLInputElement>('.weq-cache-editmode input')!.click());
  expect(page.host.querySelector('[data-grid]')?.getAttribute('data-editable')).toBe('true');
  act(() => page.button('SQL').click());
  const input = page.host.querySelector('textarea')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      input,
      'SELECT 1;',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  page.exportCurrent();
  expect(f.targets.at(-1)).toEqual({
    expectedAccountUin: '10001',
    expectedAccountConfigId: 'synthetic-source',
    dbPaths: ['/synthetic/msg.db'],
  });
  expect(document.querySelector('[role="dialog"][aria-label="导出明文数据库"]')).not.toBeNull();
  act(() =>
    [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => node.textContent === '取消合成导出')!
      .click(),
  );
  expect(document.querySelector('.weq-tool-modal')).toBeNull();
  expect(page.host.querySelector('.weq-cache-db')).toBe(browser);
  expect(page.host.querySelector('textarea')).toBe(input);
  expect(input.value).toBe('SELECT 1;');
  expect(page.host.querySelector<HTMLInputElement>('.weq-cache-editmode input')!.checked).toBe(
    true,
  );
});

it('换库后不展示或执行另一库的旧 SQL 草稿和结果', async () => {
  const page = mount();
  act(() => page.button('SQL').click());
  const input = page.host.querySelector('textarea')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      input,
      'SELECT 1;',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => page.button('执行').click());
  expect(f.run).toHaveBeenCalledWith({ dbPath: '/synthetic/msg.db', sql: 'SELECT 1;' });
  expect(page.host.textContent).toContain('返回 1 行');
  act(() => page.host.querySelector<HTMLButtonElement>('.weq-cache-dbpick-btn')!.click());
  act(() => page.host.querySelectorAll<HTMLButtonElement>('.weq-cache-dbpick-item')[1]!.click());
  expect(page.host.querySelector('textarea')!.value).toBe('');
  expect(page.host.textContent).not.toContain('返回 1 行');
  expect(page.button('执行').disabled).toBe(true);
});

it('选择另一个库再导出携带它的路径，隐藏后停查询并移除导出模态，换源重置浏览现场', () => {
  const page = mount();
  act(() => page.host.querySelector<HTMLButtonElement>('.weq-cache-dbpick-btn')!.click());
  act(() => page.host.querySelectorAll<HTMLButtonElement>('.weq-cache-dbpick-item')[1]!.click());
  page.exportCurrent();
  expect(f.targets.at(-1)?.dbPaths).toEqual(['/synthetic/other.db']);
  page.render(false);
  for (const name of ['config', 'databases', 'objects'])
    expect(f.query.mock.calls.filter(([query]) => query === name).at(-1)?.[1]).toMatchObject({
      enabled: false,
    });
  expect(document.querySelector('.weq-tool-modal')).toBeNull();
  page.render();
  expect(page.host.querySelector('.weq-cache-dbpick-name')?.textContent).toBe('other.db');
  f.configId = 'synthetic-other-source';
  page.render();
  expect(page.host.querySelector('.weq-cache-dbpick-name')?.textContent).toBe('msg.db');
});
