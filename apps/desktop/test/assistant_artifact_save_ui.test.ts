import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AssistantArtifact, ExportOutputPlan, ExportSavePolicy } from '@weq/service';
import type { client } from '../src/renderer/src/trpc/client';
import { AssistantArtifactCard } from '../src/renderer/src/views/agentlab/AssistantArtifactCard';

type Receipt = NonNullable<Awaited<ReturnType<typeof client.account.getExportOutputReceipt.query>>>;
const state = vi.hoisted(() => ({
  configId: 'source-a',
  web: false,
  receipts: new Map<string, Receipt>(),
  prepare: vi.fn(
    async (
      _intent?: ExportSavePolicy,
      _output?: ExportOutputPlan,
    ): Promise<ExportSavePolicy | null> => ({ mode: 'after' }),
  ),
  start: vi.fn(async (_input: unknown) => 'report-task'),
  save: vi.fn(async (_input: unknown): Promise<string | null> => '/saved/result.html'),
  open: vi.fn(async (_input: unknown) => true),
  invalidate: vi.fn(async (_input: unknown) => {}),
  toast: vi.fn(() => 1),
  error: vi.fn(),
  choose: vi.fn(),
  download: vi.fn(async (_input: unknown) => ({ url: '/download/synthetic' })),
}));
vi.mock('../src/renderer/src/lib/target', () => ({
  get IS_WEB() {
    return state.web;
  },
}));
vi.mock('../src/renderer/src/lib/dialogUtils', () => ({
  useAppDialog: () => ({ error: state.error }),
}));
vi.mock('../src/renderer/src/components/Toast', () => ({
  useToast: (select: (store: { push: typeof state.toast }) => unknown) =>
    select({ push: state.toast }),
}));
vi.mock('../src/renderer/src/hooks/useExportSavePolicy', () => ({
  useExportSavePolicy: () => {
    const configId = state.configId;
    return {
      binding: { expectedAccountUin: '10001', expectedAccountConfigId: configId },
      prepareSave: state.prepare,
      chooseServerLocation: state.choose,
      isCurrent: () => configId === state.configId,
    };
  },
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ account: { getExportOutputReceipt: { invalidate: state.invalidate } } }),
    account: {
      getExportOutputReceipt: {
        useQuery: (input: { taskId: string }, options: { enabled: boolean }) => ({
          data: options.enabled ? (state.receipts.get(input.taskId) ?? null) : undefined,
        }),
      },
    },
  },
  client: {
    account: {
      getExportOutputReceipt: {
        query: async (input: { taskId: string }) => {
          const data = state.receipts.get(input.taskId);
          return data ?? null;
        },
      },
      startAssistantArtifactSave: { mutate: state.start },
      saveExportTaskOutput: { mutate: state.save },
      openSavedExportOutput: { mutate: state.open },
      openAssistantExport: { mutate: state.open },
      openAssistantArtifact: { mutate: state.open },
      exportTaskDownload: { mutate: state.download },
      assistantArtifactDownload: { mutate: state.download },
    },
  },
}));
const cleanups: Array<() => void> = [];
const report: AssistantArtifact = {
  id: 'report.md',
  name: '合成报告.md',
  kind: 'markdown',
  mime: 'text/markdown',
  bytes: 100,
};
const expected = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' };
function receipt(id: string, output: Receipt['output']): Receipt {
  return {
    id,
    name: '合成结果',
    status: 'completed',
    error: undefined,
    save: { policy: { mode: 'after' }, status: 'pending' },
    output,
  };
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.configId = 'source-a';
  state.web = false;
  state.download.mockClear();
  state.receipts.clear();
  state.prepare.mockReset().mockResolvedValue({ mode: 'after' });
  state.start.mockReset().mockImplementation(async () => {
    state.receipts.set('report-task', { ...receipt('report-task', null), status: 'pending' });
    return 'report-task';
  });
  state.save.mockReset().mockResolvedValue('/saved/result.html');
  state.open.mockClear();
  state.toast.mockClear();
  state.error.mockClear();
  state.choose.mockClear();
  state.invalidate.mockClear();
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});
async function mount(artifact = report) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = async (next = artifact) =>
    act(async () => root.render(h(AssistantArtifactCard, { artifact: next })));
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  await render();
  return { host, render };
}
async function save(host: HTMLElement) {
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => node.textContent === ' 保存')!
      .click(),
  );
}
function capture(host: HTMLElement, name: string) {
  const output = process.env.WEQ_ARTIFACT_LAYOUT_DIR;
  if (!output) return;
  mkdirSync(output, { recursive: true });
  const links = ['index.css', 'export-save-actions.css', 'assistant-artifact-save.css']
    .map((file) => `<link rel="stylesheet" href="/@fs${resolve('src/renderer/src/styles', file)}">`)
    .join('');
  writeFileSync(
    resolve(output, `${name}.html`),
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8">${links}<style>body{margin:0;padding:16px;background:var(--background);font-family:system-ui}*,*::before,*::after{box-sizing:border-box}main{max-width:720px;margin:auto}</style><body><main>${host.innerHTML}</main></body></html>`,
  );
}
it('报告使用原句柄创建单文件保存任务，排队不冒称已保存，完成反馈提供打开／定位', async () => {
  const f = await mount();
  state.prepare.mockResolvedValueOnce({
    mode: 'preset',
    filePath: '/saved/合成报告.md',
    uniqueFileName: true,
  });
  await save(f.host);
  expect(state.prepare).toHaveBeenCalledWith(undefined, {
    kind: 'file',
    name: '合成报告',
    format: 'md',
  });
  expect(state.start).toHaveBeenCalledWith({
    ...expected,
    id: 'report.md',
    name: '合成报告.md',
    savePolicy: { mode: 'preset', filePath: '/saved/合成报告.md', uniqueFileName: true },
  });
  expect(f.host.textContent).not.toContain('已保存');
  state.receipts.set('report-task', {
    ...receipt('report-task', { kind: 'file', name: '合成报告', extension: 'md' }),
    save: { policy: { mode: 'after' }, status: 'saved', path: '/saved/合成报告.md' },
  });
  await f.render();
  expect(f.host.textContent).toContain('已保存');
  capture(f.host, 'artifact-saved');
  await act(async () =>
    f.host.querySelector<HTMLButtonElement>('[aria-label="打开保存结果"]')!.click(),
  );
  await act(async () =>
    f.host.querySelector<HTMLButtonElement>('[aria-label="在文件夹中显示"]')!.click(),
  );
  expect(state.open.mock.calls).toEqual([
    [{ ...expected, taskId: 'report-task', reveal: false }],
    [{ ...expected, taskId: 'report-task', reveal: true }],
  ]);
});
it('已有导出卡片只另存既有任务，保留自动避让标记，不创建新的生成任务', async () => {
  state.receipts.set(
    'export-task',
    receipt('export-task', { kind: 'file', name: '合成结果', extension: 'csv' }),
  );
  const f = await mount({ ...report, id: 'export-task', kind: 'export' });
  state.prepare.mockResolvedValueOnce({
    mode: 'preset',
    filePath: '/saved/结果.csv',
    uniqueFileName: true,
  });
  await save(f.host);
  expect(state.prepare).toHaveBeenCalledWith(undefined, {
    kind: 'file',
    name: '合成结果',
    format: 'csv',
  });
  expect(state.save).toHaveBeenCalledWith({
    ...expected,
    taskId: 'export-task',
    filePath: '/saved/结果.csv',
    uniqueFileName: true,
  });
  expect(state.start).not.toHaveBeenCalled();
});
it('菜单另存取消不创建任务；稍后保存已有包不复制也不重建任务', async () => {
  const artifact = { ...report, id: 'export-task', kind: 'export' as const };
  state.receipts.set('export-task', receipt('export-task', { kind: 'directory' }));
  const f = await mount(artifact);
  state.prepare.mockResolvedValueOnce(null);
  act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="本次保存选项"]')!.click());
  const choose = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (node) => node.textContent === '另存到…',
  )!;
  await act(async () => choose.click());
  expect(state.prepare).toHaveBeenCalledWith(
    { mode: 'before' },
    { kind: 'bundle', name: '合成结果' },
  );
  expect(state.save).not.toHaveBeenCalled();
  expect(state.start).not.toHaveBeenCalled();
  await save(f.host);
  expect(state.save).not.toHaveBeenCalled();
  expect(state.start).not.toHaveBeenCalled();
  expect(f.host.textContent).toContain('等待保存');
});
it('报告保存失败后重试使用已完成缓存，失败反馈仍保留上次位置', async () => {
  const f = await mount();
  await save(f.host);
  state.receipts.set('report-task', {
    ...receipt('report-task', { kind: 'file', name: '合成报告', extension: 'md' }),
    save: {
      policy: { mode: 'after' },
      status: 'failed',
      path: '/saved/previous.md',
      error: '目标不可用',
    },
  });
  await f.render();
  expect(f.host.textContent).toContain('上次保存：/saved/previous.md');
  capture(f.host, 'artifact-failed');
  state.prepare.mockResolvedValueOnce({ mode: 'before', filePath: '/saved/new.md' });
  await save(f.host);
  expect(state.start).toHaveBeenCalledOnce();
  expect(state.save).toHaveBeenCalledWith({
    ...expected,
    taskId: 'report-task',
    filePath: '/saved/new.md',
    uniqueFileName: undefined,
  });
});
it('保存任务被用户删除后报告可重新登记，不把缓存丢失变成永久错误', async () => {
  const f = await mount();
  await save(f.host);
  state.receipts.delete('report-task');
  await f.render();
  expect(f.host.textContent).toContain('结果已清理');
  await save(f.host);
  expect(state.start).toHaveBeenCalledTimes(2);
  expect(state.save).not.toHaveBeenCalled();
});
it.each(['markdown', 'export'] as const)(
  'Web %s 区分服务器保存与浏览器下载，下载不准备服务器位置或重新生成',
  async (kind) => {
    state.web = true;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      const artifact = { ...report, kind, id: kind === 'export' ? 'export-task' : report.id };
      const f = await mount(artifact);
      expect(f.host.textContent).toContain('保存到服务器');
      capture(f.host, `artifact-web-${kind}`);
      await act(async () =>
        f.host.querySelector<HTMLButtonElement>('[aria-label="下载到浏览器"]')!.click(),
      );
      expect(state.download).toHaveBeenCalledWith(
        kind === 'export'
          ? { ...expected, taskId: 'export-task' }
          : { ...expected, id: 'report.md', name: '合成报告.md' },
      );
      expect(click).toHaveBeenCalledOnce();
      expect(state.prepare).not.toHaveBeenCalled();
      expect(state.start).not.toHaveBeenCalled();
    } finally {
      click.mockRestore();
    }
  },
);
it.each(['source', 'artifact'])('准备期间变化 %s 后，旧回包不能触发保存', async (change) => {
  const f = await mount();
  let finish!: (policy: ExportSavePolicy) => void;
  state.prepare.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  act(() =>
    [...f.host.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => node.textContent === ' 保存')!
      .click(),
  );
  if (change === 'source') state.configId = 'source-b';
  await f.render(change === 'artifact' ? { ...report, id: 'other.md' } : report);
  await act(async () => finish({ mode: 'after' }));
  expect(state.start).not.toHaveBeenCalled();
  expect(state.save).not.toHaveBeenCalled();
});
