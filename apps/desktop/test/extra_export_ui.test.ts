import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  PersonaBotExportPane,
  QzoneTargetInput,
  QzoneContentSelector,
} from '../src/renderer/src/views/export/ResourceExportPanes';

const state = vi.hoisted(() => ({
  current: true,
  prepare: vi.fn(
    async (): Promise<{ mode: 'before'; directory: string } | null> => ({
      mode: 'before',
      directory: '/synthetic',
    }),
  ),
  start: vi.fn(async (_input: unknown) => ({ canceled: false, taskId: 'bot-task' })),
  chooseReport: vi.fn(async (): Promise<boolean | null> => false),
  success: vi.fn(),
  error: vi.fn(),
  added: vi.fn(),
}));
vi.mock('../src/renderer/src/hooks/useExportSavePolicy', () => ({
  useExportSavePolicy: () => ({
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'synthetic' },
    settings: { isLoading: false },
    prepareSave: state.prepare,
    isCurrent: () => state.current,
  }),
}));
vi.mock('../src/renderer/src/views/export/ExportReportControl', () => ({
  useExportReportDialog: () => ({ choose: state.chooseReport, dialog: null }),
}));
vi.mock('../src/renderer/src/lib/dialogUtils', () => ({
  useAppDialog: () => ({ success: state.success, error: state.error }),
}));
vi.mock('../src/renderer/src/components/settings/ApiModelSelect', () => ({
  ApiModelSelect: () => null,
}));
vi.mock('../src/renderer/src/lib/draftClose', async (original) => ({
  ...(await original<object>()),
  useDraftProtection: () => ({ reset: vi.fn() }),
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const query = () => ({ data: null, isLoading: false, isError: false, refetch: vi.fn() });
  const proxy = new Proxy(
    {},
    {
      get: (_target, key) =>
        key === 'subscribe'
          ? () => ({ unsubscribe() {} })
          : key === 'invalidate'
            ? async () => undefined
            : proxy,
    },
  );
  const account = new Proxy(
    {},
    {
      get: (_target, key) =>
        key === 'listAgentLabPersonas'
          ? { useQuery: () => ({ ...query(), data: [{ id: 'synthetic', name: '合成克隆' }] }) }
          : {
              useQuery: query,
              useMutation: () => ({ mutateAsync: state.start, isLoading: false }),
            },
    },
  );
  return { trpc: { account, bootstrap: proxy, useUtils: () => proxy }, client: proxy };
});
const cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.current = true;
  vi.clearAllMocks();
  state.prepare.mockResolvedValue({ mode: 'before', directory: '/synthetic' });
  state.chooseReport.mockResolvedValue(false);
});
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  vi.unstubAllGlobals();
});
async function mount(element: ReturnType<typeof h>) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  cleanup.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}
async function click(host: HTMLElement, text: string) {
  const button = [...host.querySelectorAll('button')].find((item) =>
    item.textContent?.includes(text),
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
it('可按 QQ 号添加他人空间，输入不自行扩大导出对象', async () => {
  const host = await mount(h(QzoneTargetInput, { onAdd: state.added }));
  const input = host.querySelector('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '20002');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(state.added).not.toHaveBeenCalled();
  await act(async () =>
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(state.added).toHaveBeenLastCalledWith('20002');
});
async function botForm() {
  const host = await mount(h(PersonaBotExportPane));
  await click(host, '合成克隆');
  const input = host.querySelector<HTMLInputElement>('input[placeholder="机器人登录的 QQ 号"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '10001');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return host;
}
it('联系人页分段依次为空间、都导出、相册，支持单独导出任意一项', async () => {
  const change = vi.fn();
  const host = await mount(h(QzoneContentSelector, { value: 'both', onChange: change }));
  expect([...host.querySelectorAll('[role="tab"]')].map((node) => node.textContent)).toEqual([
    '空间',
    '都导出',
    '相册',
  ]);
  expect(host.querySelector('[aria-selected="true"]')?.textContent).toBe('都导出');
  await click(host, '相册');
  expect(change).toHaveBeenLastCalledWith('albums');
  await click(host, '空间');
  expect(change).toHaveBeenLastCalledWith('posts');
});
it('机器人复用原配置表单，公共保存带上账号来源，不把排队提示当成完成', async () => {
  const host = await botForm();
  await click(host, '导出机器人');
  expect(state.start).toHaveBeenCalledWith(
    expect.objectContaining({
      personaId: 'synthetic',
      selfId: '10001',
      expectedAccountConfigId: 'synthetic',
      savePolicy: { mode: 'before', directory: '/synthetic' },
      includeIntegrityReport: false,
    }),
  );
  expect(state.success).toHaveBeenCalledWith('机器人导出任务已创建', expect.any(String));
});
it('取消机器人保存选择，配置仍在且不创建任务', async () => {
  const host = await botForm();
  state.prepare.mockResolvedValueOnce(null);
  await click(host, '导出机器人');
  expect(state.start).not.toHaveBeenCalled();
  expect(
    host.querySelector<HTMLInputElement>('input[placeholder="机器人登录的 QQ 号"]')?.value,
  ).toBe('10001');
});
it('机器人位置等待期间切源，不发送旧配置', async () => {
  const host = await botForm();
  state.prepare.mockImplementationOnce(async () => {
    state.current = false;
    return { mode: 'before', directory: '/synthetic' };
  });
  await click(host, '导出机器人');
  expect(state.start).not.toHaveBeenCalled();
});
