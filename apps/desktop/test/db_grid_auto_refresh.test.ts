// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DbDataGrid } from '../src/renderer/src/views/cache/DbDataGrid';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';
import type { TableRowsResult } from '@weq/service';

const rpc = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('../src/renderer/src/lib/dialogUtils', () => ({
  useAppDialog: () => ({ success: vi.fn(), error: vi.fn(), confirm: vi.fn() }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      dbExplorer: {
        getRows: { query: rpc.read },
        updateCell: { mutate: rpc.write },
        insertRow: { mutate: rpc.write },
        deleteRow: { mutate: rpc.write },
      },
    },
  },
}));

function page(text: string): TableRowsResult {
  return {
    columns: [{ cid: 0, name: '正文', type: 'TEXT', notNull: false, defaultValue: null, pk: 0 }],
    rows: [[text]],
    keys: [{ t: 'rowid', rowid: '1' }],
    hasRowid: true,
    nextCursor: null,
  };
}
let cleanup: (() => void) | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rpc.read.mockReset().mockResolvedValue(page('初始值'));
  rpc.write.mockReset();
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let active = true;
  let dbPath = 'fixture-a';
  const render = () =>
    act(async () =>
      root.render(
        h(TabActivity, { active }, h(DbDataGrid, { dbPath, table: 'messages', editable: true })),
      ),
    );
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  await render();
  return {
    host,
    setActive: async (value: boolean) => {
      active = value;
      await render();
    },
    setSource: async (value: string) => {
      dbPath = value;
      await render();
    },
  };
}

it('表格恢复时自动读取，正在编辑时延后校准，不提交或抹掉草稿', async () => {
  const view = await mount();
  expect(rpc.read).toHaveBeenCalledTimes(1);
  expect(view.host.querySelector('[title="刷新"]')).toBeNull();
  act(() =>
    view.host
      .querySelector('.weq-cache-cell')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
  );
  const input = view.host.querySelector<HTMLInputElement>('.weq-cache-cell-input')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      '编辑中的值',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await view.setActive(false);
  rpc.read.mockResolvedValue(page('远端新值'));
  await view.setActive(true);
  expect(rpc.read).toHaveBeenCalledTimes(1);
  expect(input.value).toBe('编辑中的值');
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(rpc.read).toHaveBeenCalledTimes(2);
  expect(view.host.textContent).toContain('远端新值');
  expect(rpc.write).not.toHaveBeenCalled();
});

it('切换来源时立即清除旧数据，旧在途响应不覆盖新来源', async () => {
  const view = await mount();
  let finish!: (value: TableRowsResult) => void;
  rpc.read.mockReturnValueOnce(
    new Promise<TableRowsResult>((resolve) => {
      finish = resolve;
    }),
  );
  await view.setActive(false);
  await view.setActive(true);
  rpc.read.mockResolvedValue(page('新来源'));
  await view.setSource('fixture-b');
  expect(view.host.textContent).toContain('新来源');
  await act(async () => finish(page('旧来源迟到值')));
  expect(view.host.textContent).not.toContain('旧来源迟到值');
  expect(view.host.textContent).toContain('新来源');
});
